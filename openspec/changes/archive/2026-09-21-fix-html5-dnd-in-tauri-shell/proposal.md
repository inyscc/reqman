## Why

集合树与变量表格的拖拽排序**在桌面壳里完全不工作**：按住一个请求拖动，没有落点指示、松手也不产生任何改动。而同一套交互在浏览器里是好的——`tests-browser/tree-expansion-gestures.spec.ts` 里那三条真实引擎用例（同级排序、拖入目录、搜索态不可拖）一直是绿的。

根因不在前端，而在窗口创建：主窗口在 `lib.rs` 里用 `WebviewWindowBuilder` 建，**没有关掉 Tauri 的拖放处理器**。Windows / WebView2 上，wry 会把 WebView2 子窗口的 OLE 拖放目标撤掉换成自己的、只认 `CF_HDROP` 文件的那个，页面内的 HTML5 拖拽因此根本进不到 DOM。也就是说，`ui-layout` 的「集合树的拖拽排序与移动」与「变量表格的重复键与拖拽排序」两条早已交付的能力，在 Windows 上是**空头承诺**。

这个缺陷长期不可见，源于验证环境的结构性偏差：开发与全部浏览器用例都跑在 Linux / 本机 Chrome 上，**两者都不经过 Tauri 的窗口创建路径**。`README` 已把「Windows 上的构建与冒烟待办」列为已知限制，本次是那条限制的第一个具体代价。

## What Changes

- 主窗口创建时关掉 Tauri 的拖放处理器（`WebviewWindowBuilder::disable_drag_drop_handler()`）：把拖放目标还给 WebView2，页面内的 HTML5 拖拽恢复可用。一次修复同时覆盖集合树与变量表格。
- 在 `security_audit.rs` 既有的窗口构造审计中新增一条源码级断言，把「这一行必须存在」变成 `cargo test` 会红的回归保护，断言文案里写明 Windows / WebView2 的原因，使后来者摘掉它之前先读到理由。
- 真机验收：在 `npm run tauri dev` 的 Windows 窗口里实际拖一次（集合树排序 / 改归属 / 变量表格排序），补上此前缺失的那一跳。

真机验收又暴露出**第二件事**，它才是本变更后半段的主体：**跨目录拖放总是落到目标父级的末尾，与指针位置无关**，而插入线却仍然画在指针所在处。落位规则本身是按规格实现的（"移动后的条目 SHALL 出现在目标父级的末尾"），撒谎的是指示器——指示器承诺了一件系统做不到的事。而规格内部对此本就自相矛盾：`#### Scenario: 文件夹与请求交错`（"拖到两个文件夹之间 → 排在这两个文件夹之间"）**没有限定同一父级**，与那条「末尾」互相打架。

因此本变更把落点契约统一到"插入线即最终落位"：

- 跨目录拖动按落点插入：`request_move` / `folder_move` 接受目标位置，在同一个事务里把目标父级的子条目重编号（文件夹与请求共用一套 `sort_order`，必须一起重排）。
- 「移入」语义不变：落在目录行**中间区域**仍然追加到该目录末尾——那里本来就没有位置信息。
- 相应地 `ui-layout` 的规格要改口（那条「末尾」收窄到「移入」情形）。

手势侧不动：`WorkspaceTree.tsx` 的 `hoverRow` 早就把正确的位置算出来了，只是过去没人把它传给后端。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `ui-layout`: 「集合树的拖拽排序与移动」把「移动后的条目 SHALL 出现在目标父级的末尾」收窄为**仅适用于「移入」方式**（落在目录行中间区域），并新增「插入线即最终落位、跨目录拖动按落点插入」的契约与对应场景。该条要求内部原本就与 `#### Scenario: 文件夹与请求交错` 互相矛盾，本次是站到有可见结果的那一边，不是引入新行为。

（`window-chrome` 的「会话标签行的窗口拖拽区」已把侧栏条目拖拽明确划在窗口拖拽之外，其措辞在本变更后依然成立，不动。）

## Impact

- 代码（外壳）：`src-tauri/src/lib.rs`（窗口 builder 链增加一次调用）、`src-tauri/src/security_audit.rs`（新增一条断言）。
- 代码（落点契约）：`src/lib/treeMoves.ts`（`TreeMove` 的 `move-*` 带上目标位置、`buildMove` 传出、`applyTreeMove` 按位置插入）、`src/lib/commands.ts` 与 `src/App.tsx`（两个命令的位置入参）、`src-tauri/src/commands.rs`、`src-tauri/src/storage/requests.rs`、`src-tauri/src/storage/workspace.rs`（位置入参 + 目标父级重编号，单事务内完成）。
- 行为：集合树与变量表格的拖拽在 Windows 桌面壳内恢复；跨目录拖动改为**落在指针位置**、「移入目录」仍追加到末尾。`drag_drop_enabled` 关闭后应用**不再接收文件拖入**——当前 `src/` 与 `src-tauri/src/` 中没有任何 `onDragDropEvent` / `DragDrop` 的使用（导入走 dialog 插件），故无功能损失。
- 依赖与权限：不新增运行时依赖、不改 capabilities、命令名不变，因此 `security_audit.rs` 的权限白名单与命令面断言不受影响。
- 测试基建：`src-tauri/src/testutil.rs` 的自签证书生成由外部 `openssl` 命令改为 `rcgen`，`src-tauri/Cargo.toml` 增加该 **dev** 依赖（关默认特性、只留 ring）。动机是 `cargo test` 在未安装 openssl 的机器上跑不完 TLS 那条安全用例；仅测试期编译，不进产物。
- 数据：`sort_order` 的写入语义扩展——跨父级移动现在会重编号目标父级的全部子条目（而非只给移动项算 `MAX+1`）。既有数据不需要迁移，字段与取值域都不变。
- 验证：`cargo test`（新增断言 + 存储层位置用例）、`npm test`（`treeMoves` 的纯逻辑用例）、`npm run test:browser`（跨目录按落点插入的真实引擎用例），以及**人工真机验收**这一跳。
