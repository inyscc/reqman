## Context

Console 的行是 `<button className="console-line">`。这个选择当初是为了「整行可点、键盘可达」，代价是文字不可选：Chrome 的 UA 样式给 button 设了 `user-select: none`，而「不可展开」的输出行更是用了 `disabled`——disabled 元素连焦点与选择一起关掉。详情区（`<table>`、`<pre>`）是普通元素，一直可选，于是最常被复制的那一行恰好是唯一拿不到的。

## Goals / Non-Goals

**Goals**

- 一行日志的文字能用鼠标拖选、用系统的复制动作取走。
- 不想拖选时，一个入口就能把整行带走（粘到工单、聊天里仍然看得懂是谁打的）。
- 复制失败不能装作成功。

**Non-Goals**

- 不做「复制全部 / 复制筛选结果 / 复制为 cURL」这类派生动作：这次只解决「把看见的东西带走」，多出来的动作各自都需要自己的规则（复制范围要不要含请求头？截断的正文算不算全？）。
- 不把展开后的详情塞进复制内容。详情区本来就能框选，两套复制范围叠在一起只会让人猜。
- 不做格式化（去缩进、压空白）。复制出来的应与看到的一致。

## Decisions

### D1 行容器从 `<button>` 换成 `<div role="button" tabIndex={0}>`

三个问题一次解决：

1. `user-select`——div 没有 UA 的禁选规则，文字恢复可选。
2. `disabled`——不可展开的行改用 `aria-disabled="true"` + 点击不入栈，语义还在（辅助技术读得出不可展开），选择能力不再被一并没收。
3. **button 里不能放 button**——复制入口要落在行尾，按钮嵌套按钮是非法结构，浏览器会把内层拆出去，点击行为不可预期。换成 div 后投影天然成立。

代价是键盘行为要自己写：Enter / 空格触发展开，空格还要 `preventDefault`（否则会滚一屏）。这部分收在一个 `onRowKeyDown` 里，两种条目共用。

### D2 选区非空时，点击不切换

拖选的 `mouseup` 会落在同一行上，`click` 照常派发。不拦的话「选一段文字」= 「顺手折叠/展开」。守卫放在点击处理的第一行：

```
if (window.getSelection()?.toString()) return
```

只在行级 click 上判断，复制按钮自己 `stopPropagation`，不受影响。

### D3 文本表示是 `consoleLog.ts` 里的纯函数 `entryToText`

放 lib 而不是组件里，理由与 `filterEntries` 一样：它是「条目说什么」的一部分，不是布局。单测直接喂条目断言字符串，不用渲染。

结果措辞与搜索用的 `haystack` 共用同一个 `resultText()`——同一个终态在两处不能有两种叫法（搜索里「失败」、复制里「错误」会让人怀疑是不是两回事）。`haystack` 保持只含可匹配的字段（方法 / URL / 结果），`entryToText` 在其上补人的排版：

- 网络：`POST https://api.test/1 — 200 OK 99 ms`（失败则 `— 失败：找不到主机 api.test`）
- 输出：`[前置 · 请求层 · log] 正文`（`segment` 为空时只有 `[前置 · log]`）

### D4 剪贴板沿用 `navigator.clipboard.writeText`，失败要说出来

`CurlSnapshot` 已经这么做了，两处保持一致：成功把按钮文字切成「已复制」1.5 秒，失败把错误信息挂在该行（`title` + 按钮文字变「复制失败」）。Tauri 的 webview 把它当安全上下文处理，实测可用；不额外引入 clipboard 插件——为一个写文本动作加一层 Rust 命令不划算。

### D5 复制入口只在 hover / focus 时出现

一行日志的主要职责是「读」。常驻按钮会挤掉 URL 与输出文本的宽度（`.console-url` 已经是省略号截断），所以默认 `opacity: 0`，`.console-entry:hover` 或行内 `:focus-visible` 时显形；键盘 Tab 到达复制按钮时同样显形（`focus-within`），否则会出现「焦点在一个看不见的按钮上」。不可见时仍占位（`visibility` 而非 `display`），避免悬停瞬间整行重排。
