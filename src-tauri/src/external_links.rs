use crate::workspace::{AppError, Result};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const MAX_URL_BYTES: usize = 8192;

fn invalid_url() -> AppError {
    AppError::new(
        "INVALID_PATH",
        "Cannot open this link. Use an absolute HTTP or HTTPS URL with a hostname, no credentials or control characters, and at most 8192 bytes.",
    )
}

fn validate_url(input: &str) -> Result<Url> {
    if input.len() > MAX_URL_BYTES
        || input.trim() != input
        || input.chars().any(char::is_control)
        || input.contains('\\')
        || input.as_bytes().windows(3).any(|part| {
            part[0] == b'%'
                && ((part[1] == b'0' || part[1] == b'1') && part[2].is_ascii_hexdigit()
                    || part[1] == b'7' && part[2].eq_ignore_ascii_case(&b'f'))
        })
    {
        return Err(invalid_url());
    }

    // The URL parser repairs forms like `https:host` and extra slashes. Require
    // an explicit, nonempty authority rather than accepting those repairs.
    let (scheme, remainder) = input.split_once("://").ok_or_else(invalid_url)?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Err(invalid_url());
    }
    let authority = remainder.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') {
        return Err(invalid_url());
    }

    let url = Url::parse(input).map_err(|_| invalid_url())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none_or(str::is_empty)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.as_str().len() > MAX_URL_BYTES
    {
        return Err(invalid_url());
    }
    Ok(url)
}

#[tauri::command]
pub async fn open_external_link(app: tauri::AppHandle, url: String) -> Result<()> {
    let url = validate_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.opener()
            .open_url(String::from(url), None::<&str>)
            .map_err(|error| {
                AppError::new(
                    "IO",
                    format!("Could not open the link in your browser. Check that a default web browser is installed and configured, then try again. {error}"),
                )
            })
    })
    .await
    .map_err(|error| AppError::new("IO", format!("The browser-opening task failed. Try opening the link again. {error}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_absolute_web_urls_and_normalizes_hosts() {
        for input in [
            "http://example.com/path?query=yes#fragment",
            "https://example.com:8443/space%20here",
            "https://[::1]/",
            "https://例え.テスト/ページ",
        ] {
            assert!(validate_url(input).is_ok(), "{input}");
        }
        assert_eq!(
            validate_url("HTTPS://EXAMPLE.COM/path").unwrap().as_str(),
            "https://example.com/path"
        );
    }

    #[test]
    fn rejects_non_web_and_ambiguous_destinations() {
        for input in [
            "",
            "relative.md",
            "//example.com",
            "#fragment",
            "https:example.com",
            "https:/example.com",
            "https:///example.com",
            "https://",
            "https://?q=x",
            "https://#fragment",
            "file:///tmp/file",
            "mailto:person@example.com",
            "javascript:alert(1)",
            "ftp://example.com",
            "custom://example.com",
            "https://user:password@example.com",
            "https://user@example.com",
            "https://@example.com",
            "https://:password@example.com",
            "https://example.com\\@evil.example",
            "https://exa mple.com",
            "https://[::1",
            "https://example.com:99999",
            " https://example.com",
            "https://example.com ",
            "https://example.com/\npath",
            "https://example.com/\tpath",
            "https://example.com/\0path",
            "https://example.com/\u{85}",
            "https://example.com/%00",
            "https://example.com/%1F",
            "https://example.com/%7f",
        ] {
            assert_eq!(
                validate_url(input).unwrap_err().code,
                "INVALID_PATH",
                "{input:?}"
            );
        }
    }

    #[test]
    fn bounds_input_and_normalized_url_size() {
        let prefix = "https://example.com/";
        let at_limit = format!("{prefix}{}", "a".repeat(MAX_URL_BYTES - prefix.len()));
        assert!(validate_url(&at_limit).is_ok());
        assert!(validate_url(&format!("{at_limit}a")).is_err());
        let expanding = format!("{prefix}{}", "é".repeat(2000));
        assert!(expanding.len() < MAX_URL_BYTES);
        assert!(validate_url(&expanding).is_err());
    }
}
