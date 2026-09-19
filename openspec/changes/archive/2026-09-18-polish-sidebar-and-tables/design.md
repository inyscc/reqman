## Context

当前侧栏结构（`App.tsx:902-949`）：`.sidebar` > `.sidebar-head`（只读工作区名，将被删）> `.sidebar-tabs` > `.sidebar-body`。`.sidebar-body`（`App.css:144-149`）是 `flex:1; overflow:auto; padding:10px`，内部直接渲染 `WorkspaceTree` 的 `.stack`，而 `.stack` 把搜索工具栏（`.tree-toolbar`）与集合列表（`.tree-root`）一起卷动。

表格现状：`RequestEditor.tsx` 的 `KeyValueTable`（params / headers / url_encoded）已有启停 checkbox + 末列删除按钮，但删除按钮**常驻**；`FormDataEditor`（`:452`）有删除按钮但**无** checkbox 列；`VariablesPanel.tsx`（`:209`）末列常驻「揭示 + 删除」、无 checkbox。`App.css:964-976` 的 `table` 规则给每个 `td` 加 `border-bottom`，满屏横线。全局无任何 `::-webkit-scrollbar` 定制，WebView2 默认滚动条约 17px 粗。

## Goals / Non-Goals

**Goals:**
- 侧栏头部去除、树行禁选、集合列表独立滚动、细滚动条、表格 Postman 风格（轻行 / hover / 吸顶 / 行操作按需显现）。
- 改动集中在 CSS 与少量 TSX 标记，不引入新依赖、不改变数据模型。

**Non-Goals:**
- 不做工作区切换功能（超出打磨范围）。
- 不引入真正的悬浮（overlay）滚动条库——仅用细 CSS 滚动条近似，理由见风险。
- 不为变量表新增「启停」概念（变量无启停用意，变量表只做行操作按需显现）。

## Decisions

**D1 — 删 `sidebar-head`**：直接删除 `App.tsx:905-908` 的 `.sidebar-head` 块，侧栏从 `.sidebar-tabs` 起。无行为变化（`ui-layout` 从未要求该头部）。

**D2 — 树行禁选**：在 `App.css` 的 `.node`（或 `.tree`）上加 `user-select: none`。作用域限定在 `.node`，不波及 `.tree-search-input`（输入框本身不受祖先 `user-select:none` 影响编辑，且搜索框拖选仍可用）。

**D3 — 集合列表独立滚动（方案 A，非 sticky）**：把 `.sidebar-body` 改为 `display:flex; flex-direction:column; overflow:hidden; padding:0`；`.sidebar-body > .stack`（唯一直接子节点是 `WorkspaceTree` 根；`.stack` 为共享工具类、在 15 处面板内复用，绝不可全局改）加 `flex:1; min-height:0`；将 `.tree-root`（`ul`，`:573`）设为滚动容器 `flex:1; min-height:0; overflow:auto; padding:0 10px 10px`，`.tree-toolbar` 保持 `flex:none` 并自带上内边距。空态提示（「暂无集合」「没有匹配的请求」）作为 `.stack` 中 `flex:none` 兄弟节点留在工具栏下、滚动区上。
- *备选 B（sticky 工具栏）*：仅给 `.tree-toolbar` 加 `position:sticky`，但 `.sidebar-body` 的 `padding:10px` 会让 sticky 顶部留 10px 缝隙，且滚动条轨道仍贯穿搜索框那一列，观感不达标，故弃用。
- 副作用：Environments tab 同样落在 `.sidebar-body` 内，`.env-panel` 需 `flex:1; min-height:0; display:flex; flex-direction:column`，`.env-list` 加 `flex:1; overflow:auto; min-height:0` 才能在收束后的侧栏内滚动。

**D4 — 细滚动条**：全局加
```
::-webkit-scrollbar { width:6px; height:6px; }
::-webkit-scrollbar-thumb { background: rgba(16,24,40,0.28); border-radius:3px; }
::-webkit-scrollbar-track { background: transparent; }
* { scrollbar-width: thin; scrollbar-color: rgba(16,24,40,0.28) transparent; }
```
不设置 `scrollbar-gutter`，避免额外占用宽度。

**D5 — 表格 Postman 风格**：
- 轻量化：`td` 的 `border-bottom` 改为更淡（或仅 hover 时用分隔），`th` 更淡更小。
- 行 hover：`tbody tr:hover { background: var(--panel-2); }`。
- 吸顶表头：`thead th { position: sticky; top:0; background: var(--panel); z-index:1; }`，相对最近的滚动祖先（请求编辑器的 `.pane-body` / 主区滚动容器）生效；表短时自然不吸顶。
- 「选中」按 `:focus-within` 解释：行内任一输入框/控件获得焦点即视为选中，删除按钮显现且不依赖 hover；hover 用 `:hover`。两者独立，天然满足「选中优先级高」（焦点行无需 hover 也显）。

**D6 — form-data 补 checkbox**：在 `FormDataEditor` 每行首列加 `<td><input type="checkbox" checked={row.enabled} onChange={...update(index,{enabled})}></td>`，表头补一个首列空 `th`。`FormRow` 已有 `enabled` 字段（`RequestEditor.tsx:439` 的 `EMPTY_FIELD`），无需改模型（`enabled` 已持久化于存储，切换即写入草稿、保存时落库）。但 TS 清洗层 `withoutEmptyRows`（`src/lib/rows.ts`）当前只剔**空行**、不读 `enabled`——params/headers 此前靠 Rust 侧才排除停用行、对 form 并不保证——因此新增发送专用 `cleanForSend`（`rows.ts`）：在 `withoutEmptyRows` 基础上**再按 `enabled` 过滤**（params/headers/urlencoded/form 一并），用于 `App.tsx` 的 4 个发送/预览/导出出口，且**始终传入 `cleanForSend(draft)`**（不再写 `dirty ? ... : null`）——因为 not-dirty 时 `inline:null` 会回退到仍含 `enabled:false` 的 stored 请求，form 停用行可能漏网；始终走清洗才能保证「停用行不进入发送」。落库保存仍走 `withoutEmptyRows`（只剔空行），停用的行以 `enabled:false` 落库、不被删除。

**D7 — 行操作按需显现（纯 CSS）**：给删除按钮加类名 `row-delete`（`KeyValueTable` / `FormDataEditor`），变量表给操作单元 `.var-actions` 同样处理；CSS：
```
tbody tr .row-delete, tbody tr .var-actions { opacity:0; transition: opacity .12s; }
tbody tr:hover .row-delete, tbody tr:focus-within .row-delete,
tbody tr:hover .var-actions, tbody tr:focus-within .var-actions { opacity:1; }
```
checkbox 列不受影响、始终可见。此方案零 JS 状态。

> 注：「选中」语义已与用户确认——指行内任一输入框/控件获焦（即 `:focus-within`），不引入行选中态；hover 用 `:hover`，两者独立，天然满足「选中优先级高」。

## Risks / Trade-offs

- [吸顶表头需滚动祖先] → 确认表格所在的 `.pane-body` / 主区确实是 `overflow:auto` 容器；若不是则补一个滚动包裹层，否则 `sticky` 无效。
- [细滚动条在 macOS 上为 overlay、近无效果] → 可接受，纯视觉增强，不降级功能。
- [user-select:none 潜在影响 a11y] → `.node` 为 `role=button`，禁选不影响键盘操作与读屏，风险低。
- [删 `sidebar-head` 改变侧栏高度] → 仅少一行，tab 对齐不受影响；用现有测试 / 视觉核对确认。
- [真·悬浮滚动条未实现] → 6px 透明轨道已贴近参考图观感；若后续确需零占位 overlay，再引入第三方库，本变更不纳入。
