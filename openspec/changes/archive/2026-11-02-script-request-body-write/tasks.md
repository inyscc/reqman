# Tasks

## 1. 沙箱侧的请求体：喂得进去、读得回来

- [x] 1.1 `src/lib/scriptRuntime.ts`：`toSandboxRequest(preview, bodyKind?)` 在 `raw` 与 `none` 两种类型下**一律**给出 `body: { mode: 'raw', raw: body_text ?? '' }`；表单 / 二进制沿用既有的文本投影（D2）。验证：`tests/script-phase.test.ts` 的「前置脚本改写的请求体逐段接力」在空正文请求上写入正文成功，不再抛 `Cannot set properties of undefined`。
- [x] 1.2 `src/lib/scriptRuntime.ts`：新增 `readSandboxBody`，`executeOne` 的返回值带上 `body`（该段正常结束时回读，被超时强杀时为 `null`）。验证：同上的接引用例读回改写后的正文。
- [x] 1.3 `src/lib/scriptRuntime.ts`：`runScriptPhase` 新增 `currentBody` 接力状态，每段结束后并入并喂给下一段，结果里带回 `request.body`（D3）。验证：`tests/script-phase.test.ts` 的三级脚本接力用例。

## 2. 差异合并

- [x] 2.1 新增 `src/lib/scriptBody.ts`：`diffRequestBody(fed, final)` 只在文本不同时返回改动；`applyScriptBody(request, change)` 把改动合进草稿，`none` 补正文时 `kind` 变为 `raw`，非 `raw` 形态返回 `ignored`（D1 / D6）。验证：`tests/script-body.test.ts` 七条（一字未改、回读不到、整份替换、保留其它字段、空正文补写、表单被拒、无改动原样返回）。

## 3. 接到发送流程上

- [x] 3.1 `src/App.tsx`：合并顺序为「头 → 体」，`withSentHeaders` 之后再 `withSentBody`；任一改动即把 `saved_id` 置空走内联（D4）。验证：`tests/app.test.tsx` 的「前置脚本改写的请求体随请求发出…」「脚本没碰请求体时仍按 saved_id 发送（不回归）」。
- [x] 3.2 `src/App.tsx`：`ignored` 为真时往本次 console 追加一条 `warn`（"请求体不是 raw 形态（表单 / 二进制），脚本对请求体的改动未生效。"）（D5）。验证：`tests/app.test.tsx` 的「表单正文不接受脚本改写：改动被拒并明说」。
- [x] 3.3 `src/App.tsx`：前置脚本结束时的请求形态传给后置阶段，后置读到的是**实际发出**的头与正文。验证：`tests/app.test.tsx` 的同一条端到端用例里的后置断言。

## 4. 补全声明对齐

- [x] 4.1 `src/lib/pmDts.ts`：`pm.request.body` 改为必填、`raw: string`，删掉"body 只是读取面、改不动"的旧注释（D6）。验证：`tests/pm-dts.test.ts` 断言声明里有 `body: RequestBody` 与 `raw: string`，且不再出现"body 不声明"的措辞。

## 5. 集成校验

- [x] 5.1 只读 `url` / `method` 仍是快照：既有用例「脚本对 URL 与请求体的改动不影响发送」中关于正文的部分由新行为取代，URL 部分保持。验证：`tests/app.test.tsx` 里 URL 相关的既有断言未改。
- [x] 5.2 类型检查与全量测试：`npx tsc --noEmit` 退出码 0；`npx vitest run` 621 条全绿（本 change 新增 14 条）。

## Workflow follow-up

- 归档本 change，并把 `pm-script-runtime` 的 delta 合并进主规格。
