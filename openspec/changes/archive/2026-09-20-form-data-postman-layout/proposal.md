# Proposal: form-data-postman-layout

## Why

form-data 表格与 Params 表共用同一套幽灵行模型，但视图层落后一截：键入后不出现「下一行」跳板行（Postman 是键入即见新行）、幽灵行缺少勾选列占位导致整行左移一列、也没有描述列。用户以 Postman form-data（Key | Type | Value | Description）为基准要求对齐。

## What Changes

- FormDataEditor 的幽灵行补齐勾选列占位 `<td>`，与表头 5 列对齐。
- FormDataEditor 增加「下一行」跳板行（与 `KeyValueTable` 同机制）：幽灵行物化后下方立即出现空白行，点击/键入即续写——键入即见新行的自动新增观感。
- form-data 表新增「描述」列（表头、普通行、幽灵行、跳板行）。`FormRow.description` 已在模型中并随请求持久化、导入导出往返，本次只是补上视图。file 行的描述可编辑；「内容 / 文件」列的文件名展示仍取自 `description`（导入链路把文件名写在这里）。
- `rows.ts`：`isEmptyFormField` 从「只看名称」升级为两档判定的保留档（名称与描述皆空才算空行），描述-only 的 form 行不再被出口清洗掉；发送侧 `cleanForSend` 对 form 行增加「名称非空」过滤，避免把无名字段发出去。
- **文件选取入口**：form-data 文件行与 binary 正文接上既有的 `pick_upload_file` 命令——文件行提供「选择文件」（系统对话框，路径留在后端，前端只拿一次性句柄）、已选后可重新选择或清除；binary 正文从「只有一行提示」升级为带选取入口的行。此前文件句柄只能来自 Postman 导入，手工建的文件字段永远停在「未选择文件」。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `ui-layout`: 「描述列」要求扩展到 form-data 表（此前只覆盖 Params / Headers / urlencoded 三张表）；「键值表的列与空行判定」中 form 行的保留判定与发出判定改为与键值表同构的两档表述；幽灵行「其下方出现新的幽灵行」的语义在 form-data 表上成立；新增「请求体文件的选取」要求（form 文件行与 binary 经系统对话框选取文件）。

## Impact

- `src/components/RequestEditor.tsx`：`FormDataEditor`（列结构、幽灵行、跳板行、文件行选取）；body 分支的 binary 行；`RequestEditorProps` 增加 `onPickFile`（App 注入 `client.pickUploadFile()`，与 `onCurl` 同款注入模式）。
- `src/lib/rows.ts`：`isEmptyFormField` 两档化；`cleanForSend` 的 form 过滤。
- 后端无改动：`pick_upload_file` 命令与发送链路的句柄消费均为既有能力。
- 测试：`tests/request-editor.test.tsx` 补 form-data 跳板行 / 描述列 / 文件选取断言；`tests-browser` 复用既有表格几何用例回归。
