## Context

动机见 `proposal.md`；行为约束见本变更的 `specs/ui-layout/spec.md`。实现相关的现状：

- `src/components/VariablesPanel.tsx` 是唯一实现点，环境变量与全局变量共用（用 `environmentId` 是否为空区分作用域）。它现在把名称与值渲染成只读文本，动作只有 `variableSet`（新增）、`variableDelete`、`secretReveal`。
- `variable_set` 已是 upsert：按「作用域 + 归属 + 名称」定位，命中则 `UPDATE`（**id 不变**），且 `initial` / `current` 传 `null` 表示保持原值（`COALESCE`）。所以「就地改值」不需要任何后端改动。
- **但 `is_secret` 在 Rust 侧是 `#[serde(default)] bool`**：不传就等于 `false`。改值时若不显式带上 `is_secret: variable.is_secret`，一个 secret 变量会被顺手关掉 secret 标记。
- secret 的明文只能经 `secretReveal` 取得，列表里拿到的是掩码值；`current.state === 'unreadable'` 表示密钥不可用、值读不出来。
- 既有两个断言依赖「值以文本呈现」：`getByTestId('masked-apiKey').textContent` 与 `getByTestId('plain-apiKey').textContent`。后者会随本变更失效（输入框没有 textContent）。

## Goals / Non-Goals

**Goals:**

- 改值在表格里直接完成，不新增弹窗、不新增面板。
- 提交语义与项目既有编辑一致：回车 / 失焦提交、Esc 还原、值没变就不发请求。
- 掩码边界不被削弱：未揭示的 secret 不预填明文，也不会因为「失焦顺手提交」被写坏。

**Non-Goals:**

- 不做重命名（需按 id 更新的独立后端能力）。
- 不做「初始值 / 当前值」两列的区分（面板现在只有一列，写入时两者同值，与新增路径一致）。
- 不改后端、命令层、依赖。

## Decisions

### D1: 可读值直接是输入框；未揭示的 secret 走「掩码 + 修改」

非 secret 与已揭示的 secret：值单元格就是常驻输入框，预填真实值。

未揭示的 secret：**保持现在的掩码呈现**（`******`，`data-testid="masked-<name>"` 不变），旁边给一个「修改」入口；点击后原地换成**空**输入框，placeholder 说明「留空表示不修改」，Esc 或取消退回掩码。

理由有两条。其一，掩码是 `variable-engine` 的既有约束（secret 值在界面上以掩码呈现），把一个空的输入框直接盖上去会让「当前值是多少」这条信息消失；其二，输入框里既不能放掩码文本（用户会当成值改掉）、也不能放明文（那等于自动揭示），所以只能在「掩码只读 + 显式进入编辑」和「空输入框顶掉掩码」之间选，前者信息更全、也更难误操作。

备选：像 Postman 那样在输入框里放掩码点（`••••`）并在聚焦时清空——需要额外的聚焦态处理，且「清空」这一步在失焦提交的语义下容易写坏值；否决。

### D2: 草稿与提交判定

每个变量 id 一个草稿值 `drafts[id]`，输入框显示 `drafts[id] ?? 当前呈现值`。提交时按行类型判定「值是否变化」：

```
未揭示的 secret: 草稿为空 -> 不发请求（保持原值）；否则写入草稿
其他:            草稿 === 原值 -> 不发请求；否则写入草稿
```

Esc 或取消：删掉草稿（输入框回落到 props 呈现值）。

理由：未揭示 secret 的「原值」在界面上是掩码、在数据上是未知明文，没法用「与原值比较」判定，所以对它用「空即不修改」这条显式规则。

### D3: 提交时必须显式传 `is_secret`

写请求固定带 `is_secret: variable.is_secret`（见 Context：Rust 侧默认 false）。这是本次最容易踩的坑——漏了它，编辑一个 secret 变量就等于把它降级成明文普通变量。

### D4: 提交后清草稿，靠外层刷新列表

提交成功或失败都清掉该 id 的草稿：成功时列表会经 `onChanged()` 重新拉取（值等于刚写入的），失败时输入框回落成原值并显示错误。不做乐观改列表（`variables` 由 `App` 持有），代价是成功后到刷新回来之间有一帧显示旧值——一次 IPC 往返，可接受。

### D5: 不可读的变量不进入编辑态

`current.state === 'unreadable'` 的行继续显示「不可读」徽章，不渲染输入框、不显示修改入口（密钥不可用时写进去也没意义，后端切换 secret 标记还会直接报错）。`current.state === 'not_persisted'` 按空值处理（该作用域本就不落盘，面板不会遇到）。

### D6: 迁移既有断言

`masked-<name>`（未揭示 secret）保持 span + 文本，断言不动；`plain-<name>` 变成输入框，断言从 `textContent` 改为 `input.value`——断言的意图（揭示后能看到明文）不变。

## Risks / Trade-offs

- [常驻输入框让每行都是可聚焦元素，Tab 会逐个经过] → 与 Postman 的形态一致，可接受；输入框带 `aria-label={`变量值 ${name}`}`，读屏能说清是哪一行。
- [点击「删除」「揭示」时先触发失焦提交] → D2 的「值未变不提交」把这条路堵住了：只点按钮、不改值的场景不会产生任何写请求。
- [编辑 secret 后掩码刷新，用户看不到自己刚填的值] → 这是掩码边界的必然结果（要看得点「揭示」），在 design 里记明，不额外放宽。
- [既有测试失效] → 单列一条迁移任务（`plain-` 那一处），`npm test` 必须全绿。
