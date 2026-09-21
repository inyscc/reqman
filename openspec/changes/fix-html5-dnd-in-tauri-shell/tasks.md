## 1. 窗口创建

- [x] 1.1 在 `src-tauri/src/lib.rs` 的 `WebviewWindowBuilder` 链上（与 `.decorations(false)` 相邻处，`on_navigation(is_allowed_navigation)` 保持不变）增加 `.disable_drag_drop_handler()`，并加注释说明 **Windows / WebView2 下外壳会替换掉 WebView2 子窗口的 OLE 拖放目标，页面内的 HTML5 拖拽因此到不了 DOM**（design D1）；验证方式：`cargo check --manifest-path src-tauri/Cargo.toml` 通过，且改动后 `lib.rs` 中 `on_navigation(is_allowed_navigation)` 与 `windows.is_empty()` 两条既有不变量仍成立（由 2.1 所在的审计文件保证）。
- [x] 1.2 确认关闭拖放处理器没有功能损失：在 `src/` 与 `src-tauri/src/` 中检索 `onDragDropEvent`、`DragDropEvent`、`DragDrop`、`tauri://drag-enter` / `drag-over` / `drag-drop`，应全部零命中（导入导出只经具名命令与 dialog 插件）；验证方式：检索结果为空，并把该结论写进本次提交说明。

## 2. 回归守卫

- [x] 2.1 在 `src-tauri/src/security_audit.rs` 中、`window_is_created_in_code_so_the_navigation_guard_applies` 之后**新增一个独立 `#[test]`**（沿用该文件「一个不变量一个测试」的粒度），断言 `read("src/lib.rs")` 含 `disable_drag_drop_handler`，断言文案写明原因：Windows 下关掉它对集合树与变量表格的 HTML5 拖拽是必需的（design D2）；验证方式：`cargo test --manifest-path src-tauri/Cargo.toml` 全绿，并做一次**反向验证**——临时注释掉 1.1 那一行时该用例必须变红，恢复后重新变绿。**实施补记**：反向验证必须**整行删掉**、不能只注释（`contains` 会连注释里的字面量一起匹配）；同理 `lib.rs` 的说明注释刻意不写出方法名，否则注释本身就能满足断言、守卫形同虚设。

## 3. 真机验收（Windows）

- [x] 3.1 在 Windows 上 `npm run tauri dev`（Rust 变更需重新编译，热更新不生效），在集合树里把「外层请求」拖到同级另一行之前：应出现插入线、松手后顺序改变；再把它拖到某个**文件夹行的中间区域**：应整行高亮、松手后归入该文件夹末尾；重新加载工作区后确认顺序与归属都已持久化。
  **实施补记**：首次真机验收时拖拽手势本身已恢复（第 1 组的目标达成），但发现**跨目录移动总是落到目标父级末尾、与指针位置无关**，而插入线仍画在指针处——该缺陷不在本组设定的行为内，已升级为第 5 组。**第 5 组落地后真机复验通过**：同级排序出现插入线且顺序改变、落在文件夹行中间区域整行高亮并归入该文件夹末尾、重新加载工作区后顺序与归属都保持。
- [x] 3.2 在同一窗口里验证**变量表格**的拖拽排序（实体面板 → 变量页签）同样生效，且**跨集合**拖动一个请求时全程不出现任何落点指示、松手不报错；验证方式：手动操作 + 重新打开集合确认顺序。
  **实施补记**：真机通过——变量表格的拖拽排序生效；跨集合拖动全程无落点指示、松手不报错。若拖拽仍不可用，先记录现象（拖动全程的指针形态、行有无拖影、`dragstart` 是否到达 DOM），**修完再判断、不要预设现象对应哪个成因**（design 的风险项已记录该判别为何不作为结论使用）。
- [x] 3.3 确认本次取舍的既定代价确实如此：往窗口里拖入一个 `.json` 文件不再有任何反应，而工具栏 / 底栏的导入入口照常可用；验证方式：手动确认「拖入无反应 + 导入模态可用」两条同时成立。
  **实施补记**：真机确认两条同时成立。该代价已写进 `README` 的「已知限制」。

## 4. 收尾与全量校验

- [x] 4.1 在 `README` 的「已知限制」中把「Windows 上的构建与冒烟待办」收敛一条具体结论：Windows 桌面壳内的 HTML5 拖拽依赖窗口不接管拖放处理（对应 `src-tauri/src/lib.rs` 的那次调用，摘掉它会让 `cargo test` 变红）；验证方式：该条文案与 3.1 / 3.2 的实际观察一致。
  **实施补记**：README 那条已改写为「交付目标是 Windows 安装包，但日常验证并不总在 Windows 上跑」，并写进这次的起因（拖拽在壳里整个失效、Linux 与浏览器用例全绿）、根因（wry 替换掉 WebView2 的 OLE 拖放目标）、修法与守它的断言，以及代价（**应用不再接收文件拖入**，无功能依赖）。文案与本变更的真机观察逐条一致。
- [x] 4.2 跑完整套件并确认全绿：`npm test`、`npm run test:browser`、`cargo test --manifest-path src-tauri/Cargo.toml`、`npm run build`。本次未改一行前端代码，因此前两项应保持原有结果——若出现变化，说明改动越界；验证方式：四条命令的退出码均为 0，且 `npm run test:browser` 的用例数与改动前一致。
  **实施补记（四条命令全绿，无例外）**：`npm test` 15 文件 / **412** 用例全绿；`npm run test:browser` 11 文件 / **76** 用例全绿（集合树拖拽 4 条，其中跨目录落点那条由第 5 组新增）；`npm run build` 成功；`cargo test` **305 passed / 0 failed**。
  起初 `cargo test` 是 301 passed / 1 failed，唯一失败项 `net::tests::certificate_validation_is_on_by_default_and_can_be_disabled_per_request`：`testutil.rs` 要 spawn `openssl` 现场签发自签证书，而本机未安装。该失败发生在**测试启动阶段**、早于任何业务代码，与本变更的代码无关（是 `README` 里"开发在 Linux 上进行"留下的环境差），但它确实让本组的验收条件不成立——**第 6 组把证书生成换成纯 Rust 后，这项阻塞已消除**。
  另注：本组原文"本次未改一行前端代码"已被第 5 组推翻——它改的正是前端落点语义与后端写入，前端用例数因此从 409 涨到 412。
- [x] 4.3 校验变更产物自身：`openspec validate fix-html5-dnd-in-tauri-shell --strict` 通过（`.openspec.yaml` 已标 `skip_specs: true`，本变更不产生 spec delta）；验证方式：命令退出码为 0。
  **实施补记**：第 5 组落地后本变更**不再是零 delta**——`skip_specs` 已撤，改为新增 `specs/ui-layout/spec.md` 规格增量（「集合树的拖拽排序与移动」按 MODIFIED 改写）。`validate --strict` 在两种状态下都通过。

## 5. 跨目录落点（真机验收暴露，见 design D5 与 specs/ui-layout 的规格增量）

- [x] 5.1 `src/lib/treeMoves.ts`：`TreeMove` 的 `move-folder` / `move-request` 带上目标位置（`index`，`Infinity` 表示追加末尾）；`buildMove` 的跨父级分支把 `target.index` 传出；`applyTreeMove` 的跨父级分支由 `append` 改为按位置插入（否则乐观结果与后端结果差一格）；验证方式：`npm test` 的纯逻辑用例覆盖「跨父级插到中间」「位置为 `Infinity` 时落末尾」「位置越界被夹住」三条，且既有同级排序用例保持全绿。
- [x] 5.2 `src/lib/commands.ts` 与 `src/App.tsx`：`requestMove` / `folderMove` 增加位置入参并在 `moveNode` 里透传；验证方式：`npm run build` 通过（tsc 的类型检查即覆盖签名一致性）。
- [x] 5.3 Rust 后端：`commands.rs` 的 `request_move` / `folder_move` 增加可选位置入参；`storage/requests.rs::move_request` 与 `storage/workspace.rs::move_folder` 在**同一事务**内改归属并按位置重编号目标父级的**混合**子条目（文件夹与请求共用 `sort_order`，`collection_tree` 按它混排）；同时补上 `move_folder` 过去的遗漏——位置为空时也要把 `sort_order` 设为末尾值，而不是保留旧序号；验证方式：`cargo test` 在 storage 层新增用例——「跨父级移动插到第 k 位后 `collection_tree` 的顺序与预期一致」「位置为空时落在末尾」「越界位置被夹到合法区间」「文件夹与请求交错时不串位」，且既有移动用例保持全绿。
- [x] 5.4 `tests-browser/tree-expansion-gestures.spec.ts` 新增真实引擎用例：把一个请求拖到**另一个文件夹内**某一行请求的下半区，断言它落在那一行**之后**（而不是该文件夹末尾），且后端收到的位置与落点一致；验证方式：`npm run test:browser` 全绿。
- [x] 5.5 真机复验（Windows）：跨目录拖动时插入线出现在指针处、松手后**就落在插入线的位置**；落在目录行中间区域仍进该目录末尾；重新加载工作区后位置保持。验证方式：手动操作，并回填 3.1 / 3.2 的结论。
  **实施补记**：真机通过——跨目录拖动落点与插入线一致（这是本次修复的核心症状），「移入目录」仍落在末尾，重新加载后位置保持。3.1 / 3.2 的结论已同时回填。

## 6. 消除 openssl 依赖（实施期发现的环境阻塞，获明确批准后顺手做掉）

- [x] 6.1 把 `testutil.rs` 的自签证书生成从 spawn `openssl` 换成 `rcgen`（dev 依赖，`default-features = false, features = ["crypto", "ring"]`）：`generate_self_signed()` 不再要临时目录与 PEM 中转，直接返回 (证书 DER, 私钥 PKCS#8 DER)；`HttpsTestServer::start` 随之去掉 `dir` 参数，`net/tests.rs` 的调用点同步简化。SAN 保持 DNS:localhost + IP:127.0.0.1，与旧 openssl 命令逐项等价——少了 IP 那项，「默认拒绝」会因**名称不匹配**而拒绝，而不是因为证书不受信任。验证方式：`cargo test` **305 passed / 0 failed**（此前 301/1），`cargo check --tests` 无告警；`cargo tree -i x509-parser` 打印 "nothing to print"，证明 `cargo add` 预取的那批 crate 未进构建图。
