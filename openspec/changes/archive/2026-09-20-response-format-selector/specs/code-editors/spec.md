# code-editors Delta

## MODIFIED Requirements

### Requirement: 响应正文的只读编辑面与大正文降级

响应面板的正文 SHALL 使用只读的富代码编辑器呈现，提供语法高亮、行号与 JSON 折叠；响应正文的呈现格式选择（见 http-engine「响应内容与格式化」）SHALL 照常生效，编辑面的高亮语言 SHALL 跟随当前生效的文本格式（跟随检测 / Raw / JSON / XML / HTML）。正文超过体积阈值（10MB）时 SHALL 降级为纯文本原样展示（只读），并提示高亮已禁用。阈值 SHALL 集中为单一配置。Hex 格式 SHALL NOT 使用富代码编辑器承载——它以专门的字节视图呈现。

#### Scenario: 响应正文只读高亮

- **WHEN** 用户查看一个 JSON 响应的正文（呈现格式为 JSON）
- **THEN** 正文以只读、带语法高亮与折叠的编辑器呈现，不可编辑

#### Scenario: 高亮语言跟随所选格式

- **WHEN** 用户把一个 HTML 响应的呈现格式从跟随检测切到 Raw
- **THEN** 正文仍为只读编辑器呈现，但按所选格式对应的语言重新高亮

#### Scenario: 大正文降级

- **WHEN** 响应正文超过 10MB
- **THEN** 正文以纯文本原样展示，并提示高亮已禁用
