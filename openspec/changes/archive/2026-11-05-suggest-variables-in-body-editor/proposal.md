## Why

「输入 `{{` 时给候选」上一版只覆盖了地址栏、参数表与请求头表——那三处是原生 input。Body raw 走 Monaco，是 `{{var}}` 用得最多的地方，在那儿敲 `{{` 什么也不会弹（`tests-browser` 里也没能覆盖，因为 Monaco 在 happy-dom 跑不了）。

## What Changes

- Body raw 编辑面（Monaco）在键入 `{{` 时，弹出与地址栏同一份变量候选：名字 + 当前取值 + 来源作用域；选中即补成 `{{name}}`。
- 三个复用而不是三份新实现：判定用 `suggestContext`、过滤用 `filterCandidates`、取值用同一个源的 `candidates()`（同名遮蔽只剩生效条、secret 只给掩码）。
- 按模型 URI 登记的从「悬停取值函数」改成「整个取值源」：悬停与候选共用一份登记，provider 仍然每一种语言只注册一次。
- 触发字符取 `{`：Monaco 是「字符插入后」触发，敲下第二个 `{` 才构成 `{{`，单敲一个 `{` 判定为 null、返回空集，不会弹出「无建议」面板。

## Impact

- 规格：`ui-layout` 的「变量输入时的候选提示」「候选的过滤、插入与键盘操作」两处需求把 Body raw 纳入编辑面之列，并补一条针对代码编辑面的场景。
- 代码：`lib/monacoEnv.ts`（补全 provider、登记表换成取值源）、`components/CodeSurface.tsx`（`variableSource`）、`components/RequestEditor.tsx`（传源）、`dev/codeSurfaceHarness.tsx`（驱动钩子）。
- 不做：脚本编辑器的变量候选（那里已有 `pm.*` 补全，先让位）、响应正文（只读）。
