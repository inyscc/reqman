# Design

## Context

动机见 proposal.md - Why。影响取舍的是这几处已核对的事实：

1. **runner 侧的时间线**：Node 20 于 2026-04 EOL；runner 自 2026-06-16 起默认使用 Node 24；2026-09-23 Node 20 从 runner 移除，同时 `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION` 回退开关一并失效。也就是说，今天除升级引用外没有别的出口。
2. **`.github/workflows/release.yml` 是本仓库唯一的 workflow**，触发条件只有 `push: tags: v*` 与 `workflow_dispatch` 两种。
3. **同一个 workflow 内另外四个 action 的运行时**（逐个读上游 `action.yml` 的 `runs.using` 核对）：

   | action | 引用 | `runs.using` |
   |---|---|---|
   | `dtolnay/rust-toolchain` | `@stable` | `composite`（无 Node 运行时） |
   | `swatinem/rust-cache` | `@v2` | `node24` |
   | `tauri-apps/tauri-action` | `@v1` | `node24` |
   | `actions/upload-artifact` | `@v7` | `node24` |

4. **告警点名的恰好只有 `checkout@v4` 与 `setup-node@v4`**，与上表的盘点结果一致——不存在未被点名的第三处 Node 20 依赖。
5. **本仓库 `package.json` 没有 `packageManager` 字段**（`package-lock.json` 存在）。

## Goals / Non-Goals

**Goals:**

- 让 `release.yml` 里每个 action 都声明 `node24`（或不含 Node 运行时），从根上消掉这类告警，而不是压掉它。
- 版本选择不引入与"摆脱 Node 20"无关的行为漂移。
- 提供一条不消耗真实发版的验证路径。

**Non-Goals:**

- **不收紧供应链姿态**：不改 SHA 锁定、不引入版本更新自动化。那是一次独立的安全决策，不应塞进"消掉 Node 20 告警"里。
- **不对齐本机 Node 要求与 CI 构建 Node**：`README.md` 写的是开发者本机 `Node 22+`，workflow 里 `node-version: '24'` 是 CI 构建用版本，两者描述不同对象。是否把本机要求也提到 24 是独立决策。
- **不重构 workflow**：缓存策略、并发组、Release 参数、artifact 路径都保持原样。

## Decisions

### D1. 两个 action 都升到 v7，而不是最小跳到 v5

`node24` 的分界点与当前 latest：

```
actions/checkout      v5.0.0 = node24 起点      latest = v7.0.1
actions/setup-node    v5.0.0 = node24 起点      latest = v7.1.0  (2026-10-08 发布)
```

- **选 v7**：文件里 `upload-artifact` 已经在 v7 线，让这两条也落在同一条 latest 线上，避免下次常规维护时再动一次同一处。
- **备选 v5**：这是"刚好拿到 `node24`"的最小跳，同样能消除告警，且跨过的上游变更面更小。若评审倾向保守，切 v5 是等价可行的选择——**本 change 不依赖 v7 独有的任何特性**，D2/D3 的排除论证对 v5/v6/v7 都成立。
- **否决"停在 v4 并靠 runner 强制"**：这正是当前告警的状态。它依赖 runner 的强制行为而非 action 自己的声明，是不可控的长期依赖。

### D2. checkout 的 `allow-unsafe-pr-checkout` 不构成影响

`checkout` v6/v7（并反向移植到 v5.1.0、v4.4.0）默认阻止在 `pull_request_target` 与 `workflow_run` 场景下检出 fork 的 PR。而本 workflow 的触发面是：

```
on:
  push:  tags: v*
  workflow_dispatch
        |
        +-- pull_request_target  x 不适用
        +-- workflow_run         x 不适用
```

两条触发路径都不构成 `pull_request_target` / `workflow_run` 上下文，因此该限制的适用条件不成立，v5/v6/v7 任一选择都不受影响。

### D3. setup-node 的自动缓存与 ESM 变更不构成影响

- **v5.0.0**：`package.json` 存在 `packageManager` 字段时自动启用缓存（可用 `package-manager-cache: false` 关闭）。已核对本仓库 `package.json` **没有**该字段 → 不触发。
- **v6.0.0**：把自动缓存收窄为仅 npm。本项目只用 npm。
- **v7.0.0**：迁移到 ESM，并移除 dummy `NODE_AUTH_TOKEN` 导出。本 workflow 不向任何 registry 发布（`GITHUB_TOKEN` 只提供给 `tauri-action` 用于创建 Release），不依赖该导出。
- **现有写法继续成立**：workflow 里是显式的 `cache: npm`，且 `package-lock.json` 存在，满足该缓存模式的前提。

### D4. 不引入任何 Node 运行时开关

- `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` 的语义是"提前切到 24"，而 24 如今已是唯一运行时，设置它没有任何作用。
- `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION` 已随 Node 20 的移除而失效，设置它不会生效。

两者都只会变成日后需要清理的历史包袱，因此一个都不加。

### D5. 其余四个 action 保持引用不变

依据上表逐个核对的结果：`rust-toolchain` 是 composite action，本身不含 Node 运行时；`rust-cache@v2`、`tauri-action@v1`、`upload-artifact@v7` 上游已在其浮动主标签上声明 `node24`。因此它们的"引用不变"不等于"没跟上"，而是"已经在了"。

### D6. 验证走 `workflow_dispatch`，不消耗真实发版

`release.yml` 已内建手动触发分支：`tauri-action` 与产物上传两步都以 `if: github.event_name == 'workflow_dispatch'` 为条件，因此手动触发只构建、把产物留成 Actions artifact，**不创建 Release**。这正是"打标签前先验证流水线"的既有设计，用它确认告警消失，无需为了验证去推一个真实标签。

## Risks / Trade-offs

- **R1：v5 → v7 跨两个 major，可能带入与 Node 运行时无关的行为变化** → 这两个 action 的职责极窄（拉取代码、安装 Node），任何不兼容都会在 workflow 启动阶段立刻失败而非延迟到打包；两者互相独立，回退是把对应引用改回 `@v4`。
- **R2：`setup-node@v7.1.0` 发布于 2026-10-08（前一日），线非常新** → 若求稳可停在 v6；本 change 的验收标准只有"告警消失 + dispatch 跑通"，v6 同样满足，切换成本是改一个数字。
- **R3：依赖浮动主标签意味着上游在该线上的后续改动会被自动接收** → 这是仓库既有做法（`@v4`、`@v7`、`@v2`、`@stable` 全是浮动标签），本 change 不改变这一姿态，也不把它当作本次要解决的问题。
- **R4：告警消失只能证明"声明与运行时不再冲突"，不能证明上游行为零变化** → 由"dispatch 构建成功 + artifact 上传成功"共同覆盖；真正的端到端确认仍然是下一次真实发版，这一点无法提前替代。

## Migration Plan

1. 改 `.github/workflows/release.yml` 中两处 `uses:` 引用。
2. 手动触发一次（`workflow_dispatch`），确认：Node 20 相关 annotation 消失、Windows 构建成功、artifact 上传成功。
3. 若失败：两个引用彼此独立，逐个回退到 `@v4` 定位是哪一处引起。

无状态迁移，不涉及数据回滚。
