# code-editors Specification

## Purpose

请求体、脚本与响应正文三处代码编辑面统一使用 Monaco 代码编辑器，提供语法高亮、行号、JSON 折叠与脚本 `pm.*` 补全，使正文编辑与脚本编写获得接近 Postman 的编辑体验。

## Requirements

### Requirement: 代码编辑面使用富代码编辑器

请求编辑器的 raw 正文、脚本编辑器（Pre-request / Post-response，含请求 Scripts 标签页与集合/文件夹实体脚本面板）、响应面板的正文三处 SHALL 使用富代码编辑器（Monaco）而非纯 `<textarea>` 或 `<pre>`，并满足：

- 三处编辑面 SHALL 提供语法高亮与行号；
- 可写编辑面（raw 正文、脚本）的改写 SHALL 仍计入既有未保存判定：`Ctrl+S` 保存与未保存守卫照常生效；
- 编辑器初始化 SHALL 为懒加载：首次打开对应编辑面时才加载编辑器资源，SHALL NOT 拖慢应用冷启动。

#### Scenario: raw 正文与脚本编辑器提供高亮与行号

- **WHEN** 用户打开请求的 Body（raw）标签页或 Scripts 标签页
- **THEN** 正文 / 脚本以带语法高亮与行号的编辑器呈现，而不是纯文本框

#### Scenario: 编辑器懒加载

- **WHEN** 应用启动且尚未打开任何代码编辑面
- **THEN** 编辑器相关资源不被加载，应用冷启动不受影响

#### Scenario: 改写计入未保存判定

- **WHEN** 用户在编辑器中修改正文或脚本后尝试关闭该标签
- **THEN** 界面按既有未保存守卫询问，`Ctrl+S` 可直接保存

### Requirement: 请求体 raw 编辑器的语言感知与折叠

请求体为 `raw` 时，其编辑器 SHALL 按类型行的语言选择（json / xml / html / text / javascript）提供对应的语法高亮；正文为 JSON 时 SHALL 提供结构折叠（可折叠对象 / 数组节点）。语言为 json 时，既有「raw 正文的格式化动作」（Beautify / Minify）SHALL 照常作用于正文草稿。

#### Scenario: 语言感知高亮

- **WHEN** 用户把 raw 正文语言切到 `xml`
- **THEN** 正文按 XML 语法高亮

#### Scenario: JSON 折叠

- **WHEN** raw 正文语言为 JSON 且正文含嵌套对象
- **THEN** 编辑器提供折叠控件，可折叠嵌套节点

#### Scenario: 格式化动作照常

- **WHEN** 语言为 JSON 且用户点击 Beautify
- **THEN** 正文按既有格式化动作重排，编辑器内容随之更新

### Requirement: 脚本编辑器的 pm.* 补全

脚本编辑器 SHALL 提供 JavaScript 语法高亮，并 SHALL 提供 Postman 兼容的 `pm.*` API 补全：补全项 SHALL 与宿主运行时实际提供的 `pm` 能力同源（新增一个 `pm` 能力时补全同步获得，SHALL NOT 维护两份手工清单）。

#### Scenario: pm.environment 成员补全

- **WHEN** 用户在脚本编辑器中输入 `pm.environment.`
- **THEN** 补全列表给出宿主支持的 `pm.environment` 方法（如 set / get / unset）

#### Scenario: 补全与运行时同源

- **WHEN** 宿主新增一个 pm 能力并加入运行时白名单
- **THEN** 编辑器补全同步提供该能力，无需手工同步第二份声明

### Requirement: 响应正文的只读编辑面与大正文降级

响应面板的正文 SHALL 使用只读的富代码编辑器呈现，提供语法高亮、行号与 JSON 折叠；既有「原始 / 格式化」切换 SHALL 照常生效。正文超过体积阈值（10MB）时 SHALL 降级为纯文本原样展示（只读），并提示高亮已禁用。阈值 SHALL 集中为单一配置。

#### Scenario: 响应正文只读高亮

- **WHEN** 用户查看一个 JSON 响应的正文
- **THEN** 正文以只读、带语法高亮与折叠的编辑器呈现，不可编辑

#### Scenario: 大正文降级

- **WHEN** 响应正文超过 10MB
- **THEN** 正文以纯文本原样展示，并提示高亮已禁用

### Requirement: 小输入面保持轻量

cURL 快照文本块与其余小表单输入（如设置、导入导出文本域）SHALL 保持纯 `<textarea>`，SHALL NOT 升级为富代码编辑器。

#### Scenario: cURL 快照保持 textarea

- **WHEN** 用户打开请求的 cURL 标签
- **THEN** 命令文本块仍为可编辑的多行文本框（沿用既有行为），不引入编辑器高亮
