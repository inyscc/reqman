## Why

Console 里的内容常常是要拿去别处用的：一个由脚本解析出来的 ID、一段 JSON、一句报错原文。但现在这些文字**选不中**：

- 标题行是 `<button>`。浏览器给 button 的 UA 样式带 `user-select: none`，拖选完全没反应，右键也没有「复制」。
- 不能展开的纯文本输出，那一行还是 `disabled` 的按钮——比普通按钮更彻底，连焦点都拿不到。

详情区（请求头表、响应正文 `pre`）本来就能选，唯独最常看的那一行不行。用户只能截图或手抄。

## What Changes

- **标题行不再是 button**：改成带 `role="button"` 的行容器，文字恢复可选中；键盘仍可用 Enter / 空格展开，展开态的语义仍由 `aria-expanded` 表达。
- **每条条目加一个「复制」入口**：指针悬停或键盘聚焦时出现在行尾，点一下就把这一行的文本表示写进剪贴板——输出条目带 `[前置 · 请求层 · log]` 前缀，网络条目带方法、URL 与结果。
- **复制有回执**：成功时按钮短暂变「已复制」，失败时把原因说出来（沿用 `CurlSnapshot` 的写法），不静默。
- **选区非空时点击不切换展开**：拖选完松手不该顺带把条目折起来。
- **JSON 树的折叠行同样改成可选中**的容器——展开后最常被复制的就是那里的叶子值。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `request-console`：新增一条「条目的复制」需求——文本 SHALL 可被选中复制、每条条目 SHALL 提供复制入口并复制其单行文本表示、复制成功 SHALL 有反馈而失败 SHALL 说明原因、基于选择的点击手势 SHALL NOT 改变展开状态。

## Impact

- 代码：`src/components/ConsolePanel.tsx`（行结构与复制入口）、`src/lib/consoleLog.ts`（新增纯函数 `entryToText`）、`src/App.css`（可选中、复制按钮的显隐）。
- 测试：`tests/console-panel.test.tsx`、`tests/console-log.test.ts`，浏览器侧 `tests-browser/console-panel.spec.ts` 一条。
- 迁移：无。条目的数据形状不变，纯呈现层改动。
