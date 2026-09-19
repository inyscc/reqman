# variable-engine Specification

## Purpose

定义变量解析的行为契约：五个作用域及其优先级、占位符与路径变量的替换规则、动态变量的求值、未解析变量的可观察表现，以及 secret 变量的掩码边界。

## Requirements

### Requirement: 作用域优先级
系统 SHALL 按 `local > data > environment > collection > global` 的优先级解析同名变量，取优先级最高且已定义的作用域的值。

#### Scenario: 同名变量跨作用域遮蔽
- **WHEN** 同一名称在 global 与 environment 中都有定义
- **THEN** 解析结果取 environment 中的值

#### Scenario: 高优先级作用域未定义
- **WHEN** 某名称只在 collection 与 global 中定义，而当前存在一个不含该名称的 environment
- **THEN** 解析结果取 collection 中的值，而非因 environment 存在而解析失败

### Requirement: 全局变量与集合变量
系统 SHALL 提供在工作区范围内可用的全局变量，以及随集合存储、仅在所属集合及其子节点内可用的集合变量。

#### Scenario: 集合变量不外泄
- **WHEN** 集合 A 定义了变量 X，在集合 B 下的请求中引用 `{{X}}`
- **THEN** 集合 A 的 X 不参与解析，该引用按未解析处理

### Requirement: 环境变量与活动环境
系统 SHALL 维护至多一个活动环境，该环境的变量参与解析；切换活动环境 SHALL 立即影响后续解析结果。

#### Scenario: 切换环境后立即生效
- **WHEN** 活动环境从 A 切换到 B，且两者对同名变量的取值不同
- **THEN** 下一次解析立即得到 B 的值，无需重启应用

### Requirement: 本地变量与迭代数据
系统 SHALL 提供仅在单次请求执行期间有效的本地变量，以及由运行器提供的迭代数据；两者 SHALL NOT 被持久化，且在一次执行结束后失效。

#### Scenario: 本地变量不落盘
- **WHEN** 脚本或运行时写入一个本地变量，随后重启应用
- **THEN** 该变量不再存在，也不出现在任何持久化的变量列表中

### Requirement: 占位符替换
系统 SHALL 在发送请求前，对 URL、query 参数、headers、body 与认证字段中的 `{{name}}` 占位符执行替换，替换结果 SHALL 与实际发出的请求一致。

#### Scenario: 多字段替换
- **WHEN** URL、一个 header 与 body 中分别引用了已定义变量
- **THEN** 实际发出的请求中三处均为对应值，且不存在多余的占位符字面量

#### Scenario: 同一变量多处引用
- **WHEN** 同一次请求中同一变量被引用多次
- **THEN** 各引用处均被替换，且动态变量之外的值保持一致

### Requirement: 路径变量
系统 SHALL 支持路径变量，既接受 `:name` 形式也接受 `{{name}}` 形式，并 SHALL 在填充后生成合法的请求路径。

#### Scenario: 冒号形式路径变量
- **WHEN** URL 为 `/users/:id` 且 `id` 有可解析的值
- **THEN** 发出请求的路径中 `:id` 被替换为该值

#### Scenario: 花括号形式路径变量
- **WHEN** URL 为 `/users/{{id}}` 且 `id` 有可解析的值
- **THEN** 发出请求的路径与 `:id` 形式在相同取值下一致

### Requirement: 动态变量
系统 SHALL 支持动态变量，包括唯一标识符、时间戳、随机整数、随机 UUID 及常见随机姓名与随机邮箱；每次求值 SHALL 产生该类型的合法新值。

#### Scenario: 唯一标识符互不相同
- **WHEN** 同一次请求中两处引用唯一标识符类动态变量
- **THEN** 两处得到互不相同的合法值

#### Scenario: 随机整数落在范围内
- **WHEN** 引用随机整数类动态变量
- **THEN** 得到的值落在该变量约定的整数范围内

### Requirement: 未解析变量提示

当占位符无法解析时，系统 SHALL 保留原始占位符文本，SHALL NOT 静默替换为空字符串。系统 SHALL 在发出请求之前拦截：请求中存在任何未解析变量时，SHALL NOT 发出该请求，并 SHALL 以可辨识的错误列出未解析的变量名。拦截 SHALL 发生在请求发出之前，因此这类请求不产生任何网络往返。

#### Scenario: 未定义变量提示

- **WHEN** 请求引用了任何作用域都未定义的变量，且用户触发发送
- **THEN** 系统不发出该请求，并以错误列出该变量名，同时请求中仍保留 `{{name}}` 原文

#### Scenario: 发送前可见

- **WHEN** 存在未解析变量
- **THEN** 该状态在请求发出之前即被呈现，且不产生任何网络请求

#### Scenario: 没有未解析变量时照常发送

- **WHEN** 请求中的占位符全部解析成功，且用户触发发送
- **THEN** 请求照常发出，不出现拦截错误

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
