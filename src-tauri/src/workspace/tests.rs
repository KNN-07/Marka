use super::*;

fn fixture() -> (tempfile::TempDir, WorkspaceService, String) {
    let root = tempfile::tempdir().unwrap();
    let mut service = WorkspaceService::default();
    let workspace = service.select(root.path()).unwrap();
    (root, service, workspace.id)
}
#[test]
fn traversal_absolute_and_windows_paths_are_rejected_for_reads_and_writes() {
    let (root, mut service, id) = fixture();
    let outside = tempfile::tempdir().unwrap();
    let external = outside.path().join("outside.md");
    fs::write(&external, "untouched").unwrap();
    let mut attacks = vec![
        "../outside.md".to_owned(),
        "nested/../../outside.md".into(),
        "C:/outside.md".into(),
        "C:outside.md".into(),
        "\\\\server\\share\\outside.md".into(),
        "//server/share/outside.md".into(),
        "safe.md:stream".into(),
        "nested\\outside.md".into(),
    ];
    attacks.push(external.to_string_lossy().into_owned());
    for attack in attacks {
        assert_eq!(
            service.read(&id, &attack).unwrap_err().code,
            "INVALID_PATH",
            "{attack}"
        );
        assert_eq!(
            service
                .write(&id, &attack, "attack", None)
                .unwrap_err()
                .code,
            "INVALID_PATH",
            "{attack}"
        );
        assert_eq!(
            service.asset(&id, &attack).unwrap_err().code,
            "INVALID_PATH",
            "{attack}"
        );
    }
    assert_eq!(fs::read_to_string(external).unwrap(), "untouched");
    assert!(service
        .search(&id, "untouched", true)
        .unwrap()
        .matches
        .is_empty());
    assert!(root.path().exists());
}
#[test]
fn generation_is_checked_for_every_operation() {
    let (root, mut service, old) = fixture();
    fs::write(root.path().join("a.md"), "old").unwrap();
    service.select(root.path()).unwrap();
    assert_eq!(
        service.read(&old, "a.md").unwrap_err().code,
        "STALE_WORKSPACE"
    );
    assert_eq!(
        service.write(&old, "a.md", "new", None).unwrap_err().code,
        "STALE_WORKSPACE"
    );
    assert_eq!(service.list(&old, "").unwrap_err().code, "STALE_WORKSPACE");
    assert_eq!(
        service.mkdir(&old, "folder").unwrap_err().code,
        "STALE_WORKSPACE"
    );
    assert_eq!(
        service.search(&old, "", false).unwrap_err().code,
        "STALE_WORKSPACE"
    );
    assert_eq!(
        service.asset(&old, "image.png").unwrap_err().code,
        "STALE_WORKSPACE"
    );
}
#[test]
fn create_only_and_stale_revision_preserve_disk() {
    let (root, mut service, id) = fixture();
    let original = service.write(&id, "notes.md", "first", None).unwrap();
    assert_eq!(
        service
            .write(&id, "notes.md", "collision", None)
            .unwrap_err()
            .code,
        "ALREADY_EXISTS"
    );
    fs::write(root.path().join("notes.md"), "external").unwrap();
    assert_eq!(
        service
            .write(&id, "notes.md", "stale", Some(&original.revision))
            .unwrap_err()
            .code,
        "CONFLICT"
    );
    assert_eq!(
        fs::read_to_string(root.path().join("notes.md")).unwrap(),
        "external"
    );
    fs::remove_file(root.path().join("notes.md")).unwrap();
    assert_eq!(
        service
            .write(&id, "notes.md", "stale", Some(&original.revision))
            .unwrap_err()
            .code,
        "NOT_FOUND"
    );
}
#[test]
fn unicode_spaces_bom_and_crlf_survive_save() {
    let (root, mut service, id) = fixture();
    service.mkdir(&id, "Marka Space ü").unwrap();
    let path = "Marka Space ü/Écriture 文件.MDX";
    fs::write(root.path().join(path), b"\xef\xbb\xbf# Title\r\nfirst\r\n").unwrap();
    let read = service.read(&id, path).unwrap();
    assert_eq!(read.text, "# Title\nfirst\n");
    let saved = service
        .write(&id, path, "# Title\nchanged\n", Some(&read.revision))
        .unwrap();
    let bytes = fs::read(root.path().join(path)).unwrap();
    assert_eq!(bytes, b"\xef\xbb\xbf# Title\r\nchanged\r\n");
    assert_eq!(saved.revision, hash(&bytes));
    assert_eq!(saved.path, path);
    assert_eq!(saved.text, "# Title\nchanged\n");
}
#[test]
fn emoji_and_unicode_case_search_have_original_utf16_positions() {
    let (root, service, id) = fixture();
    fs::write(root.path().join("emoji.md"), "😀 alpha ÉCHO\nother").unwrap();
    let result = service.search(&id, "ALPHA", false).unwrap();
    assert_eq!(result.matches[0].line, 1);
    assert_eq!(result.matches[0].column, 4);
    assert_eq!(result.matches[0].length, 5);
    let result = service.search(&id, "écho", false).unwrap();
    assert_eq!(result.matches[0].column, 10);
    assert_eq!(result.matches[0].length, 4);
}
#[test]
fn search_exclusions_limits_and_read_errors_are_observable() {
    let (root, mut service, id) = fixture();
    service.mkdir(&id, "node_modules").unwrap();
    fs::write(root.path().join("node_modules/hidden.md"), "needle").unwrap();
    fs::write(root.path().join("invalid.md"), [0xff]).unwrap();
    fs::write(root.path().join(".visible.md"), "needle\n".repeat(1001)).unwrap();
    let result = service.search(&id, "needle", true).unwrap();
    assert_eq!(result.matches.len(), 1000);
    assert!(result.truncated);
    assert!(result.matches.iter().all(|m| m.path == ".visible.md"));
    let result = service.search(&id, "absent", true).unwrap();
    assert_eq!(result.skipped, 1);
    assert!(service.search(&id, "  ", true).unwrap().matches.is_empty());
    assert_eq!(
        service.read(&id, "invalid.md").unwrap_err().code,
        "INVALID_UTF8"
    );
    fs::File::create(root.path().join("oversize.md"))
        .unwrap()
        .set_len(DOCUMENT_LIMIT + 1)
        .unwrap();
    assert_eq!(
        service.read(&id, "oversize.md").unwrap_err().code,
        "TOO_LARGE"
    );
}
#[test]
fn asset_extension_and_magic_must_agree() {
    let (root, service, id) = fixture();
    fs::write(root.path().join("bad.png"), "<svg onload='attack()'/>").unwrap();
    fs::write(root.path().join("bad.svg"), b"\x89PNG\r\n\x1a\n").unwrap();
    assert_eq!(
        service.asset(&id, "bad.png").unwrap_err().code,
        "UNSUPPORTED_FILE"
    );
    assert_eq!(
        service.asset(&id, "bad.svg").unwrap_err().code,
        "UNSUPPORTED_FILE"
    );
    fs::write(root.path().join("good.PNG"), b"\x89PNG\r\n\x1a\n").unwrap();
    assert_eq!(
        service.asset(&id, "good.PNG").unwrap(),
        b"\x89PNG\r\n\x1a\n"
    );
}
#[test]
fn missing_parent_and_directory_target_do_not_destroy_existing_data() {
    let (root, mut service, id) = fixture();
    let original = service.write(&id, "kept.md", "keep", None).unwrap();
    assert_eq!(
        service
            .write(&id, "missing/new.md", "new", None)
            .unwrap_err()
            .code,
        "NOT_FOUND"
    );
    service.mkdir(&id, "folder.md").unwrap();
    assert!(service
        .write(&id, "folder.md", "wrong", Some(&original.revision))
        .is_err());
    assert_eq!(
        fs::read_to_string(root.path().join("kept.md")).unwrap(),
        "keep"
    );
    assert!(root.path().join("folder.md").is_dir());
}

#[cfg(unix)]
#[test]
fn unix_symlink_reads_writes_list_and_search_cannot_escape() {
    use std::os::unix::fs::symlink;
    let (root, mut service, id) = fixture();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("outside.md"), "secret").unwrap();
    symlink(outside.path(), root.path().join("escape")).unwrap();
    symlink(
        outside.path().join("outside.md"),
        root.path().join("link.md"),
    )
    .unwrap();
    for path in ["escape/outside.md", "link.md"] {
        assert_eq!(service.read(&id, path).unwrap_err().code, "INVALID_PATH");
        assert_eq!(
            service.write(&id, path, "attack", None).unwrap_err().code,
            "INVALID_PATH"
        );
    }
    assert_eq!(
        service.list(&id, "escape").unwrap_err().code,
        "INVALID_PATH"
    );
    assert!(service.list(&id, "").unwrap().is_empty());
    assert!(service
        .search(&id, "secret", true)
        .unwrap()
        .matches
        .is_empty());
    assert_eq!(
        fs::read_to_string(outside.path().join("outside.md")).unwrap(),
        "secret"
    );
}
#[cfg(unix)]
#[test]
fn unix_permissions_survive_atomic_replacement_and_failures_preserve_original() {
    use std::os::unix::fs::PermissionsExt;
    let (root, mut service, id) = fixture();
    let initial = service.write(&id, "mode.md", "original", None).unwrap();
    fs::set_permissions(
        root.path().join("mode.md"),
        fs::Permissions::from_mode(0o640),
    )
    .unwrap();
    let saved = service
        .write(&id, "mode.md", "saved", Some(&initial.revision))
        .unwrap();
    assert_eq!(
        fs::metadata(root.path().join("mode.md"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o640
    );
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o500)).unwrap();
    let result = service.write(&id, "mode.md", "failure", Some(&saved.revision));
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    match result {
        Err(error) => { assert_eq!(error.code, "IO"); assert_eq!(fs::read_to_string(root.path().join("mode.md")).unwrap(), "saved"); },
        Ok(_) => eprintln!("Permission-denial case unavailable: this process can bypass Unix directory permissions (for example root/CAP_DAC_OVERRIDE)."),
    }
}
#[cfg(windows)]
#[test]
fn windows_locked_file_replacement_preserves_original() {
    use std::os::windows::fs::OpenOptionsExt;
    let (root, mut service, id) = fixture();
    let original = service.write(&id, "locked.md", "original", None).unwrap();
    let _lock = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(root.path().join("locked.md"))
        .unwrap();
    assert_eq!(
        service
            .write(&id, "locked.md", "replacement", Some(&original.revision))
            .unwrap_err()
            .code,
        "IO"
    );
    assert_eq!(
        fs::read_to_string(root.path().join("locked.md")).unwrap(),
        "original"
    );
}
#[cfg(windows)]
#[test]
fn windows_symlink_boundary_or_explicit_privilege_notice() {
    use std::os::windows::fs::symlink_dir;
    let (root, mut service, id) = fixture();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("outside.md"), "secret").unwrap();
    if let Err(error) = symlink_dir(outside.path(), root.path().join("escape")) {
        if error.raw_os_error() == Some(1314) {
            eprintln!("Windows symlink boundary case not exercised: ERROR_PRIVILEGE_NOT_HELD; enable Developer Mode or grant SeCreateSymbolicLinkPrivilege. Drive/UNC/ADS traversal cases still run.");
            return;
        }
        panic!("Unable to create Windows symlink fixture: {error}");
    }
    assert_eq!(
        service.read(&id, "escape/outside.md").unwrap_err().code,
        "INVALID_PATH"
    );
    assert_eq!(
        service
            .write(&id, "escape/outside.md", "attack", None)
            .unwrap_err()
            .code,
        "INVALID_PATH"
    );
    assert!(service
        .search(&id, "secret", true)
        .unwrap()
        .matches
        .is_empty());
    assert_eq!(
        fs::read_to_string(outside.path().join("outside.md")).unwrap(),
        "secret"
    );
}
