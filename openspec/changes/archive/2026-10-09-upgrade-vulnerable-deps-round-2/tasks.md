## 1. 三处升级（D1 / D2 / D3）

- [x] 1.1 dompurify 的 override 由 `^3.4.15` 抬到 `^3.4.16` 并刷新锁文件 — 验证：`npm ls dompurify` 显示 3.4.16（这三处版本改动在排查时已落到工作区，本步是核对，并把声明改到新 advisory 的修复版本）
- [x] 1.2 source-map-js 刷新到 1.2.2，**不加 override**（父范围 `^1.2.1` 本就允许）— 验证：`npm ls source-map-js` 显示 1.2.2，且 `package.json` 的 `overrides` 里**没有**新增 source-map-js
- [x] 1.3 rustls 用 `cargo update -p rustls --precise 0.23.45` 定点升级 — 验证：`src-tauri/Cargo.lock` 中 rustls = 0.23.45，且 `git diff` 显示该文件只动了 rustls 一处、没有顺带漂移其它依赖

## 2. 回归验证（R1 / R2 / R3）

- [x] 2.1 类型检查与前端单测 — 验证：`npx tsc --noEmit` 无输出；`npm test` 520 passed / 0 failed（source-map-js 只在 dev 期，由这条覆盖）
- [x] 2.2 生产构建 — 验证：`npm run build` 成功（dompurify 会进发布产物，这条路径必须真的构建过一次）
- [x] 2.3 浏览器套件 — 验证：`npm run test:browser` 15 文件 / 113 passed（真实引擎，覆盖 monaco——也就是 dompurify 所在的那条渲染路径）
- [x] 2.4 后端测试 — 验证：`cargo test --lib` 396 passed / 0 failed（rustls 在 TLS 栈里；其中含本地自建 HTTPS 测试服务器与自签证书的用例）

## 3. 记录不可动项（D4）

- [x] 3.1 README「已知限制」新增一条，列出 `@faker-js/faker`、`uuid`、`lodash.pick`、`glib` 四条与各自一句理由（漏洞够不着 / 上游无补丁版本 / 只在 dev 期 / 只在 Linux 构建图）— 验证：逐条对照 proposal 的「不做」，四处理由一致，且每条理由都能在仓库内查到依据
- [x] 3.2 **不**在 GitHub 上 dismiss 这四条 — 验证：推送后 `gh api repos/inyscc/reqman/dependabot/alerts?state=open` 仍列出这四条

## 4. 收尾

- [x] 4.1 复查三处的实际解析版本（D5 的判据，不以 Dependabot 的重扫为准）— 验证：`npm ls dompurify` = 3.4.16、`npm ls source-map-js` = 1.2.2、`Cargo.lock` 的 rustls = 0.23.45
- [x] 4.2 推送后核对开放条目数 — 验证：`gh api ...dependabot/alerts?state=open` 计数为 4，且列表里不再出现 dompurify / source-map-js / rustls
- [x] 4.3 规划产物自校验 — 验证：`openspec validate upgrade-vulnerable-deps-round-2 --strict` 退出码 0
- [x] 4.4 提交本次改动（依赖版本 + README 条目 + 本 change 的规划产物）— 验证：`git log` 有对应提交，且 `git status --short` 干净

## Workflow follow-up

- 走 `/opsx:apply` 实施本变更。
- 按项目的评审要求完成后归档本变更。
- 归档后确认 `openspec/specs/` 未被改动（本 change 声明 `skip_specs: true`）。
