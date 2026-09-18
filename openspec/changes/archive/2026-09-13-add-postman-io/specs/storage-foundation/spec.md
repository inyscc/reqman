## ADDED Requirements

### Requirement: 条目描述持久化

系统 SHALL 为集合、文件夹与请求保存可选的描述文本，并在应用重启后完整恢复；描述 SHALL NOT 参与请求发送。

#### Scenario: 描述随条目往返

- **WHEN** 用户为某集合、文件夹或请求填写描述后重启应用
- **THEN** 该描述仍可读，且与保存前一致

#### Scenario: 描述不影响发送

- **WHEN** 一条带描述的请求被发送
- **THEN** 实际发出的请求中不包含该描述
