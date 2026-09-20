# Tasks: form-data-postman-layout

## 1. 表格结构

- [x] 1.1 `FormDataEditor` 幽灵行补勾选列占位 `<td>`，与表头 5 列对齐；验证：既有单测全绿，空白行从「字段名」列起步
- [x] 1.2 `FormDataEditor` 增加「下一行」跳板行（字段名 / 类型 / 值 / 描述，aria-label 用「下一行的 \*」），键入即见新行；验证：单测断言物化后跳板行出现、点击跳板行落定当前行并把焦点交回空白行

## 2. 描述列

- [x] 2.1 form-data 表新增「描述」列：表头、普通行、幽灵行、跳板行四处；file 行描述可编辑，代码注释标注「description 兼作文件名展示」的既有语义；验证：单测断言描述就地编辑并写进模型

## 3. 空行判定

- [x] 3.1 `rows.ts`：`isEmptyFormField` 升级为「名称与描述皆空」；`cleanForSend` 的 form 过滤收紧为 `enabled && 名称非空`；验证：单测覆盖「描述-only 行保留」「无名 form 字段不进发送载荷」

## 4. 验证

- [x] 4.1 `npm test` 全量单测通过（337/337）
- [x] 4.2 `tests-browser` 既有表格几何用例回归通过（本机 Chrome：fill 5/5、ghost-row 5/5、session-bar 11/11）

## 5. 文件选取入口

- [x] 5.1 `RequestEditorProps` 增加 `onPickFile`（可选），App 注入 `client.pickUploadFile()`；验证：tsc 无错、既有单测不破
- [x] 5.2 form 文件行：未选时呈「选择文件」按钮，选取后展示文件名并提供「重新选择 / 清除」；验证：单测断言句柄与名称写入行、清除置空、取消对话框无副作用
- [x] 5.3 binary 正文：提示旁提供「选择文件 / 清除」，写入 `body.binary`；验证：单测断言 binary 写入与清除
- [x] 5.4 `npm test` 全量单测通过（341/341）；浏览器回归 fill spec 5/5（binary 场景已同步新 UI）
