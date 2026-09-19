## Context

现状与约束（动机见 `proposal.md`）：

- 样式集中在单个 `src/App.css`（约 1260 行），17 个组件全部用 `className` 驱动，无 CSS Modules、无 UI 库、无设计系统。1260 行里既有通用规则也有一次性补丁（例如 `.sidebar-head` 已是死样式）。
- 约 19 处内联 `style`，其中混有静态几何（`width: 120` / `28` / `200` / `90`、`padding: '4px 10px'`）与硬编码颜色（`ResponsePanel.tsx` 的 `border: '1px solid #ddd'`）。
- **离线优先**：打包目标是 Windows 安装包，README 明确「离线、本地优先，不依赖云服务」。字体不能走 CDN，也不宜引入字体文件。
- `ui-layout`「浅色配色」规定浅色单主题且 `SHALL NOT 提供深色变体`；本次不触碰。
- `window-chrome` 规定无原生装饰、拖拽与窗口控制由页面承载，因此主区第一行必须是拖拽区，且拖拽区只能有一处。
- 已有的存储出口是 Rust 侧的 `settings_get` / `settings_set(scope, key)`，scope 为 snake_case 命名空间（既有 `script_gate`、`script_send_request`），key 为归属 id。`src/lib/commands.ts` 顶部明确「前端不直连存储与网络，全部能力都经这里的具名命令进入 Rust」。
- `tests/app.test.tsx` 目前用 `.crumb-bar`、`session-bar`、`session-tab` 作断言锚点，另有 4 处 `getByText('另存为')` / `getByText('删除')`。

## Goals / Non-Goals

**Goals:**

- 建立一组 token，使后续任何新增样式都有唯一落点，不再出现散落的 hex 与任意像素。
- 主区顶部 chrome 由两行减为一行，且当前请求名在界面上只渲染一次。
- 分栏比例可调，并按工作区记住。
- 全程不新增 npm 依赖、不新增字体文件、不改动 Rust 侧代码与数据 schema。

**Non-Goals:**

- 深色主题、侧栏折叠、命令面板、解析预览条默认折叠。
- 引入 CSS 框架、CSS-in-JS 或 UI 组件库。
- **图标系统**：窗口控制（手写 SVG）、工具栏（文本字符 `+` / `⧉` / `⌕`）、搜索框内联 SVG 三种来源混用的问题本次不统一，只清掉明显不合理的内联尺寸。统一图标需要先选定图标方案，属于独立变更。
- 不改动任何数据流、命令契约、持久化 schema 与请求发送行为。

## Decisions

### D0 视觉方向：冷中性 + 靛蓝主色 + 描边分层

**这是本变更中唯一决定「页面长什么样」的决策**，D1–D9 都是机制。没有它，`tasks.md` 1.1 与 1.5 无值可用。

**中性色阶**（偏蓝的冷灰，而非纯灰）：

| token | 值 | 用途 |
| --- | --- | --- |
| `--bg` | `#f7f8fa` | 应用底、侧栏底 |
| `--panel` | `#ffffff` | 面板、主区 |
| `--panel-2` | `#f1f3f6` | 输入框、次级控件、行悬停 |
| `--border` | `#e4e7ec` | 常规描边 |
| `--border-strong` | `#d3d8e0` | 需要强调的边界 |
| `--text` | `#1c2024` | 正文 |
| `--muted` | `#667085` | 次要文字、图标 |

**主色**：`#1a73e8` → `#4c6ef5`（靛蓝）。同时删掉全部 `color-mix(in srgb, var(--accent) 25%, transparent)` 用法——那层褪色的粉紫是当前「脏」的主要来源。新增 `--accent-soft: #eef1fe` 专供选中底。若要严格贴住 `ui-layout`「浅色配色」里「蓝色主色」的字面，退回 `#2563eb` 即可，其余不变。

**选中 / 悬停 / 活动 三态**（任务 1.5 需要的取值）：

| 态 | 表现 | 备注 |
| --- | --- | --- |
| 选中（当前对象） | `--accent-soft` 实底 + `--text` 文字 + 左侧 2px 主色标 | 左标用 `::before` 画，**不需要改 DOM** |
| 悬停（指针经过） | `--panel-2` 一档中性浅灰 | 不掺主色，与「选中」明确区分 |
| 活动（当前视图 / 标签页） | `--panel` 底 + 描边 | 靠「浮起」表达，不靠着色 |

**层次（elevation）**：不新增容器 DOM。三级阴影只给浮层，描边继续用 `border: 1px solid var(--border)`。

> 实现期修正：原本设计为用 `box-shadow: inset 0 0 0 1px` 替代 `border`，理由是「描边不占布局」。这个理由不成立——`* { box-sizing: border-box }` 已经保证显式设宽高的元素不受 border 影响。而转换的代价很大：文件里约 11 处用 `border: none` / `border-color: transparent` 抹平按钮边框的规则（`.icon-button`、`.window-controls button`、`button.ghost`、`.node-menu button`、`.tree-toggle`、`.node-more`、`.tree-search-input`、`.tree-search-clear`、`.preview-toggle`、`.script-pane-list button`、`.var-editor .var-edit`）抹不掉 `box-shadow`，会静默长出边框。收益（自动宽高元素的 2px 与略干净的圆角）抵不上这个风险，故保留 `border`。

层次靠「浮层有阴影、平面只有描边」这一档差表达：

```css
--shadow-1: 0 1px 2px rgba(16, 24, 40, 0.04);
--shadow-2: 0 4px 12px rgba(16, 24, 40, 0.08), 0 1px 2px rgba(16, 24, 40, 0.04);
--shadow-3: 0 18px 48px rgba(16, 24, 40, 0.16);
```

**圆角 2 档**：`--radius-sm: 4px`（控件、标签、行）、`--radius-md: 8px`（面板、模态）；`999px` 只留给徽章的 pill 形态。

**字号 4 档**：`--text-xs: 11px`（元信息、徽章）、`--text-sm: 12px`（树、表格、按钮）、`--text-base: 13px`（正文、输入）、`--text-lg: 15px`（区块标题、模态标题）。

**间距**：`--space-1: 2px`、`--space-2: 4px`、`--space-3: 6px`、`--space-4: 8px`、`--space-5: 12px`、`--space-6: 16px`。

**固定高度条里的控件必须紧凑化**（实现期发现的规则，改动前它被违反了三次）：`.sidebar-tabs` 与 `.session-bar` 靠 `--chrome-row`（40px）显式等高，`.status-bar` 在 `.app` 的网格里写死 32px。这些条内部的按钮 SHALL 使用紧凑内边距，SHALL NOT 沿用全局 `button` 的内边距——全局值是按独立按钮设计的，放进固定高度的条里会把条撑满甚至溢出。此前 `.session-tab` 里那个 `×` 关闭按钮就把会话标签行顶到 55.5px（而侧栏 tab 行只有 45.5px，两条下边线差 10px），底栏的三个入口按钮也把 32px 的栏塞满。

**动效基线与边界**：按下反馈 120ms、悬停显隐 120ms（沿用既有 `0.12s`）、浮层入场 180ms；缓动 `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`、`--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)`。

**明确不加动效的地方**：树节点展开折叠、切换标签页、切换请求、发送中的状态切换。这些都是每天几十到上百次的操作，动效只会让它们显得慢；只有「偶尔发生」的浮层（模态、节点菜单、下拉）才配入场过渡。这条边界必须写进实现——否则很容易顺手给树节点加上展开动画。

**替代方案（否）**：保留 Google 蓝 + 暖中性——改动最小、最贴项目一路「对齐 Postman」的取向，但效果最接近现状。突破「不改 DOM」加容器分层——效果最好，但边界代价见 Risks 第一条。

### D1 token 落在 `App.css` 的 `:root`，保留既有变量名

保留 `--bg` `--panel` `--panel-2` `--border` `--text` `--muted` `--accent` `--accent-fg` `--danger` `--warn` `--ok` 这 11 个既有名字——它们已被 1260 行样式引用，改名会淹没 diff。新增的量另起前缀：`--space-*`（4 的倍数）、`--radius-*`（2 档）、`--shadow-*`（3 档）、`--text-*`（字号分级）、`--ease-*`（缓动）。

**替代方案（否）**：引入 CSS 框架或 CSS-in-JS。违背「不新增依赖」，且需要整体迁移 1260 行样式，收益与风险不成比例。

### D2 字体：纯系统字体栈 + 字号分级

UI 用 `'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif`；等宽用 `'Cascadia Mono', Consolas, ui-monospace, monospace`。字号分四级：正文 13px、树与表格 12px、元信息 11px、会话标签名称 13px semibold。

丑的根因是「全站只有一个字号」，不是「字体不够洋气」。Windows 上 Segoe UI Variable 本身就是为 UI 设计的字体，且零体积。

**替代方案（否）**：`@fontsource-variable/inter`。离线可用，但 +1 依赖、+约 100KB 包体，换来的是跨平台一致性——而本产品的交付目标只有 Windows。

### D3 顶部一行化的 DOM 结构

`.main` 的 `grid-template-rows` 由 `auto auto minmax(0, 1fr)`（session-bar / crumb-bar / 请求+响应）改为 `auto minmax(0, 1fr)`。`.crumb-bar` 元素消失，其内容并入 `.session-bar`。

`.session-bar` 内部从左到右：

```
[ 集合名 › METHOD 名称输入框 × ]  <grow>  [未保存][保存]  [另存为][删除]  [环境选择器]  [– □ ✕]
        ^ 标签 + 面包屑合成同一个元素
```

保留 `data-testid="session-bar"` 与 `session-tab`；`tests/app.test.tsx` 中针对 `.crumb-bar` 的断言改为针对合并后元素。

**替代方案（否）**：新增一层 `app-header` 行。该行在没有品牌内容时约 80% 是空白，且会造出第二个候选拖拽区——`window-chrome` 的三条 requirement 都要重写（当前三条都把「紧贴窗口上沿 / 拖拽 / 窗口控制位置」钉在会话标签行上）。合并方案只需往拖拽区的排除清单里加一项。

### D4 拖拽区排除清单用 `input` 通配，而非枚举类名

```48:48:src/components/ResizeStrips.tsx
return Boolean(target?.closest('button, select, .env-select, .window-controls'));
```

扩为 `button, select, input, textarea, .env-select, .window-controls`。合并后请求名与实体名两个输入框都落在这一行，`input` 通配一次覆盖，未来新增输入控件也不会再漏。

**替代方案（否）**：给名称框加专用类名再枚举。每加一个输入就要记得回来补一次，漏了就是「在名称框里拖选文字结果窗口飞走」。

### D5 方法徽章：新建 `.method-badge`，按幂等分两组

`.badge` 当前承担六种语义（方法、「环境」、「集合」、「文件夹」、「使用中」、「未保存」），无法容纳方法专属的配色。新建 `.method-badge`。

分组依据是**是否幂等**（而不是按方法名各配一色）：幂等组 `GET` `HEAD` `OPTIONS`，有副作用组 `POST` `PUT` `PATCH` `DELETE`，未知与自定义方法归入第二组。颜色只表达「这个请求会不会改数据」，方法之间的区分由文字本身承担。

三处共用：集合树的 `.tree-method`、会话标签行的方法徽标、请求编辑器的方法选择框。

方法选择框是原生 `<select>`，`<option>` 无法着色（各平台渲染不一致）。做法是用 `appearance: none` 让容器承载徽章配色，并按当前方法着色，**保留下拉行为与键盘操作的原生实现**。

**替代方案（否）**：换成自绘下拉以完全控制呈现。那是交互层面的改动，会牵动 spec 未规定的键盘与无障碍行为，以及现有一批围绕 `<select>` 的测试。

### D6 响应区工具条：合并只发生在 `pane-header` 之内

`pane-header` 里当前塞了「响应」+ 最多 6 个 badge + tabs + 「保存全文」，且带 `flex-wrap: wrap`，窗口一窄就折行，高度不可预测。改为：元信息（status / elapsed / size / http_version / 代理）收成一段紧凑的等宽文本（status 仍单独着色），去掉 `flex-wrap` 改为 `overflow: hidden` + 次要项可截断，使头部高度恒定。

**对提案措辞的修正**：提案写的是「两层并为一层」。实现时发现这两组标签属于不同维度——`pane-header` 的 tabs 是「看响应的哪一部分」（Body / Headers / 脚本），`pane-body` 内的是「同一部分的哪种呈现」（原始 / 格式化）。把它们塞进同一组标签会造成语义混淆，用户无法判断点「格式化」会不会丢掉当前所在的 Headers 视图。

因此决定：**不合并这两组**，改为把「原始 / 格式化 + content_type」这一行收紧成紧凑工具条（高度约 34px → 约 26px），并把 `.pane-body` 作为 `.stack` 的 8px gap 收到 4px。垂直回收量约为原估的一半。

**替代方案（否）**：合并成一组。省下的约 34px 抵不上视图维度被混淆的代价。

### D7 分栏拖拽：真实 gutter 列 + CSS 变量承载比例

`.main.with-response` 当前是 `grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)`。改为三列，中间插一个固定宽度的 gutter 作为分隔线的命中区：

```
grid-template-columns: minmax(0, var(--split, 50%)) 5px minmax(0, 1fr);
```

拖动时只写 `--split` 一个变量；`pointerup` 时才落库。落库走既有设置接口：

```
scope = 'ui_layout', key = <workspaceId>, value = <比例的字符串形式>
```

读取缺失或不可解析时回落默认比例。非激活工作区不写。

**替代方案（否）**：`localStorage`。技术上可行，但直接违背 `src/lib/commands.ts` 确立的契约——「前端不直连存储与网络，全部能力都经这里的具名命令进入 Rust」。为一条 UI 偏好开一个例外，会让这条契约失去约束力。

**替代方案（否）**：弹簧动效。`animate` 与 `apple-design` 的弹簧方案针对的是可被 GPU 合成的变换；分栏拖动本质是布局重排（`grid-template-columns`），弹簧只会让跟手感变差。

### D8 请求级操作按需显现用 `visibility` 而非条件渲染

「另存为」「删除」保留文字标签，在无悬停且行内无焦点时不可见。

用 `visibility: hidden` 而不是 `display: none`，也不做条件渲染，有两个理由：

1. 新的 spec 场景要求「显现与隐藏 SHALL NOT 改变该行的布局宽度」——`visibility` 保留占位，`display: none` 会让这一行宽度突变；
2. `tests/app.test.tsx` 的 4 处 `getByText('另存为')` / `getByText('删除')` 依赖元素存在于 DOM，条件渲染会让它们失败。

同时依赖与既有惯例一致：`.row-delete` / `.var-actions` 已在 `ui-polish` 中用「悬停或行内焦点时显现」的规则处理。

### D9 内联 `style` 只保留真正动态的值

静态几何与配色一律进 CSS 类；内联 `style` 只用于运行时才知道的值（拖拽中的 `--split`、按数据着色的项）。需要清理的具体项：`ResponsePanel.tsx` 的 `border: '1px solid #ddd'` 与 `wordBreak`、`RequestEditor.tsx` 的 `width: 120` / `28` / `200` / `90` / `auto` 与 `padding: '4px 10px'`、`VariablesPanel.tsx` 与 `PreviewBar.tsx` 的若干静态值。

## Risks / Trade-offs

- **「不改 DOM」这个约束压住了层次感的上限** → `inset` 描边加背景色阶能把这个界面做到「整洁、有秩序、不脏」，但做不到需要容器 DOM 分层的卡片式层次。这是 A 的边界代价，已与用户确认接受；若要突破，需要另起一个放宽该边界的变更，而不是在本变更里偷偷加容器。

- **拖动时分栏两侧的 sandbox iframe 会吞掉 `pointermove`**（响应区有 `iframe.preview` 与可视化 iframe）→ 拖动开始时给两侧 pane 加 `pointer-events: none`，或在最上层铺一个透明遮罩承接指针事件，`pointerup` 时移除。
- **`grid-template-columns` 是布局属性，无法走 GPU 合成**，宽窗口下拖动可能掉帧 → 用 `requestAnimationFrame` 节流，每帧只写一次变量；拖动期间 `user-select: none` 且把光标固定为 `col-resize`。
- **CSS 变量写在父元素上会重算全部子元素样式** → 拖动期间只写 `--split` 这一个变量；若实测掉帧，退化为直接写 `element.style.gridTemplateColumns`。
- **删掉 `.crumb-bar` 会挂测试** → 同步更新 `tests/app.test.tsx` 的 3 处锚点断言；「另存为 / 删除」的 4 处保持不动。
- **方法选择框 `appearance: none` 后失去原生下拉箭头** → 用纯 CSS 画一个 caret，下拉与键盘行为仍是原生的。
- **token 收敛是全量替换，容易遗漏** → 在任务里收一条终检：搜出 `App.css` 与 `src/**` 中残留的 hex / rgba / 任意像素值并逐条归类。
- **5 色收敛为 2 组是有损的**（方法之间的颜色区分度下降）→ 可辨识度由方法名文字承担，颜色只表达「是否改数据」这一档语义，符合 spec 新增的「方法标签视觉权重 SHALL NOT 重于名称」。
- **顶部一行信息密度升高**，窄窗口下环境选择器可能被挤压 → 该行设为 `overflow: hidden`，让面包屑与集合名先截断；环境选择器与窗口控制按钮为 `flex: none`，对应 `window-chrome` 的「互不遮挡」要求。

## Migration Plan

无数据迁移。新增一条 settings 记录（`scope='ui_layout'`, `key=<workspaceId>`），读取缺失时回落默认比例；回滚只需撤回前端代码，遗留的 settings 行不影响任何行为。

实现顺序（每一阶段结束时测试应当可运行）：

1. 建立 token 与视觉基底——**不改 DOM**，先把颜色、字号、间距、圆角、层次替换到位。
2. 合并顶部两行——改 DOM，一并更新 `tests/app.test.tsx` 的断言。
3. 方法徽章收敛。
4. 分栏拖拽与比例持久化。
5. 响应区工具条收紧、主区留白收紧、内联样式清理、硬编码终检。

## Open Questions

无。比例下限、gutter 宽度、默认比例的取值都是实现期可定的小数，不影响 spec、方案与任务拆分。
