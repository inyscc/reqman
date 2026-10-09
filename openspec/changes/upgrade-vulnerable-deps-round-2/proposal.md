## Why

GitHub 的 Dependabot 在默认分支上报了 8 条开放的依赖漏洞（3 high / 3 medium / 2 low）。上一轮 `upgrade-vulnerable-deps` 把 28 条清到 4 条之后，本次推送版本号时又新出现 4 条（`dompurify`、`source-map-js`、`rustls` 是本轮新 advisory，不是上一轮漏掉的）。

逐条查清引入路径后，**其中 4 条集中在三处、都能用低风险方式消除**；剩下 4 条各有明确的不可动理由，而且**它们正是上一轮特意留下的那 4 条**（`@faker-js/faker`、`uuid`、`lodash.pick`、`glib`，见「不做」）。

三处集中点：

- `dompurify` 独占 2 条（low）：本仓上一轮已用 `overrides` 把它从 monaco 声明的 `3.1.7` 提到 `^3.4.15`，而本轮 advisory 的修复版本是 **3.4.16**——同一条 override 再抬一格即可。
- `source-map-js` 贡献 1 条（high）：`css-tree@3.2.1` 声明的是 `^1.2.1`，**1.2.2 本就在这个范围内**，只是锁文件还停在 1.2.1。
- `rustls` 贡献 1 条（medium）：`reqwest` / `hyper-rustls` / `tokio-rustls` 声明的都是 `0.23`，0.23.45 是同一 minor 线上的补丁版。

## What Changes

- **`dompurify` 的 override `^3.4.15` → `^3.4.16`**：`monaco-editor@0.54.0` 把 dompurify 写成精确版本 `3.1.7`，所以 overrides 是唯一出口（这一点上一轮已实测确认，见 design D1）。本次只是把同一条 override 抬到新 advisory 的修复版本。
- **`source-map-js` 1.2.1 → 1.2.2**：父范围本就允许，刷新锁文件即取到，无需新增 override。
- **`rustls` 0.23.44 → 0.23.45**：`cargo update -p rustls --precise 0.23.45`，补丁升级。

三处**彼此独立**，任一处引发回归都能单独退回原版本。

**不做**（有意排除，理由随附）：

- **不用 `overrides` 强升 `@faker-js/faker`（5.5.3）与 `uuid`（8.3.2）**：这两条不但被 `postman-collection@5.3.1` 精确锁定，而且**上游没有可迁移的版本**——`postman-sandbox` 最新版就是本仓在用的 6.7.4，`postman-collection` 最新版就是 5.3.1，其最新版依然精确写着 `@faker-js/faker: 5.5.3` 与 `uuid: 8.3.2`。硬顶的话：faker 5→10 跨五个大版本，`postman-collection` 在用的 `faker.random.*` / `faker.name` 在 v6 就被移除，**会打断 `{{$randomXxx}}` 的替换**；uuid 那条漏洞要求调用 v3/v5/v6 时显式传入 `buf`，而本仓与上游生成 id 走的是 `v4()`，够不着。这与上一轮的政策一致。
- **不动 `lodash.pick@4.4.0`**：**上游没有修复版本**（lodash 单体包已废弃，4.4.0 是最后一版）。它只经 `devDependencies` 里的 `cheerio@^0.22.0` 进来，供 `tests/upstream/...` 的上游套件使用，不进发布产物。与上一轮一致。
- **不动 Rust 侧的 `glib`（0.18.5）**：来源是 `tauri → gtk → atk → glib`，**Linux 专属**；交付物是 Windows 安装包，它不在构建图里。`cargo update -p glib` 报 `Locking 0 packages`（gtk 0.18 钉住 glib 0.18，要动得整条 gtk-rs 栈跟着走，那是上游的事）。与上一轮一致。
- **不在 GitHub 上 dismiss 上面 4 条**：上一轮同样留下这 4 条、并未 dismiss——它们今天还开着，正是「这四条还欠着上游」的可见提醒。列表看着清爽不是收益；Dependabot 的开放条目数在这里当提醒用（见 design D4）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无）

本 change 只调整依赖版本，不改变任何可观测行为，因此 `.openspec.yaml` 声明 `skip_specs: true`。

## Impact

- **代码**：`package.json`（一条 `overrides` 的版本号）与随之的 `package-lock.json`、`src-tauri/Cargo.lock`。**不改任何源码。**
- **当前工作区状态**：这三处版本改动在排查过程中已经落到工作区（未提交）。本 change 的作用是把它记录成一次有据可查的变更，并承担随后的验证与提交——apply 阶段的主要工作因此是**核对解析结果 + 回归验证 + 提交**，而不是重新改一遍版本号。
- **风险面**：`dompurify` 随 monaco 在 runtime（进发布产物），但只是补丁级提升且本项目不使用 monaco 的 Markdown 预览；`source-map-js` 与 `rustls` 分别只在 dev 期与 TLS 栈内。三处都没有跨 major。
- **可验证的结果**：三处依赖实际解析到已修复版本；Dependabot 的开放条目应从 8 降到 4（剩下的就是明确不动的四条）。
