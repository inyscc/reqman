# Proposal

## Why

release 流水线每次运行都会带出两条告警：`actions/checkout@v4` 与 `actions/setup-node@v4` 声明运行在 **Node 20** 上，而 runner 上的 Node 20 已于 **2026-09-23** 被彻底移除，这两个 action 只能被强制改到 Node 24 执行。

告警本身不影响当前构建（作业仍成功），但它指向的是本仓库 CI 中**仅剩的两处未跟上 Node 24 的引用**——同一个 workflow 里的 `upload-artifact@v7`、`rust-cache@v2`、`tauri-action@v1` 都已在各自上游切到 `node24`。同时，原本可用于过渡的 `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION` 开关已随 Node 20 一并失效，**除升级引用外已无其他出路**，拖延只会让流水线长期依赖 runner 的强制行为。

## What Changes

- **`actions/checkout` 由 `@v4` 升到 `@v7`**（`.github/workflows/release.yml`）。
- **`actions/setup-node` 由 `@v4` 升到 `@v7`**（同上）。选 v7 而非"刚好拿到 `node24`"的 v5，是为了与文件里既有的 `upload-artifact@v7` 处在同一条最新线上，避免下次常规维护时再动一次；版本取舍见 design 的 D1。
- **BREAKING（上游层面，本 workflow 不受影响）**：`checkout` v6/v7 默认阻止在 `pull_request_target` / `workflow_run` 场景下检出 fork 的 PR；本 workflow 只由 `push: tags: v*` 与 `workflow_dispatch` 触发，两者都不是 fork-PR 上下文。
- **BREAKING（上游层面，本 workflow 不受影响）**：`setup-node` v5 起，当 `package.json` 存在 `packageManager` 字段时自动启用缓存；v6 把自动缓存收窄为仅 npm；v7 迁移到 ESM 并移除 dummy `NODE_AUTH_TOKEN` 导出。本仓库 `package.json` 无 `packageManager` 字段、已显式声明 `cache: npm`、且不向 npm registry 发布，三条均不触及。
- **保持不动的引用**：`dtolnay/rust-toolchain@stable`（composite action，不含 Node 运行时）、`swatinem/rust-cache@v2`（已声明 `node24`）、`tauri-apps/tauri-action@v1`（已声明 `node24`）、`actions/upload-artifact@v7`（已声明 `node24`）。
- **不新增任何绕过开关**：不设 `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24`，也不设已失效的 `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION`。

**不做**（有意排除，理由随附）：

- **不把版本引用改成 commit SHA 锁定**：SHA 锁定能收紧供应链面，但它是一次独立的安全姿态调整，会引入"每次升级都要改 SHA + 加注释说明版本"的长期维护成本，与"消掉 Node 20 告警"不是同一件事。
- **不动 `node-version: '24'`**：这是 setup-node 为构建准备用的 Node 版本，与 action 自身的运行时无关，本来就已是 24。
- **不对齐 README 的 `Node 22+` 与 CI 的 `node 24`**：两者描述的是不同对象（开发者本机环境 vs CI 构建环境），是否收窄本机要求是独立决策，见 design 的 Non-Goals。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无）

本 change 只调整 CI workflow 中 action 的版本引用，不改变任何可观测行为（安装包内容、构建步骤、触发条件均不变），因此 `.openspec.yaml` 声明 `skip_specs: true`。

## Impact

- **代码**：只动 `.github/workflows/release.yml` 中的两个 `uses:` 行。
- **运行时/产物**：无影响。两个 action 只承担"拉取代码"与"安装 Node"，升级不改变两者对构建输入输出的贡献。
- **CI 行为**：告警消失；其余步骤不再受 runner 对 Node 20 的强制改写影响。
- **风险面**：改动集中在流水线入口，任何不兼容都会在 workflow 启动阶段立刻失败，而非延迟到打包；回退只需把两个引用改回 `@v4`。
- **可验证的结果**：手动触发（`workflow_dispatch`，该路径只构建、不创建 Release）跑一次，确认运行日志中不再出现 Node 20 相关 annotation。
