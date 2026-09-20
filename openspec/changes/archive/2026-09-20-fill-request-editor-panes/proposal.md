# Proposal: fill-request-editor-panes

## Why

请求编辑器的正文区没有统一的满高策略：raw 正文编辑器写死 220px 高，窗口再大下方也是一片空白；Params / Headers / form-data / urlencoded 的键值表随整页滚动，行多时表头与类型行一起滚出视野。对齐 Postman 的实际形态——编辑区永远占满剩余高度，内容在各自区域内滚动。

## What Changes

- Body 标签的 raw 正文编辑器改为铺满正文区剩余高度（去掉写死的 220px，复用 Scripts / cURL 页已有的 `fill` 机制）。
- Params、Headers、x-www-form-urlencoded、form-data 四张键值表统一改为「满高容器 + 区域内滚动」：表格容器占满正文区剩余高度，行多时在容器内滚动，表头吸顶（机制已有，吸顶偏移量随滚动容器下沉而修正）。
- 上述标签页的正文区（`.pane-body`）统一进入铺满模式；binary 只有一行提示，自然落在顶部，不做特殊处理。
- 幽灵行机制、表头吸顶行为、格式化动作与错误提示的位置均保持不变。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `ui-layout`: 新增要求——请求编辑器的 raw 正文编辑器 SHALL 铺满正文区剩余高度；Params / Headers / form-data / urlencoded 键值表 SHALL 以满高容器承载并在容器内滚动、表头吸顶。既有 Scripts / cURL 铺满要求不变。

## Impact

- `src/components/RequestEditor.tsx`: pane-body 的 `fill` 条件扩展到 body / params / headers 页；body 页内层 `div.stack` 需打通 flex 链路（`flex: 1; min-height: 0`）；raw 的 `CodeSurface` 由 `height={220}` 改为 `fill`。
- `src/App.css`: 内层 stack 的拉伸规则；键值表滚动容器的样式；`thead th` 吸顶 `top` 值随滚动容器下沉修正（从相对 `.pane-body` 的 `-var(--space-4)` 改为相对表格容器的偏移）。
- 测试：happy-dom 层 CodeSurface 为保形 mock，`height`/`fill` 不进 props，既有单元断言不受影响；真实视觉由 `tests-browser` 验证。
