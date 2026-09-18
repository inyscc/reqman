# cookie-jar Specification

## Purpose
定义 Cookie 的接收、匹配、自动附带、手动管理与加密持久化契约，以及脚本经 `pm.cookies` 访问 Cookie 时的可见范围与操作语义。它是 `pm.cookies` 能力的底座，也是请求自动携带会话状态的依据。

## Requirements

### Requirement: Cookie 的接收与保存

系统 SHALL 把响应中指示设置的 Cookie 保存下来，并按该 Cookie 自身声明的有效期与作用域属性决定其后续可用范围。当响应指示删除或使某个已保存 Cookie 过期时，系统 SHALL 相应地移除或使其失效，SHALL NOT 继续在后续请求中携带它。

#### Scenario: 响应写入的 Cookie 被保存

- **WHEN** 一次响应指示设置一个带有效期的 Cookie
- **THEN** 该 Cookie 出现在 Cookie 列表中，并可被后续请求使用

#### Scenario: 过期指令生效

- **WHEN** 某响应把已有 Cookie 的有效期设为已过去的时间或零
- **THEN** 该 Cookie 不再出现在列表的可用项中，也不出现在后续请求中

#### Scenario: 未携带有效期

- **WHEN** 响应设置一个不带有效期的会话 Cookie
- **THEN** 该 Cookie 在当前会话内可用，且其终结行为与「仅当前会话有效」一致

### Requirement: Cookie 在请求中的自动附带

系统 SHALL 在发送请求时自动附带与该请求目标匹配且仍有效的 Cookie。匹配 SHALL 同时考虑域名与路径，并 SHALL 遵守 Cookie 自身的安全属性约束。不匹配的 Cookie SHALL NOT 被附带。

#### Scenario: 同域后续请求携带 Cookie

- **WHEN** 某响应设置了目标域的 Cookie，随后向同一域发送请求
- **THEN** 该请求自动携带该 Cookie，且该事实可在请求调试信息中看到

#### Scenario: 域不匹配时不携带

- **WHEN** 向与 Cookie 所声明域不匹配的目标发送请求
- **THEN** 该请求不携带该 Cookie

#### Scenario: 路径不匹配时不携带

- **WHEN** 请求路径不落在 Cookie 声明的路径前缀范围内
- **THEN** 该请求不携带该 Cookie

#### Scenario: 重定向后按新目标重新匹配

- **WHEN** 请求跟随重定向跳转到另一个域
- **THEN** 后续跳转按新目标重新计算应携带的 Cookie，SHALL NOT 沿用原目标的 Cookie 集合

#### Scenario: 安全属性被遵守

- **WHEN** 某 Cookie 声明了仅在安全传输下发送，而请求目标不是安全传输
- **THEN** 该请求不携带该 Cookie

### Requirement: Cookie 的属性保真

系统 SHALL 保留每个 Cookie 的作用域与安全属性，至少包括所属域名、路径、安全传输标记、仅限协议访问标记与有效期。属性 SHALL NOT 在保存、重新读取或被脚本读写的过程中丢失或改变。

#### Scenario: 属性往返保真

- **WHEN** 一个带有域名、路径、安全标记与有效期的 Cookie 被保存后重新读取
- **THEN** 上述属性与保存前一致

#### Scenario: 属性影响后续匹配

- **WHEN** 两个同名 Cookie 仅在路径上不同
- **THEN** 系统按各请求的路径分别选择应携带的那一个，而不是互相覆盖或同时携带

### Requirement: Cookie 的手动管理

系统 SHALL 允许用户查看、新增、编辑与删除 Cookie，并 SHALL 在新增或编辑后立即按新取值参与后续请求。

#### Scenario: 手动新增后生效

- **WHEN** 用户手动新增一个匹配当前目标的 Cookie，随后发送该目标的请求
- **THEN** 该请求携带这个手动新增的 Cookie

#### Scenario: 删除后不再携带

- **WHEN** 用户删除一个 Cookie 后发送原本会携带它的请求
- **THEN** 该请求不再携带它，且它不出现在列表中

#### Scenario: 按域组织呈现

- **WHEN** 用户打开 Cookie 管理界面
- **THEN** 已有的 Cookie 按其所属域名归类呈现，同名但不同域的 Cookie 分别可见

### Requirement: Cookie 的持久化与加密

系统 SHALL 跨应用重启保留 Cookie。Cookie 的值 SHALL NOT 以明文形式存储于本地数据库，也 SHALL NOT 以明文出现在应用日志中。

#### Scenario: 跨重启保留

- **WHEN** 一次会话获得 Cookie 后重启应用
- **THEN** 该 Cookie 仍在，且向匹配目标发送请求时仍被携带

#### Scenario: 数据库无明文

- **WHEN** 写入一个取值可识别的 Cookie 后直接读取本地数据库文件
- **THEN** 检索不到该取值

#### Scenario: 日志无明文

- **WHEN** 一次携带 Cookie 的请求被记录到应用日志
- **THEN** 日志中该 Cookie 的取值以掩码形式出现

#### Scenario: 备份恢复后仍在

- **WHEN** 用户导出备份、清空本地数据并从该备份恢复
- **THEN** 恢复后的 Cookie 与备份时一致，且仍可用于匹配的请求

### Requirement: Cookie 的作用域

Cookie SHALL 按所属域名在应用范围内共享，SHALL NOT 随工作区分区。同一目标域下的同一 Cookie 在任意工作区、任意集合的请求中 SHALL 表现一致。

#### Scenario: 切换工作区后仍然可用

- **WHEN** 用户在某一工作区获得某域的 Cookie，随后切换到另一个工作区并向该域发送请求
- **THEN** 该请求仍携带该 Cookie

#### Scenario: 界面明确标注作用域

- **WHEN** 用户查看 Cookie 管理界面
- **THEN** 界面明确说明 Cookie 的应用级共享范围，使「切换工作区不会清空 Cookie」不构成意外

### Requirement: 脚本对 Cookie 的访问

系统 SHALL 允许脚本经 `pm.cookies` 读取当前请求目标可用的 Cookie，并 SHALL 允许脚本按指定域读取与写入 Cookie。脚本写入的 Cookie SHALL 立即按域名与路径规则参与后续请求。

#### Scenario: 读取当前请求可用的 Cookie

- **WHEN** 后置脚本读取当前请求目标的 Cookie 集合
- **THEN** 得到的集合与自动附带规则下应携带的 Cookie 一致

#### Scenario: 按域读写

- **WHEN** 脚本按某个域写入一个 Cookie，随后向该域发送请求
- **THEN** 该请求携带脚本写入的 Cookie

#### Scenario: 脚本写入遵守同样规则

- **WHEN** 脚本写入的 Cookie 带有路径或安全传输约束
- **THEN** 后续请求按这些约束决定是否携带，脚本写入不绕过匹配规则

#### Scenario: 删除

- **WHEN** 脚本删除某个域的某个 Cookie
- **THEN** 该 Cookie 不再出现在列表中，也不出现在后续请求中
