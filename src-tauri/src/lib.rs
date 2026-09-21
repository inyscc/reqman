pub mod commands;
pub mod error;
pub mod interchange;
pub mod logging;
pub mod net;
pub mod secrets;
pub mod state;
pub mod storage;
pub mod url_util;
pub mod variables;

#[cfg(test)]
pub mod security_audit;
#[cfg(test)]
pub mod testutil;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// 主窗口允许导航到的目标。
///
/// 只放行应用自身的来源与承载沙箱预览的本地承载协议；任何外部来源一律拒绝
/// （spec: 存储访问边界 / 拒绝外部导航）。
pub fn is_allowed_navigation(url: &tauri::Url) -> bool {
    match url.scheme() {
        // 应用自身资源与 IPC
        "tauri" | "ipc" | "asset" => true,
        // 不可信响应预览：blob / data / about(srcdoc) 承载在 sandbox 化的 iframe 中
        "blob" | "data" | "about" => true,
        // 开发服务器：仅回环地址
        "http" | "https" => matches!(
            url.host_str(),
            Some("localhost") | Some("127.0.0.1") | Some("tauri.localhost") | Some("ipc.localhost")
        ),
        _ => false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logging::init_tracing();

    tauri::Builder::default()
        // dialog 插件只在 Rust 侧使用（pick_upload_file / backup_* / response_save_full
        // 内部发起系统对话框），不向前端授予 dialog 权限。
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 运行态：数据库、密钥来源、上传句柄与响应仓库
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("reqman"));
            app.manage(state::AppState::initialize(&data_dir)?);

            // 窗口在代码中创建，以便挂上导航守卫；tauri.conf.json 的 windows 为空。
            // decorations(false)：去掉原生标题栏，窗口 chrome 由页面承载
            // （change: add-in-page-window-controls）。
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("reqman")
                .inner_size(1280.0, 800.0)
                .decorations(false)
                .on_navigation(is_allowed_navigation)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::workspace_list,
            commands::workspace_active,
            commands::workspace_create,
            commands::workspace_rename,
            commands::workspace_delete,
            commands::workspace_set_active,
            commands::workspace_tree,
            commands::collection_tree,
            commands::collection_get,
            commands::collection_create,
            commands::collection_rename,
            commands::collection_delete,
            commands::collection_reorder,
            commands::folder_create,
            commands::folder_rename,
            commands::folder_get,
            commands::folder_delete,
            commands::folder_move,
            commands::children_reorder,
            commands::request_get,
            commands::request_create,
            commands::request_save,
            commands::request_duplicate,
            commands::request_delete,
            commands::request_move,
            commands::environment_list,
            commands::environment_active,
            commands::environment_create,
            commands::environment_rename,
            commands::environment_delete,
            commands::environment_set_active,
            commands::environment_set_proxy,
            commands::variable_list,
            commands::variable_set,
            commands::variable_delete,
            commands::variable_create,
            commands::variable_update,
            commands::variable_reorder,
            commands::secret_reveal,
            commands::globals_list,
            commands::globals_set,
            commands::settings_get,
            commands::settings_set,
            commands::global_proxy_get,
            commands::global_proxy_set,
            commands::cookie_list,
            commands::cookie_put,
            commands::cookie_delete,
            commands::cookie_query,
            commands::collection_set_script,
            commands::folder_set_script,
            commands::variables_preview,
            commands::send_request,
            commands::response_body_span,
            commands::pick_upload_file,
            commands::backup_export,
            commands::backup_restore,
            commands::response_save_full,
            commands::collection_export,
            commands::environment_export,
            commands::globals_export,
            commands::import_postman,
            commands::curl_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::is_allowed_navigation;

    fn url(raw: &str) -> tauri::Url {
        raw.parse().expect("合法 URL")
    }

    #[test]
    fn external_navigation_is_blocked() {
        for target in [
            "https://example.com",
            "http://evil.test/login",
            "https://github.com/",
        ] {
            assert!(
                !is_allowed_navigation(&url(target)),
                "外部来源应被阻止: {}",
                target
            );
        }
    }

    #[test]
    fn app_origins_are_allowed() {
        for target in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            "http://localhost:1420/",
            "http://127.0.0.1:1420/",
        ] {
            assert!(
                is_allowed_navigation(&url(target)),
                "应用自身来源应被放行: {}",
                target
            );
        }
    }

    #[test]
    fn sandboxed_preview_carriers_are_allowed() {
        for target in [
            "blob:http://localhost:1420/9f0c",
            "data:text/html,<p>hi</p>",
            "about:srcdoc",
        ] {
            assert!(
                is_allowed_navigation(&url(target)),
                "沙箱预览承载应被放行: {}",
                target
            );
        }
    }

    #[test]
    fn non_web_schemes_are_blocked() {
        for target in ["file:///etc/passwd", "ftp://example.com/x"] {
            assert!(
                !is_allowed_navigation(&url(target)),
                "非 web 协议应被阻止: {}",
                target
            );
        }
    }
}
