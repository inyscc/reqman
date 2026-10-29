# Tasks

## 1. 后端报出实际发出的正文

- [x] 1.1 `src-tauri/src/net/mod.rs`：`ResponsePayload` 新增 `request_body: Option<String>`，从 `resolved.body` 取 `Raw { text, .. }`（D1、D2）。验证：`cargo test --lib request_body_reports_the_resolved_text_that_was_sent` —— 正文里 `{{channel}}` 引用一个全局变量，报出的必须是解析后的文本。
- [x] 1.2 非 `raw` 形态报 `None`。验证：`request_body_is_absent_for_non_raw_bodies`（表单正文）。

## 2. 后置阶段的请求形态以它为准

- [x] 2.1 `src/lib/scriptHeaders.ts`：新增 `withSentBody`，语义与 `withSentHeaders` 对齐——后端没给就不动，给了就整份覆盖（D3）。验证：`tests/script-headers.test.ts` 四条（覆盖、快照无正文时补上、`null`/`undefined` 原样返回、空串是有效取值）。
- [x] 2.2 `src/App.tsx`：后置阶段 `withSentBody(withSentHeaders(...), payload.request_body)`。验证：`tests/app.test.tsx`「后置脚本读到的正文是实际发出去的那一份」——预览给旧值 `0`、载荷给新值 `1`，断言脚本读到 `1`；同时断言发出去的 `inline.body.raw` 仍是模板，解析交给后端。

## 3. 类型与规格

- [x] 3.1 `src/lib/types.ts`：`ResponsePayload.request_body?: string | null`，与 `request_headers` 同样标为可选（响应桩不必都补）。
- [x] 3.2 `openspec/specs/pm-script-runtime/spec.md`：「pm.request 的填充」补上正文承诺与场景（D4：前置阶段不动）。

## 4. 校验

- [x] 4.1 `npx tsc --noEmit` 干净。
- [x] 4.2 `npm test` 587 通过（新增 5 条）。
- [x] 4.3 `cargo test --lib` 401 通过（新增 2 条）。
- [ ] 4.4 未跑：`npm run test:browser`、`npm run build`。
