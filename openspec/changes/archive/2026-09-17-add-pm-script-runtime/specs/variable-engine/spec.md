## ADDED Requirements

### Requirement: 脚本对变量的读写

系统 SHALL 允许脚本经 `pm.environment`、`pm.globals` 与 `pm.collectionVariables` 读写对应作用域的变量。脚本写入的变量 SHALL 按该作用域原有的可解析范围立即参与后续解析，SHALL NOT 因为写入者是脚本而扩大或缩小该范围。脚本经 `pm.variables` 写入的变量属于本地作用域，SHALL NOT 被持久化。

#### Scenario: 脚本写入的环境变量参与解析

- **WHEN** 前置脚本写入一个环境变量，且本次请求的 URL 引用了该变量名
- **THEN** 实际发出的请求使用脚本写入的值

#### Scenario: 脚本写入的集合变量不越界

- **WHEN** 脚本为集合 A 写入一个集合变量
- **THEN** 该变量在集合 A 内可解析，且在集合 B 内不参与解析

#### Scenario: 脚本写入的全局变量跨集合可用

- **WHEN** 脚本写入一个全局变量，随后在同一工作区的另一个集合下引用同名变量
- **THEN** 该引用解析为脚本写入的值

#### Scenario: 本地作用域的写入不落盘

- **WHEN** 脚本经 `pm.variables` 写入一个与既有持久化变量同名的值，随后重启应用
- **THEN** 重启后解析结果回到持久化的取值，脚本写入不残留

## MODIFIED Requirements

### Requirement: Secret 变量掩码

标记为 secret 的变量值 SHALL 在界面展示、日志输出以及脚本产生的可观测输出中以掩码形式呈现；掩码 SHALL NOT 妨碍该变量参与实际替换，也 SHALL NOT 妨碍脚本读取其真实值用于组装请求。

#### Scenario: 界面掩码但替换正常

- **WHEN** 用户查看一个 secret 变量的值并发送引用它的请求
- **THEN** 界面上显示为掩码，而实际发出的请求中该处为真实值

#### Scenario: 掩码可被显式揭示

- **WHEN** 用户主动请求查看某个 secret 变量的明文
- **THEN** 系统按用户意图展示明文，且该次揭示不改变其存储形态

#### Scenario: 脚本读取到真实值

- **WHEN** 脚本读取一个 secret 变量并把它用于组装请求
- **THEN** 实际发出的请求中该处为真实值

#### Scenario: 脚本输出中的明文被掩码

- **WHEN** 脚本把一个 secret 变量的值写入 console 输出
- **THEN** 界面上的该条输出以掩码呈现，明文不出现在可复制的输出文本中
