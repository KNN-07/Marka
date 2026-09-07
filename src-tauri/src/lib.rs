mod external_links;
mod mdx;
mod output;
mod session;
mod workspace;

use session::{AppState, RestoredSession, Session};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use workspace::{AppError, FileEntry, FileSnapshot, Result, SearchResult, Workspace};

type SharedState = Arc<Mutex<AppState>>;
#[derive(Default)]
struct ExitLatch(AtomicBool);

async fn blocking<T: Send + 'static>(
    state: SharedState,
    operation: impl FnOnce(&mut AppState) -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut state = state.lock().map_err(|_| {
            AppError::new(
                "IO",
                "Workspace state is unavailable after an internal error. Restart Marka.",
            )
        })?;
        operation(&mut state)
    })
    .await
    .map_err(|e| AppError::new("IO", format!("Filesystem operation failed: {e}")))?
}
#[tauri::command]
async fn choose_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<Option<Workspace>> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut picker = app.dialog().file().set_title("Open workspace");
        if let Some(window) = app.get_webview_window("main") {
            picker = picker.set_parent(&window);
        }
        let Some(path) = picker.blocking_pick_folder() else {
            return Ok(None);
        };
        let path = path
            .into_path()
            .map_err(|e| AppError::new("INVALID_PATH", e.to_string()))?;
        let mut state = state
            .lock()
            .map_err(|_| AppError::new("IO", "Workspace state is unavailable."))?;
        let workspace = state.select_workspace(&path)?;
        Ok(Some(workspace))
    })
    .await
    .map_err(|e| AppError::new("IO", e.to_string()))?
}
#[tauri::command]
async fn restore_session(state: tauri::State<'_, SharedState>) -> Result<RestoredSession> {
    blocking(state.inner().clone(), |s| Ok(s.restore())).await
}
#[tauri::command]
async fn list_directory(
    state: tauri::State<'_, SharedState>,
    workspace_id: String,
    path: String,
) -> Result<Vec<FileEntry>> {
    blocking(state.inner().clone(), move |s| {
        s.workspace.list(&workspace_id, &path)
    })
    .await
}
#[tauri::command]
async fn read_document(
    state: tauri::State<'_, SharedState>,
    workspace_id: String,
    path: String,
) -> Result<FileSnapshot> {
    blocking(state.inner().clone(), move |s| {
        s.workspace.read(&workspace_id, &path)
    })
    .await
}
#[tauri::command]
async fn write_document(
    state: tauri::State<'_, SharedState>,
    workspace_id: String,
    path: String,
    text: String,
    expected_revision: Option<String>,
) -> Result<FileSnapshot> {
    blocking(state.inner().clone(), move |s| {
        s.workspace
            .write(&workspace_id, &path, &text, expected_revision.as_deref())
    })
    .await
}
#[tauri::command]
async fn create_directory(
    state: tauri::State<'_, SharedState>,
    workspace_id: String,
    path: String,
) -> Result<()> {
    blocking(state.inner().clone(), move |s| {
        s.workspace.mkdir(&workspace_id, &path)
    })
    .await
}
#[tauri::command]
async fn search_workspace(
    state: tauri::State<'_, SharedState>,
    workspace_id: String,
    query: String,
    case_sensitive: bool,
) -> Result<SearchResult> {
    blocking(state.inner().clone(), move |s| {
        s.workspace.search(&workspace_id, &query, case_sensitive)
    })
    .await
}
#[tauri::command]
async fn read_asset(
    state: tauri::State<'_, SharedState>,
    workspace_id: String,
    path: String,
) -> Result<tauri::ipc::Response> {
    blocking(state.inner().clone(), move |s| {
        s.workspace
            .asset(&workspace_id, &path)
            .map(tauri::ipc::Response::new)
    })
    .await
}
#[tauri::command]
async fn save_session(
    state: tauri::State<'_, SharedState>,
    session: Session,
    workspace_id: Option<String>,
) -> Result<()> {
    blocking(state.inner().clone(), move |s| {
        s.save(session, workspace_id.as_deref())
    })
    .await
}
#[tauri::command]
fn complete_exit(app: tauri::AppHandle, latch: tauri::State<'_, ExitLatch>) {
    latch.0.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command]
async fn resolve_mdx_module(
    state: tauri::State<'_, SharedState>,
    workspace_id: String,
    entry_path: String,
    importer_path: Option<String>,
    specifier: String,
) -> Result<mdx::MdxModule> {
    blocking(state.inner().clone(), move |s| {
        s.resolve_mdx_module(
            &workspace_id,
            &entry_path,
            importer_path.as_deref(),
            &specifier,
        )
    })
    .await
}
#[tauri::command]
async fn run_mdx(
    state: tauri::State<'_, SharedState>,
    workspace_id: String,
    path: String,
    payload: mdx::MdxRunPayload,
) -> Result<()> {
    blocking(state.inner().clone(), move |s| {
        s.run_mdx(&workspace_id, path, payload)
    })
    .await
}
#[tauri::command]
async fn stop_mdx(state: tauri::State<'_, SharedState>) -> Result<()> {
    blocking(state.inner().clone(), |s| s.mdx_runtime.stop()).await
}
#[tauri::command]
async fn mdx_runtime_status(state: tauri::State<'_, SharedState>) -> Result<mdx::MdxRuntimeStatus> {
    blocking(state.inner().clone(), |s| s.mdx_runtime.status()).await
}

#[cfg(target_os = "macos")]
fn install_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem as Native, Submenu};
    let quit = MenuItem::with_id(app, "marka-quit", "Quit Marka", true, Some("CmdOrCtrl+Q"))?;
    let print = MenuItem::with_id(app, "marka-print", "Print…", true, Some("CmdOrCtrl+P"))?;
    let file = Submenu::with_items(app, "File", true, &[&print])?;
    let application = Submenu::with_items(
        app,
        "Marka",
        true,
        &[
            &Native::about(app, Some("About Marka"), None)?,
            &Native::separator(app)?,
            &Native::services(app, None)?,
            &Native::separator(app)?,
            &Native::hide(app, None)?,
            &Native::hide_others(app, None)?,
            &Native::show_all(app, None)?,
            &Native::separator(app)?,
            &quit,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &Native::undo(app, None)?,
            &Native::redo(app, None)?,
            &Native::separator(app)?,
            &Native::cut(app, None)?,
            &Native::copy(app, None)?,
            &Native::paste(app, None)?,
            &Native::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&Native::minimize(app, None)?, &Native::maximize(app, None)?],
    )?;
    app.set_menu(Menu::with_items(
        app,
        &[&application, &file, &edit, &window],
    )?)?;
    app.on_menu_event(|app, event| {
        if event.id().as_ref() == "marka-quit" {
            let _ = app.emit_to("main", "marka://exit-requested", ());
        }
        if event.id().as_ref() == "marka-print" {
            if let Some(window) = app.webview_windows().values().find(|window| {
                window.label().starts_with("print-") && window.is_focused().unwrap_or(false)
            }) {
                // App-owned event keeps font/image readiness and error handling in the print UI.
                let _ = window.eval("window.dispatchEvent(new Event('marka:print'))");
            } else {
                let _ = app.emit_to("main", "marka://print-requested", ());
            }
        }
    });
    Ok(())
}

pub fn run() {
    if mdx::runtime_mode() {
        return;
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .manage(ExitLatch::default())
        .setup(|app| {
            let path = app.path().app_local_data_dir()?.join("session.json");
            app.manage(Arc::new(Mutex::new(AppState::new(path))));
            #[cfg(target_os = "macos")]
            install_menu(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && !window.state::<ExitLatch>().0.load(Ordering::SeqCst)
                {
                    api.prevent_close();
                    let _ = window.emit("marka://exit-requested", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            choose_workspace,
            restore_session,
            list_directory,
            read_document,
            write_document,
            create_directory,
            search_workspace,
            read_asset,
            save_session,
            complete_exit,
            resolve_mdx_module,
            run_mdx,
            stop_mdx,
            mdx_runtime_status,
            external_links::open_external_link,
            output::save_export,
            output::open_print_document,
            output::print_current
        ])
        .build(tauri::generate_context!())
        .expect("Unable to initialize Marka desktop application");
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            if let Ok(mut state) = app.state::<SharedState>().lock() {
                let _ = state.mdx_runtime.stop();
            }
        }
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if !app.state::<ExitLatch>().0.load(Ordering::SeqCst) {
                api.prevent_exit();
                let _ = app.emit_to("main", "marka://exit-requested", ());
            }
        }
    });
}
