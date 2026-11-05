## 背景

地址栏 / 参数表 / 请求头表的候选是自研浮层（`VariableSuggest` + `useVariableSuggest`），因为它要贴在一个原生 input 的光标下方，还要接管 `Enter` / `Tab`。Monaco 有自己的一套：补全面板、`Ctrl+Space`、上下键与 `Enter` 由编辑器自己处理。**照搬自研浮层等于在一个已经会做这件事的编辑器里重做一遍**，还会与 `pm.*` 之类的既有补全抢按键。

## 决策

### D1：走 Monaco 的 completion provider，不移植自研浮层

`monaco.languages.registerCompletionItemProvider` 给的是：触发字符、过滤、排序、键盘、点击、详情面板全都免费，且与脚本面已有的 `pm.*` 补全共用同一套交互。代价是「长什么样」不完全由我们决定（面板样式走 Monaco 主题），但候选的**内容**与顺序仍由我们给。

### D2：判定与过滤必须复用，不许为 Monaco 再写一条

`suggestContext(text, offset)` 与 `filterCandidates(items, query)` 已经定义了「光标是否在写一个未闭合的 `{{`」与「前缀优先」的排序。Monaco 这边只做两件事：把 `position` 换成 offset（`model.getOffsetAt`），把结果换成 `CompletionItem`。为编辑器再写一条正则，必然出现「正文里能补、地址栏里补不了」这类分叉。

### D3：插入写 `{{name}}`，替换范围交给 `suggestContext`

`suggestContext` 给出的 `start`/`end` 直接当 `CompletionItem.range`：光标在 `{{ho|st}}` 里时这个范围覆盖整个占位符，因此改名字得到的是替换而不是嵌套。

`filterText` 必须带上 `{{` 前缀：Monaco 拿「`range.start` 到光标」这段文本做匹配（`{{ho`），只写 `host` 会让整份候选被过滤掉。排序用 `sortText` 固定成 `filterCandidates` 的下标，避免 Monaco 按自己的打分重排（前缀命中被排到包含命中之后）。

### D4：登记整个取值源，登记的是读 ref 的代理

provider 是按**语言**静态注册的，`{{` 在哪个模型里补、补哪个作用域的变量，只能反着从编辑面传进来。原来登记的只是一个 `resolve(name)` 函数；候选需要 `candidates()`，于是登记对象换成 `VariableSource`（悬停与候选的共同形态）。

登记的是「读 ref 的代理」而不是源本身：换环境 / 换集合时上游会重建一个源（随之丢掉旧的缓存），而模型与 provider 都不该为此重建——代理每次调用取当下的那个源，换作用域于是立刻生效。

### D5：打开时才刷新一次列表

`candidates({ refresh: context.query === '' })`：敲下第二个 `{` 时列表刚打开，重新装载一次（刚在变量面板里加的变量要立刻可选）；继续键入时走同一份列表，不再问后端。悬停那边继续走纯缓存——它没有「刚改完就要看见」的诉求。

## 风险

- **Monaco 版本升级**：`label` 对象、`sortText`、`range` 的语义在 0.5x 稳定，但 `triggerCharacters` 的触发时机依赖「字符插入后」这一行为。浏览器用例（真 Blink）覆盖了这一条，升级时它会先红。
- **JSON 语言服务同时给候选**：单敲一个 `{` 时我们返回空集，编辑器的 JSON 补全照旧；两者不会打架（我们的候选只在 `{{` 之后出现）。
- **工作区变量很多**（实测 60+）：面板限高与滚动由 Monaco 负责，不需要我们再处理。
