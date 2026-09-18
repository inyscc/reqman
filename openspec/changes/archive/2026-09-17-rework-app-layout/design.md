# Design: rework-app-layout

## Context

当前 `src/App.tsx` 用 CSS Grid 三栏（`300px | minmax(420px,1fr) | minmax(360px,1fr)`）直出全部 UI：左栏把工作区选择器、环境选择下拉、四个面板开关（变量/导入导出/Cookie/设置）与 `WorkspaceTree` 堆在一个 `pane-body` 里；中栏是 `EntityScriptPanel` 或 `RequestEditor`；右栏是 `PreviewBar` + `ResponsePanel`。所有状态（`trees`、`draft`、`environments`、`environmentId`、`variables`、各面板开关）都挂在 `App` 上，布局改造是一次组件边界重划，不涉及后端命令层与 `lib/*`。

既有可复用件：`PreviewBar`（解析预览）、`VariablesPanel`（环境/全局变量双语义）、`CookiePanel` / `SettingsPanel` / `ImportExportPanel`（低频面板）、`EntityScriptPanel`、`ResponsePanel`（自带「响应」头部与 Body/Headers/脚本 tabs）。

目标形态见 proposal.md 与 `specs/ui-layout/spec.md`；布局参照 Postman 桌面端快照（`1.json`：侧栏 x 0..460、主区请求区 y37..757 / 响应区 y757..1368、底栏 y1373）。

## Goals / Non-Goals

**Goals:**

- 组件边界与 spec 的分区一一对应：侧栏（双 tab）/ 会话标签行 / 面包屑操作行 / 地址栏+预览条 / 请求编辑器 / 响应区 / 底栏+模态。
- 状态不下放就下钻：`App` 仍是唯一数据源，布局组件只做受控渲染；避免引入状态管理库。
- 面板复用优先：除布局容器与两个新面板（环境列表、模态壳）外，尽量不改既有组件内部逻辑。

**Non-Goals:**

- 不引入拖拽分栏、多开会话标签、深色变体与主题切换、工作区切换 UI（均为 proposal 非目标）。
- 不引入路由库或组件库；模态与 tab 用现有 CSS 变量手写。
- 不改 `lib/commands`、`lib/types`、Tauri 后端。

## Decisions

### D1: 布局骨架从 CSS Grid 三栏改为「侧栏 + 主区」两段式

`.app` 改为 `grid-template-columns: 280px 1fr` + `grid-template-rows: 1fr 32px`（底栏跨两列）；侧栏自身 `grid-template-rows: auto 1fr`（tab 条 + 内容）。

主区是 `grid-template-rows: auto auto minmax(0, 1fr)`（会话标签行、面包屑行、请求/响应行），列数按可见性切换：

```
.main                  { grid-template-columns: minmax(0, 1fr); }              <- 未选中请求
.main.with-response    { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } <- 选中请求
```

会话标签行与面包屑行跨全部列（`grid-column: 1 / -1`）；请求区占第 3 行第 1 列；响应区占第 3 行第 2 列并只在选中请求时渲染——未选中时请求区（或实体脚本面板）独占整宽。响应区用 `border-left` 与请求区相隔。

理由：列的显隐用「条件渲染 + 一个类名」表达，仍是纯 CSS Grid 的固定比例，无 JS 拖拽逻辑，符合 Non-Goal。备选「始终保留响应列、仅清空内容」会留下一块空栏，与「只有选中请求才显示响应栏」冲突。

### D2: 侧栏双 tab 用受控状态，tab 键放 `App`

`sidebarTab: 'collections' | 'environments'` 存于 `App`，两个 tab 内容互斥渲染。Collections tab 直接复用现有 `WorkspaceTree`（props 不变）。Environments tab 新增 `EnvironmentsPanel`：左侧环境列表（含 Globals 固定项）+ 右侧复用 `VariablesPanel`。

理由：tab 状态影响面小（只决定侧栏渲染哪个分支），放 `App` 即可；下钻 props 而非 context，与现状一致。

### D3: 环境激活与变量展示的落点

`EnvironmentsPanel` 内部以 `environmentId`（已在 `App`）为激活态：点击环境项 → `setEnvironmentId(id)`；点击 Globals → `setEnvironmentId(null)`。`VariablesPanel` 的现有逻辑（`environmentId ? environment : global`）天然满足两种视图，无需改动，仅作为 Environments tab 的右半部分嵌入。

备选：保留顶部环境下拉 + tab 只做展示。否决——与「无环境选择下拉」需求冲突，且两个激活入口会互相打架。

### D4: 解析预览从独立栏改为地址栏下的折叠条

`PreviewBar` 内容（方法徽标、解析 URL、masked/代理徽标、未解析警告、Cookie 行、insecure 警告）整体保留，外面包一层 `PreviewStrip`：头部是折叠控件（caret +「解析预览」+ 未解析计数徽标），默认展开。未解析变量警告（`data-testid="unresolved-warning"`）从折叠体内提到折叠体外的常驻区域，折叠时仍可见——这是 spec「未解析变量警告常驻」的实现点。

理由：改动最小且保住 spec 硬要求。备选「解析结果内联进地址栏（Postman 式）」更贴原图，但要求重写 `PreviewBar` 的呈现层，且多行警告塞不进地址栏，先不做。

### D5: 低频面板模态化，单例模态壳

`modal: 'cookies' | 'settings' | 'import-export' | null` 存于 `App`；新增 `Modal` 容器组件（遮罩 + 居中卡片 + 关闭按钮 + `Escape` 关闭），内容分别复用 `CookiePanel` / `SettingsPanel` / `ImportExportPanel`。底栏右侧三个按钮触发。`ImportExportPanel` 需要的 `exportCollectionId` / `exportSendInput` / `reloadAfterImport` 逻辑不变，只改宿主。

备选：覆盖式抽屉（drawer）。模态更省侧栏空间且实现简单，与「同一时间至多一个模态」语义吻合。

### D6: 会话标签视觉壳 + 面包屑操作行归属 `App` 主区

会话标签行：方法徽标 + `draft.name`（选中实体时显示实体名），右侧 `×` 只清空选中（无多开语义）。面包屑行：`draft` 所属集合名（从 `trees` 查找 `draft.collection_id`）/ 请求名 + 保存/另存为/删除按钮。这三颗按钮当前在 `RequestEditor` 的 pane-header 里，上移到面包屑行后从 `RequestEditor` 移除。

`RequestEditor` 保留方法/URL/发送地址栏与六 tab 内容，tab 命名改为 Params/Authorization/Headers/Body/Scripts/Settings（值不变，仅显示文本）。

### D7: 底栏布局

左：状态/提示（`busy`、错误摘要、`optimisticErrors` 入口从右栏 header 搬来）；右：Cookie / 设置 / 导入导出 三个模态按钮。脚本门禁（`scriptGate`）与全局错误提示仍属于主区内容，继续放在请求区顶部（不变，避免模态套模态）。

### D8: 工作区状态保留，切换 UI 移除

`workspaces` / `workspaceId` state 与加载逻辑不动（仍取 `workspaceActive() ?? list[0]`），仅删除 `<select aria-label="工作区">` 与相关渲染。后端多工作区能力保留。

### D9: 配色换成单一浅色调色板（追加范围）

参照图是 Postman 的浅色外观：白底、浅灰分隔、深色文字、蓝色主色（图里的 Send 按钮也是蓝的，因此不改主色相）。实现方式是把 `App.css` 的 `:root` 令牌整体替换，并清掉三处硬编码深色。

| 令牌 | 深色（原） | 浅色（新） | 用途 |
|---|---|---|---|
| `--bg` | `#14161a` | `#f6f7f9` | 页面底 |
| `--panel` | `#1b1e24` | `#ffffff` | 侧栏 / 头部 / 面板 |
| `--panel-2` | `#22262e` | `#f1f3f5` | 输入框、次级按钮、hover、选中项底 |
| `--border` | `#2e333d` | `#e3e6ea` | 分隔线 |
| `--text` | `#e6e9ef` | `#1f2329` | 正文 |
| `--muted` | `#98a1b3` | `#6b7280` | 次要文字 |
| `--accent` | `#4c8dff` | `#1a73e8` | 主色（浅底上需更深的蓝才有对比度） |
| `--danger` | `#ff6b6b` | `#d92d20` | 错误 |
| `--warn` | `#ffb454` | `#b54708` | 警告 |
| `--ok` | `#4ec9a0` | `#067647` | 成功 |
| `color-scheme` | `dark` | `light` | 原生控件配色（滚动条、下拉） |

硬编码色处理：新增 `--accent-fg: #ffffff` 并让 `button.primary` 的文字改用它（原来是给深底配的 `#0b1220`）；模态遮罩改 `rgba(16, 24, 40, 0.42)`、模态阴影减淡；`pre.body` 的代码底色改 `#f6f8fa`。`iframe.preview` 的 `#fff` 保留——它承载的是响应文档本身，与主题无关。

理由：令牌本来就是集中的，替换面小、无行为变化，也不需要动任何组件逻辑。备选「浅/深双主题 + 切换开关」被否决：需要主题状态、持久化（`settingsGet/Set`）与入口，属 roadmap P1 的独立 change，proposal 的非目标已排除。

## Risks / Trade-offs

- [测试大面积失效：`tests/app.test.tsx` 依赖旧布局的定位器（`工作区`/`环境` label、面板开关文本、`scripts` tab 文本、`揭示`等）] → tasks 中单列测试迁移任务：以用户旅程重写定位器（先点 tab/模态再断言），删除被移除入口的用例；`app.test.tsx` 是全量回归，必须全绿后才归档。
- [`VariablesPanel` 的标题行写着「环境变量/全局变量 · 作用域」，嵌进 tab 后语义重复] → 保留但允许在 Environments tab 内隐藏其头部行（`VariablesPanel` 加一个可选 `hideHeader` prop，默认 false，浏览器测试不受影响）。
- [窄窗口下左右分栏会让请求区与响应区都变挤] → 响应栏只在选中请求时出现（未选中时请求区独占整宽），两列以 `minmax(0, 1fr)` 等分避免横向溢出，两个区域各自独立滚动；后续真要拖拽再作为独立 change。
- [URL 中 `{{var}}` 高亮：原生 `<input>` 无法局部着色] → 本期用「输入框 + 同尺寸透明叠层渲染高亮」的常见技巧，或退一步仅让预览条承担解析展示。作为实现细节在任务里以叠层方案为准，失败则降级为仅预览条（spec 场景只要求高亮呈现，不限定载体）。

- [浅色下若沿用深色的 `--warn` / `--danger` / `--ok`，在白底上会发飘、对比度不足] → 三色按浅底重取（见 D9 表），并在预览里逐个确认未解析变量警告、错误提示与响应状态徽标可读。

## Open Questions

- 会话标签的 `×` 是否需要「未保存确认」？当前 `selectRequest` 直接切换且 dirty 会被覆盖，是既有行为，本期不新增确认。
