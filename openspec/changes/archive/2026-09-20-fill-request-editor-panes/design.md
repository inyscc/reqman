# Design: fill-request-editor-panes

## Context

请求编辑器已有两套高度策略并存（见 `src/components/RequestEditor.tsx` 与 `src/App.css`）：

- Scripts / cURL 页：`.pane-body.fill`（正文区不滚，`overflow: clip + clip-margin` 保 Monaco 浮层）+ `CodeSurface` 的 `fill` prop（`.code-surface.fill { flex: 1; min-height: 200px }`）。
- Body / Params / Headers 页：`.pane-body` 自身滚动；raw 正文写死 `height={220}`；键值表整页滚动，表头吸顶偏移按 `.pane-body` 的 `padding: var(--space-4)` 写为 `top: calc(-1 * var(--space-4))`。

flex 链路上，Body 页比 Scripts 页多一层：`tab === 'body'` 的内容包在内层 `div.stack` 里，该层目前没有任何拉伸约束——链路会在这里断掉（Scripts 页由 `.script-pane-editor` 的 `flex: 1; min-height: 0` 兜住了中间层）。

## Goals / Non-Goals

**Goals:**

- raw 编辑器、四张键值表统一进入「满高 + 区域内滚动」。
- 复用既有 `fill` 机制，不新发明一套布局系统。

**Non-Goals:**

- 不改 Auth / Settings / cURL 页的布局（cURL 已铺满，其余为短表单）。
- 不改幽灵行、空行判定、格式化动作等表格行为逻辑。
- 不改响应区布局。

## Decisions

**D1 — pane-body 的 fill 条件扩展，不重构 RequestEditor。**
`pane-body` 的 className 条件从「scripts / curl」扩展为「scripts / curl / params / headers / body」。备选是给每个标签页各自定滚动策略——否，八个标签页两套策略已经够分裂，满高是统一形态。

**D2 — 打通 flex 链路：body 页内层 `div.stack` 加条件类。**
为内层 stack 增加一个修饰类（如 `.stack.fill`：`flex: 1; min-height: 0`），仅当该页需要铺满时挂上。备选是让 `.pane-body > .stack` 无条件拉伸——否，Auth / Settings 页的 stack 不该被拉伸，条件类比结构选择器更准确。

**D3 — raw 的 `CodeSurface` 用 `fill` prop 替换 `height={220}`。**
机制现成：`fill` 时忽略 height，`.code-surface.fill` 给出 `flex: 1; min-height: 200px`。`min-height: 200px` 顺带成为小窗口下的高度下限。

**D4 — 键值表滚动容器做进 `KeyValueTable` / `FormDataEditor` 自身。**
两套表格的 `.stack > table` 外再包一层满高滚动容器（`flex: 1; min-height: 0; overflow: auto`），body 与 params / headers 三个入口共用同一容器样式。备选是把滚动留在 `.pane-body`——否，那样类型行会随内容滚走，且满高无从谈起。

**D5 — 表头吸顶偏移换参照面。**
滚动容器下沉到表格容器后，`thead th` 的 `top` 从 `calc(-1 * var(--space-4))` 改为相对新容器的偏移。若容器不带 padding 即 `top: 0`；容器是否留 padding 在实现时对齐现状观感决定，但吸顶位置与容器内边距 MUST 一致，避免再出现「看起来没吸顶」的缝隙问题（该项目 CSS 注释里记载过同类教训）。

**D6 — `.pane-body.fill` 的 `overflow: clip + clip-margin` 继续只服务 Monaco 浮层。**
表格页容器正常 `overflow: auto`，两支不冲突；clip 方案不外溢到表格场景。

## Risks / Trade-offs

- [flex 链路某一层断掉，编辑器把正文区顶高而不是铺满] → 复用 `.script-pane-editor` 注释里记载的判据逐层核对 `min-height: 0`；真实视觉交给 `tests-browser`（happy-dom 无真实 layout，测不出这个）。
- [吸顶偏移算错，出现行内容穿透的缝] → 实现时以容器实际 padding 对齐 `top` 值，浏览器测试覆盖「滚过若干行后表头下无穿透」。
- [单测层感知不到高度] → happy-dom 的 CodeSurface 保形 mock 不含 `height`/`fill` props，既有断言不受影响；本变更不为 mock 补高度断言（无意义），视觉验收以 `tests-browser` 为准。
- [类型切换（raw → form-data）时 fill 条件翻转引起滚动容器重建] → 键值表已有 `key={...draft.id}` 稳定身份；fill 翻转只影响容器类名，不重建表格组件状态。

## Migration Plan

单次提交的纯前端样式/结构修正，无数据迁移、无回滚负担；回归路径为既有单测 + `tests-browser` 视觉验证。

## Open Questions

（无）
