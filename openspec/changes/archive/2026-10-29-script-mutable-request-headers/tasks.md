# Tasks

## 1. 运行时：回读并接力请求头

- [x] 1.1 `src/lib/scriptRuntime.ts`：`SandboxRequest.header` 允许 `disabled`，新增从 `execution.request.header` 回读的解析（只认字符串键、跳过禁用项、形态不合法时返回 `null`）。验证：单测断言脚本新增的头能回读到。 
- [x] 1.2 `executeOne` 的返回值带上回读的请求头；`runScriptPhase` 在前置阶段把它作为下一段的 `context.request.header`，并把该阶段结束时的请求形态放进结果的 `request` 字段（design D2）。验证：新增用例断言「集合段新增的头在请求段可见」，且该阶段无脚本时 `request` 为 `null`。
- [x] 1.3 按新语义重写 `tests/script-phase.test.ts` 里"pm.request 是快照：宿主不接收对它的改动（2.5）"用例（design 风险项）。验证：用例改为断言改动被回传，`npm test` 该文件全绿。

## 2. 合并：差异比较与落盘

- [x] 2.1 新增 `src/lib/scriptHeaders.ts`：`diffRequestHeaders`（按「键 → 值集合」比较，未变化返回 `null`）与 `applyScriptHeaders`（按名改写/新增、按名移除，套在草稿的原始头列表上）、`withSentHeaders`（用实际发出的头覆盖快照的头）。验证：新增 `tests/script-headers.test.ts` 覆盖未变化、新增、改写、移除、同名重复四种情形。
- [x] 2.2 `src/App.tsx` 的 `performSend`：前置阶段结束后比较差异，有变化则以合并后的内联请求发送且**置空 `saved_id`**；无变化保持原路径（design D3）。验证：`tests/app.test.tsx` 新增用例断言改头后后端收到的内联请求带上该头。

## 3. 后端：回传实际发出的请求头

- [x] 3.1 `ResponsePayload` 增加 `request_headers`，`build_attempt` 收集配置头、认证头与正文 `Content-Type`；`Cookie` 在**发送前**由 jar 匹配结果补一条（design D4）。验证：后端用例断言自定义头与 `Cookie` 都在 `request_headers` 里，且 `Set-Cookie` 带来的新 Cookie 不在其中。
- [x] 3.2 前端类型补 `request_headers?`，后置阶段用它构造 `pm.request` 与 `pm.response.originalRequest`（design D4）。验证：新增用例断言后置脚本读到认证头与 `Content-Type`。

## 4. 编辑器声明

- [x] 4.1 `src/lib/pmDts.ts`：`pm.request.headers` 补 `add` / `upsert` / `remove` / `has` / `members`，并把"只读快照"的注释改写为"请求头可改、其余字段仍是快照"。验证：`tests/pm-dts.test.ts` 改为断言写方法存在、URL 仍是只读声明。

## 5. 规格一致性与全量验证

- [x] 5.1 规格与实现一致：「pm.request 的填充」的七条场景与「编辑器里的 pm 对象声明」的两条场景各有对应断言或明确的人工验证结论。
- [x] 5.2 类型检查、单测与构建：`npx tsc --noEmit`、`npm test`、`npm run build` 退出码为 0。
- [x] 5.3 后端：`cargo test`（`src-tauri`）全绿。

## Workflow follow-up

- 实现与验证全部完成后归档该 change，并把 `pm-script-runtime` 的 delta 合并进主规格。
