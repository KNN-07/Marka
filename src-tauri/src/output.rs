use crate::workspace::{AppError, Result};
use std::{fs, io::Write, path::Path};
use tauri::{
    ipc::{InvokeBody, Request},
    Manager,
};
use tauri_plugin_dialog::DialogExt;

const MAX_OUTPUT: usize = 64 * 1024 * 1024;

fn suggested_name(encoded: &str, extension: &str) -> Result<String> {
    if encoded.len() > 2048 {
        return Err(AppError::new(
            "INVALID_PATH",
            "Export filename is too long.",
        ));
    }
    let mut bytes = Vec::with_capacity(encoded.len());
    let mut input = encoded.bytes();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let a = input.next().and_then(|c| (c as char).to_digit(16));
            let b = input.next().and_then(|c| (c as char).to_digit(16));
            match (a, b) {
                (Some(a), Some(b)) => bytes.push((a * 16 + b) as u8),
                _ => {
                    return Err(AppError::new(
                        "INVALID_PATH",
                        "Invalid encoded export filename.",
                    ))
                }
            }
        } else {
            bytes.push(byte);
        }
    }
    let decoded = String::from_utf8(bytes)
        .map_err(|_| AppError::new("INVALID_UTF8", "Invalid export filename."))?;
    let clean: String = decoded
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(120)
        .collect();
    let clean = clean.trim_matches([' ', '.']);
    let suffix = format!(".{extension}");
    let stem = if clean.to_ascii_lowercase().ends_with(&suffix) {
        &clean[..clean.len() - suffix.len()]
    } else {
        clean
    };
    // Prefix avoids Windows reserved device basenames and remains portable.
    let stem = if stem.is_empty() { "Document" } else { stem };
    let reserved = stem.split('.').next().unwrap_or("").to_ascii_uppercase();
    let prefix = if [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ]
    .contains(&reserved.as_str())
    {
        "_"
    } else {
        ""
    };
    Ok(format!("{prefix}{stem}{suffix}"))
}

fn write_export(path: &Path, bytes: &[u8]) -> Result<()> {
    if bytes.len() > MAX_OUTPUT {
        return Err(AppError::new("TOO_LARGE", "Exports are limited to 64 MiB."));
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) if value.file_type().is_symlink() || !value.is_file() => {
            return Err(AppError::new(
                "INVALID_PATH",
                "Choose a regular file, not a symbolic link or directory.",
            ))
        }
        Ok(value) => Some(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    let parent = path.parent().ok_or_else(|| {
        AppError::new(
            "INVALID_PATH",
            "Export destination has no parent directory.",
        )
    })?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    if let Some(metadata) = &metadata {
        file.as_file().set_permissions(metadata.permissions())?;
    }
    file.write_all(bytes)?;
    file.flush()?;
    file.as_file().sync_all()?;
    // Recheck the selected target; never follow a destination symlink.
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink() || !m.is_file()) {
        return Err(AppError::new(
            "INVALID_PATH",
            "Export destination changed to a symbolic link or directory.",
        ));
    }
    if metadata.is_some() {
        file.persist(path).map_err(|e| AppError::io(e.error))?;
    } else {
        file.persist_noclobber(path)
            .map_err(|e| AppError::io(e.error))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn save_export(app: tauri::AppHandle, request: Request<'_>) -> Result<bool> {
    let format = request
        .headers()
        .get("x-marka-format")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let (extension, label) = match format {
        "pdf" => ("pdf", "PDF document"),
        "docx" => ("docx", "Word document"),
        "html" => ("html", "HTML document"),
        "txt" => ("txt", "Plain text"),
        _ => {
            return Err(AppError::new(
                "UNSUPPORTED_FILE",
                "Unsupported export format.",
            ))
        }
    };
    let name = suggested_name(
        request
            .headers()
            .get("x-marka-name")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("Document"),
        extension,
    )?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) if bytes.len() <= MAX_OUTPUT => bytes.clone(),
        InvokeBody::Raw(_) => {
            return Err(AppError::new("TOO_LARGE", "Exports are limited to 64 MiB."))
        }
        _ => return Err(AppError::new("IO", "Export requires a binary payload.")),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut picker = app
            .dialog()
            .file()
            // AppImage's working directory is temporary, not a safe export default.
            .set_directory(
                app.path()
                    .home_dir()
                    .map_err(|e| AppError::new("IO", e.to_string()))?,
            )
            .set_title("Export document")
            .set_file_name(&name)
            .add_filter(label, &[extension]);
        if let Some(window) = app.get_webview_window("main") {
            picker = picker.set_parent(&window);
        }
        let Some(path) = picker.blocking_save_file() else {
            return Ok(false);
        };
        let path = path
            .into_path()
            .map_err(|e| AppError::new("INVALID_PATH", e.to_string()))?;
        // Do not silently change the path after the native overwrite confirmation.
        if !path
            .extension()
            .is_some_and(|e| e.to_string_lossy().eq_ignore_ascii_case(extension))
        {
            return Err(AppError::new(
                "UNSUPPORTED_FILE",
                format!("Choose a filename ending in .{extension}."),
            ));
        }
        write_export(&path, &bytes)?;
        Ok(true)
    })
    .await
    .map_err(|e| AppError::new("IO", e.to_string()))?
}

#[tauri::command]
pub async fn open_print_document(app: tauri::AppHandle, title: String, html: String) -> Result<()> {
    if title.len() > 2048 || html.len() > MAX_OUTPUT {
        return Err(AppError::new(
            "TOO_LARGE",
            "Print document exceeds the 64 MiB limit or its title is too long.",
        ));
    }
    let payload = serde_json::to_string(&serde_json::json!({"title": title, "html": html}))
        .map_err(|e| AppError::new("IO", e.to_string()))?;
    let label = format!("print-{}", uuid::Uuid::new_v4());
    tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App("print.html".into()))
        .title(format!("Print — {title}"))
        .inner_size(900.0, 760.0)
        .initialization_script(format!("Object.defineProperty(window, '__MARKA_PRINT__', {{value: {payload}, configurable: true}});"))
        .on_navigation(|url| {
            url.path() == "/print.html" && (url.scheme() == "tauri" && url.host_str() == Some("localhost")
                || url.scheme() == "http" && (url.host_str() == Some("tauri.localhost")
                    || cfg!(debug_assertions) && url.host_str() == Some("localhost") && url.port() == Some(1420)))
        })
        .build().map_err(|e| AppError::new("IO", format!("Unable to open print window: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn export_replaces_file_without_changing_other_files() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("output.pdf");
        let source = root.path().join("source.md");
        fs::write(&target, b"old").unwrap();
        fs::write(&source, b"source").unwrap();
        let permissions = fs::metadata(&target).unwrap().permissions();
        write_export(&target, b"%PDF-new").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"%PDF-new");
        assert_eq!(fs::read(&source).unwrap(), b"source");
        assert_eq!(fs::metadata(&target).unwrap().permissions(), permissions);
    }
    #[cfg(unix)]
    #[test]
    fn export_refuses_symlink_without_touching_referent() {
        let root = tempfile::tempdir().unwrap();
        let original = root.path().join("original.txt");
        let link = root.path().join("link.txt");
        fs::write(&original, b"untouched").unwrap();
        std::os::unix::fs::symlink(&original, &link).unwrap();
        assert!(write_export(&link, b"replacement").is_err());
        assert_eq!(fs::read(original).unwrap(), b"untouched");
    }
    #[test]
    fn suggested_names_decode_unicode_and_remove_path_syntax() {
        assert_eq!(
            suggested_name("r%C3%A9sum%C3%A9", "pdf").unwrap(),
            "résumé.pdf"
        );
        assert_eq!(suggested_name("..%2FCON", "txt").unwrap(), "_CON.txt");
        assert!(suggested_name("%FF", "txt").is_err());
    }
}

#[tauri::command]
pub fn print_current(window: tauri::WebviewWindow) -> Result<()> {
    if !window.label().starts_with("print-") {
        return Err(AppError::new(
            "IO",
            "Printing is available only in a print window.",
        ));
    }
    window
        .print()
        .map_err(|e| AppError::new("IO", format!("Unable to open the native print dialog: {e}")))
}
