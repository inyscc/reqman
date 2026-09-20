# Design: form-data-postman-layout

## Context

`FormDataEditor` 与 `KeyValueTable` 共用同一套幽灵行状态机（`pending` / `ownedIndex` / `releaseGhost`），差异本应只有「多一个类型下拉、空行判定只看名称」。但视图层有三处落后：没有 `KeyValueTable` 拥有的「下一行」跳板行；幽灵行少了勾选列占位 `<td>`（4 个 `<td>` 对 5 个 `<th>`，整行左移）；没有描述列。

`FormRow.description` 已在模型中（`FormField.description`），随请求持久化、导入导出往返；但 `rows.ts` 的 `isEmptyFormField` 只看名称，描述会被出口清洗掉。file 行的 `description` 被导入链路复用为文件名（RequestEditor 里 `已选择：${row.description ?? '文件'}`），没有独立的文件名字段。

## Goals / Non-Goals

**Goals:**

- form-data 表与 Params 表在「自动新增行」与「列结构」上完全同构，对齐 Postman。
- 描述-only 的 form 行不再被清洗；无名 form 字段不进入发送载荷。

**Non-Goals:**

- 不改后端 multipart 逻辑——发送侧过滤在前端 `cleanForSend` 完成；`pick_upload_file` 与发送链路的句柄消费均为既有能力。
- 不动 `binary` 的 `{ file_handle, description }` 结构。

## Decisions

**D1 — 跳板行照抄 `KeyValueTable` 的形态，而非改状态机。**
状态机（键入即物化）两边已经一致，缺的只是物化后「下方再铺一行空白」。把 `KeyValueTable` 的 `owned !== null` 跳板行分支移植过来，aria-label 用「下一行的字段名 / 类型 / 值 / 描述」（与幽灵行的「新增字段的 \*」区分，测试按 label 取元素不会撞）。备选是抽公共组件统一两张表——值得做但波及四张表与既有测试标签，超出本变更，留待后续重构。

**D2 — 幽灵行与跳板行都补齐勾选列占位。**
占位 `<td />` 与 `KeyValueTable` 的幽灵行同款（那里首列就是空占位）。这样两张表的空白行都从「字段名」列起步，与表头逐列对齐。

**D3 — 描述列对 file 行不做特判，全行可编辑。**
`description` 在 file 行上兼作文件名展示（`已选择：…`）是导入链路的既有事实。若强行拆出「文件名只读 + 描述可编辑」需要加字段、动导入导出与 Rust 侧往返，收益低。接受这一处语义重叠：file 行编辑描述会同时改变「已选择：…」的展示文案，在代码注释里写明。备选（新增独立 `file_name` 字段）留给「form 文件选取入口」那个未来变更一起做。

**D4 — `isEmptyFormField` 两档化：名称与描述皆空才算空行（保留档）。**
与 `isEmptyKeyValue` 的保留判定同构（form 行没有值要求）。发出档不引入 `hasRequestData` 的「或值非空」——form 行的值对 file 类型无意义，发出判定保持「名称非空」。

**D5 — `cleanForSend` 的 form 过滤从 `enabled` 收紧为 `enabled && 名称非空`。**
描述-only 行现在会被保留判定留在存储里，若发送过滤仍只看 `enabled`，会把无名（且可能带文件）的字段发出去。加名称非空判断与三张键值表的发出判定同构。

**D6 — 文件选取经 `onPickFile` prop 注入，组件不直连 commands。**
`RequestEditorProps` 增加 `onPickFile?: () => Promise<PickedFile | null>`，App 注入 `client.pickUploadFile()`——与 `onCurl` 同款注入模式，RequestEditor 保持不依赖命令层，既有单测宿主不受影响。备选（组件内 import client）会破坏测试分层，否。

**D7 — 选取结果复用 `description` 存文件名，清除连描述一起清。**
与导入链路的存储形态一致（`已选择：${description}`）。清除 = 句柄置空 + 描述置空：file 行的描述本来就是文件名语义（D3 已接受的重叠），留半截状态反而费解。「重新选择」覆盖句柄与名称。

**D8 — binary 从「提示行」升级为「提示 + 选取 + 名称 + 清除」。**
提示保留一句（系统对话框、一次性句柄的安全语义值得说明），入口与文件行同款式。binary 与 form 文件行共用同一 `onPickFile`。

## Risks / Trade-offs

- [跳板行 aria-label 与既有测试断言冲突] → 新标签（下一行的 \*）先 grep 全测试目录确认无占用；`新增字段的 \*` 系列断言不受影响（跳板行不占用这些 label）。
- [file 行描述被编辑后「已选择」文案跟着变] → design D3 已接受的语义重叠；在视图代码注释标注。
- [保留判定放宽后，历史数据里出现描述-only 行] → 出口清洗（保存/发送）已同步收紧，不会发送无名载荷；存储里多留用户写下的描述符合「不静默丢内容」的项目原则。

## Migration Plan

纯前端修正，无数据迁移。回滚即恢复原文件。

## Open Questions

（无）
