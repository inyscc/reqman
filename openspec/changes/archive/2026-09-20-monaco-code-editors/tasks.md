# monaco-code-editors · tasks

## 1. 基础设施：CodeSurface + worker 装载

- [x] 1.1 建立 `CodeSurface` 薄壳组件（prop：`readOnly` / `language` / `height` / `value` / `onChange` / `onSave` / `enableCompletion`），动态 `import('monaco-editor')`。验证：组件可渲染，且入口 chunk 体积不因引入 Monaco 而增长（懒加载成立）。
- [x] 1.2 装配 `MonacoEnvironment.getWorker`（`?worker` 构造器，label `typescript`/`javascript`→ts.worker、`json`→json.worker、其余→editor.worker），并显式 `import 'monaco-editor/esm/vs/language/typescript/monaco.contribution'` 与 json 贡献。验证：`monaco.languages.typescript` 非 undefined，编辑器可创建。
- [x] 1.3 模型用 `file://` URI 创建（`createModel(value, language, monaco.Uri.parse('file:///...'))`），并对 `getJavaScriptWorker()` 加竞态重试（容忍字符串 rejection `"JavaScript not registered!"`）。验证：编辑面创建后 worker 可达，不报 `Could not find source file`。

## 2. 三处接入

- [x] 2.1 请求体 raw 换 `CodeSurface`：按类型行语言选择提供对应高亮，JSON 时提供折叠。验证：语言切到 xml 高亮为 XML；JSON 嵌套可折叠；语言 json 时 Beautify/Minify 照常改写草稿且计入未保存判定（Ctrl+S 可保存）。
- [x] 2.2 脚本编辑器（请求 Scripts 标签页 + 集合/文件夹实体脚本面板，pre/test）换 `CodeSurface` 并注入 `pm.d.ts`（从 `postman-sandbox/types/index.d.ts` 的 `Postman` 类型派生 + `pm.require` 补丁）。验证：输入 `pm.environment.` 弹出 set/get/unset 等补全；补全面覆盖 `Postman` 类型声明的 `pm` 能力。
- [x] 2.3 响应正文换只读 `CodeSurface`，阈值集中为 `CODE_SURFACE_MAX_BYTES = 10MB`。验证：`≤10MB` 时只读高亮 + 折叠、原始/格式化切换照常；`>10MB` 时回落纯 `<pre>` 原样展示并提示"高亮已禁用"。

## 3. 测试分层

- [x] 3.1 happy-dom 层：`vi.mock` 把 `CodeSurface` 换成**保形** mock——可写面（body raw / 脚本）成 `<textarea aria-label=...>`，只读响应正文成保 `data-testid="response-body"` 且 `textContent` 为正文的元素。验证：`tests/**` 既有断言（`getByLabelText('raw 正文')` 的 `.value`、`getByTestId('response-body')` 的 `.textContent`、Minify/Beautify、cURL 语义）全部通过且**无需修改**。
- [x] 3.2 tests-browser 层（本机 Chrome）：新增编辑器用例——补全弹出、JSON 折叠、行号、Ctrl+S 保存、IME 中文输入。验证：`vitest run --config vitest.browser.config.ts` 相关用例通过。

## 4. 观感 + 收尾

- [x] 4.1 `monaco.editor.defineTheme` 把 token 颜色映射到浅色设计系统 CSS 变量（`--panel-2`/`--surface-sunken`/`--accent`、6px 细滚动条）。验证：编辑器观感与全站一致。同时实机确认光标在 Monaco 内按 Ctrl+S 仍冒泡到 window 层保存（预期零接线），且不弹运行环境自身保存界面。
- [ ] 4.2 打包后复核：`npm run build && tauri dev`（WebView2）下 worker 起、补全能弹；失败则以 `getWorker` 返回 Worker 实例兜底。验证：打包产物里编辑面补全可用。
- [x] 4.3 清理 spike 临时文件：`src/dev/monacoSpike.tsx`、`src/dev/pm.d.ts`、`tests-browser/monaco-spike.spec.ts`、`main.tsx` 的 `#monaco-spike` 路由。验证：删除后无残留引用，`npm run build` 与全部测试通过。
