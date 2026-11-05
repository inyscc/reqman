# 正文候选面板被请求区裁掉

## 为什么

在 Body raw 里键入 `{{` 打开的候选面板，窗口一窄就被请求区的右边界裁掉右半边（用户截图里表现为「被挡住了」）。

面板是 Monaco 的补全面板，挂在编辑器内部（`position: absolute`）。请求区外面套着两层 `overflow: hidden`（`.request-region`、`.main.with-response`），正文区自己又是 `overflow: clip`——只要面板右缘越过请求区边界，就只剩左半截。

窄窗口下这几乎是必然：面板宽度由最长候选决定（名字 + 取值 + 来源，430px 左右），请求区宽度随分栏收缩，光标又常常停在一行的末尾附近。

## 改什么

`CodeSurface` 创建编辑器时打开 `fixedOverflowWidgets`：浮层改用 viewport 坐标系定位，包含块变成视口，祖先的 `overflow` 不再作用于它。

父容器的放行已经做过了（`.code-surface` 不设 `overflow: hidden`），但那不足够——真正下刀的是更外层。既有的 `overflow-clip-margin: 320px` 只管正文区自身的裁剪，管不到 `.request-region`。

## 不做什么

- 不把 `.request-region` / `.main` 的 `overflow: hidden` 改掉：请求区与响应区分栏的布局、拖动调整、区域内的滚动都依赖它。
- 不给正文自造浮层：spec 已经要求正文里的候选使用编辑器自身的补全面板（展开、滚动、键盘、焦点与其它补全一致）。

## 代价与验证

浮层坐标改由 Monaco 自己换算，因此要确认三件事：位置仍贴着光标、插入写回正确、其它浮层（变量悬停提示、脚本面 `pm.*` 的提示）不受影响。

- 真浏览器用例 `tests-browser/variable-suggest.spec.ts`「窗口变窄时列表仍完整可见」：900×700 下打开候选，取面板四角内缩 4px 的点做 `elementFromPoint`，命中的必须仍是面板自己。把开关关回去这条用例即失败（实测四角变成 `[true, false, true, false]`）。
- `code-surface` / `variable-hover-tip` / `variable-suggest-body` 全量复跑无回归。
