# Design

## Context

动机见 `proposal.md - Why`。与设计相关的现状：

- 脚本的变量读写已经通了一条完整链路：沙箱回读 `execution.<scope>.values` → `runScriptPhase` 逐段接力 → `persistWrites` 落库 → 后端发送时解析。落库是这条链路能覆盖"本次请求"的原因——写入先于发送。
- 本地作用域没有落库这一步，因此它在沙箱外没有任何载体：`readScopeValues` 只读三个持久化作用域，`persistWrites` 只写那三个，`SendRequestInput.local` 只有脚本内 `pm.sendRequest` 在用。
- 上游沙箱把本地作用域叫 **`_variables`**（`execution._variables`，`CONTEXT_VARIABLE_SCOPES` 里的第一项），而 `pm.variables` 的 `set` 就写在这一层。
- 后端 `load_scope_layers` 的层次顺序是 `Local → Data → Environment → Collection → Global`（高优先级在前），`lookup` 逐层查找，`unresolved` 也由同一套查找得出。也就是说：**只要把值送进 `local`，严格模式的拦截、解析优先级、secret 标记三件事都自动对齐**，后端一行不用改。

## Goals / Non-Goals

**Goals:**

- `pm.variables.set` 的取值参与本次请求的解析（任意字段的 `{{name}}`）。
- 一次执行内连续：跨脚本段、前置到后置。
- 不落库、不新增命令、不改存储。

**Non-Goals:**

- 不做迭代数据（`data`）：那属于运行器，本变更只碰本地作用域。
- 不改变同一段脚本内写入对它自己 `pm.sendRequest` 不可见的现状（上游限制）。
- 不做变量面板的刷新（脚本写入后表格仍是旧值，见下方风险项）。

## Decisions

**D1 喂名字用 `_variables`，不是 `local`。**
沙箱的 `options.context` 与 `execution` 两侧都用 `_variables` 这个键。喂错名字的表现是**静默失效**：`pm.variables.set` 照常成功、`pm.variables.get` 在本段内也读得到，但回读永远是空的，段间接力也断——和「脚本没执行」看起来一模一样。因此两侧各写一条注释钉住这个名字。

**D2 本地取值经 `SendRequestInput.local` 交给后端，而不是落库。**
落库会违反「本地变量不持久化」；`local` 字段正是为这种「只在这一次执行里有效」的取值准备的。后端的 `Local` 层是最内层，优先级、未解析判定、secret 名单三件事都由它统一处理，前端不需要复算。

**D3 一个请求的一次执行里本地作用域连续，交给后置时用 `initialLocal` 入参。**
`runScriptPhase` 每次调用都是新的一次沙箱执行（新的 `_variables`），所以要显式把前置阶段的结果传进去。用第 10 个位置参数而不是改成一个 options 对象，是为了不动既有的九个实参调用点；本文件的签名本来就是位置参数风格。

**D4 `localSecretNames` 用取值比对得出。**
数据库里没有这些名字的行，后端无从判断哪个是 secret。本地取值等于某个已揭示的 secret 明文时即标记该名字：判据是**取值**而不是名字（名字可能被脚本换掉），宁可多标（把恰巧相同的普通值掩掉）也不能漏标——漏标就是明文进日志。

**D5 取消时不特殊处理本地值。**
取消那一路不会发出请求，交回的 `local` 没人用；`written` 仍按原规则清空（取消的副作用止于中止点）。

## Risks

- **取值比对的误报**：某种常见值（如 `"0"`、`"true"`）恰好与某个 secret 明文相同，会被当成 secret 掩掉。影响是日志里多几处掩码，不改变实际发出的请求。
- **面板不刷新**（既有问题，本变更未扩大）：`ScriptPhaseResult.written` 目前没有界面消费，脚本写入后变量表格与悬浮提示仍显示旧值。本地变量不落库、本来也不该出现在表格里，因此这条对本地作用域不适用；对另外三个作用域仍是待办。
- **半段写入的可见性**：脚本抛错或超时的那一段，它的本地写入不并入结果（与此前处理持久化作用域同一规则：没跑完的段不算已完成的事实）。
