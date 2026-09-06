use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;
use walkdir::WalkDir;

pub const DOCUMENT_LIMIT: u64 = 5 * 1024 * 1024;
const ASSET_LIMIT: u64 = 10 * 1024 * 1024;
const EXCLUDED: &[&str] = &[".git", "node_modules", "target", "dist"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: &'static str,
    pub message: String,
}
pub type Result<T, E = AppError> = std::result::Result<T, E>;
impl AppError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn io(error: std::io::Error) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => "NOT_FOUND",
            std::io::ErrorKind::AlreadyExists => "ALREADY_EXISTS",
            _ => "IO",
        };
        Self::new(code, error.to_string())
    }
}
impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::io(e)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub root: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub kind: &'static str,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSnapshot {
    pub path: String,
    pub text: String,
    pub revision: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: usize,
    pub column: usize,
    pub length: usize,
    pub text: String,
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
    pub skipped: usize,
}
#[derive(Clone)]
struct Encoding {
    bom: bool,
    newline: &'static str,
}
#[derive(Default)]
pub struct WorkspaceService {
    pub workspace: Option<Workspace>,
    root: Option<PathBuf>,
    encodings: HashMap<PathBuf, Encoding>,
}

pub fn validate_path(path: &str, root_allowed: bool) -> Result<()> {
    if (path.is_empty() && !root_allowed)
        || path.starts_with('/')
        || path.contains(['\\', ':', '\0'])
        || (!path.is_empty()
            && path
                .split('/')
                .any(|s| s.is_empty() || s == "." || s == ".."))
    {
        return Err(AppError::new("INVALID_PATH", "Use a workspace-relative path with / separators, without traversal, drive prefixes or empty segments."));
    }
    Ok(())
}
pub fn supported(path: &Path) -> bool {
    path.extension()
        .and_then(|x| x.to_str())
        .map(|x| matches!(x.to_ascii_lowercase().as_str(), "md" | "markdown" | "mdx"))
        .unwrap_or(false)
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn read_limited(path: &Path, max: u64) -> Result<Vec<u8>> {
    let file = fs::File::open(path)?;
    if !file.metadata()?.is_file() {
        return Err(AppError::new(
            "INVALID_PATH",
            "The selected path is not a regular file.",
        ));
    }
    if file.metadata()?.len() > max {
        return Err(AppError::new(
            "TOO_LARGE",
            format!("File exceeds the {} MiB limit.", max / 1024 / 1024),
        ));
    }
    let mut bytes = Vec::new();
    file.take(max + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max {
        return Err(AppError::new(
            "TOO_LARGE",
            "File grew beyond the size limit.",
        ));
    }
    Ok(bytes)
}
fn decode(bytes: &[u8]) -> Result<(String, Encoding)> {
    let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
    let text = std::str::from_utf8(if bom { &bytes[3..] } else { bytes }).map_err(|_| {
        AppError::new(
            "INVALID_UTF8",
            "This document is not valid UTF-8. Convert it to UTF-8 before opening.",
        )
    })?;
    let newline = if text.contains("\r\n") {
        "\r\n"
    } else if text.contains('\r') {
        "\r"
    } else {
        "\n"
    };
    Ok((
        text.replace("\r\n", "\n").replace('\r', "\n"),
        Encoding { bom, newline },
    ))
}
impl WorkspaceService {
    pub fn select(&mut self, root: &Path) -> Result<Workspace> {
        let root = fs::canonicalize(root)?;
        if !root.is_dir() {
            return Err(AppError::new(
                "INVALID_PATH",
                "Workspace must be a directory.",
            ));
        }
        let workspace = Workspace {
            id: uuid::Uuid::new_v4().to_string(),
            name: root
                .file_name()
                .unwrap_or(root.as_os_str())
                .to_string_lossy()
                .into_owned(),
            root: root.to_string_lossy().into_owned(),
        };
        self.root = Some(root);
        self.workspace = Some(workspace.clone());
        self.encodings.clear();
        Ok(workspace)
    }
    pub fn check(&self, id: &str) -> Result<&Path> {
        let workspace = self
            .workspace
            .as_ref()
            .ok_or_else(|| AppError::new("NO_WORKSPACE", "Open a workspace folder first."))?;
        if workspace.id != id {
            return Err(AppError::new(
                "STALE_WORKSPACE",
                "This operation belongs to a previously opened workspace.",
            ));
        }
        Ok(self.root.as_deref().expect("workspace root invariant"))
    }
    pub fn root(&self) -> Option<&Path> {
        self.root.as_deref()
    }
    pub fn resolve(
        &self,
        id: &str,
        path: &str,
        create: bool,
        root_allowed: bool,
    ) -> Result<PathBuf> {
        let root = self.check(id)?;
        validate_path(path, root_allowed)?;
        let mut target = root.to_path_buf();
        let parts: Vec<_> = path.split('/').filter(|s| !s.is_empty()).collect();
        for (index, part) in parts.iter().enumerate() {
            target.push(part);
            match fs::symlink_metadata(&target) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(AppError::new(
                        "INVALID_PATH",
                        "Symbolic links inside a workspace are not followed.",
                    ))
                }
                Ok(_) => {}
                Err(e)
                    if create
                        && index + 1 == parts.len()
                        && e.kind() == std::io::ErrorKind::NotFound =>
                {
                    let parent = fs::canonicalize(target.parent().expect("relative child"))?;
                    if !parent.starts_with(root) || !parent.is_dir() {
                        return Err(AppError::new(
                            "INVALID_PATH",
                            "The destination parent must be an existing workspace directory.",
                        ));
                    }
                    return Ok(parent.join(part));
                }
                Err(e) => return Err(e.into()),
            }
        }
        let target = fs::canonicalize(target)?;
        if !target.starts_with(root) {
            return Err(AppError::new(
                "INVALID_PATH",
                "The path leaves the authorized workspace.",
            ));
        }
        Ok(target)
    }
    fn wire(&self, path: &Path) -> Result<String> {
        let relative = path
            .strip_prefix(self.root.as_ref().expect("workspace root invariant"))
            .map_err(|_| AppError::new("INVALID_PATH", "Path is outside the workspace."))?;
        relative
            .components()
            .map(|c| {
                c.as_os_str().to_str().map(str::to_owned).ok_or_else(|| {
                    AppError::new("INVALID_PATH", "This filename is not valid Unicode.")
                })
            })
            .collect::<Result<Vec<_>>>()
            .map(|v| v.join("/"))
    }
    pub fn list(&self, id: &str, path: &str) -> Result<Vec<FileEntry>> {
        let target = self.resolve(id, path, false, true)?;
        let mut entries = Vec::new();
        for entry in fs::read_dir(target)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if EXCLUDED.contains(&name.as_str())
                || (!kind.is_dir() && !(kind.is_file() && supported(&entry.path())))
            {
                continue;
            }
            let wire = self.wire(&entry.path())?;
            let canonical = self.resolve(id, &wire, false, false)?;
            entries.push(FileEntry {
                path: self.wire(&canonical)?,
                name,
                kind: if kind.is_dir() { "directory" } else { "file" },
            });
        }
        entries.sort_by(|a, b| {
            (a.kind != "directory")
                .cmp(&(b.kind != "directory"))
                .then_with(|| natural_cmp(&a.name, &b.name))
        });
        Ok(entries)
    }
    pub fn read(&mut self, id: &str, path: &str) -> Result<FileSnapshot> {
        let target = self.resolve(id, path, false, false)?;
        if !supported(&target) {
            return Err(AppError::new(
                "UNSUPPORTED_FILE",
                "Open a .md, .markdown or .mdx document.",
            ));
        }
        let bytes = read_limited(&target, DOCUMENT_LIMIT)?;
        let (text, encoding) = decode(&bytes)?;
        self.encodings.insert(target.clone(), encoding);
        Ok(FileSnapshot {
            path: self.wire(&target)?,
            text,
            revision: hash(&bytes),
        })
    }
    pub fn write(
        &mut self,
        id: &str,
        path: &str,
        text: &str,
        revision: Option<&str>,
    ) -> Result<FileSnapshot> {
        let target = self.resolve(id, path, revision.is_none(), false)?;
        if !supported(&target) {
            return Err(AppError::new(
                "UNSUPPORTED_FILE",
                "Save using a .md, .markdown or .mdx extension.",
            ));
        }
        if text.len() as u64 > DOCUMENT_LIMIT {
            return Err(AppError::new(
                "TOO_LARGE",
                "Documents are limited to 5 MiB.",
            ));
        }
        let (encoding, permissions) = if let Some(expected) = revision {
            let disk = read_limited(&target, DOCUMENT_LIMIT)?;
            if hash(&disk) != expected {
                return Err(AppError::new(
                    "CONFLICT",
                    "The file changed on disk. Reload it or explicitly confirm an overwrite.",
                ));
            }
            let encoding = match self.encodings.get(&target) {
                Some(encoding) => encoding.clone(),
                None => decode(&disk)?.1,
            };
            (encoding, Some(fs::metadata(&target)?.permissions()))
        } else {
            if target.exists() {
                return Err(AppError::new(
                    "ALREADY_EXISTS",
                    "A file already exists at this path. Choose another name.",
                ));
            }
            (
                Encoding {
                    bom: false,
                    newline: "\n",
                },
                None,
            )
        };
        let logical = text.replace("\r\n", "\n").replace('\r', "\n");
        let encoded = if encoding.newline == "\n" {
            std::borrow::Cow::Borrowed(logical.as_str())
        } else {
            std::borrow::Cow::Owned(logical.replace('\n', encoding.newline))
        };
        let mut bytes = Vec::with_capacity(encoded.len() + if encoding.bom { 3 } else { 0 });
        if encoding.bom {
            bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
        }
        bytes.extend_from_slice(encoded.as_bytes());
        if bytes.len() as u64 > DOCUMENT_LIMIT {
            return Err(AppError::new(
                "TOO_LARGE",
                "Encoded document exceeds the 5 MiB limit.",
            ));
        }
        let mut temporary = NamedTempFile::new_in(target.parent().expect("file parent"))?;
        temporary.write_all(&bytes)?;
        if let Some(permissions) = permissions {
            temporary.as_file().set_permissions(permissions)?;
        }
        temporary.flush()?;
        temporary.as_file().sync_all()?;
        // Recheck after preparing the replacement, immediately before the atomic rename.
        if let Some(expected) = revision {
            if hash(&read_limited(&target, DOCUMENT_LIMIT)?) != expected {
                return Err(AppError::new(
                    "CONFLICT",
                    "The file changed while preparing the save.",
                ));
            }
            temporary
                .persist(&target)
                .map_err(|e| AppError::io(e.error))?;
        } else {
            temporary
                .persist_noclobber(&target)
                .map_err(|e| AppError::io(e.error))?;
        }
        self.encodings.insert(target.clone(), encoding);
        Ok(FileSnapshot {
            path: self.wire(&target)?,
            text: logical,
            revision: hash(&bytes),
        })
    }
    pub fn mkdir(&self, id: &str, path: &str) -> Result<()> {
        fs::create_dir(self.resolve(id, path, true, false)?).map_err(Into::into)
    }
    pub fn search(&self, id: &str, query: &str, case_sensitive: bool) -> Result<SearchResult> {
        let root = self.check(id)?;
        let mut result = SearchResult::default();
        if query.trim().is_empty() {
            return Ok(result);
        }
        let regex = RegexBuilder::new(&regex::escape(query))
            .case_insensitive(!case_sensitive)
            .build()
            .map_err(|e| AppError::new("IO", e.to_string()))?;
        let mut count = 0;
        let mut total = 0u64;
        let walker = WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                !e.file_type().is_symlink()
                    && (e.depth() == 0
                        || !EXCLUDED
                            .iter()
                            .any(|n| e.file_name() == std::ffi::OsStr::new(n)))
            });
        'walk: for entry in walker {
            count += 1;
            if count > 50_000 {
                result.truncated = true;
                break;
            }
            let entry = match entry {
                Ok(e) => e,
                Err(_) => {
                    result.skipped += 1;
                    continue;
                }
            };
            if !entry.file_type().is_file() || !supported(entry.path()) {
                continue;
            }
            let path = match self.wire(entry.path()).and_then(|p| {
                self.resolve(id, &p, false, false)
                    .and_then(|r| self.wire(&r))
            }) {
                Ok(p) => p,
                Err(_) => {
                    result.skipped += 1;
                    continue;
                }
            };
            let target = self.resolve(id, &path, false, false)?;
            let bytes = match read_limited(&target, DOCUMENT_LIMIT) {
                Ok(b) => b,
                Err(_) => {
                    result.skipped += 1;
                    continue;
                }
            };
            total += bytes.len() as u64;
            if total > 100 * 1024 * 1024 {
                result.truncated = true;
                break;
            }
            let (text, _) = match decode(&bytes) {
                Ok(t) => t,
                Err(_) => {
                    result.skipped += 1;
                    continue;
                }
            };
            for (line, value) in text.lines().enumerate() {
                for found in regex.find_iter(value) {
                    if result.matches.len() == 1000 {
                        result.truncated = true;
                        break 'walk;
                    }
                    result.matches.push(SearchMatch {
                        path: path.clone(),
                        line: line + 1,
                        column: value[..found.start()].encode_utf16().count() + 1,
                        length: value[found.start()..found.end()].encode_utf16().count(),
                        text: value.to_owned(),
                    });
                }
            }
        }
        Ok(result)
    }
    pub fn asset(&self, id: &str, path: &str) -> Result<Vec<u8>> {
        let target = self.resolve(id, path, false, false)?;
        let extension = target
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") {
            return Err(AppError::new(
                "UNSUPPORTED_FILE",
                "Only local PNG, JPEG, GIF and WebP images are allowed.",
            ));
        }
        let bytes = read_limited(&target, ASSET_LIMIT)?;
        let valid = match extension.as_str() {
            "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "jpg" | "jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
            "gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
            "webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
            _ => false,
        };
        if !valid {
            return Err(AppError::new(
                "UNSUPPORTED_FILE",
                "Image bytes do not match the filename's raster format.",
            ));
        }
        Ok(bytes)
    }
}
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let al = a.to_lowercase();
    let bl = b.to_lowercase();
    let mut a = al.chars().peekable();
    let mut b = bl.chars().peekable();
    loop {
        match (a.peek(), b.peek()) {
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut x = String::new();
                let mut y = String::new();
                while a.peek().is_some_and(char::is_ascii_digit) {
                    x.push(a.next().unwrap());
                }
                while b.peek().is_some_and(char::is_ascii_digit) {
                    y.push(b.next().unwrap());
                }
                let xn = x.trim_start_matches('0');
                let yn = y.trim_start_matches('0');
                let order = xn
                    .len()
                    .cmp(&yn.len())
                    .then_with(|| xn.cmp(yn))
                    .then_with(|| x.len().cmp(&y.len()));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (Some(_), Some(_)) => {
                let order = a.next().cmp(&b.next());
                if order != Ordering::Equal {
                    return order;
                }
            }
            _ => return a.next().cmp(&b.next()),
        }
    }
}

#[cfg(test)]
mod tests;
