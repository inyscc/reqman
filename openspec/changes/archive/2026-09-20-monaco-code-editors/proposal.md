# monaco-code-editors

## Why

请求体（raw）、脚本（Pre-request / Post-response）与响应正文目前分别是纯 `<textarea>` 和只读 `<pre>`：没有语法高亮、没有行号、没有 JSON 折叠，写脚本时也没有 `pm.*` 补全。编辑 JSON 正文看不出结构与配对括号，写脚本全靠记忆 API，大响应正文难以阅读。升级为 Monaco 代码编辑器，对齐 Postman 的编辑体验。

## What Changes

- 请求体 raw 编辑器：`<textarea>` → Monaco（可写），语言感知高亮（json / xml / html / text / javascript）+ 行号 + JSON 折叠。
- 脚本编辑器（Pre-request / Post-response）：`<textarea>` → Monaco（可写），JS 高亮 + `pm.*` 补全（经 `pm.d.ts` 注入）。
- 响应正文：只读 `<pre>` → 只读 Monaco（高亮 + JSON 折叠）；正文超过 10MB 时降级回纯 `<pre>` 原样展示。
- cURL 快照与其余小输入框**保持 `<textarea>`** 不变。
- 引入并固定 `monaco-editor@0.54.0`（**不**用 0.55+），经懒加载的 `CodeSurface` 组件承载；worker 经 `MonacoEnvironment.getWorker` 装载。

## Capabilities

### New Capabilities

- `code-editors`: 请求体 raw、脚本（pre/test）、响应正文三处代码编辑面统一使用 Monaco——语法高亮 + 行号、JSON 折叠、脚本 `pm.*` 补全；响应正文只读且超 10MB 时降级为纯文本展示。

### Modified Capabilities

- `ui-layout`: 「Ctrl+S 保存当前编辑面」需求中场景里"脚本文本域"的措辞更新为与控件无关——脚本编辑器将不再是 `<textarea>`；Ctrl+S 保存行为本身不变。

## Impact

- 新依赖：`monaco-editor@0.54.0`（固定版本，已在 `package.json`）。
- 新组件 `CodeSurface`：薄壳包裹 Monaco（readOnly / 语言 / 高度可配），动态 import 懒加载，不进启动模块图。
- 影响代码：`RequestEditor.tsx`（Body raw）、`ScriptPane.tsx`（pre/test）、`ResponsePanel.tsx`（响应正文）。
- CSP 已满足 Monaco 需要（`worker-src 'self' blob:`、`unsafe-eval`、`unsafe-inline`），无需改动安全配置。
- 测试分层：happy-dom 测试把 `CodeSurface` mock 成带同样 `aria-label` 的 `<textarea>`（既有断言一行不改）；`tests-browser`（本机 Chrome）验证编辑器真身（补全 / 折叠 / 行号 / IME）。
- 响应正文 10MB 阈值集中为一个常量；`pm.d.ts` 与运行时 API 白名单保持单源。
- 清理：spike 临时文件 `src/dev/monacoSpike.tsx`、`src/dev/pm.d.ts`、`tests-browser/monaco-spike.spec.ts` 与 `main.tsx` 的 spike 路由在实现阶段移除。
