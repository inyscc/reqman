## Why

GitHub 的 Dependabot 在默认分支上报了 28 条开放的依赖漏洞（2 critical / 3 high / 19 medium / 4 low）。逐条查清引入路径后，其中 **24 条集中在三处，且都能用低风险的方式消除**；剩下 4 条各有明确的不可动理由（见「不做」）。

三处集中点：

- `dompurify` 独占 20 条（medium / low）：`monaco-editor@0.54.0` 把它的版本写成了**精确值** `3.1.7`。
- `crypto-js@3.3.0` 贡献 2 条 critical：来自本仓库 `devDependencies` 的直接声明。
- `serialize-javascript` 贡献 2 条（high / medium）：`mocha@10.8.2` 锁在 6.x，而 **mocha 11 仍然锁 6.x**，只有 12 才带 `^7.1.1`。

## What Changes

- **`dompurify` 通过 `overrides` 提升到 `^3.4.15`**：这是 20 条的唯一出口。最初打算升级 `monaco-editor`（0.54 → 0.57）来带上它，**实测否决了那条路**——0.56 重排了整个 ESM 入口，项目的 Monaco 集成层（`src/lib/monacoEnv.ts`）围绕旧路径构建，构建与浏览器套件立刻失败（细节见 design D1）。dompurify 的修复是 minor（3.1.7 → 3.4.15），且本项目不使用 monaco 的 Markdown 预览，因此 overrides 的兼容风险很低。
- **`crypto-js` `^3.3.0` → `^4.2.0`**：消掉 2 条 critical（仍是 devDependency，不进发布产物）。
- **`mocha` `^10.8.2` → `^12`**：随它把 `serialize-javascript` 带到 7.x，消掉 2 条。

**不做**（有意排除，理由随附）：

- **不升级 `monaco-editor`**：0.54 → 0.57 需要把 `src/lib/monacoEnv.ts` 的加载要点（worker 入口、语言贡献导入、语言服务 API）整体迁到 0.56 之后的新入口。那是一次独立的适配工作，不该塞进"消除依赖漏洞"里；本 change 用 overrides 达成同一目标。
- **不动 `cheerio@0.22.0`**：它带来 `lodash.pick@4.4.0`（high，**上游没有修复版本**——该包早已废弃）。唯一出路是把 cheerio 升到 1.x，而 vendored 的上游套件用的是 0.22 的旧 API，改动会扩散进 vendored 代码。它是 devDependency，不进发布产物。
- **不用 `overrides` 强升 `postman-collection` 的 `faker` / `uuid`**：那是 major 跳跃（faker 5→10、uuid 8→11），与 dompurify 那种 minor 修复不是一回事，等于替上游赌兼容性。等上游发版。
- **不动 Rust 侧的 `glib`**：它是 Linux 平台的间接依赖，Windows 依赖树里根本不存在，不影响本项目的发布产物。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无）

本 change 只调整依赖版本，不改变任何可观测行为，因此 `.openspec.yaml` 声明 `skip_specs: true`。

## Impact

- **代码**：只动 `package.json`（两个版本号 + 一条 `overrides`）与随后的 `package-lock.json`。
- **风险面**：`crypto-js` 与 `mocha` 各跨一个 major，都只在 `npm run test:upstream` 这条链上（vendored 套件的 runner 与它用到的库），不进发布产物；dompurify 是 minor 提升，且只被 monaco 的 Markdown 预览路径使用。
- **回退**：三处彼此独立，任一处引发回归都能单独退回原版本。
- **可验证的结果**：三处依赖实际解析到已修复版本，Dependabot 的开放条目应从 28 降到 4。
