# ui-polish Specification

## Purpose

侧栏与键值表的视觉 / 交互打磨：去掉无操作意义的工作区头部、防止树行文本被选中、把集合列表的滚动范围收束到列表本身、用细滚动条省布局宽度，并把参数 / 变量表对齐 Postman 的清爽风格（轻行、hover 高亮、表头吸顶、行操作按需显现）。

## Requirements

### Requirement: 侧栏不展示工作区头部

侧栏 SHALL NOT 在 Collections / Environments 两个 tab 之上渲染任何工作区名称头部。侧栏的第一个可见元素 SHALL 为 tab 行。

#### Scenario: 启动无工作区头部

- **WHEN** 应用加载完成
- **THEN** 侧栏顶部不再出现标注「工作区」的元素，也不出现当前工作区名的只读展示；tab 行紧跟在侧栏上沿

### Requirement: 集合树行不可文本选中

集合树的节点行 SHALL 设置 `user-select: none`，使单击或双击行名称时不触发浏览器原生文本选中；搜索输入框内的文本选中不受影响。

#### Scenario: 单击目录名不选中文字

- **WHEN** 用户单击一个集合或文件夹节点的名称
- **THEN** 名称文字不被选中，且该目录的展开 / 折叠切换照常发生

#### Scenario: 双击名称不选中文字

- **WHEN** 用户双击一个文件夹或请求节点的名称
- **THEN** 名称文字不被选中；目录节点的展开态只切换一次，请求节点照常打开该请求

#### Scenario: 搜索框仍可选中

- **WHEN** 用户在集合树搜索框内拖选文字
- **THEN** 文字正常被选中，不受树行禁选影响

### Requirement: Collections tab 滚动范围收束

Collections tab 中，搜索工具栏 SHALL 固定在侧栏顶部，不随列表滚动；只有其下方的集合列表 SHALL 滚动。工具栏 SHALL NOT 在滚动时被卷出视野。

#### Scenario: 长列表滚动时工具栏不动

- **WHEN** 集合列表高度超过侧栏可视区并发生滚动
- **THEN** 搜索工具栏始终钉在顶部可见，集合列表在其下方独立滚动

#### Scenario: 空态提示不被卷走

- **WHEN** 列表为空或过滤无命中、显示空态提示
- **THEN** 该提示与搜索工具栏一同保持在滚动区上方，不被滚动影响

### Requirement: 全局细滚动条

应用内所有滚动容器（侧栏树、响应正文、表格、模态）SHALL 使用细滚动条（约 6px 宽、透明轨道），使其占用可忽略的布局宽度；非悬停时视觉上克制。

#### Scenario: 滚动条不明显占宽

- **WHEN** 某区域内容溢出并出现滚动条
- **THEN** 滚动条纤细、轨道透明，内容宽度不被明显压缩

### Requirement: 表格轻量化与 hover 高亮

参数 / 请求头 / 表单 / 变量等键值表 SHALL 以更轻的行分隔、行 hover 高亮、吸顶表头呈现；表头在表体滚动时 SHALL 保持可见。

#### Scenario: 表头吸顶

- **WHEN** 表格高度超过其容器并滚动
- **THEN** 表头行钉在容器顶部，不随表体滚走

#### Scenario: 行 hover 高亮

- **WHEN** 指针悬停在某个数据行
- **THEN** 该行显示与默认态可区分的高亮背景

### Requirement: form-data 行提供启停 checkbox

form-data 表 SHALL 为每一数据行提供启用 / 停用 checkbox，与 Params / Headers / url_encoded 一致；停用的行 SHALL 在发送 / 保存的既有清洗环节被排除。

#### Scenario: form-data 行有 checkbox

- **WHEN** form-data 标签页渲染
- **THEN** 每个数据行首列有一个 checkbox，切换它即改变该行 `enabled` 状态

### Requirement: 行操作按钮按需显现

键值表与变量表中，单行的删除（变量表还包括揭示）操作 SHALL 仅在该行被悬停或包含键盘焦点时显现，SHALL NOT 常驻可见；启停 checkbox 列 SHALL 始终可见。

#### Scenario: hover 显示操作

- **WHEN** 指针悬停在某数据行
- **THEN** 该行的删除按钮出现

#### Scenario: 焦点行显示操作

- **WHEN** 某行内的输入框 / 控件获得键盘焦点（正在编辑该行）
- **THEN** 即使指针不在该行上，删除按钮也显现

#### Scenario: 默认隐藏操作

- **WHEN** 某行既未被悬停也不含焦点
- **THEN** 不显示删除按钮
