## ADDED Requirements

### Requirement: 请求编辑器正文区的满高与区域内滚动

请求编辑器的正文区 SHALL 以满高策略呈现各标签页的内容：正文区自身 SHALL NOT 随内容增长出现整页滚动，内容超出可用高度时 SHALL 在各自的编辑面或表格容器内滚动。该策略 SHALL 同时适用于 Body 标签页（raw / form-data / x-www-form-urlencoded）、Params 标签页与 Headers 标签页。

请求体为 `raw` 时，其编辑器 SHALL 铺满正文区扣除类型行与格式化错误提示后的剩余高度与宽度，下方 SHALL NOT 残留大块空白。编辑器内容超出一屏时 SHALL 在编辑器内部滚动（与 Scripts / cURL 标签页的既有行为一致）。

Params、Headers、x-www-form-urlencoded、form-data 四张键值表 SHALL 由一个满高的表格容器承载：容器 SHALL 占满正文区扣除其上方固定内容（如 Body 类型行）后的剩余高度；行数少于一屏时容器不出现滚动条、布局与现状等价；行数超出一屏时 SHALL 在容器内滚动，SHALL NOT 把滚动扩张到整个正文区。

表格滚动时表头 SHALL 吸顶：表头 SHALL 始终钉在表格容器顶部可见，滚过的数据行 SHALL NOT 从表头下方穿透可见。表头吸顶 SHALL NOT 因滚动容器从正文区下沉到表格容器而失效。

Body 标签页的类型行（请求体类型单选与语言选择）与格式化错误提示 SHALL 固定在编辑面或表格容器的上方，SHALL NOT 随表格内容或编辑器内容滚出视野。binary 类型只有一行提示，SHALL 呈现在正文区顶部，SHALL NOT 因满高策略产生额外空白或滚动。

既有行为 SHALL 保持不变：键值表的幽灵行仍为表尾最后一行；格式化动作（Minify / Beautify）与错误提示的位置不变；表格行的两档空行判定不变。

#### Scenario: raw 正文铺满剩余高度

- **WHEN** 用户打开一个请求的 Body 标签页且请求体类型为 `raw`
- **THEN** 正文编辑器占满类型行以下的剩余高度与宽度，下方不残留大块空白
- **AND** 正文超出一屏时在编辑器内部滚动

#### Scenario: 键值表区域内滚动

- **WHEN** Params / Headers / form-data / urlencoded 表的行数超出一屏
- **THEN** 表格在其满高容器内滚动，类型行（若有）与正文区其它固定内容不随行滚出视野

#### Scenario: 滚动时表头吸顶

- **WHEN** 用户在任一键值表的满高容器内滚动
- **THEN** 表头钉在容器顶部始终可见，滚过的行不从表头下方穿透

#### Scenario: 行数不足一屏

- **WHEN** 任一键值表的行数少于一屏
- **THEN** 容器不出现滚动条，表格布局与满高策略引入前等价

#### Scenario: binary 保持一行

- **WHEN** 用户把请求体类型切到 `binary`
- **THEN** 正文区顶部呈现一行提示，无滚动、无多余空白
