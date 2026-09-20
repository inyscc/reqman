# monaco-code-editors · design

## Context

三处编辑面现状（动机见 `proposal.md - Why`）：请求体 raw 是 `<textarea rows={10}>`，脚本 pre/test 是 `<textarea className="mono">` ×2，响应正文是只读 `<pre className="body">`。本设计的约束主要来自一次**已跑通的 spike**（`src/dev/monacoSpike.tsx` + `tests-browser/monaco-spike.spec.ts`），它把 Monaco 在 Tauri WebView2 里的 worker 装载与 `pm.environment.*` 补全验证为**可行**，并暴露了若干必须遵守的坑。

既有事实：

- 依赖极少且自控（6 个 runtime 依赖，`Dropdown.tsx` 是自绘的），倾向自己画控件。
- CSP 已放行 Monaco 需要的一切：`worker-src 'self' blob:`、`unsafe-eval`、`unsafe-inline`（`tests-browser/worker-csp.spec.ts` 已盯着这份 CSP）。
- 测试分两套：`vitest.config.ts` 跑 happy-dom（业务逻辑），`vitest.browser.config.ts` 跑本机 Chrome（playwright，编辑器真身）。
- `scriptRuntime.ts` 已示范"重依赖动态 import、不进启动模块图"的先例（postman-sandbox 3MB chunk）。
- 项目已把 `monaco-editor` 固定到 `0.54.0`（`package.json`）。

## Goals / Non-Goals

**Goals:**

- 三处编辑面换成 Monaco：高亮 + 行号、JSON 折叠、脚本 `pm.*` 补全。
- 现有 happy-dom 业务断言**一行不改**（经 mock 分层）。
- 响应正文超 10MB 降级为纯文本，大响应不卡主线程。
- `pm.d.ts` 与运行时 API 白名单保持单源，杜绝漂移。

**Non-Goals:**

- cURL 快照与其余小输入框保持 `<textarea>`，不动。
- 不做响应正文的"解析出路径的 JSON 树搜索/复制路径"（那是独立能力，超出本次范围）。
- 不迁移到 monaco 0.55+ 的新 LSP 架构（见决策 1）。

## Decisions

### 1. 固定 `monaco-editor@0.54.0`，不用 0.55+

Spike 实测：0.55 把 `languages.typescript` 从嵌套命名空间挪走，0.56 又重组 ESM 并加了**限制性 `exports`**，把 `monaco-editor/esm/vs/...` 深路径映射成 `esm/vs/esm/vs/...` 报"文件不存在"。网上所有「Monaco + Tauri/Vite + `?worker`」教程与下面的 worker 装载方案都是按**经典 API** 写的，0.54 是经典 API 的最后一个版本。

备选：0.56 最新（tree-shakeable、LSP 多语言服务器）——对本应用（单一 JS 语言补全）无实质收益，且新架构在 standalone 场景的文档/验证都缺。**否决**，固定 0.54.0。

### 2. `CodeSurface` 薄壳组件统一三处编辑面

三处需求不同（可写/只读、语言、高度、补全），抽一个 `<CodeSurface>` 组件承载：`readOnly`、`language`、`height`、`value`、`onChange`、`onSave`（Ctrl+S）、`enableCompletion`（脚本）等 prop。这样 mock 只 mock 一处，测试工作量减半（见决策 8）。cURL / 小输入框不走 CodeSurface。

### 3. Worker 装载：`MonacoEnvironment.getWorker` + `?worker` 构造器

Spike 验证过的装载方式（0.54 里 `getWorker()` 仍优先查 `MonacoEnvironment`）：

```ts
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';

self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === 'typescript' || label === 'javascript') return new TsWorker(); // JS 与 TS 共用 ts.worker
    if (label === 'json') return new JsonWorker();
    return new EditorWorker();
  },
};
```

注意 label 是 `this._modeId`：`typescript` 与 `javascript` 分开传，但共用同一个 ts.worker（JS 语言服务是 TS 的降级模式）。worker 经 CSP `worker-src 'self'` 满足，无需 `blob:` 兜底。

### 4. 模型 URI 必须用 `file://`

Spike 里卡最久的根因：默认 `inmemory://model/N` 这种 URI 会断 TS worker 的模型同步，补全/诊断全报 `Could not find source file`。改用 `monaco.editor.createModel(value, language, monaco.Uri.parse('file:///...'))` 立即正常。每个编辑面给一个稳定的 `file://` URI（如 `file:///reqman/body/<reqId>.json`）。

### 5. 语言贡献显式 import + `getJavaScriptWorker` 竞态重试

两个 spike 坑：

- `monaco-editor` 主入口只导出 editor 核心 API，`monaco.languages.typescript` **不会自动注册**——必须 `import 'monaco-editor/esm/vs/language/typescript/monaco.contribution'`（json 同理），否则 `javascriptDefaults` undefined。
- `getJavaScriptWorker()` 在 JS 语言服务经 `onLanguage` 异步注册完成前会以**字符串** `"JavaScript not registered!"` reject（不是 Error，`err.message` 是 undefined）。需要带重试地取（≤ 几十次轮询）。

另注：`getExtraLibs()` 返回 `{ filePath: content }` 对象，**不是数组**（判注入用 `hasOwnProperty`，别用 `.some()`）。

### 6. 响应正文只读 + 10MB 阈值降级

响应正文用 `CodeSurface readOnly`，但 Monaco 打开几 MB 文档要建 TextModel + 全量 tokenizer，主线程会卡。阈值集中为一个常量：

```ts
// lib/codeSurface.ts
export const CODE_SURFACE_MAX_BYTES = 10 * 1024 * 1024;
```

`size <= 10MB` → 只读 Monaco；`> 10MB` → 回落纯 `<pre className="body">` 原样展示 + "正文过大，高亮已禁用"提示。这与用户决策一致（"超过 10M 就原样展示"）。

**注意这是新增的第二个阈值，与既有的 50MB 截断上限是两回事**：`ResponsePanel.tsx` 已有的 `Math.min(response.size_bytes, 50 * 1024 * 1024)` 控制**后端保留多少正文**（截断），10MB 控制**用不用 Monaco 高亮**（渲染方式）。二者相互独立、各自保留，不合并。

### 7. `pm.d.ts` 从 postman-sandbox 的 `pm` 类型派生

`pm.*` 补全经 `monaco.languages.typescript.javascriptDefaults.addExtraLib(pmDts, 'pm.d.ts')` 注入。风险：运行时提供的 pm 能力清单与编辑器声明若各抄一份，迟早漂移。

**真源是 `postman-sandbox` 自带的类型**：`node_modules/postman-sandbox/types/index.d.ts` 里就是 `declare var pm: Postman;`（`Postman` 接口描述完整的 `pm.*` 面）。所以 `pm.d.ts` SHALL 从该类型派生（直接复用/裁剪 `Postman` 声明），**不是**从 `BRIDGE_EVENTS` 推导——`BRIDGE_EVENTS`（`scriptRuntime.ts`）只是宿主桥的 4 个低层事件（`console`/`assertion`/`sendRequest`/`cookies`），与 `pm.*` 公开 API 不是一回事。

对本项目补丁（`wrapUserScript` 里给 `pm.require` 打的别名）在派生结果上追加声明。同步检查：`pm.d.ts` 与固定的 `postman-sandbox@6.7.4` 的类型绑定，升级该依赖时须重新派生。

### 8. 测试分层：happy-dom mock + tests-browser 验真身

Monaco 在 happy-dom 跑不了（需真实 layout）。分层：

- `tests/**`（happy-dom）：`vi.mock` 把 `CodeSurface` 换成**保形**的元素，且要按编辑面区分形状（既有测试对三处的读法不同）：
  - 可写面（body raw、脚本 pre/test）：mock 成 `<textarea aria-label=...>`（透传 aria-label），保住 `(el as HTMLTextAreaElement).value` 读写；
  - 只读响应正文：mock 成保 **`data-testid="response-body"`** 且 `textContent` 等于正文的元素（如 `<pre data-testid="response-body">{value}</pre>`）——既有断言读的是 `screen.getByTestId('response-body').textContent`（`app.test.tsx`），**不是** `.value`；mock 成 `<textarea>` 会让 `textContent` 为空、断言挂掉。

  这样 `screen.getByLabelText('raw 正文')`、`getByTestId('response-body')`、`.value`/`.textContent` 这些既有断言**一行不改**，继续钉 draft 流转 / dirty / Minify-Beautify / cURL 语义。`vi.mock` 在项目里已有先例。
- `tests-browser/**`（本机 Chrome）：验证编辑器真身——补全弹出、折叠、行号、Ctrl+S、IME 中文输入。`vitest.browser.config.ts` + playwright 已接通。

### 9. 观感主题 + IME 实机验证

- 主题：`App.css` 是 1800+ 行手打浅色设计系统（`--panel-2`/`--surface-sunken`/`--accent`、6px 细滚动条）。Monaco 自带主题，需 `monaco.editor.defineTheme` 把 token 颜色与滚动条接到这些 CSS 变量上；语法配色参考 Postman 的浅色编辑器（注释绿 / 字符串暗红 / 数字青绿 / 关键字蓝 / JSON 键青蓝），即 `base: 'vs'` 的 Light+ 系，在 `rules` 里显式钉住。
- 浮层裁切：`.code-surface` 有 `overflow: hidden`（圆角需要），会把 Monaco 的补全/hover 浮层裁掉——光标靠上时光其明显。编辑器须设 `fixedOverflowWidgets: true`，让浮层改用 fixed 定位逃出裁切容器。
- Ctrl+S：**无需为 Monaco 额外接线**——Ctrl+S 已由 `App.tsx` 的 window 层 `onKeyDown` 监听（注释明说"不依赖焦点位置"），而 Monaco 默认不绑定 Ctrl+S，按键会冒泡到 window。只需 `tests-browser` 实机确认 Monaco 未吞掉该键（预期零改动），即可满足 `ui-layout` 的「Ctrl+S 保存当前编辑面」（本 change 已把该场景的"脚本文本域"措辞改为与控件无关）。
- IME：UI 全中文，用户会在 JSON 字符串/脚本里打中文。Monaco 在 Windows WebView2 的 IME 表现尚可，Mac/Linux 历史上 composition 有坑——`tests-browser` 起本机 Chrome 覆盖，Windows 之外需实机验证。

## Risks / Trade-offs

- **0.54.0 是"旧"版本** → 明确取舍：为经典 API 的成熟度与文档密度放弃最新版；0.56 的新 LSP 架构本应用用不上。锁定在 `package.json`。
- **worker 在 Tauri 打包后（`tauri://`/`http://tauri.localhost`）的可用性** → Spike 已在浏览器（vite dev）验证；打包后 WebView2 需按同一 spike 路径再验一次（tasks 里列一项，若失败用 `getWorker` 返回实例而非 URL 兜底）。
- **`pm.d.ts` 漂移** → 决策 7 单源，减少但仍需 review 纪律。
- **Monaco 体积** → 懒加载，只在打开编辑面时加载；入口 chunk 不增（可像 `scriptRuntime.ts` 那样用断言钉住）。
- **IME 在 Mac/Linux** → Windows 优先，其它平台标记为需实机验证（Open Questions）。

## Migration Plan

1. `package.json` 已固定 `monaco-editor@0.54.0`（已就位）。
2. 实现 `CodeSurface` + worker 装载 + 三处接入（body / scripts / response）。
3. 测试分层落地：happy-dom mock `CodeSurface`，`tests-browser` 加编辑器用例。
4. **清理 spike 临时文件**：`src/dev/monacoSpike.tsx`、`src/dev/pm.d.ts`、`tests-browser/monaco-spike.spec.ts`，以及 `main.tsx` 的 spike 路由（`#monaco-spike` 分支）。

回滚：单 commit 引入，回滚即 revert；`CodeSurface` 未启用时可回退到原 `<textarea>`/`<pre>` 渲染（保留为 feature flag 备选）。

## Open Questions

- **打包后 WebView2 的 worker**：spike 在浏览器验证过，但 `tauri://` 自定义协议下 `worker-src 'self'` + `new Worker(url)` 的组合需打包后实机复核（兜底：`getWorker` 返回实例）。
- **Mac/Linux 的 IME composition**：Windows WebView2 表现尚可，其它平台中文输入需实机确认；不影响 Windows 首发。
