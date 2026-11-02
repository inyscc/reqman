# Spec Delta

## MODIFIED Requirements

### Requirement: 脚本 console 输出的收集与呈现

系统 SHALL 收集脚本执行期间产生的 console 输出并在界面上呈现，SHALL NOT 使其只能从应用日志中取得。每条输出 SHALL 按原文呈现：多行文本的换行与缩进 SHALL NOT 被折叠为一行；超长的单行 SHALL 在呈现区内折行，SHALL NOT 要求用户横向滚动才能读全。

#### Scenario: 输出可见

- **WHEN** 脚本调用 console 输出一段文本后发送请求
- **THEN** 该文本出现在脚本 console 面板中

#### Scenario: 输出可区分来源

- **WHEN** 同一次发送中前置脚本与后置脚本各自产生输出
- **THEN** 面板中的输出可区分来自哪一段脚本

#### Scenario: 多行输出保留换行

- **WHEN** 脚本以一条 console 输出打印含换行的多行文本（例如带缩进的 JSON）
- **THEN** 面板按原文呈现该文本，换行与缩进均保留，不折叠为一行
