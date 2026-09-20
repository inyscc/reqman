# Tasks: fill-request-editor-panes

## 1. 布局打通

- [x] 1.1 `RequestEditor.tsx`：`pane-body` 的 `fill` 条件扩展到 params / headers / body 三页（与 scripts / curl 同款条件表达式），运行既有单测确认无回归
- [x] 1.2 body 页内层 `div.stack` 挂铺满修饰类，`App.css` 新增该类的 `flex: 1; min-height: 0` 规则；验证：raw 页类型行固定顶部、编辑器不再顶高正文区
- [x] 1.3 raw 的 `CodeSurface` 以 `fill` 替换 `height={220}`；验证：`npm test` 既有断言全绿（happy-dom mock 不读 height/fill）

## 2. 键值表满高容器

- [x] 2.1 为 `KeyValueTable` / `FormDataEditor` 的表格外层加满高滚动容器样式（`flex: 1; min-height: 0; overflow: auto`），params / headers / urlencoded / form-data 四处共用；验证：行少于一屏无滚动条，布局与现状等价
- [x] 2.2 修正 `thead th` 吸顶偏移：`top` 相对新的滚动容器取值，与容器实际 padding 一致；验证：容器内滚动时表头钉在顶部、行内容不从表头下穿透

## 3. 验证

- [x] 3.1 运行 `npm test` 全量单测通过
- [x] 3.2 `tests-browser` 在本机 Chrome 上验证五条场景：raw 铺满且编辑器内滚、表格区域内滚、表头吸顶、行数不足一屏无滚动条、binary 保持一行
