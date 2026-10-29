## Why

「前置脚本算一个值写进变量，当前请求就用它」这条用法在请求体上确实生效了——后端在脚本落库之后重新解析，`{{dynChan}}` 取到的是新值。但**脚本自己看不到这件事**。

用户的实际写法是把验证塞进后置脚本：

```js
console.log(pm.request.body.raw);        // 期望看到 {"channelId":"1"}
console.log(pm.variables.get('dynChan')); // 期望看到 1
```

跑出来的却是 `{"channelId":"0"}` 与 `1`——正文说旧值，变量说新值。于是唯一能观察到的证据都在说「请求没用上刚算出来的变量」，功能其实是对的。

根因：喂进沙箱的那份请求是**脚本执行前**解析出来的（`performSend` 里 `variablesPreview` 在 `runScriptPhase` 之前），前置脚本写入的变量在其中还是上一轮的旧值。后置阶段已经用后端回带的 `request_headers` 盖掉了请求头（`withSentHeaders`），正文却还留着那份快照。

请求头当时能想到「实际发出的那一份」，是因为认证落成的头只有后端知道；正文同理，只是没人补上。

## What Changes

- **后端报出实际发出的正文**：`ResponsePayload` 新增 `request_body`，仅 `raw` 形态有值。表单、多段与二进制不报——它们的形态不是一段可回灌的文本，报出去只会让后置脚本读到半真半假的东西。
- **后置阶段的 `pm.request` 以它为准**：`withSentBody` 把它盖到请求形态上，与 `withSentHeaders` 并列使用。`pm.response.originalRequest` 同源，一并纠正。
- **规格**：`pm-script-runtime`「pm.request 的填充」补一句「后置读到的正文是实际发出的那一份」，并给出场景（前置写新值、正文引用它、后置读到新值）。

前置阶段仍是脚本执行前的快照——那时变量确实还没算出来，如实反映才是对的。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `pm-script-runtime`:
  - 「pm.request 的填充」：在「后置脚本读到的请求头 SHALL 是实际发出的那一份」之后补上正文的同款承诺，限定在 `raw` 形态，并新增一条场景。
