# Spec Delta

## MODIFIED Requirements

### Requirement: pm.request 的填充

后置脚本读到的请求头 SHALL 是**实际发出的那一份**，至少包含：请求编辑器里配置的头、前置脚本写入的头、认证落成的头、正文的 `Content-Type`，以及随本次请求携带的 `Cookie`。由网络栈在更底层补齐的头（`Host`、`Content-Length`、`User-Agent`）SHALL NOT 被承诺存在。

后置脚本读到的**请求体** SHALL 同样是实际发出的那一份，而不是脚本执行前的解析快照：前置脚本刚刚写入的变量，其新取值 SHALL 在后置脚本读到的正文里可见。该承诺只覆盖 `raw` 形态的正文；表单、多段与二进制正文的形态 SHALL NOT 被承诺。

#### Scenario: 后置脚本读到实际发出的请求体
- **WHEN** 前置脚本把一个新值写入变量，请求体中的 `{{name}}` 引用该变量，后置脚本读取请求体
- **THEN** 读到的正文里是脚本刚写入的新值，而不是发送前那个旧值
