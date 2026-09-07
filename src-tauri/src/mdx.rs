use crate::{
    session::AppState,
    workspace::{validate_path, AppError, Result, DOCUMENT_LIMIT},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
};
use tempfile::NamedTempFile;

const PAYLOAD_LIMIT: usize = 32 * 1024 * 1024;
const EXTENSIONS: &[&str] = &["jsx", "tsx", "mdx", "js", "ts", "json", "css"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MdxPlugin {
    pub name: String,
    pub path: String,
    #[serde(default = "default_export")]
    pub export_name: String,
}
fn default_export() -> String {
    "default".into()
}
fn identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_' || b == b'$')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'$')
}
pub fn is_mdx(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("mdx"))
}
fn allowed_extension(path: &str, extensions: &[&str]) -> bool {
    Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|extension| {
            extensions
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        })
}
pub fn validate_registry(files: &[String], plugins: &[MdxPlugin]) -> Result<()> {
    if files.len() > 1000 || plugins.len() > 32 {
        return Err(AppError::new(
            "TOO_LARGE",
            "Too many MDX grants or plugins.",
        ));
    }
    let mut seen = HashSet::new();
    for path in files {
        validate_path(path, false)?;
        if !is_mdx(path) || !seen.insert(path) {
            return Err(AppError::new(
                "INVALID_PATH",
                "Execution grants must be unique saved MDX paths.",
            ));
        }
    }
    let mut names = HashSet::new();
    for plugin in plugins {
        validate_path(&plugin.path, false)?;
        if plugin
            .path
            .split('/')
            .any(|part| part.eq_ignore_ascii_case("node_modules"))
        {
            return Err(AppError::new(
                "INVALID_PATH",
                "Installed npm packages cannot be registered as local plugins.",
            ));
        }
        if plugin.name.len() > 64
            || !plugin
                .name
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_uppercase)
            || !plugin.name.bytes().all(|b| b.is_ascii_alphanumeric())
            || !identifier(&plugin.export_name)
            || plugin.export_name.len() > 64
            || ["Callout", "Badge", "Tabs", "Tab"].contains(&plugin.name.as_str())
            || !names.insert(&plugin.name)
            || !allowed_extension(&plugin.path, &["jsx", "tsx", "mdx"])
        {
            return Err(AppError::new("INVALID_PATH", "Plugins need unique PascalCase names (excluding Callout, Badge, Tabs, Tab), valid exports and local .jsx/.tsx/.mdx paths."));
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MdxModule {
    pub path: String,
    pub source: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MdxRunPayload {
    pub title: String,
    pub code: String,
    pub theme: String,
}
impl MdxRunPayload {
    fn validate(&self) -> Result<()> {
        if self.title.len() > 4096
            || self.code.len() > PAYLOAD_LIMIT
            || !["light", "dark"].contains(&self.theme.as_str())
        {
            return Err(AppError::new(
                "INVALID_PAYLOAD",
                "Invalid or oversized MDX runtime payload.",
            ));
        }
        Ok(())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MdxRuntimeStatus {
    pub running: bool,
    pub path: Option<String>,
    pub error: Option<String>,
}
struct Running {
    child: Child,
    _payload: NamedTempFile,
    _directory: tempfile::TempDir,
    path: String,
}
#[derive(Default)]
pub struct MdxRuntime {
    running: Option<Running>,
    error: Option<String>,
}
impl MdxRuntime {
    pub fn stop(&mut self) -> Result<()> {
        if let Some(running) = self.running.as_mut() {
            if running.child.try_wait()?.is_none() {
                running.child.kill()?;
                running.child.wait()?;
            }
        }
        self.running = None;
        self.error = None;
        Ok(())
    }
    pub fn status(&mut self) -> Result<MdxRuntimeStatus> {
        if let Some(running) = self.running.as_mut() {
            if let Some(status) = running.child.try_wait()? {
                if !status.success() {
                    self.error = Some(format!("MDX runtime exited: {status}"));
                }
                self.running = None;
            }
        }
        Ok(MdxRuntimeStatus {
            running: self.running.is_some(),
            path: self.running.as_ref().map(|r| r.path.clone()),
            error: self.error.clone(),
        })
    }
    fn start(&mut self, path: String, payload: MdxRunPayload) -> Result<()> {
        payload.validate()?;
        let bytes = serde_json::to_vec(&payload)
            .map_err(|e| AppError::new("INVALID_PAYLOAD", e.to_string()))?;
        if bytes.len() > PAYLOAD_LIMIT {
            return Err(AppError::new(
                "TOO_LARGE",
                "Serialized MDX payload exceeds 32 MiB.",
            ));
        }
        let directory = tempfile::tempdir()?;
        let mut temporary = NamedTempFile::new_in(directory.path())?;
        temporary.write_all(&bytes)?;
        temporary.flush()?;
        self.stop()?;
        // Relaunch the actual inner binary, not the AppImage runtime wrapper.
        // AppRun's exported APPDIR/library/GTK environment is inherited unchanged;
        // the parent keeps its extracted/mounted image alive until this child exits.
        // This works without FUSE and keeps Child attached to the process to kill.
        let child = Command::new(std::env::current_exe()?)
            .arg("--marka-mdx-runtime")
            .arg(temporary.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()?;
        self.running = Some(Running {
            child,
            _payload: temporary,
            _directory: directory,
            path,
        });
        Ok(())
    }
}
impl Drop for MdxRuntime {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

impl AppState {
    pub fn approve_mdx_entry(&self, id: &str, path: &str) -> Result<()> {
        self.workspace.check(id)?;
        if !self.session.allow_mdx_execution
            || !self.session.mdx_execution_files.iter().any(|p| p == path)
            || !is_mdx(path)
        {
            return Err(AppError::new(
                "MDX_NOT_APPROVED",
                "Enable executable MDX and explicitly approve this saved file first.",
            ));
        }
        let target = self.workspace.resolve(id, path, false, false)?;
        if !target.is_file() {
            return Err(AppError::new(
                "INVALID_PATH",
                "The MDX entry must be a saved regular file.",
            ));
        }
        Ok(())
    }
    pub fn run_mdx(&mut self, id: &str, path: String, payload: MdxRunPayload) -> Result<()> {
        self.approve_mdx_entry(id, &path)?;
        self.mdx_runtime.start(path, payload)
    }
    pub fn resolve_mdx_module(
        &self,
        id: &str,
        entry: &str,
        importer: Option<&str>,
        specifier: &str,
    ) -> Result<MdxModule> {
        self.approve_mdx_entry(id, entry)?;
        let base = if let Some(importer) = importer {
            validate_path(importer, false)?;
            if !(specifier.starts_with("./") || specifier.starts_with("../"))
                || specifier.contains(['\\', ':', '?', '#', '\0'])
            {
                return Err(AppError::new(
                    "INVALID_PATH",
                    "MDX dependencies must use local relative imports, never packages or URLs.",
                ));
            }
            // Verify importer itself belongs to this generation and is a supported local module.
            self.workspace.resolve(id, importer, false, false)?;
            if !allowed_extension(importer, EXTENSIONS) {
                return Err(AppError::new("INVALID_PATH", "Unsupported MDX importer."));
            }
            let mut parts: Vec<&str> = importer.split('/').collect();
            parts.pop();
            for part in specifier.split('/') {
                match part {
                    "." => {}
                    ".." => {
                        if parts.pop().is_none() {
                            return Err(AppError::new(
                                "INVALID_PATH",
                                "MDX import leaves the workspace.",
                            ));
                        }
                    }
                    "" => return Err(AppError::new("INVALID_PATH", "Empty import path segment.")),
                    value => parts.push(value),
                }
            }
            parts.join("/")
        } else {
            validate_path(specifier, false)?;
            if !self.session.mdx_plugins.iter().any(|p| p.path == specifier) {
                return Err(AppError::new(
                    "MDX_NOT_APPROVED",
                    "This plugin is not registered for this workspace.",
                ));
            }
            specifier.to_owned()
        };
        validate_path(&base, false)?;
        if base
            .split('/')
            .any(|part| part.eq_ignore_ascii_case("node_modules"))
        {
            return Err(AppError::new(
                "INVALID_PATH",
                "Installed npm packages cannot be imported by local MDX.",
            ));
        }
        let extension = Path::new(&base).extension().and_then(|s| s.to_str());
        let candidates = if let Some(extension) = extension {
            if !EXTENSIONS
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
            {
                return Err(AppError::new(
                    "INVALID_PATH",
                    format!("Unsupported MDX module extension: {base}"),
                ));
            }
            vec![base]
        } else {
            EXTENSIONS
                .iter()
                .map(|ext| format!("{base}.{ext}"))
                .chain(EXTENSIONS.iter().map(|ext| format!("{base}/index.{ext}")))
                .collect()
        };
        for path in candidates {
            let target = match self.workspace.resolve(id, &path, false, false) {
                Ok(target) => target,
                Err(error) if error.code == "NOT_FOUND" => continue,
                Err(error) => return Err(error),
            };
            let file = fs::File::open(target)?;
            if !file.metadata()?.is_file() {
                return Err(AppError::new(
                    "INVALID_PATH",
                    "MDX modules must be regular files.",
                ));
            }
            if file.metadata()?.len() > DOCUMENT_LIMIT {
                return Err(AppError::new(
                    "TOO_LARGE",
                    format!("MDX module exceeds 5 MiB: {path}"),
                ));
            }
            let mut bytes = Vec::new();
            file.take(DOCUMENT_LIMIT + 1).read_to_end(&mut bytes)?;
            if bytes.len() as u64 > DOCUMENT_LIMIT {
                return Err(AppError::new(
                    "TOO_LARGE",
                    format!("MDX module exceeds 5 MiB: {path}"),
                ));
            }
            let source = String::from_utf8(bytes).map_err(|_| {
                AppError::new("INVALID_UTF8", format!("MDX module is not UTF-8: {path}"))
            })?;
            return Ok(MdxModule { path, source });
        }
        Err(AppError::new(
            "NOT_FOUND",
            format!("Local MDX module not found: {specifier}"),
        ))
    }
}

/// This branch occurs before any main application builder, state or plugin exists.
pub fn runtime_mode() -> bool {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--marka-mdx-runtime")) {
        return false;
    }
    let result = (|| -> std::result::Result<(), Box<dyn std::error::Error>> {
        let path = PathBuf::from(args.next().ok_or("Missing runtime payload")?);
        if args.next().is_some() {
            return Err("Unexpected runtime arguments".into());
        }
        let file = fs::File::open(&path)?;
        if !file.metadata()?.is_file() || file.metadata()?.len() > PAYLOAD_LIMIT as u64 {
            return Err("Invalid runtime payload file".into());
        }
        let mut bytes = Vec::new();
        file.take(PAYLOAD_LIMIT as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > PAYLOAD_LIMIT {
            return Err("Runtime payload exceeds limit".into());
        }
        let payload: MdxRunPayload = serde_json::from_slice(&bytes)?;
        payload.validate().map_err(|e| e.message)?;
        let bootstrap = format!(
            "window.__MARKA_MDX_PAYLOAD__ = {};",
            serde_json::to_string(&payload)?
        );
        let mut context = tauri::generate_context!("tauri.runtime.conf.json");
        // Cargo/Tauri build overrides can replace the secondary context's CSP.
        // Apply the runtime-only configuration authoritatively before constructing it.
        *context.config_mut() = serde_json::from_str(include_str!("../tauri.runtime.conf.json"))?;
        // A unique WebView2/WebKit profile prevents sharing renderer pools and
        // storage with the editor. The parent owns the enclosing temporary folder
        // so killing a hung runtime also cleans its profile.
        let profile = tempfile::tempdir_in(path.parent().ok_or("Missing payload directory")?)?;
        let profile_path = profile.path().to_path_buf();
        tauri::Builder::default()
            .setup(move |app| {
                tauri::WebviewWindowBuilder::new(
                    app,
                    "mdx-runtime",
                    tauri::WebviewUrl::App("mdx-runtime.html".into()),
                )
                .title("Marka — Executable MDX")
                .inner_size(1000.0, 760.0)
                .data_directory(profile_path)
                .incognito(true)
                .initialization_script(&bootstrap)
                .on_navigation(|url| {
                    url.as_str() == "about:blank"
                        || url.as_str() == "about:srcdoc"
                        || (url.path() == "/mdx-runtime.html"
                            && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                                || (matches!(url.scheme(), "http" | "https")
                                    && url.host_str() == Some("tauri.localhost"))
                                || (cfg!(debug_assertions)
                                    && url.scheme() == "http"
                                    && url.host_str() == Some("localhost")
                                    && url.port() == Some(1420))))
                })
                .build()?;
                Ok(())
            })
            .run(context)?;
        drop(profile);
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("MDX runtime: {error}");
        std::process::exit(1);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::Session;

    fn fixture() -> (tempfile::TempDir, AppState, String) {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("entry.mdx"), "# Entry").unwrap();
        let mut state = AppState::new(directory.path().join("settings/session.json"));
        let workspace = state.select_workspace(directory.path()).unwrap();
        state.session.allow_mdx_execution = true;
        state.session.mdx_execution_files.push("entry.mdx".into());
        (directory, state, workspace.id)
    }

    #[test]
    fn execution_requires_global_and_exact_saved_file_grants_and_current_generation() {
        let (directory, mut state, id) = fixture();
        assert!(state.approve_mdx_entry(&id, "entry.mdx").is_ok());
        state.session.allow_mdx_execution = false;
        assert_eq!(
            state.approve_mdx_entry(&id, "entry.mdx").unwrap_err().code,
            "MDX_NOT_APPROVED"
        );
        state.session.allow_mdx_execution = true;
        assert_eq!(
            state.approve_mdx_entry(&id, "other.mdx").unwrap_err().code,
            "MDX_NOT_APPROVED"
        );
        fs::remove_file(directory.path().join("entry.mdx")).unwrap();
        assert_eq!(
            state.approve_mdx_entry(&id, "entry.mdx").unwrap_err().code,
            "NOT_FOUND"
        );
        state.select_workspace(directory.path()).unwrap();
        assert_eq!(
            state.approve_mdx_entry(&id, "entry.mdx").unwrap_err().code,
            "STALE_WORKSPACE"
        );
    }

    #[test]
    fn resolver_reads_relative_extension_and_index_modules_but_rejects_escape_and_packages() {
        let (directory, state, id) = fixture();
        fs::create_dir(directory.path().join("components")).unwrap();
        fs::write(
            directory.path().join("components/index.tsx"),
            "export default () => null",
        )
        .unwrap();
        let module = state
            .resolve_mdx_module(&id, "entry.mdx", Some("entry.mdx"), "./components")
            .unwrap();
        assert_eq!(module.path, "components/index.tsx");
        assert_eq!(module.source, "export default () => null");
        for specifier in [
            "react",
            "https://example.com/a.ts",
            "../outside.ts",
            "./secret.txt",
            "/etc/passwd",
            "./a.ts?raw",
        ] {
            assert!(
                state
                    .resolve_mdx_module(&id, "entry.mdx", Some("entry.mdx"), specifier)
                    .is_err(),
                "{specifier}"
            );
        }
        assert!(state
            .resolve_mdx_module(&id, "entry.mdx", None, "components/index.tsx")
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn resolver_never_follows_workspace_symlinks() {
        let (directory, state, id) = fixture();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.ts"), "secret").unwrap();
        std::os::unix::fs::symlink(outside.path(), directory.path().join("linked")).unwrap();
        assert_eq!(
            state
                .resolve_mdx_module(&id, "entry.mdx", Some("entry.mdx"), "./linked/secret.ts")
                .err()
                .unwrap()
                .code,
            "INVALID_PATH"
        );
    }

    #[test]
    fn registry_rejects_reserved_duplicate_nonlocal_and_invalid_identifiers() {
        let good = MdxPlugin {
            name: "Chart".into(),
            path: "components/Chart.tsx".into(),
            export_name: "default".into(),
        };
        assert!(validate_registry(&["entry.mdx".into()], &[good.clone()]).is_ok());
        assert!(validate_registry(&[], &[good.clone(), good.clone()]).is_err());
        for name in [
            "Callout",
            "Badge",
            "Tabs",
            "Tab",
            "chart",
            "Chart-Plot",
            "Éclair",
        ] {
            assert!(validate_registry(
                &[],
                &[MdxPlugin {
                    name: name.into(),
                    ..good.clone()
                }]
            )
            .is_err());
        }
        for path in ["../Chart.tsx", "Chart.js", "https://example.com/Chart.tsx"] {
            assert!(validate_registry(
                &[],
                &[MdxPlugin {
                    path: path.into(),
                    ..good.clone()
                }]
            )
            .is_err());
        }
        assert!(validate_registry(
            &[],
            &[MdxPlugin {
                export_name: "a.b".into(),
                ..good
            }]
        )
        .is_err());
        assert!(validate_registry(&["entry.md".into()], &[]).is_err());
    }

    #[test]
    fn switching_workspace_clears_trust_without_resetting_global_preferences() {
        let (_directory, mut state, _) = fixture();
        state.session.theme = "dark".into();
        state.session.mdx_plugins.push(MdxPlugin {
            name: "Chart".into(),
            path: "Chart.tsx".into(),
            export_name: "default".into(),
        });
        let other = tempfile::tempdir().unwrap();
        state.select_workspace(other.path()).unwrap();
        assert!(state.session.mdx_execution_files.is_empty());
        assert!(state.session.mdx_plugins.is_empty());
        assert!(!state.session.allow_mdx_execution);
        assert_eq!(state.session.theme, "dark");
    }

    #[cfg(unix)]
    #[test]
    fn permission_and_plugin_changes_kill_running_child_and_release_payload() {
        for change in 0..3 {
            let (_directory, mut state, id) = fixture();
            let payload = NamedTempFile::new().unwrap();
            let payload_path = payload.path().to_path_buf();
            let child = Command::new("sleep").arg("60").spawn().unwrap();
            state.mdx_runtime.running = Some(Running {
                child,
                _payload: payload,
                _directory: tempfile::tempdir().unwrap(),
                path: "entry.mdx".into(),
            });
            let mut session = state.session.clone();
            match change {
                0 => session.allow_mdx_execution = false,
                1 => session.mdx_execution_files.clear(),
                _ => session.mdx_plugins.push(MdxPlugin {
                    name: "Entry".into(),
                    path: "entry.mdx".into(),
                    export_name: "default".into(),
                }),
            }
            state.save(session, Some(&id)).unwrap();
            assert!(!state.mdx_runtime.status().unwrap().running);
            assert!(!payload_path.exists());
        }
    }

    #[test]
    fn old_preferences_migrate_without_execution_authority() {
        let mut value = serde_json::to_value(Session::default()).unwrap();
        for key in ["allowMdxExecution", "mdxExecutionFiles", "mdxPlugins"] {
            value.as_object_mut().unwrap().remove(key);
        }
        let session: Session = serde_json::from_value(value).unwrap();
        assert!(!session.allow_mdx_execution);
        assert!(session.mdx_execution_files.is_empty());
        assert!(session.mdx_plugins.is_empty());
    }
}
