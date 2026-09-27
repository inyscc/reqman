## 1. 拦截时机落到发送前（D1）

- [x] 1.1 后端发送路径：在 `resolve_request` 之后、建连之前判定 `unresolved`，非空则返回新增的可辨识错误码（消息列出变量名）且不建连 — 验证：Rust 单测断言该情形下没有任何网络往返，且错误码可辨识
- [x] 1.2 `SendRequestInput` 增加严格开关（缺省严格），宿主桥替脚本发请求时显式关闭它 — 验证：命令签名与既有调用点全部通过类型检查，脚本路径的入参断言为关闭
- [x] 1.3 前端 `src/App.tsx`：移除脚本之前的拦截块，发送失败的处理把新错误码纳入「不清空响应区但仍呈现错误」 — 验证：新增用例——请求体引用前置脚本写入的变量时请求照发且使用脚本写入的值
- [x] 1.4 补齐拦截时机的断言：脚本写入后不拦、确实未定义仍拦且不产生网络、脚本内请求不被拦 — 验证：`tests/` 下三条用例通过

## 2. `pm.request` 填充（D2）

- [x] 2.1 后端扩展 `variables_preview`：增加「揭示」（未掩码）开关，保持单条命令承载同一次解析的两种呈现 — 验证：Rust 单测断言揭示模式下 secret 变量参与解析且不被掩码，非揭示模式下仍被掩码
- [x] 2.2 前端 `src/lib/commands.ts` 与调用点接入该开关（脚本用揭示模式、界面浮层沿用掩码模式） — 验证：`npm run build` 的类型检查通过
- [x] 2.3 `src/lib/scriptRuntime.ts`：新增解析结果 → postman-collection `Request` JSON 形状的转换，并在前置与后置脚本的 `options.context` 中喂入 `request` — 验证：单测断言喂入的 context 含预期的 url / method / header / body 形状
- [x] 2.4 断言 `pm.request` 的字段面：URL 非空且反映的目标与本次请求一致、请求头与请求体与实际请求一致、认证只暴露方式不暴露凭据 — 验证：`tests/` 下用例通过
- [x] 2.5 断言 `pm.request` 是快照：脚本添加请求头后实际请求不变 — 验证：用例断言发出的请求不含脚本添加的头部

## 3. `pm.response` 填充（D3）

- [x] 3.1 `stream` 按上游原生支持的形态填：文本用 `body_text`，二进制用 `{ type: 'Base64', data: <base64> }` — 验证：二进制响应的 `pm.response.text()` 给出完整正确内容
- [x] 3.2 先确认 `size_bytes` 在截断场景下的语义，再填入 `downloadedBytes`，使 `pm.response.size()` 可用 — 验证：`pm.response.size()` 的结果与实际响应大小一致，含响应被截断的情形
- [x] 3.3 填入 `originalRequest`（本次请求） — 验证：后置脚本读到的 `originalRequest` 与实际发出的请求一致
- [x] 3.4 填入响应 Cookie（从响应头 `set-cookie` 解析） — 验证：多个 `set-cookie` 及其属性（域、路径、有效期、Secure、HttpOnly）保真

## 4. 三个连带修复（D2 / D4 / D5）

- [x] 4.1 宿主桥替脚本发请求时，把当前内存作用域合并后经 `local` 传入，**并带上 secret 标记**（扩展取值形状或另传名字列表，见 D4） — 验证：①用例「先 `set` 再发起引用 `{{x}}` 的请求」解析到新值而非旧值；②用例断言脚本内请求引用的 secret 在日志与错误消息中仍被掩码
- [x] 4.2 发送结果回带**后端实际用于发送的请求目标**，后置脚本阶段据此确定 `pm.cookies` 的当前请求（不使用重定向后的最终地址），前置阶段沿用脚本执行前解析出的目标 — 验证：用例——前置脚本改写 URL 中引用的变量后，后置脚本读到新目标的 Cookie 集合
- [x] 4.3 `runScriptPhase` 仅在脚本阶段正常结束时落库；用户取消时不落库，脚本抛错或超时则保留此前各段的写入 — 验证：三条用例分别断言落库行为，且中止时已产生的 console 输出仍呈现

## 5. 回归与整体校验

- [x] 5.1 安全审计断言不因新增命令与开关而失败 — 验证：`cargo test` 中安全审计相关用例全部通过
- [x] 5.2 全量回归 — 验证：`npm run test`（18 个文件全过）、`cargo test`（338 通过）、`npm run test:upstream`（212 通过 / 9 跳过 / **0 失败**；其中 2 条按 Node 后端的 teleport 编解码限制跳过，根因与处理方式见 `tests/upstream/RESULTS.md`）
- [x] 5.3 实机冒烟（Windows 客户端）：导入一个「前置脚本写入变量 + 请求体引用该变量」的集合并发送成功；二进制响应的后置脚本可读到正文；发送中取消后变量未被落库 — 验证：三项手工观察均符合预期

## 6. 收尾

- [x] 6.1 `openspec validate --changes --strict` 通过 — 验证：命令退出码为 0 且无警告
- [x] 6.2 确认无需更新 `NOTICE` 与第三方许可汇总（本变更不新增依赖） — 验证：`package.json` 与 `Cargo.toml` 的依赖清单与上一版本一致（本变更未新增依赖）

## 7. 失败提示可读（实机试用时的补充）

- [x] 7.1 `classify_net_failure` 把「TLS 握手位置读到非 TLS 数据」（rustls 的 `corrupt message` 一族）归为 `TlsError`，不再落入笼统的连接失败 — 验证：Rust 单测断言该文本得到 `TlsError`
- [x] 7.2 该情形的失败消息换成可操作的中文提示：点名「用 https:// 访问了一个只提供 http 的服务」并保留原始错误文本 — 验证：单测断言消息含协议提示与原始文本，且其它失败不被改写
- [x] 7.3 spec 增量：`http-engine` 的「响应元数据」补上消息可读性要求与该情形的 scenario — 验证：`openspec validate --changes --strict` 通过

## 8. 编辑器补全声明随实现同步（实机试用时的补充）

- [x] 8.1 `pmDts.ts` 把 `pm.request` / `pm.response` / `pm.cookies` 从 `unknown` 换成自足的具体形态：request 的 url / method / headers / body / auth、response 的 downloadedBytes / cookies / originalRequest / `size()`、以及 cookies 的 `get` 与 `jar()` — 验证：`tests/pm-dts.test.ts` 断言这些成员都在声明里
- [x] 8.2 快照语义写进声明：不声明 `pm.request` 的写方法（`headers.add` 等），避免让人以为改得动 — 验证：用例断言声明里不含 `add` / `remove` / `upsert`
- [x] 8.3 spec 增量：`pm-script-runtime` 新增「编辑器补全与运行时能力一致」（含两条 scenario） — 验证：`openspec validate --changes --strict` 通过
