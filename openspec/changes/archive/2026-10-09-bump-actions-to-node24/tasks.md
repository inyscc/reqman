# Tasks

## 1. 升级 action 引用

- [x] 1.1 将 `.github/workflows/release.yml` 中 `actions/checkout@v4` 改为 `actions/checkout@v7`。验证：在该文件中检索 `actions/checkout@`，结果只剩一条且为 `@v7`
- [x] 1.2 将同文件中 `actions/setup-node@v4` 改为 `actions/setup-node@v7`。验证：检索 `actions/setup-node@` 只剩一条 `@v7`，且该 step 下的 `node-version: '24'` 与 `cache: npm` 两行未被改动
- [x] 1.3 复核其余四个引用保持原样，并确认未引入任何运行时开关。验证：全文件检索 `dtolnay/rust-toolchain@stable`、`swatinem/rust-cache@v2`、`tauri-apps/tauri-action@v1`、`actions/upload-artifact@v7` 各命中一处且未改名；同时检索 `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` 与 `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION` 均无命中

## 2. 通过手动触发验证流水线

- [x] 2.1 提交改动并推送到 `master`（远端 `git@github.com:inyscc/reqman.git`），再触发手动构建：`gh workflow run release.yml`。验证：`gh run list --workflow=release.yml --limit 1` 中出现本次运行，状态为 queued / in_progress
- [x] 2.2 等待运行结束后检视结论：`gh run watch <run-id>`，或打开该次运行的 Annotations 面板。验证：运行结论为 success，且 Annotations 中不再出现任何 `Node.js 20` 相关条目——这正是本 change 要达成的可观测结果
- [x] 2.3 确认本次手动触发的行为符合 design D6（只构建、不发布）。验证：`gh run view <run-id>` 显示 `reqman-windows` artifact 已上传，且与触发前对比 `gh release list --limit 1` 没有新增 Release 条目

## Workflow follow-up

- 在项目评审要求满足后归档本 change。
- 归档后确认 `openspec/specs/` 下未因本 change 产生任何增量——`skip_specs: true` 应使归档只落 change 目录，不改动规格。
