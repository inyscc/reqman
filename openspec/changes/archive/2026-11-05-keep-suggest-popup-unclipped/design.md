# 设计：让正文里的补全浮层越过请求区边界

## D1 根因是祖先的 `overflow`，不是 `.code-surface`

探针在真实应用（1280×800 与 1000×700 两种窗口）上量到的事实：

| 祖先 | overflow | 位置 |
| --- | --- | --- |
| `.code-surface.fill` | visible | 编辑器宿主，早已放行 |
| `.pane-body.stack` | clip（margin 320px） | 正文区，只裁自身之外的 320px |
| `.request-region` | hidden | **真正裁掉面板右缘的一层** |
| `.main.with-response` | hidden | 分栏容器 |

1000×700 下：面板 `right = 802`，`.request-region` 右界 `675`，溢出 127px，`elementFromPoint` 在溢出部分命中的是下层元素——面板确实被裁。

## D2 选 `fixedOverflowWidgets`

Monaco 的这个开关把浮层从「编辑器内绝对定位」改为「viewport 固定定位」。fixed 元素的包含块是视口，祖先（不是它的包含块）的 `overflow` 裁剪不适用，因此不需要动任何布局样式。

替代方案都不合适：

- **放宽祖先的 overflow**：`.request-region` / `.main` 的 `hidden` 撑着分栏与区域内滚动，改 `clip` + `overflow-clip-margin` 会影响滚动容器的行为，且 320px 的魔数还要在每一层重复一次。
- **自造浮层**：spec 要求正文候选使用编辑器自身的补全面板（键盘、滚动、焦点语义与其它补全一致），自造等于把那条要求推翻。

## D3 之前为什么没开

`CodeSurface` 原有一条注释说「开了会让补全详情面板错位到编辑器上方」。这句是当时的推测，没有验证过。这次实测：面板位置贴着光标、详情面板没有错位、插入后光标归位，`code-surface` 与 `variable-hover-tip` 两个浏览器用例组全绿。注释已按实测结论改写。

## D4 溢出之后盖在相邻面板上，是预期

面板属于请求区，但视觉上会盖住响应区的一角。这是浮层的正常行为，与地址栏候选、变量悬停提示一致；要求面板「不裁切」和「不遮挡相邻内容」不可能同时成立，取前者。

## D5 回归护栏

单测渲染不出裁剪（happy-dom 没有排版），因此护栏必须在真浏览器里：

`tests-browser/variable-suggest.spec.ts` 新增一条用例，900×700 视口下打开正文候选，先断言「面板确实越过了请求区右边界」（否则这条用例没验到东西），再取面板四角内缩 4px 的点做 `elementFromPoint`，要求命中的元素仍在面板内。

把 `fixedOverflowWidgets` 改回 `false` 时该用例失败（四角为 `[true, false, true, false]`），证明它抓的是这次的问题，而不是一个恒真的断言。
