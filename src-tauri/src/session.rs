use crate::workspace::{supported, validate_path, AppError, Result, Workspace, WorkspaceService};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Session {
    pub version: u32,
    pub tabs: Vec<String>,
    pub active_path: Option<String>,
    pub theme: String,
    pub wrap: bool,
    pub preview_mode: String,
    pub sidebar_width: f64,
    pub split_ratio: f64,
    pub outline_visible: bool,
    #[serde(default = "default_warn_external_links")]
    pub warn_external_links: bool,
}

fn default_warn_external_links() -> bool {
    true
}

impl Default for Session {
    fn default() -> Self {
        Self {
            version: 1,
            tabs: Vec::new(),
            active_path: None,
            theme: "system".into(),
            wrap: true,
            preview_mode: "split".into(),
            sidebar_width: 240.0,
            split_ratio: 0.5,
            outline_visible: true,
            warn_external_links: default_warn_external_links(),
        }
    }
}
impl Session {
    pub fn validate(&self) -> Result<()> {
        if self.version != 1
            || !["system", "light", "dark"].contains(&self.theme.as_str())
            || !["split", "source", "preview"].contains(&self.preview_mode.as_str())
            || !self.sidebar_width.is_finite()
            || !(160.0..=600.0).contains(&self.sidebar_width)
            || !self.split_ratio.is_finite()
            || !(0.2..=0.8).contains(&self.split_ratio)
            || self.tabs.len() > 1000
        {
            return Err(AppError::new(
                "IO",
                "Unsupported or invalid session preferences.",
            ));
        }
        let mut seen = HashSet::new();
        for path in &self.tabs {
            validate_path(path, false)?;
            if !supported(Path::new(path)) || !seen.insert(path) {
                return Err(AppError::new(
                    "INVALID_PATH",
                    "Session tabs must be unique supported document paths.",
                ));
            }
        }
        if self
            .active_path
            .as_ref()
            .is_some_and(|p| !self.tabs.contains(p))
        {
            return Err(AppError::new(
                "INVALID_PATH",
                "The active session document must be an open saved tab.",
            ));
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    root: Option<PathBuf>,
    session: Session,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredSession {
    pub workspace: Option<Workspace>,
    pub session: Session,
    pub notice: Option<String>,
}

pub struct AppState {
    // One I/O lock serializes saves (including same-document saves), selection and persistence.
    // The generation cannot change between authorization and the filesystem operation.
    pub workspace: WorkspaceService,
    pub session: Session,
    pub session_path: PathBuf,
    restored: bool,
}
impl AppState {
    pub fn new(session_path: PathBuf) -> Self {
        Self {
            workspace: WorkspaceService::default(),
            session: Session::default(),
            session_path,
            restored: false,
        }
    }
    pub fn restore(&mut self) -> RestoredSession {
        if self.restored {
            return RestoredSession {
                workspace: self.workspace.workspace.clone(),
                session: self.session.clone(),
                notice: None,
            };
        }
        self.restored = true;
        let mut notice = None;
        let envelope = (|| -> Result<Option<Envelope>> {
            let file = match fs::File::open(&self.session_path) {
                Ok(f) => f,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(e) => return Err(e.into()),
            };
            let mut bytes = Vec::new();
            file.take(1024 * 1024 + 1).read_to_end(&mut bytes)?;
            if bytes.len() > 1024 * 1024 {
                return Err(AppError::new("TOO_LARGE", "Session file exceeds 1 MiB."));
            }
            let envelope: Envelope =
                serde_json::from_slice(&bytes).map_err(|e| AppError::new("IO", e.to_string()))?;
            envelope.session.validate()?;
            if envelope.root.is_none() && !envelope.session.tabs.is_empty() {
                return Err(AppError::new(
                    "IO",
                    "Session has tabs but no authorized root.",
                ));
            }
            if envelope
                .root
                .as_ref()
                .is_some_and(|root| !root.is_absolute())
            {
                return Err(AppError::new(
                    "INVALID_PATH",
                    "The saved workspace root must be an absolute native path.",
                ));
            }
            Ok(Some(envelope))
        })();
        match envelope {
            Err(error) => notice = Some(format!("Could not restore settings: {}. Defaults are in use; the original session file has been left intact.", error.message)),
            Ok(None) => {},
            Ok(Some(envelope)) => {
                self.session = envelope.session;
                if let Some(root) = envelope.root {
                    match self.workspace.select(&root) {
                        Ok(workspace) => {
                            let mut kept = Vec::new(); let mut dropped = 0;
                            for path in &self.session.tabs {
                                match self.workspace.resolve(&workspace.id, path, false, false) {
                                    Ok(target) if target.is_file() && supported(&target) => {
                                        let wire = target.strip_prefix(self.workspace.root().expect("selected root")).ok().and_then(|p| p.components().map(|c| c.as_os_str().to_str()).collect::<Option<Vec<_>>>()).map(|p| p.join("/"));
                                        if let Some(wire) = wire { if !kept.contains(&wire) { kept.push(wire); } } else { dropped += 1; }
                                    },
                                    _ => dropped += 1,
                                }
                            }
                            self.session.tabs = kept;
                            if !self.session.active_path.as_ref().is_some_and(|p| self.session.tabs.contains(p)) { self.session.active_path = self.session.tabs.first().cloned(); }
                            if dropped > 0 { notice = Some(format!("{dropped} missing or inaccessible saved tabs were not restored.")); }
                        },
                        Err(error) => {
                            self.session.tabs.clear(); self.session.active_path = None;
                            notice = Some(format!("Reopen your workspace folder: {} ({})", root.display(), error.message));
                        },
                    }
                }
            },
        }
        RestoredSession {
            workspace: self.workspace.workspace.clone(),
            session: self.session.clone(),
            notice,
        }
    }
    pub fn save(&mut self, session: Session, id: Option<&str>) -> Result<()> {
        match (self.workspace.workspace.as_ref(), id) {
            (Some(_), Some(id)) => {
                self.workspace.check(id)?;
            }
            (None, None) => {}
            _ => {
                return Err(AppError::new(
                    "STALE_WORKSPACE",
                    "Settings belong to a different workspace generation.",
                ))
            }
        }
        session.validate()?;
        if id.is_none() && !session.tabs.is_empty() {
            return Err(AppError::new(
                "NO_WORKSPACE",
                "Cannot persist saved tabs without a workspace.",
            ));
        }
        let envelope = Envelope {
            root: self.workspace.root().map(Path::to_path_buf),
            session: session.clone(),
        };
        let bytes =
            serde_json::to_vec_pretty(&envelope).map_err(|e| AppError::new("IO", e.to_string()))?;
        let parent = self
            .session_path
            .parent()
            .ok_or_else(|| AppError::new("IO", "Session directory is unavailable."))?;
        fs::create_dir_all(parent)?;
        let mut temporary = NamedTempFile::new_in(parent)?;
        temporary.write_all(&bytes)?;
        temporary.flush()?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(&self.session_path)
            .map_err(|e| AppError::io(e.error))?;
        self.session = session;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_session_restores_with_link_warning_without_resetting_preferences() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.json");
        let original = br#"{"root":null,"session":{"version":1,"tabs":[],"activePath":null,"theme":"dark","wrap":false,"previewMode":"source","sidebarWidth":300.0,"splitRatio":0.6,"outlineVisible":false}}"#;
        fs::write(&path, original).unwrap();

        let restored = AppState::new(path.clone()).restore();
        assert!(restored.notice.is_none());
        assert!(restored.session.warn_external_links);
        assert_eq!(restored.session.theme, "dark");
        assert!(!restored.session.wrap);
        assert_eq!(restored.session.preview_mode, "source");
        assert_eq!(restored.session.sidebar_width, 300.0);
        assert_eq!(restored.session.split_ratio, 0.6);
        assert!(!restored.session.outline_visible);
        assert_eq!(fs::read(path).unwrap(), original);
    }

    #[test]
    fn disabled_link_warning_survives_save_and_restart() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.json");
        let mut app = AppState::new(path.clone());
        app.save(
            Session {
                warn_external_links: false,
                ..Session::default()
            },
            None,
        )
        .unwrap();

        let restored = AppState::new(path).restore();
        assert!(restored.notice.is_none());
        assert!(!restored.session.warn_external_links);
    }

    #[test]
    fn damaged_session_is_not_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session.json");
        fs::write(&path, b"{broken").unwrap();
        let mut app = AppState::new(path.clone());
        let restored = app.restore();
        assert!(restored.notice.is_some());
        assert!(restored.workspace.is_none());
        assert_eq!(fs::read(path).unwrap(), b"{broken");
    }
    #[test]
    fn session_generation_cannot_reassign_root() {
        let temp = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let mut app = AppState::new(temp.path().join("settings/session.json"));
        let old = app.workspace.select(temp.path()).unwrap();
        let current = app.workspace.select(other.path()).unwrap();
        assert_eq!(
            app.save(Session::default(), Some(&old.id))
                .unwrap_err()
                .code,
            "STALE_WORKSPACE"
        );
        app.save(Session::default(), Some(&current.id)).unwrap();
        let mut restored = AppState::new(app.session_path.clone());
        assert_eq!(restored.restore().workspace.unwrap().root, current.root);
    }
    #[test]
    fn missing_tabs_are_dropped_with_notice() {
        let temp = tempfile::tempdir().unwrap();
        let mut app = AppState::new(temp.path().join("settings/session.json"));
        let workspace = app.workspace.select(temp.path()).unwrap();
        fs::write(temp.path().join("present.md"), "saved").unwrap();
        let session = Session {
            tabs: vec!["present.md".into(), "missing.md".into()],
            active_path: Some("missing.md".into()),
            ..Session::default()
        };
        app.save(session, Some(&workspace.id)).unwrap();
        let restored = AppState::new(app.session_path.clone()).restore();
        assert_eq!(restored.session.tabs, ["present.md"]);
        assert!(restored.notice.is_some());
    }
}
