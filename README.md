# reqman

离线、本地优先的 API 客户端（Tauri v2 + Rust + React）。前端只做界面，网络、文件、数据库、密钥全部在 Rust 侧。

- 需求书：`rodemap`
- 已交付能力的规格：`openspec/specs/`；进行中的变更：`openspec/changes/add-postman-io/`（已归档的在 `openspec/changes/archive/`）

## 环境要求

- Rust 工具链与 Cargo（SQLite 以 bundled 方式编译，需要 C 编译器）
- Node 22+ 与 npm
- Linux 还需要：`webkit2gtk-4.1`、`gtk+-3.0`、`libsoup-3.0`
- 网络层测试会用 `openssl` 现场签发一张自签证书，需系统存在 `openssl` CLI

## 运行

```bash
npm install

npm run tauri dev     # 开发模式，需要图形会话
npm run tauri build   # 打包，交付目标是 Windows 安装包
npx tauri build --no-bundle   # 只出可执行文件（跳过打包步骤，冒烟用）
```

打包步骤会从 GitHub 拉取 WiX / NSIS 工具链，**直连不到 GitHub 的网络里会以超时失败**（表现为
`Downloading https://github.com/wixtoolset/...` 长时间没有进展）。这类网络可以指定镜像：

```powershell
$env:TAURI_BUNDLER_TOOLS_GITHUB_MIRROR = 'https://ghproxy.net/'
npx tauri build --bundles nsis
```

（本次在 Windows 上就是用它产出 `reqman_0.1.0_x64-setup.exe` 的：NSIS 3.11 与
`nsis_tauri_utils` 均取自该第三方镜像，**没有做校验和比对**——介意的话请在可信网络里用官方源重打一次。）

## 发布

推一个 `v*` 标签即触发 `.github/workflows/release.yml`：在 Windows runner 上构建 NSIS 与 MSI，
并创建一个**草稿** Release 把安装包附上去，人工确认后再 Publish。

```bash
# 三处版本号必须是同一个值（流水线第一步会校验，不一致直接失败）：
#   package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml
git tag v0.1.1
git push origin v0.1.1
```

在 Actions 页面手动触发同一条流水线时**只构建、不创建 Release**，产物留成 artifact，
用于正式打标签前先验证流水线本身。

Release 默认是草稿（`releaseDraft: true`）；要改成推标签即公开，把该行改成 `false`。
安装包未做代码签名，用户首次运行会看到 SmartScreen 的「未知发布者」提示，点「仍要运行」即可通过。

## 测试

前端与后端分开跑，两条命令互不依赖，也不需要先启动应用。

```bash
npm test                              # 前端：store、沙箱预览、界面
cd src-tauri && cargo test --lib      # 后端：存储、密钥、变量、网络
```

后端测试自带本地 HTTP 测试服务器与自签证书的 HTTPS 服务器，**不需要外部网络**。

需要真实浏览器引擎的隔离验证另有一条：

```bash
npm run test:browser
```

浏览器按「Playwright 自带 Chromium → 本机 Chrome → 本机 Edge」的顺序选取（见
`tests-browser/browser.ts`）：装了 Chrome / Edge 就能直接跑，不必先下载；要复现与交付基线
一致的环境再执行 `npx playwright install chromium`。

其他检查：

```bash
npx tsc --noEmit                            # 类型检查
npm run build                               # tsc + vite build
openspec validate add-postman-io --strict   # 规划产物一致性
```

## 目录结构

- `src-tauri/src/` — Rust 侧：`storage`（SQLite 与迁移）、`secrets`（设备密钥与 AEAD）、`variables`（解析引擎）、`net`（请求执行）、`commands.rs`（命令面）、`security_audit.rs`（安全边界的可回归断言）
- `src/` — 界面。不直连存储与网络，全部经 `src/lib/commands.ts` 里的具名命令；数据流为乐观更新 + 后端确认为准
- `openspec/` — 规划产物：`specs/`（已交付能力）、`changes/`（进行中的变更，已归档的在其 `archive/` 下）

## 已知限制

- **无法强制 HTTP/2**：依赖镜像没有 `h2 >= 0.4.14`，reqwest 的 `http2` 特性装不上。请求设置为 HTTP/2 时会显式降级并记录警告，响应里会给出实际协商到的协议版本。
- **需要图形会话才能验证的部分**：webview 的热更新，以及系统文件/保存对话框（`pick_upload_file`、`backup_export`、`backup_restore`、`response_save_full`）。这些命令的下层逻辑都有测试覆盖，对话框那一跳只经过编译验证——因为路径从不来自前端，由后端拉起系统对话框取得。
- **交付目标是 Windows 安装包，但日常验证并不总在 Windows 上跑**：Windows 的构建与冒烟需要在 Windows 机器或 CI runner 上单独安排，不是常态环节。**这条限制已经付过一次代价**：集合树与变量表格的拖拽在 Windows 桌面壳里整个失效——按住一个请求拖动，没有落点指示、松手什么也不发生——而 Linux 与全部浏览器用例一直是绿的。根因不在前端：主窗口在代码里创建时没有关掉 Tauri 的拖放处理器，Windows/WebView2 下 wry 会撤掉 WebView2 子窗口自己的 OLE 拖放目标、换上只认文件的那个，于是页面内的 HTML5 拖拽根本到不了 DOM。修法是 `src-tauri/src/lib.rs` 窗口 builder 链上的 `disable_drag_drop_handler()`，`security_audit.rs` 有断言守着这一行（摘掉它 `cargo test` 会红）。**代价：应用不再接收文件拖入**（往窗口里拖一个文件无任何反应）——当前没有任何功能依赖它，导入只经系统对话框。教训是这类"只在某个平台的宿主里存在"的缺陷 Chrome 用例喂不到，只能靠真机冒烟；变更记录见 `openspec/changes/fix-html5-dnd-in-tauri-shell/`。
- **数据库迁移只向前**：schema 迁移按 `user_version` 单向推进，不提供回退。引入新迁移后，旧版本应用不再保证能读该数据库。**变量表在 `user_version` 4 被重建过**（去掉 `(scope, owner_id, name)` 的唯一约束以支持同名共存，并新增启用 / 描述 / 顺序三列；变更见 `openspec/changes/rework-collection-tree-and-variable-model/`）：迁移为既有变量补上「全部启用 + 描述为空 + 按名称排序」，取值与 secret 标记原样保留，因此**降级到旧版本后该表不可用、也没有自动还原路径**——需要回退时请从 `backup_export` 的备份恢复。
- **curl 导出可能含 secret 明文**：curl 是「拿去直接跑」的命令，按设计取变量解析后的真实取值，因此引用 secret 变量时命令里是明文（命令只随返回值交给界面，不写入日志）。界面会就此给出提示。
- **脚本 console 的 secret 掩码是取值匹配，可被绕过**：脚本读到的 secret 是明文，界面上的脚本输出按「取值匹配」替换为掩码——脚本做一次编码变换（如 base64）即可让明文不出现原样。这只挡无意泄漏，不承诺挡住有意外发；真正的防线是脚本执行门禁与 `pm.sendRequest` 的目标策略。
- **Cookie 的作用域是应用级、按域共享**：Cookie 不随工作区分区。在同一目标域获得的登录态，切换工作区后依然有效（界面有明确标注）；这在多工作区隔离的预期上可能反直觉，属有意设计。
- **生产 CSP 包含 `'unsafe-eval'`**：脚本沙箱靠 eval/Function 编译用户脚本，而沙箱的 blob Worker 继承文档 CSP——没有它，生产构建里所有脚本静默失效。代价是主文档也放开了 eval；缓解靠脚本来源限制与命令面审计（原计划的原型冻结已关闭，原因见下一条）。
- **已关闭 `freezePrototype`（原型冻结）**：Tauri 把该配置实现为在主文档**文档起点**注入 `Object.freeze(Object.prototype)`，而脚本沙箱的**宿主侧**（`postman-sandbox` 打包的 lodash 4.18.1）在引导阶段要往一个新建的普通对象上拷 `toString`；冻结后那次赋值在 ESM 严格模式下直接抛 `TypeError: Cannot assign to read only property 'toString' of object '#<Object>'`——沙箱模块无法求值，**脚本功能会完全不可用**（复现步骤见 `openspec/changes/archive/2026-09-17-add-pm-script-runtime/design.md` 的 D17）。因此本应用不开启它，代价是少一层针对原型污染的纵深；真正的边界是脚本执行门禁、`pm.sendRequest` 的目标策略与宿主桥的出口校验。`tests-browser/host-injection.spec.ts` 按配置镜像这一注入——一旦有人把它改回 `true`，该用例会失败。
- **Linux（WebKitGTK）上的 CSP 兜底未经验证**：blob Worker 是否继承文档 CSP，已在 Chromium/Blink 侧证实为「继承」（`tests-browser/worker-csp.spec.ts`，Windows WebView2 同属 Blink 可沿用）。WebKitGTK 一侧未验——Playwright WebKit 需要额外系统库（`libgtk-4-1`、`libgstreamer-plugins-bad1.0-0`、`flite1`），本机只能经 `sudo apt-get` 安装。因此**在 Linux 上运行沙箱时**，「即使发生逃逸也发不出数据」这一层没有被证实，实际防线只有宿主桥的出口校验与脚本执行门禁。补验方式：在真实客户端里运行 `openspec/changes/archive/2026-09-17-add-pm-script-runtime/probes/worker-csp-probe.js`。
- **curl 导出引用本地文件时不可直接执行**：多段表单的文件字段与二进制正文在内部只以一次性句柄表示，路径从不进入后端，因此命令里的文件位置是占位符，需用户自行替换。
- **系统凭据库不可用时的功能边界**：secret 值与 Cookie 的**持久化**依赖操作系统凭据库（Windows 凭据管理器 / macOS Keychain / Linux Secret Service）。在无图形会话或缺少 DBus 会话总线的环境（例如纯 SSH 会话、容器）里，凭据库会不可用——此时这两项持久化被**拒绝**（绝不退化为明文落库），而请求发送、变量解析、脚本执行不受影响，Cookie 在本次运行内仍然有效（会话 Cookie 语义）。界面在这些操作上会给出明确的降级提示。
