## Context

动机见 `proposal.md` 的 Why。这里只放理解方案所必需的状态与约束。

界面侧的拖拽链路已被证明是正确的，本变更不动它：

- `src/components/WorkspaceTree.tsx` 的 `dragHandlers`：`draggable`、`dragstart` 里 `beginDrag`、`dragover` 里 `preventDefault` 才允许放下、`drop` 里 `commit`，与 HTML5 DnD 的约定一致。
- `src/lib/treeMoves.ts` 的 `buildMove` / `applyTreeMove`：把「拖动项 + 落点」翻译成一次写入并就地重排，纯函数、可单独验证。
- `src/components/VariablesPanel.tsx`：变量表格的拖拽排序，走同一套 HTML5 DnD。
- `tests-browser/tree-expansion-gestures.spec.ts` 的「集合树拖拽（真实引擎）」三条用例在本机 Chrome 里全绿。

窗口的创建方式是既有约束，不是本变更的自由选择：

- `src-tauri/src/lib.rs` 在 `setup` 中用 `WebviewWindowBuilder` 建主窗口，`tauri.conf.json` 的 `app.windows` 为空数组。这是**被审计钉住的**：`security_audit.rs` 的 `window_is_created_in_code_so_the_navigation_guard_applies` 同时断言 `windows.is_empty()` 与 `lib.rs` 含 `on_navigation(is_allowed_navigation)`。
- 因此「把窗口搬回配置、用 `dragDropEnabled: false` 解决」这条路会当场打破上述两条断言。

## Goals / Non-Goals

**Goals:**

- 让页面内的 HTML5 拖拽在 Windows 桌面壳内真正生效，从而兑现 `ui-layout` 中集合树与变量表格那两条既有的拖拽要求。
- 让这个修复**不可被无声摘掉**：留下一道自动化守卫，且守卫本身说清理由。
- 补上此前缺失的真机验收动作。

**Non-Goals:**

- 不动集合树的手势与落点解算（`WorkspaceTree.tsx` 的 `dragHandlers` / `hoverRow`）：它们没有缺陷，`hoverRow` 一直算出了正确位置。
- 不引入指针事件自绘拖拽，不替换 HTML5 DnD。
- 不新增依赖、不放宽权限、命令名不变。
- 不为应用新增「拖入文件即导入」能力；相反，本次**关闭**了接收文件拖入的通道。这是选定方案的既定代价，不是疏漏——代价的边界与将来重启它的路径见 Risks 首条。

## Decisions

### D1：关掉外壳的拖放处理器，而不是改前端

Tauri v2 的窗口配置项 `dragDropEnabled` **默认为 true**，而它的文档注释给出了直接答案：

```
tauri-utils-2.9.3/src/config.rs:1943
  /// Whether the drag and drop is enabled or not on the webview.
  /// By default it is enabled.
  /// Disabling it is required to use HTML5 drag and drop on the frontend on Windows.
```

对应的 builder 方法（`tauri-2.11.5/src/webview/webview_window.rs:1029`，即本项目 `Cargo.lock` 锁定的 2.11.5）：

```
  /// Disables the drag and drop handler. This is required to use HTML5 drag
  /// and drop APIs on the frontend on Windows.
  pub fn disable_drag_drop_handler(mut self) -> Self
```

机制在 wry 里可以逐行看到（`wry-0.55.1/src/webview2/mod.rs:150-158` 与 `webview2/drag_drop.rs`）——它**不是**"多一层拦截"，而是**替换掉 WebView2 的拖放目标**：

```
  建窗时若 drag-drop handler 存在（默认）
        |
        v
  SetAllowExternalDrop(false)          让 WebView2 别自己处理外部拖放
  DragDropController::new(hwnd)        枚举窗口的子 HWND
        |
        v
  RevokeDragDrop(child_hwnd)           撤掉 WebView2 自己的 IDropTarget
  RegisterDragDrop(child_hwnd, wry 的目标)
        |
        v
  wry 的目标只认 CF_HDROP：拿不到文件就 `return Ok(())` 直接退出
                                            (drag_drop.rs:159-199)
        |
        v
  [ 页面内的 DOM 拖拽无人接管 ] ---> dragstart / dragover / drop 到不了渲染进程
```

替代方案是改前端用 pointer 事件自绘拖拽。弃：那是为"既要文件拖入、又要内部拖拽"准备的绕路，而本应用两处都不需要文件拖入，代价却是重写两套已经正确的交互。

### D2：回归守卫放在 `security_audit.rs` 的窗口构造断言里

这个缺陷的杀伤力在于**跨平台不可见**：Linux（WebKitGTK）与 Chrome 里都是好的。唯一能自动化的是源码级断言，而这恰是本仓库一贯的做法——`security_audit.rs` 已经在读 `capabilities/default.json`、`tauri.conf.json`、`src/lib.rs` 与前端源码做同类断言。

原先担心"语义上不属于安全边界"，复核后不成立：同文件里的 `window_is_created_in_code_so_the_navigation_guard_applies` 本来就在断言**窗口构造**（`windows.is_empty()` + builder 链上的 `on_navigation(...)`），并已在注释里说明理由。本变更按该文件的既有粒度**新增一个独立 `#[test]`**（而非塞进那个测试），断言 `lib.rs` 含 `disable_drag_drop_handler`，并在断言文案里写出 Windows / WebView2 的原因。

同时**否决"只写进 tasks 当人工验收项"**：人工项不产生回归信号，而这个开关恰好是那种"看起来多余、删掉后 Linux 上一切正常"的代码——下一次有人在 Linux 上做 Tauri 升级或清理 builder 链时，一定会想删它。

### D3：~~不动规格文本~~（已被真机验收推翻，保留记录）

**本条作废。** 原判断是：规格已经把可观察行为写对，坏的只是实现，所以不补 delta、标 `skip_specs: true`。

推翻它的是真机验收里的一条观察：**跨目录拖放总是落到目标父级的末尾**。落位规则本身是按规格实现的，撒谎的是**指示器**——而 `ui-layout` 的这条要求内部本就自相矛盾：

```
  「落在某一行的上 / 下半区时以插入线指示同级排序」      <- 没说只限同一父级
  #### Scenario: 文件夹与请求交错
     WHEN 把一个请求拖到两个文件夹之间                  <- 同样没说只限同一父级
     THEN 该请求排在这两个文件夹之间
                              vs
  「移动后的条目 SHALL 出现在目标父级的末尾」           <- 与前两条打架
```

前者承诺可见的落位，后者承诺"一律末尾"。实现选了后者、指示器画了前者，于是用户看到的就是"松手的位置不对"。既然要统一，就必须改规格——`skip_specs` 已撤，见 D5。

教训值得记下：D3 的推理链（"规格写对了"）依赖的是**静态阅读规格**，而矛盾恰恰藏在两条相隔十几行的文字之间。是产品行为被真机跑出来后，这个矛盾才显形。

需要记下的是**另一条曾被考虑的路**：给 `window-chrome` 加一条「外壳 SHALL NOT 接管 webview 的拖放处理」。它有仓库先例可循（该能力要求 5 已在承载"审计白名单须与生效清单同步"这类元约束；上一轮归档变更也曾为"侧栏拖拽"专门收紧过该能力的措辞），但最终没走。

判据是**守卫的完备性**：规格文字的价值在于兜住自动化守护不住的部分；一条约束能被多少个断言**精确**覆盖，决定了补 delta 的边际价值。

```
  约束有几种实现方式？                     源码断言的覆盖力         delta 的边际价值

  很多种（例：「前端不得有通用文件能力」）    只能守住见过的那一种  ->  高：其余写法靠规格文字兜
        |
  恰好一种（「外壳不得接管拖放」=           完备：摘掉必红，        ->  极低：规格不增加
   lib.rs 里那一次 builder 调用）          换写法也会被 contains 抓到    任何「会红的新东西」
```

本次落在后一档：约束**一对一映射到一个调用点**，D2 的源码断言对它已经是完备守卫——这正是"一个断言就够"的情形，规格文字在这里不会有任何增量约束力。再加，理由已写进本文档（D1），需要时能被发现；若日后确需更强的可发现性，补该 delta 仍是一次独立且低成本的改动。

### D4：不把窗口搬回 `tauri.conf.json`

配置层的 `dragDropEnabled: false` 确实是一条路，但它会打破 `security_audit.rs` 中 `windows.is_empty()` 与 `on_navigation` 两条断言，而"窗口在代码中创建"正是导航守卫得以挂上的前提。用配置换掉代码建窗，等于为了一个开关拆掉一堵墙。弃。

### D5：统一落点契约——插入线即最终落位

**决策**：跨父级移动 SHALL 按落点插入，不再一律追加到末尾；落在目录行**中间区域**的「移入」仍追加到末尾（那里本来就没有位置信息）。

**写入次数上的取舍**：

| 做法 | 代价 |
|---|---|
| 前端连发两条既有命令：`request_move`（追加）+ `children_reorder`（重排到第 k 位） | 零后端改动；但**两次写入、非原子**——第二条失败时条目停在目标父级末尾，状态与指示不符 |
| 给 `request_move` / `folder_move` 增加可选位置入参，在**同一事务**内改归属并重编号目标父级 | 动 Rust（commands + storage）与它们的用例；一次写入 |

**选后者。** 理由与本仓库把「拖动项 + 落点」设计成**一次后端写入**（`treeMoves.ts` 头注释的原始约定）同源：非原子写入在这个功能里的表现形式正是"有时对、有时差一格"——也就是刚被修掉的那类难复现缺陷。

**重编号必须文件夹与请求一起做。** 两者共用一套 `sort_order`，`collection_tree` 按它混排：

```
workspace.rs:663-672
  // 文件夹与请求混排：按 sort_order 稳定排序，同序号时文件夹在前
```

现状无法表达"插到第 k 位"：`move_request` 只算 `MAX(sort_order)+1`，`move_folder` 连 `sort_order` 都不更新。后者还带来一个既有不一致——注释声称"后端把它追加到目标父级末尾"，实际却按旧序号落位，重新加载后可能与界面不一致。现在两种条目走同一条规则。

**`App.tsx` 的乐观重排（`applyTreeMove`）随之对齐**：跨父级分支从 `append` 改为按位置插入，否则乐观结果与后端结果会差一格，而"瞬时看不出、刷新才对不上"正是最难查的一类。

`hoverRow` 不动：它一直算出了正确的位置，只是没人把它传下去。

### D6：去掉 openssl 依赖（实施期的相邻清理，获明确批准）

`cargo test` 在本机差一条：`testutil.rs` 用 `openssl` 命令现场签自签证书，而本机没装 `openssl`。这不是"环境不巧"——它让**证书校验默认开启**这条安全行为的测试在整类机器上静默缺席（Windows 开发机、精简 CI 镜像），而 4.2 的验收条件恰好是"四条命令退出码为 0"。

三条路：

| 做法 | 判断 |
|---|---|
| `rcgen`（dev 依赖，只留 ring） | **选它。** 真实传递依赖 `ring` / `rustls-pki-types` / `time` 都已在树里，没有新增编译单元；`cargo add` 预取的 `x509-parser`、`nom` 等经 `cargo tree -i x509-parser` 证实**不在构建图中** |
| 用 ring 自己手搓 DER | 弃。约 150 行 ASN.1 拼装，写错就得到极难解的 handshake 错误，换来的只是省一个 dev 依赖 |
| 把证书与私钥作为常量搬进测试 | 弃。省事，但留下一份终将过期的"魔法 blob"，且没人说得清它的来历 |

顺带把 SAN 补全（DNS + IP），与旧 openssl 命令逐项等价：否则"默认拒绝"会因**名称不匹配**而拒绝，测试名字里的"证书校验"就名不副实。

产物边界：只进 `[dev-dependencies]`，不进安装包；`testutil.rs` 本就只在 `cfg(test)` 下编译。

## Risks / Trade-offs

- [应用从此不接收文件拖入（往窗口里拖一个 .json 不再有任何反应）] → 当前无任何功能依赖它：`src/` 与 `src-tauri/src/` 中 `onDragDropEvent` / `DragDrop` / `tauri://drag-*` 零命中，导入只经 dialog 插件。若将来要做"拖入文件即导入"，需重新评估：那时要么恢复 handler 并改用 pointer 事件自绘内部拖拽，要么另寻承载方式——**这条取舍以本行为界**。
- [断言是源码级匹配（`source.contains(...)`），改名或换写法会让它误报] → 与同文件既有断言的保真度一致；它守的是"这一行还在不在"，不是行为正确性。行为正确性由真机验收覆盖。
- [真机验收依赖人工，可能再次被跳过] → 验收步骤写进 `tasks.md` 并明确"必须在 Windows 的 `npm run tauri dev` 窗口里"；`README` 的 Windows 冒烟待办在本变更后应同步收敛一条具体项。
- [只修了 Windows 上这一个成因；若真机修完仍不可拖，说明还有第二个成因] → 先**记录现象**（拖动全程的指针形态、行有没有拖影、`dragstart` 是否到达 DOM），修完再判断，**不要预设现象对应哪个成因**。此处原先写着"观察指针形态即可区分「外壳接管」与「落点判定」两类成因"，那是一条**未经验证的假设**，不是结论：按 D1 的图推——`dragstart` 发生在渲染进程、早于浏览器进程的 `DoDragDrop`——外壳接管的症状本应是"**有拖影、但落点指示从不出现、松手没反应**"，与直觉相反。而 Chromium 对同页内部拖拽在部分平台另有一条通路，它在 WebView2 里的确切行为无法只靠源码钉死，因此该判别不再当结论使用。
  这不影响本次动手：handler 开着时外壳**必然**介入（Tauri 文档明示，且 wry 的 `RevokeDragDrop` / `RegisterDragDrop` 实打实），这条通路必须先修掉，修它对不对与症状归属无关。
  **结局**：真机验收确认拖拽本身恢复，"拖不动"没有第二个成因，本风险未兑现。但同一次验收暴露出**一个相邻缺陷**——跨目录落位与指示器不符，其处置见 D5 与 tasks 第 5 组。
- [跨父级移动现在会重编号目标父级的全部子条目] → 单事务内完成、失败整批回滚；重编号只写 `sort_order`，不碰名称 / 脚本 / 认证 / 请求内容（规格对此有明文约束）。
- [同级排序走 `children_reorder`、跨父级走 `move_*`，"两条路径做同一件事"] → 两条共用同一套「下标即 `sort_order`」的约定；`npm test` 的纯逻辑用例与 `tests-browser` 的真实引擎用例同时钉住同级排序与跨目录插入，任一退化都会变红。
