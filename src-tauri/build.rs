fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "choose_workspace",
            "restore_session",
            "list_directory",
            "read_document",
            "write_document",
            "create_directory",
            "search_workspace",
            "read_asset",
            "save_session",
            "complete_exit",
            "save_export",
            "open_print_document",
            "print_current",
            "open_external_link",
            "resolve_mdx_module",
            "run_mdx",
            "stop_mdx",
            "mdx_runtime_status",
        ]),
    ))
    .expect("failed to build Marka application manifest");
}
