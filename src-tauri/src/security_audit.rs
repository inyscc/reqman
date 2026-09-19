//! 安全边界审计（任务 7.2）。
//!
//! 把「前端没有通用文件/网络能力」从纪律要求变成可回归断言：直接读取应用真实
//! 的权限清单、CSP 配置与命令注册表，任何一条被放宽都会让这些测试失败。

#![cfg(test)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read(relative: &str) -> String {
    let path = manifest_dir().join(relative);
    std::fs::read_to_string(&path).unwrap_or_else(|err| panic!("读取 {} 失败：{}", path.display(), err))
}

/// 前端被授予的权限清单。
fn granted_permissions() -> Vec<String> {
    let raw = read("capabilities/default.json");
    let value: serde_json::Value = serde_json::from_str(&raw).expect("capabilities 是合法 JSON");
    value["permissions"]
        .as_array()
        .expect("permissions 是数组")
        .iter()
        .map(|item| item.as_str().expect("权限是字符串").to_string())
        .collect()
}

/// 从命令注册表中抽出真正暴露给前端的命令名。
fn registered_commands() -> Vec<String> {
    let source = read("src/lib.rs");
    let mut names = Vec::new();
    for line in source.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("commands::") {
            let name: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            if !name.is_empty() {
                names.push(name);
            }
        }
    }
    names
}

#[test]
fn capabilities_grant_no_file_shell_or_network_ability() {
    let permissions = granted_permissions();
    assert!(!permissions.is_empty(), "权限清单不应为空");

    // roadmap 明确禁止的通用能力：任意文件读写、命令执行、任意 HTTP
    let forbidden_plugins = ["fs", "shell", "http", "process", "dialog", "opener", "os"];
    for permission in &permissions {
        let namespace = permission.split(':').next().unwrap_or_default();
        assert!(
            !forbidden_plugins.contains(&namespace),
            "不应向前端授予 {} 类能力（实际权限：{}）",
            namespace,
            permission
        );
    }

    // 只允许驱动界面所需的核心里程碑。
    //
    // `core:window:allow-destroy` 是「退出应用前的未保存处置」新增的唯一一项：
    // 拦截到关闭请求后若还有未保存的编辑，先 preventDefault 问用户，确认后才自行
    // destroy 窗口。`core:window:default` 并不包含它，而 `onCloseRequested` 在不
    // preventDefault 时会自行 destroy——不授予它反而会让窗口关不掉。
    //
    // `add-in-page-window-controls` 新增四项，全部只驱动窗口本身，不读文件、
    // 不发网络、不执行命令：
    // - allow-minimize / allow-toggle-maximize：页面内的最小化与最大化 / 还原按钮
    //   （toggleMaximize 一个入口覆盖两个方向，不需要 allow-maximize / allow-unmaximize 拆分）；
    // - allow-start-dragging：会话标签行的手动拖拽移动（`data-tauri-drag-region`
    //   对子元素不继承，行内空白是子元素，只能手动触发 startDragging）；
    // - allow-start-resize-dragging：decorations(false) 丢掉原生边缘缩放后，
    //   由窗口边缘的透明窄条经 startResizeDragging 恢复八方向缩放。
    // isMaximized 查询已由 core:window:default 覆盖（见 gen/schemas/desktop-schema.json）。
    let allowed = [
        "core:app:default",
        "core:event:default",
        "core:window:default",
        "core:webview:default",
        "core:window:allow-destroy",
        "core:window:allow-minimize",
        "core:window:allow-toggle-maximize",
        "core:window:allow-start-dragging",
        "core:window:allow-start-resize-dragging",
    ];
    for permission in &permissions {
        assert!(
            allowed.contains(&permission.as_str()),
            "出现了未在审计白名单中的权限：{}",
            permission
        );
    }
}

#[test]
fn no_path_resolution_permission_is_granted() {
    for permission in granted_permissions() {
        assert!(
            !permission.contains("core:path"),
            "不应向前端授予路径解析能力：{}",
            permission
        );
    }
}

#[test]
fn generated_capability_manifest_matches_the_audited_set() {
    // gen/schemas/capabilities.json 是构建期由 Tauri 生成的真实清单，
    // 直接检查它，避免只审计源文件而与实际生效的权限脱节。
    let raw = read("gen/schemas/capabilities.json");
    let value: serde_json::Value = serde_json::from_str(&raw).expect("能力清单是合法 JSON");

    let mut effective = BTreeSet::new();
    if let Some(map) = value.as_object() {
        for capability in map.values() {
            if let Some(permissions) = capability["permissions"].as_array() {
                for permission in permissions {
                    if let Some(text) = permission.as_str() {
                        effective.insert(text.to_string());
                    }
                }
            }
        }
    }

    assert!(!effective.is_empty(), "生成的能力清单不应为空");
    for permission in &effective {
        assert!(
            !permission.starts_with("fs:")
                && !permission.starts_with("shell:")
                && !permission.starts_with("http:")
                && !permission.starts_with("dialog:")
                && !permission.starts_with("opener:")
                && !permission.starts_with("process:"),
            "生成清单里出现了不该有的能力：{}",
            permission
        );
    }
}

/// 把 CSP 字符串解析成 指令 → 来源列表。
fn csp_directives(csp: &str) -> BTreeMap<String, Vec<String>> {
    let mut out = BTreeMap::new();
    for directive in csp.split(';') {
        let tokens: Vec<String> = directive
            .split_whitespace()
            .map(|token| token.to_string())
            .collect();
        if tokens.is_empty() {
            continue;
        }
        out.insert(tokens[0].clone(), tokens[1..].to_vec());
    }
    out
}

#[test]
fn content_security_policy_is_enabled_and_restrictive() {
    let raw = read("tauri.conf.json");
    let value: serde_json::Value = serde_json::from_str(&raw).expect("配置是合法 JSON");
    let security = &value["app"]["security"];

    let csp = security["csp"].as_str().expect("生产 CSP 必须被设置");
    let directives = csp_directives(csp);
    let sources = |name: &str| -> Vec<String> { directives.get(name).cloned().unwrap_or_default() };

    // -- 逐指令核对实际取值（9.1）：任何放宽或改动都会在这里失败 --------------
    assert_eq!(
        sources("default-src"),
        vec!["'self'"],
        "default-src 应只允许自身：{:?}",
        directives.get("default-src")
    );

    // script-src 必须是恰好这三项：
    // - 'self'：应用自身的脚本（Tauri 会再注入 nonce/hash）
    // - 'unsafe-eval'：**沙箱的硬性要求**——用户脚本跑在 blob Worker 里，uniscope 用
    //   eval/Function 编译脚本（design「其五」），而 1.3 已实测 Worker 继承文档 CSP，
    //   没有 unsafe-eval 生产构建里所有脚本都会静默失败。
    //   代价是主文档也放开了 eval；缓解：无远程脚本来源 + 命令面审计。
    //   （原先还列了 freezePrototype，已按 design D17 关闭：它与沙箱宿主侧不相容。）
    assert_eq!(
        sources("script-src"),
        vec!["'self'", "'unsafe-eval'"],
        "script-src 应恰好为 self + unsafe-eval（沙箱 eval 的硬性要求）：{:?}",
        directives.get("script-src")
    );

    // connect-src 是「沙箱逃逸后的最后一道墙」（D3）：除自身与 Tauri IPC 入口外
    // 不得出现任何来源，也绝不允许通配
    assert_eq!(
        sources("connect-src"),
        vec!["'self'", "ipc:", "http://ipc.localhost"],
        "connect-src 应只允许自身与 IPC 入口：{:?}",
        directives.get("connect-src")
    );

    assert_eq!(
        sources("worker-src"),
        vec!["'self'", "blob:"],
        "worker-src 必须允许 blob:（脚本沙箱的 Worker）：{:?}",
        directives.get("worker-src")
    );
    assert_eq!(
        sources("frame-src"),
        vec!["'self'", "data:", "blob:"],
        "frame-src 必须允许 data:/blob:（响应预览的隔离承载）：{:?}",
        directives.get("frame-src")
    );

    for directive in ["object-src", "base-uri", "form-action", "frame-ancestors"] {
        assert_eq!(
            sources(directive),
            vec!["'none'"],
            "{} 应为 'none'：{:?}",
            directive,
            directives.get(directive)
        );
    }

    // 任何来源列表里都不允许通配或远程 http(s) 来源（connect-src 的 ipc 除外，
    // 它是 Tauri 的固定 IPC 入口）
    for (directive, sources) in &directives {
        for source in sources {
            assert!(!source.contains('*'), "{} 不应含通配来源：{}", directive, source);
            if directive != "connect-src" {
                assert!(
                    !(source.starts_with("http://") || source.starts_with("https://")),
                    "{} 不应出现远程来源：{}",
                    directive,
                    source
                );
            }
        }
    }
    assert!(
        !csp.contains("script-src 'self' 'unsafe-inline'"),
        "生产 CSP 不应放开内联脚本：{}",
        csp
    );

    // -- 开发 CSP：允许热更新通道，但只存在于开发配置 -------------------------
    let dev_csp = security["devCsp"].as_str().expect("开发 CSP 必须被设置");
    assert!(
        dev_csp.contains("ws://localhost:1420"),
        "开发 CSP 需要放行 Vite 的热更新通道：{}",
        dev_csp
    );
    // 开发专用来源不得泄漏进生产 CSP（注意 ipc.localhost 是 Tauri 的固定入口，
    // 不在禁止之列；要挡的是开发服务器的来源与热更新通道）
    assert!(
        !csp.contains("localhost:1420") && !csp.contains("ws:"),
        "生产 CSP 不应包含开发期的本地/热更新来源：{}",
        csp
    );

    // freezePrototype：这里**刻意不按值断言**（design D17）。
    //
    // 它原先断言 `== true`（「应冻结原型以降低原型污染风险」）。实测证明这条设置与沙箱
    // 宿主侧不相容：Tauri 把它实现为文档起点的 `Object.freeze(Object.prototype)`，而
    // `postman-sandbox` 宿主侧的 lodash 4.18.1 在引导阶段要把自身方法拷进一个新建的普通
    // 对象（`source[methodName] = func`，其中一轮正是 `toString`）——ESM 严格模式下抛
    // `Cannot assign to read only property 'toString' of object '#<Object>'`，整个沙箱
    // chunk 求值失败、脚本功能完全不可用。也就是说，按值断言「为真」恰好把一条会让功能
    // 失效的设置钉成了「正确」。
    //
    // 现在断言的是不变量：这个开关必须被**显式取值**，且它的取值由浏览器用例与真机环境
    // 共同钉住（见 `every_document_start_injection_is_pinned_by_a_browser_case`；把
    // freezePrototype 改回 true 会让 tests-browser/host-injection.spec.ts 变红）。
    assert!(
        security["freezePrototype"].as_bool().is_some(),
        "app.security.freezePrototype 必须显式取值：影响主文档执行环境的开关不能缺省"
    );
    assert_eq!(
        security["dangerousDisableAssetCspModification"].as_bool(),
        Some(false),
        "不应关闭 Tauri 的 CSP 注入"
    );
}

#[test]
fn window_is_created_in_code_so_the_navigation_guard_applies() {
    let raw = read("tauri.conf.json");
    let value: serde_json::Value = serde_json::from_str(&raw).expect("配置是合法 JSON");
    let windows = value["app"]["windows"]
        .as_array()
        .expect("windows 是数组");
    assert!(
        windows.is_empty(),
        "窗口应在代码中创建，才能挂上导航守卫（见 lib.rs 的 setup）"
    );

    let source = read("src/lib.rs");
    assert!(
        source.contains("on_navigation(is_allowed_navigation)"),
        "主窗口必须挂上导航守卫"
    );
}

#[test]
fn no_generic_file_or_shell_command_is_exposed() {
    let commands = registered_commands();
    assert!(!commands.is_empty(), "应能解析出命令注册表");

    // roadmap 明确要求禁止暴露的通用能力
    let forbidden = [
        "read_file",
        "write_file",
        "execute_command",
        "generic_http",
        "run_command",
        "spawn",
        "open_path",
    ];
    for name in &commands {
        assert!(
            !forbidden.contains(&name.as_str()),
            "不应暴露通用能力命令：{}",
            name
        );
    }

    // 命令名必须是具名的领域能力，不能是泛化入口
    for name in &commands {
        assert!(
            !name.ends_with("_raw") && !name.contains("any_") && !name.contains("arbitrary"),
            "命令名过于泛化：{}",
            name
        );
    }
}

#[test]
fn the_command_surface_is_the_audited_one() {
    let commands: BTreeSet<String> = registered_commands().into_iter().collect();

    // 本变更声明的能力入口，逐条核对（design D18 + 只读查询命令）
    let expected = [
        "workspace_list",
        "workspace_active",
        "workspace_create",
        "workspace_rename",
        "workspace_delete",
        "workspace_set_active",
        "workspace_tree",
        "collection_tree",
        // 只读查询：取回集合实体本身（集合级脚本挂在实体上，树形接口不给）。
        // 不写、不发网络请求，不引入新的能力类别。
        "collection_get",
        "collection_create",
        "collection_rename",
        "collection_delete",
        "collection_reorder",
        "folder_create",
        "folder_rename",
        // 只读查询：取回文件夹实体本身（文件夹级脚本挂在实体上），理由同上。
        "folder_get",
        "folder_delete",
        "folder_move",
        "children_reorder",
        "request_get",
        "request_create",
        "request_save",
        "request_duplicate",
        "request_delete",
        "request_move",
        "environment_list",
        "environment_active",
        "environment_create",
        "environment_rename",
        "environment_delete",
        "environment_set_active",
        "environment_set_proxy",
        "variable_list",
        "variable_set",
        "variable_delete",
        "secret_reveal",
        "globals_list",
        "globals_set",
        "settings_get",
        "settings_set",
        "global_proxy_get",
        "global_proxy_set",
        // Cookie 手动管理：都是具名的领域能力，不引入通用文件或网络入口；
        // 取值落库仍是密文（spec: Cookie 的持久化与加密）
        "cookie_list",
        "cookie_put",
        "cookie_delete",
        "cookie_query",
        "collection_set_script",
        "folder_set_script",
        "variables_preview",
        "send_request",
        "response_body_span",
        "pick_upload_file",
        "backup_export",
        "backup_restore",
        "response_save_full",
        // 导入导出：都不接受前端传入的路径。
        // 导入的两种来源是「粘贴文本」与「一次性文件句柄」；导出的去向由后端
        // 拉起系统保存对话框取得（spec: 导入来源与访问边界）。因此它们没有为
        // 前端新增任何通用文件或网络能力。
        "collection_export",
        "environment_export",
        "globals_export",
        "import_postman",
        // curl 导出：只把命令文本交给界面，不写文件、不发起网络请求
        "curl_export",
    ];

    for name in expected {
        assert!(
            commands.contains(name),
            "命令面缺少声明的入口：{}",
            name
        );
    }
    assert_eq!(
        commands.len(),
        expected.len(),
        "命令面出现了未经审计的新入口：{:?}",
        commands
            .iter()
            .filter(|name| !expected.contains(&name.as_str()))
            .collect::<Vec<_>>()
    );
}

// ---------------------------------------------------------------------------
// 任务 9.2：脚本沙箱的边界审计
// ---------------------------------------------------------------------------

/// 宿主桥的出口集合（`scriptRuntime.ts` 的 `BRIDGE_EVENTS`）——
/// 桥是脚本对外的唯一通道，出口必须是这份有限具名集合的成员。
const AUDITED_BRIDGE_EVENTS: &[(&str, &str)] = &[
    ("console", "console: 'console',"),
    ("assertion", "assertion: 'execution.assertion',"),
    (
        "sendRequest",
        "sendRequest: (executionId: string) => `execution.request.${executionId}`,",
    ),
    (
        "cookies",
        "cookies: (executionId: string) => `execution.cookies.${executionId}`,",
    ),
];

/// Cookie 仓库允许的 Store 方法（`scriptRuntime.ts` 的 `COOKIE_STORE_METHODS`）。
const AUDITED_COOKIE_STORE_METHODS: &str = "const COOKIE_STORE_METHODS = Object.freeze([
  'findCookie',
  'findCookies',
  'putCookie',
  'updateCookie',
  'removeCookie',
  'removeCookies',
  'getAllCookies',
  'removeAllCookies',
] as const);";

/// 桥的出口集合是有限的具名集合，且宿主只为它们注册处理分支。
#[test]
fn the_bridge_exit_set_is_the_audited_one() {
    let source = read("../src/lib/scriptRuntime.ts");

    // BRIDGE_EVENTS 里恰好是审计过的四个出口
    for (name, declaration) in AUDITED_BRIDGE_EVENTS {
        assert!(
            source.contains(declaration),
            "桥出口 {} 的声明与审计不一致（或被改名）：应包含 {}",
            name,
            declaration
        );
    }

    // 宿主的每一个 context.on(...) 都必须是这四个出口之一——不允许通配、
    // 不允许额外的处理分支（1.2：uvm 宿主侧不过滤事件名，边界由这里守）
    let audited_registrations: BTreeSet<String> = [
        "BRIDGE_EVENTS.console",
        "BRIDGE_EVENTS.assertion",
        "BRIDGE_EVENTS.sendRequest(executionId)",
        "BRIDGE_EVENTS.cookies(executionId)",
    ]
    .iter()
    .map(|name| name.to_string())
    .collect();

    let mut registered = BTreeSet::new();
    let mut cursor = source.as_str();
    while let Some(position) = cursor.find("context.on(") {
        let rest = &cursor[position + "context.on(".len()..];
        let first_argument = rest.split(',').next().unwrap_or_default().trim();
        registered.insert(first_argument.to_string());
        cursor = rest;
    }

    assert!(!registered.is_empty(), "应能解析出桥的处理分支");
    for registration in &registered {
        assert!(
            audited_registrations.contains(registration),
            "桥出现了未经审计的处理分支：{}",
            registration
        );
    }

    // Cookie 仓库的方法白名单逐字核对
    assert!(
        source.contains(AUDITED_COOKIE_STORE_METHODS),
        "Cookie 仓库的方法白名单与审计不一致"
    );
}

/// 脚本运行时不得给前端新增任何通用网络能力；脚本的一切出站都只能经
/// 具名命令进入 Rust（design D1 / D3）。
#[test]
fn the_script_runtime_adds_no_general_network_ability() {
    let source = read("../src/lib/scriptRuntime.ts");

    for forbidden in [
        "fetch(",
        "XMLHttpRequest",
        "new WebSocket",
        "EventSource",
        "sendBeacon",
        "navigator.",
    ] {
        assert!(
            !source.contains(forbidden),
            "脚本运行时不应出现通用网络原语：{}",
            forbidden
        );
    }

    // 唯一的外部依赖是沙箱模块本身，且必须是动态 import（见下一条审计）
    assert!(
        source.contains("await import('postman-sandbox')"),
        "沙箱必须经动态 import 装载"
    );
}

/// 沙箱必须保持**动态 import**：静态 import 会把它连同一批浏览器 polyfill 塞进启动模块图，
/// 入口 chunk 从约 282 KB 涨到约 3.43 MB——这份代码只有真正执行脚本时才需要，也不该出现在
/// 启动路径上（纵深）。
///
/// 原先的理由「静态 import 会让 Tauri 初始化失效、应用黑屏（1.5 的实机结论）」**已更正**
/// （2026-09-17 复核）：那轮黑屏的真正原因是主文档原型被 `freezePrototype` 冻结、该 chunk
/// 在**求值期**抛错、应用根本没挂载，与静态 import 无关；关掉冻结原型后，静态 import 的产物
/// 在 WebView2 上启动、IPC 与脚本执行全部正常（design D17）。审计保留——它守的是体积与
/// 「沙箱不进启动图」，不再靠「否则黑屏」这个理由。真机侧的对照见
/// `probes/webview2-smoke.mjs` 的入口体积判据。
#[test]
fn the_sandbox_is_not_in_the_startup_module_graph() {
    let source = read("../src/lib/scriptRuntime.ts");

    for line in source.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("import ") && trimmed.contains("'postman-sandbox'") {
            assert!(
                trimmed.starts_with("import type"),
                "postman-sandbox 只能以 import type（编译期擦除）或动态 import 出现，\
                 发现静态导入：{}",
                trimmed
            );
        }
    }
}

/// 响应预览与脚本沙箱是**两条方向相反的隔离边界**（9.2 / design D9）：
/// 预览的 sandbox iframe 必须保持不授予任何允许项（尤其不得出现 allow-scripts）。
/// 引擎级行为由 tests-browser/sandbox.spec.ts 运行时验证，这里守源码层面的开关。
#[test]
fn the_response_preview_stays_script_free() {
    // 承载函数不得出现带引号的 allow-scripts 授权（注释里的文字不算）
    let sandbox_source = read("../src/lib/sandbox.ts");
    assert!(
        !sandbox_source.contains("\"allow-scripts\"") && !sandbox_source.contains("'allow-scripts'"),
        "预览承载不得授予 allow-scripts"
    );

    let panel_source = read("../src/components/ResponsePanel.tsx");
    assert!(
        panel_source.contains("sandbox=\"\""),
        "预览 iframe 必须保持空 sandbox 属性"
    );

    // 运行时行为的验证用例必须存在：其用例矩阵是「sandbox 为空 → 脚本不执行、
    // 无法逃逸」加上「授予 allow-scripts → 脚本执行」的正对照
    let spec = read("../tests-browser/sandbox.spec.ts");
    assert!(
        spec.contains("hostPage(PAYLOAD, '')"),
        "预览隔离用例必须保留「sandbox 为空」的运行时验证"
    );
    assert!(
        spec.contains("script-ran") && spec.contains("toEqual([])"),
        "预览隔离用例必须保留「脚本未执行」的行为断言"
    );
}

// ---------------------------------------------------------------------------
// 任务 9.8 / 9.9：文档起点注入项必须被浏览器用例钉住
// ---------------------------------------------------------------------------

/// 浏览器用例（`tests-browser/*.spec.ts`）的源码，按文件名排序。
fn browser_specs() -> Vec<(String, String)> {
    let dir = manifest_dir().join("../tests-browser");
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|err| panic!("读取 {} 失败：{}", dir.display(), err))
        .map(|entry| entry.expect("目录项可读").path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("ts"))
        .collect();
    paths.sort();

    assert!(!paths.is_empty(), "应存在浏览器用例（tests-browser/*.spec.ts）");

    paths
        .into_iter()
        .map(|path| {
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            let source = std::fs::read_to_string(&path)
                .unwrap_or_else(|err| panic!("读取 {} 失败：{}", path.display(), err));
            (name, source)
        })
        .collect()
}

/// 凡是**影响主文档执行环境**的注入项，都必须有一条浏览器用例**从 `tauri.conf.json` 读它**
/// 并在真浏览器里复现（design D17）。
///
/// 断言的是「耦合」而不是取值，这是本条的重点：按值断言某条配置「为真」曾经恰好把一条会让
/// 脚本功能完全失效的设置（`freezePrototype`）钉成了「正确」。真正要守的是「配置怎么变，
/// 都有一条用例会在它把功能弄坏时变红」，所以这里检查的是「有一份用例同时读了配置与这个键」。
#[test]
fn every_document_start_injection_is_pinned_by_a_browser_case() {
    let specs = browser_specs();

    // 当前影响主文档执行环境的注入项。新增同类开关（Tauri 的文档起点注入、注入的 CSP
    // 指令、原型冻结…）时必须同时补一条浏览器用例，否则这里会失败。
    for key in ["csp", "freezePrototype"] {
        let pinned = specs
            .iter()
            .any(|(_, source)| source.contains("tauri.conf.json") && source.contains(key));

        assert!(
            pinned,
            "没有任何浏览器用例同时读取 `tauri.conf.json` 与 `{}`：该注入项没有被钉住，\
             配置被改坏时不会有人拦住（design D17）。已有用例：{:?}",
            key,
            specs.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>()
        );
    }
}
