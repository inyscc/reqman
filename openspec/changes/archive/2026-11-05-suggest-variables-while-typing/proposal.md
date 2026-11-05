## Why

变量只能靠记忆敲。想知道「当前有哪些变量、叫什么、现在的值是什么」，用户必须先切到变量面板或环境编辑器，把名字抄回来，再回到地址栏或键值表里逐字打——`{{host}}`、`{{baseUrl}}`、`{{api_token}}` 这类名字拼错一个字母，发送时就退化成「未解析」错误，而报错里只说这个名字不存在，不说它本来该是哪个。

项目里已经有一条**反向**的能力：指针停在 `{{name}}` 上能看到它当前的值与来源（`ui-layout`「变量占位符的悬浮值提示」）。但它要求「已经把名字写对」。本变更补上另一半——**在写的时候给出候选**：键入 `{{` 就列出当前作用域里可用的变量、它们的值、来自哪一层，选中即补成完整的 `{{name}}`。

## What Changes

- **地址栏、参数表与请求头表的取值列**：光标停在一个未闭合的 `{{` 之后时，弹出候选浮层。
- **候选内容**：变量名 + 当前解析所用的取值 + 来源作用域（environment / collection / global），与悬停提示同源同口径；同名遮蔽时只列**生效的那一条**。
- **过滤与插入**：继续键入即按名称过滤（前缀匹配优先），`↑` / `↓` 选择，`Enter` / `Tab` 补成 `{{name}}`，`Esc` 收起且不改动文本；鼠标点选同样插入。
- **替换整个占位符**：候选打开时若光标落在已写好的 `{{name}}` 内部，插入 SHALL 替换掉整个占位符（含已有的 `}}`），不产生 `{{{{name}}}}`。
- **secret 只给掩码**：候选列表 SHALL NOT 成为读取明文的出口（明文仍只经变量面板的揭示与悬停提示两条既有出口）。
- **覆盖层**：与悬停提示同构，不改变请求编辑器与响应区的布局；地址栏下方 SHALL NOT 因此出现常驻的展示区。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `ui-layout`:
  - 新增「变量输入时的候选提示」：触发条件、候选内容与排序、插入范围、键位、收起边界、secret 的呈现。
  - 新增「候选提示的叠加性与失效边界」：不改变布局；失焦、点击外部、祖先容器滚动、光标离开该占位符时收起。

## Impact

- **代码**：新增候选判定与过滤的纯函数（`src/lib/variableSuggest.ts`）、候选浮层组件与交互 hook（`src/components/VariableSuggest.tsx`、`src/lib/useVariableSuggest.ts`）；`src/lib/variableHover.ts` 的取值源补一个「列出候选」出口（复用同一份 `load()` 缓存与 `effectiveByName` 判定，不新写作用域规则）；`src/components/RequestEditor.tsx` 的地址栏与 `KeyValueTable` 的取值列接入；`src/App.css` 补浮层样式。
- **行为变化**：`Enter` / `Tab` / `↑` / `↓` / `Esc` 在候选打开时被候选接管——参数表幽灵行的「回车提交并跳到下一行」在候选打开时让位（先补全，再按一次回车才跳）。
- **安全边界**：不新增后端命令；候选里的 secret 只呈现后端下发的掩码，SHALL NOT 调用揭示出口。
- **测试**：`tests/variableSuggest.test.ts` 覆盖判定、过滤与替换范围；`tests/variable-suggest.test.tsx` 覆盖键盘、点选、收起与 secret 掩码；`tests/variableHover.test.ts` 补候选来源的作用域口径；`tests-browser/variable-suggest.spec.ts` 覆盖真实渲染下的定位、布局不变与输入不中断。
