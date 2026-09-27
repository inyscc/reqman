## Context

动机见 proposal.md — Why。影响取舍的是这几处已核对的事实：

1. **`monaco-editor@0.54.0` 把 `dompurify` 写成精确版本 `3.1.7`**（不是范围）——要带走它，要么随 monaco 一起升，要么用 `overrides` 覆盖。`0.57.0` 自带 `3.4.15`，但升级它另有代价（见 D1）。
2. **`mocha@11.7.5` 仍写 `serialize-javascript: ^6.0.2`** —— mocha 11 到不了修复区间，必须跨到 12（`^7.1.1`）。
3. **`crypto-js` 4.x 与 3.x 的 API 形态一致**（`CryptoJS.<算法>` 对象式调用），风险主要在模块格式而非接口；它在 vendored 的上游代码里被使用。
4. 三处的 scope：`dompurify` 随 monaco 在 runtime（会进发布产物），`crypto-js` 与 `mocha` 在 development（不进发布产物）。

## Goals / Non-Goals

**Goals:**

- 让 24 条漏洞对应的依赖**实际解析到**已修复版本。
- 每一处都能单独回退，不产生"绑在一起的升级"。

**Non-Goals:**

- 不动带 4 条漏洞的 `cheerio` 与 `postman-collection`（理由见 proposal 的「不做」）。
- 不把 `overrides` 当成通用手段：只在 dompurify 这种「minor 修复 + 本项目几乎不触达的路径」上用（D1）；faker / uuid 那种 major 跳跃仍等上游。

## Decisions

### D1. 用 overrides 提升 dompurify，而不是升级 monaco-editor

**实测推翻了我最初的方向。** 原本打算升 monaco（0.54 → 0.57）以带上它自己的 dompurify，理由是"上游的选择比 overrides 可靠"。实测（`npm run build` + 浏览器套件）立刻失败，查 CHANGELOG 发现 **0.56 是 breaking**：

- `monaco-editor/esm/vs/editor/editor.worker` 不再可解析（0.57 里是 `editor.worker.js`，另有新的 `editor.worker.start.js`）；
- `monaco-editor/esm/vs/language/*/monaco.contribution` 的副作用导入失去类型声明（TS2882）；
- `monaco.languages.typescript` 被标记为 deprecated，`javascriptDefaults` / `getJavaScriptWorker` 从它的类型里消失（TS2339）。

而 `src/lib/monacoEnv.ts` 恰恰是**围绕这些路径 spike 出来的**——worker 装载、contribution 显式导入、TS worker 的注册竞态重试，都是那份"已跑通的装载要点"里的硬约束。适配它等于把这件事重做一遍，风险与收益不成比例；它应当是一次独立的改动，而不是"消掉依赖漏洞"的附带。

转向的另一个依据来自漏洞本身的性质：dompurify 的修复是 **3.1.7 → 3.4.15（minor）**，monaco 只调用它稳定的 `sanitize` 接口，而本项目不使用 monaco 的 Markdown 预览——这条路径在 reqman 里几乎不被触达。

- **做法**：`overrides: { "dompurify": "^3.4.15" }`，`monaco-editor` 留在 0.54.0。
- **代价**：解析结果与 monaco 声明不符（这一点在 lock 里是显式的、可回退的）。
- **不把这个做法推广到 faker / uuid**：那两条是 major 跳跃（5→10、8→11），与 dompurify 的 minor 修复不是一回事，仍按原计划等上游。

### D2. mocha 跨到 12，并把 overrides 留作回退

mocha 11 仍锁 `serialize-javascript@^6`，所以"升一个 major"解决不了问题。直接跨到 12，它自带 `^7.1.1`。

- **备选：保留 mocha 10 + `overrides: { serialize-javascript: ^7.1.2 }`。** 不否决，而是**降级为回退方案**：若 mocha 12 跑不起上游套件，就退回这条路，并在 tasks 里记录实际走过的路径。它更保守，但绕开了 runner 自己的依赖声明。
- **影响面有限**：mocha 只用于 `npm run test:upstream`（vendored 套件的 runner），不参与应用构建。

### D3. 以本地解析版本判定成功，不等 Dependabot

Dependabot 的重扫是异步的（推送之后才可能更新）。判据以 `npm ls` 的**实际解析结果**为准：dompurify ≥ 3.4.13、crypto-js = 4.2.0、serialize-javascript ≥ 7.0.5。Dependabot 的开放条目数只做事后核对——若它暂时还是 28 条，不代表这次升级失败。

## Risks / Trade-offs

- **R1：overrides 让 monaco 拿到一个它没声明过的 dompurify（3.1.7 → 3.4.15）** → 二者是 minor 关系，monaco 只用到稳定的 `sanitize` 接口，且本项目的 monaco 不使用 Markdown 预览。回归由 `npm run build` 与 `tests-browser/` 的真实引擎用例覆盖；失败则删掉 overrides 回退（20 条随之回来），不影响另外两处。
- **R2：mocha 10 → 12 可能跑不起上游套件** → 该套件是 vendored 的第三方测试，与产品行为无关；失败则按 D2 的回退方案处理。
- **R3：crypto-js 3 → 4 影响 vendored 上游代码** → 由 `npm run test:upstream` 覆盖（其中确有使用它的用例）。
- **R4：漏洞数下降但暴露面未必等比例下降** → 20 条 dompurify 来自同一条渲染路径的多个 advisory，属于"同一处被重复计数"。这次升级的实质收益是"该路径不再使用有已知缺陷的版本"，而不是"修好了 20 个独立问题"。
