## Context

动机见 `proposal.md`（Why），行为契约见 `specs/ui-layout/spec.md` 与 `specs/window-chrome/spec.md`。这里只记影响做法的现状与约束：

- 主区状态目前是**单槽位**：`App.tsx` 里的 `selectedId` / `draft` / `dirty` / `response` / `tab`（请求编辑器内层标签）各一份，`activateRequest` 直接覆盖它们，因此「切换请求」必须过守卫。
- **目标平台：仅 Windows（Tauri/WebView2）。** 窗口控制按钮据此置于会话标签行最右端（最小化 / 最大化-还原 / 关闭），与 `window-chrome` 的落位一致；不要按 macOS 习惯左移——`close` 在左上仅是 macOS 反例，本平台右侧才是熟悉位置。
- 主区的三个面由互斥分支决定：`showEnvironmentEditor`（`sidebarTab === 'environments'`）、`selectedEntity && entityDraft`、`draft`。选中实体时 `activateEntity` 会 `setDraft(null); setSelectedId(null)`，把请求丢掉。
- 顶部那一行（`.session-bar`，`--chrome-row` 40px）同时是窗口标题栏与请求身份 header；`window-chrome` 把拖拽与窗口控制按钮钉在这一行上，环境选择器与窗口控制按钮**不可被遮挡**。
- 编辑面注册表（`src/lib/editing.ts`）里只有两种面：`App` 注册的 `request`（`SURFACE_PRIORITY.request`，带 `isActive: () => !showEnvironmentEditor && modal === null`）与 `EntityScriptPanel` 注册的 `entity-script-<id>`（`SURFACE_PRIORITY.panel`，**没有 `isActive`**）。`Ctrl+S` 存 `top()`，守卫存 `dirty()`。
- 按工作区持久化显示偏好的先例是 `src/lib/layout.ts`：`settingsGet/settingsSet(scope='ui_layout', key=工作区 id, value=字符串)`，读不懂回落默认、写不进静默吞掉。`settings_get` / `settings_set` 两条命令已存在，Rust 侧不需要改动。
- `loadTree(workspaceId)` 在新建、删除、改名、导入之后都会被调用；导入会真的删掉请求。
- 样式集中在 `src/App.css`（token 已就位：`--chrome-row`、`--space-*`、`--radius-*`、`--text-*`、`--ease-*`）。既有边界：每天数十次以上的操作不加过渡动效。

## Goals / Non-Goals

**Goals:**

- 把主区从「一个草稿槽位」改为「一组按标签分持的编辑会话」，使切换不再需要守卫。
- 让标签栏、环境选择器、窗口控制按钮在同一行里各就其位：标签栏是唯一可收缩元素。
- 复用既有的设置存储与编辑面注册表两套机制，不新增依赖、不动 Rust 侧、不做 schema 迁移。

**Non-Goals:**

- 不做标签的拖拽排序（`rodemap` 把它与多标签并列，但排序需要独立的落库格式与命中测试，本轮不做）。
- 不做标签溢出下拉列表。
- 不做草稿的持久化（见 D6）。
- 不做多窗口。
- 不再维持「主区顶部从窗口上沿到地址栏只有一行」——本变更刻意放弃该布局目标，见 D2。

## Decisions

### D1 标签是一个对象，草稿存在标签里

```
SessionTab =
  | { kind: 'request'; requestId: string; draft: SavedRequest; dirty: boolean;
      response: ResponsePayload | null; innerTab: EditorTab;
      scriptReport: ScriptReport | null }
  | { kind: 'entity';  entityKind: 'collection' | 'folder'; id: string;
      draft: Collection | Folder | null }
```

`App` 持有 `tabs: SessionTab[]` 与 `activeTabId`。`activeTabId` 取代 `selectedId` 成为「主区显示什么」的唯一判据；树的选中态由它派生（见规格「标签激活态与树的选中一致」）。

**为什么草稿要放进标签、而不是只存 `requestId` 再从 store 或树里取**：`requestStore` 里的是「已提交的乐观值」，而草稿是「还没提交的编辑副本」，两者不是同一个东西。只有一个槽位时二者可以共用一份状态；有 N 个标签时它们必须分开，否则每个标签的未保存编辑会被别的标签覆盖。

**同一 id 至多一个标签是硬约束**，不是体验偏好：两个标签持有同一 `requestId` 的草稿时，`requestStore.markDirty(id)` 的乐观覆盖层无法判断该以哪份草稿为准，树上的名称会开始闪烁。因此所有打开入口统一走一个 `openRequest(id)` / `openEntity(kind, id)`，先查在册标签。

**备选（否）**：标签只存 id、草稿集中放在一个 `Map<id, SavedRequest>`。等价于把状态换个地方存，但多出一层与 `tabs` 的同步，且「标签关了草稿还在不在」需要一个额外规则——直接放进标签则「关标签即丢草稿」是默认行为，与预期一致。

**id 稳定性**：`requestCreate` / `requestDuplicate` 由后端立即分配真实 id（`created.id` / `copy.id`），`loadTree` 后仍在树中，所以按 id 对账绝不会把新建/另存的标签误杀为僵尸——实现不要在这两个路径用临时 id。

**新建 / 另存为不丢当前草稿**：二者是「新增标签」，不再覆盖单槽位的 `draft`，因此不再需要过守卫（与单槽位相反）；原已打开的标签原样保留。

### D2 标签是纯标签，请求身份下沉到请求面板头

标签只呈现身份（方法徽标 / 种类图标 + 名称）与状态（激活、未保存指示），不可就地编辑。请求名输入框、所属集合面包屑、`另存为` / `删除` 移到请求区自己的面板头（`RequestEditor` 顶部，地址栏上方）；实体侧把它们放进 `EntityScriptPanel` 已有的 `pane-header`（现在那里的 `<strong>集合 · 名称</strong>` 变成可编辑输入框）。

**为什么**：一个标签装不下输入框，N 个标签更不可能。而身份下沉顺带修掉一处既有的不对称——响应区早就有自己的 `pane-header`（`<strong>响应</strong>` + 元信息 + 保存全文），只有请求侧没有、身份被托管给了顶部那行。下沉后请求侧与响应侧对称。

**顺带的好处**：`另存为` / `删除` 是请求级操作，原先挤在窗口标题栏里与窗口控制按钮抢横向空间；下沉后顶部那行右侧只剩环境选择器与窗口控制按钮——正好是 `window-chrome` 要求不可被遮挡的两块，冲突自己解开。

**方法徽标不放请求面板头**：它紧邻的地址栏里就是 METHOD 选择框，同一屏重复表达同一个方法没有信息量。因此三处一致（集合树节点、会话标签、方法选择框）保持不变，`ui-layout` 的「集合树的外观与密度」不需要改动。

**备选（否）**：① 激活标签膨胀成「集合名 › METHOD 名称输入框」。宽度随激活态跳动，且集合名会把激活标签撑得很宽，标签条变成"一个大标签 + 若干小标签"。② 只有一个标签时保持现状、两个以上才切到标签形态。同一界面存在两套布局，输入框位置随标签数迁移，测试与样式面积翻倍。

**代价（必须记）**：正式推翻 `rework-visual-system-and-app-chrome` 的 D3 目标「主区顶部 chrome 由两行减为一行」。当时的权衡是「顶部不要有第二条承载同一信息的行」，那个前提在单标签下成立；多标签下顶部那行被标签集合占满，身份必须有新家，于是这层对称性换了回来。

### D3 环境编辑器不进标签

`showEnvironmentEditor = sidebarTab === 'environments'` 原样保留，作为唯一的「接管」分支：它成立时标签栏整条不渲染，该行只剩环境选择器与窗口控制按钮；请求与实体标签原样留在状态里，切回 Collections 即恢复。

**备选（否）**：标签栏常驻、环境编辑器激活时所有标签都非激活。它需要在标签轴与侧栏轴之间建立耦合——点击一个标签必须隐式把侧栏切回 Collections，于是「点标签」同时改变侧栏，两套导航开始互相驱动。用现有布尔换掉这个耦合，收益明显。

### D4 编辑面按标签注册；实体面必须补 `isActive`

- 每个打开的标签注册一个编辑面（id 形如 `request:<requestId>` / `entity:<kind>:<id>`，沿用 `SURFACE_PRIORITY.request` / `.panel`），`label` 用该标签的名称。
- 请求面的 `isActive` 沿用现有语义：标签处于激活、且 `showEnvironmentEditor` 为假、且无模态。**非激活的标签仍注册面**，因此它照样进入 `dirty()`，关窗时会被守卫提示——这正是「另一个标签里有没存下的东西」要保住的。
- 实体面**必须新增 `isActive`**：现状它没有 `isActive`，而优先级是 `panel`（高于 `request`）。它一旦进入后台标签，`top()` 仍会选中它，`Ctrl+S` 就会去保存一个用户没在看的实体脚本——这是本次改动引入的新缺陷面，属必测点。

**备选（否）**：只注册一个聚合面，`save()` 里保存全部脏标签。实现最省，但会让 `Ctrl+S` 越权保存用户没在看的标签，违背 `ui-layout` 既有的区分（`Ctrl+S` 存「我现在弄的这个」，守卫的「保存并继续」才存全部脏面）。

### D5 `loadTree` 之后对账

`loadTree` 完成后，丢弃 `tabs` 中指向已不存在的请求/实体的项；被丢弃的项正好是激活项时，激活态按规格移交给相邻标签，没有标签则回空态。

**为什么必须有**：导入会真删请求；删除集合会级联删请求与文件夹。不对账就会留下指向已删 id 的标签，点开它只会拿到一个后端错误。因此删除集合/文件夹也是守卫触发项（其下含脏标签时先问），见规格「未保存改动在被丢弃前的守卫」。

**对账判据只用「条目是否仍存在」**，不看标签是否脏——脏标签"仍存在"时绝不能被对账误关，丢弃它的唯一合法途径是守卫。

**时机**：对账必须在 `loadTree` 把条目写回 store 之后再跑（先 seed 再对账）。它依赖的「条目是否存在」来自刚拉回的树；在 seed 之前跑会把刚要恢复的标签误判为"指向不存在"而误杀。

**备选（否）**：只在删除路径里手写关闭对应标签。会漏掉导入这条路径（导入走的是"替换 + 重新拉树"，没有单条删除事件），对账是对所有路径都成立的不变量。

### D6 标签集合持久化：`scope='ui_tabs'`，key = 工作区 id

值形如 `{"tabs":[{"kind":"request","id":"..."},{"kind":"entity","entityKind":"folder","id":"..."}],"activeId":"..."}`（JSON 字符串）。读写纪律完全对齐 `src/lib/layout.ts`：读不到、解析失败、格式不符一律回落「空集合 + 无激活项」；写入失败静默，不打断使用。写入时机只在标签集合或激活项变化时（开/关/切），不在每次编辑时。

恢复流程挂在加载工作区之后、树拉取完成之后：按 id 从树/库中取回条目，取不到的丢弃。**明确顺序：先 `loadTree` 把条目写回 store（seed）→ 再按现存 id 过滤恢复标签 → 最后跑 D5 的对账**；三者必须串好，否则恢复出的标签会在对账前被"指向不存在"误杀。

**明确非目标：不持久化草稿。** 靠两个理由：① 与「退出应用前的未保存处置」语义打架——那边刚问完用户「要不要保存」，这边又偷偷把草稿存了下来，用户的选择就失去意义；② 草稿里可能有 secret 变量的明文取值，把它序列化进 settings 表会把 `variable-engine` 辛苦守住的掩码边界捅穿。

**备选（否）**：换一张新表或新命令。没有必要——标签集合与分栏比例同性质（按工作区记的显示偏好），`settings` 表就是为这类东西准备的，用新命令只会扩大命令面与安全审计面积。

### D7 溢出：标签栏是这一行里唯一可收缩的元素

`.session-tabs { flex: 1 1 auto; min-width: 0; overflow-x: auto; scrollbar-width: none }`，隐藏滚动条，垂直滚轮转成横向滚动；`.env-select` 与 `.window-controls` 保持 `flex: none`。标签宽度限制在区间内并省略号截断；**非激活与激活标签等宽**——宽度随激活态变化会让每次切换整条重排，也会让「显现不引起水平跳动」那类要求在对的位置失效。

不做溢出下拉列表：Postman 与 VS Code 都不用，且 `Ctrl+Tab` 与集合树已经能到达任意标签，多一个浮层的收益不抵它的键盘与无障碍面积。

**拖拽排除**：window-chrome 要求「标签上按下并拖动 SHALL NOT 移动窗口」。现有 `isInteractiveSessionBarTarget`（`ResizeStrips.tsx`）只排除 `button, select, input, textarea, .env-select, .window-controls`；标签若渲染成 `<div>` 会落入拖拽区。实现二选一：① 标签渲染成 `<button>`（自然被 `button` 排除）；② 在排除选择器里加入 `.session-tab`。任务 3.2 据此落实。

### D8 动效：切换标签不加过渡

沿用既有边界（`rework-visual-system-and-app-chrome` D5 已把「切换标签页、切换请求」列入明确不加动效的清单）：这是每天数十次以上的操作，过渡只会让它显得慢。标签的关闭与溢出滚动同样不做入场过渡——它们与切换同频。

**reduced-motion**：任何揭示 / 指示（`另存为` / `删除` 的悬停显现、未保存圆点）SHALL 只走 `opacity` / `visibility`，SHALL NOT 用位移或缩放；在 `prefers-reduced-motion: reduce` 下同样如此——把「无动效」的意图坐实，避免实现期把揭示做成 slide/fade 位移（apple-design §14）。

### D9 关闭入口与未保存指示的呈现

- 关闭按钮用 `visibility` 占位（不引起标签宽度跳动），指针悬停该标签或该标签处于激活时显现。
- 标签有未保存改动时，该位置默认显示圆点；悬停时变回关闭按钮。**非激活标签的圆点必须可见**——它是在标签栏上唯一能表达"另一个标签里有没存下的东西"的信号。
- 鼠标中键点击标签等同关闭入口。
- 标签在被按下（pointerdown）时应立即呈现按下态高亮，不等待 click / 激活完成——这是每天数十次以上的操作，即时反馈更跟手（apple-design §1）。

### D10 键盘

`Ctrl+W` 关闭激活标签（走守卫）、`Ctrl+Tab` / `Ctrl+Shift+Tab` 前后切换、`Ctrl+1..9` 跳第 N 个。统一挂在与 `Ctrl+S` 同一层的 window keydown 上，不依赖焦点位置（与既有 `Ctrl+S` 的处理一致）。

## Risks / Trade-offs

- **[`Ctrl+W` 可能被 WebView2 或宿主吞掉]** → 实现期先用一个最小探针确认宿主是否把它交到页面；若不交，就只保留中键与 `×`，快捷键清单相应缩减（不影响规格与任务拆分）。不预先假设可用。
- **[拖拽可用面积变小]** → 标签占据标题栏左侧后，可拖动区域缩小，且标签上按下会被排除出拖拽。缓解：标签栏容器保留水平内边距；标签栏内标签之外的空白处（`.session-tabs` 的剩余区域）仍属可拖拽区，规格里已显式要求。
- **[实体面漏写 `isActive` 会导致 `Ctrl+S` 保存后台标签]** → 这是本次引入的新缺陷面，列为必测：实体标签进后台后按 `Ctrl+S` 不得发出写请求。
- **[每个标签各持一份 response，内存随标签数与响应体增长]** → `response` 保存的是后端返回的 payload 引用而非深拷贝，不会复制响应体；若后续观测到压力，再考虑「只保留最近 N 份响应」的剪枝，属可延后的优化。
- **[持久化的写放大]** → 只在集合或激活项变化时写；写入静默失败，与分栏比例一致。
- **[既有测试大面积依赖单槽位]** → `tests/app.test.tsx` 里以 `session-tab` / `session-bar` 为锚点、以及「切换到另一个请求先询问」这类断言都会失效。缓解：按 TDD 顺序先改断言再改实现，避免出现"测试全绿但语义已变"的假象。
- **[规格层面 BREAKING]** → 三条需求被整体替换、两条被改写。README 与 `rodemap` 里把多标签列为 P1 的表述需要同步。

**[`requestStore.markDirty` 是死信号]** → `editDraft` 调用它，但守卫与树都不读 `requestStore.isDirty/dirtyIds`（只读 `editingRegistry`）；多标签下关脏标签（不保存）不会让守卫泄漏（标签注销即退出注册表），但 store 的 dirty 集合会一直挂该 id。若将来据此做树节点脏样式会卡死——新模型不要新增对它的读取。

## Migration Plan

- **数据**：无迁移。`ui_tabs` 是新增的 settings 键；旧版本不读它，新版本在从未写过该键的工作区上回落空集合。
- **回滚**：删掉 `ui_tabs` 记录即可回到空标签；代码回滚同时需要 revert 规格增量（BREAKING，规格与实现必须一起回退，不能只回一半）。
- **后端**：不动。`settings_get` / `settings_set` 已存在，无新命令、无 schema 迁移。
- **落地顺序**：先改测试锚点（把单槽位断言改成多标签断言）→ 状态模型（D1）→ 编辑面注册与 `isActive`（D4）→ 顶部布局与身份下沉（D2、D7、D9）→ 对账（D5）→ 持久化（D6）→ 键盘（D10）。

## Open Questions

- WebView2 是否把 `Ctrl+W` 交给页面——可通过一支最小探针在实现期确认。它只影响快捷键清单里的一项，不改变规格、做法或任务拆分。
