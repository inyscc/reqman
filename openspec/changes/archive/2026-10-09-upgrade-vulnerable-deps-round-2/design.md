## Context

动机见 proposal.md — Why。影响取舍的是这几处已核对的事实：

1. **`monaco-editor@0.54.0` 把 `dompurify` 写成精确版本 `3.1.7`**（不是范围），所以 dompurify 的版本只能由 `overrides` 决定。上一轮已实测否决过"升 monaco 来带上它"这条路（0.56 重排 ESM 入口，构建与浏览器套件立刻失败，见 archived `upgrade-vulnerable-deps` 的 D1），该结论本轮仍然成立，不再重复试。
2. **现有 override 是 `^3.4.15`，锁文件冻结在 3.4.15**：`^3.4.15` 语义上本就允许 3.4.16，也就是说"能不能装到修复版"一直是能；挡住它的是锁文件，不是范围。
3. **`source-map-js` 的父声明是 `^1.2.1`**（`css-tree@3.2.1`），1.2.2 本就在范围内。它只经 `css-tree ← jsdom` 在 **dev 期**使用。
4. **`rustls` 有三个父声明（`reqwest` / `hyper-rustls` / `tokio-rustls`），都写 `0.23`**；0.23.45 是同一 minor 线上的补丁版。实测 `cargo update -p rustls` 的提示是 `84 unchanged dependencies behind latest`——笼统更新会顺带推动另外 84 个包。
5. **不动的那四条正是上一轮留下的那四条**：`@faker-js/faker`、`uuid`、`lodash.pick`、`glib` 今天仍开着，这本身就是"上一轮没有 dismiss 它们"的证据。
6. 镜像上 `dompurify@3.4.16`、`source-map-js@1.2.2`、`rustls 0.23.45` 均可取（逐个 `npm view` 与 `cargo update --dry-run` 确认过）。

## Goals / Non-Goals

**Goals:**

- 让本轮四条新 advisory 对应的依赖**实际解析到**已修复版本。
- 每一处都能单独回退，不产生"绑在一起的升级"。
- 把"剩下四条为什么不动"写成可复查的依据，并且**让它在仓库里可见**（见 D4）——上一轮只在已归档的 change 里写过，仓库本身不留痕。

**Non-Goals:**

- 不动 `@faker-js/faker` / `uuid` / `lodash.pick` / `glib`（理由见 proposal 的「不做」）。
- 不把 `overrides` 当通用手段：只在"上游把版本钉死、且修复是安全的量级"时用。`source-map-js` 有正常路径，就不走 overrides。
- 不做依赖的全量更新（那是另一件事，见 D3）。

## Decisions

### D1. dompurify：把 override 抬到 `^3.4.16`，不动 monaco-editor

**备选一：只刷新锁文件，不动 `package.json`。** 因为 `^3.4.15` 本就允许 3.4.16，单靠 `npm update` 也能把它装上去。不采纳：**差别不在能不能装，而在声明表达了什么**。`^3.4.15` 写的是上一轮的修复版本，而该版本现在已被新 advisory 判为有缺陷——留在声明里，下一次有人（或某个自动化）读 `package.json` 时会读到一个错的答案：它看起来像是"本项目要求的底线已经安全了"。

**备选二：升级 `monaco-editor` 以带上它自己的 dompurify。** 上一轮实测否决（0.56 起是 breaking，`src/lib/monacoEnv.ts` 的装载要点围绕旧入口构建）。本轮没有新信息推翻它，不重试。

**做法**：`overrides: { "dompurify": "^3.4.16" }`，`monaco-editor` 留在 0.54.0。
**代价**：解析结果仍与 monaco 声明不符（这一点在 lock 里是显式的、可回退的）——这与上一轮相同，属于已知且被接受的状态。

### D2. source-map-js：刷新锁文件，不加 override

父范围 `^1.2.1` 本就允许 1.2.2，`npm update source-map-js` 即取到。

**备选：加一条 `overrides: { "source-map-js": "^1.2.2" }`。** 不采纳：override 是"上游声明到不了修复版本时"的手段，这里上游声明是对的，用 override 会在将来别人问"为什么要覆盖"时留下一条没有理由的覆盖，也会掩盖"这条本来就能正常升级"这一事实。

### D3. rustls：用 `--precise` 定点升级，不用笼统的 `cargo update`

`cargo update -p rustls --precise 0.23.45` 只动这一个包。**备选：`cargo update -p rustls`（不带 `--precise`）**——它会顺带把其它可更新的依赖推到各自范围内最新（实测提示 84 个候选），把一次安全补丁扩散成一次全量依赖漂移，review 时也说不清"哪一行是这次要的"。不采纳。

**顺带记录**：`glib` 那条之所以单列，不只是"Linux 专属"，还因为 `cargo update -p glib` 报 `Locking 0 packages`——gtk 0.18 把 glib 钉在 0.18，单独升它根本锁不进依赖图。

### D4. 保留那四条开放告警，并把它们的理由写进 README 的「已知限制」

**不 dismiss。** 沿用上一轮的做法（今天仍开着的四条即为证据）。开放条目在这里当"还欠着上游"的提醒用；把它们 dismiss 掉会让"这四条还没解决"这件事从列表里消失，列表看着清爽不是收益。

**但这次多一步：写进 README。** 上一轮把理由只写在了已归档的 change 里，仓库本身不留痕——今天打开 README 的人无法知道那四条是**知情保留**而不是漏掉的。这与 README「已知限制」一节的既有用法一致（那一节记的正是这类"知道、但当前不动"的边界，例如脚本 console 掩码可被编码绕过）。

**备选：只在 change 里记，不动 README。** 也就是上一轮的做法。不采纳的理由如上：一个只存在于归档产物里的理由，等于只有翻归档的人看得到。

### D5. 成功以本地解析结果判定，不等 Dependabot

Dependabot 的重扫是异步的（推送之后才可能更新）。判据以**实际解析结果**为准：`npm ls dompurify` = 3.4.16、`npm ls source-map-js` = 1.2.2、`Cargo.lock` 的 rustls = 0.23.45。开放条目数只做事后核对——推送后它暂时还是 8 条，不代表这次升级失败。

## Risks / Trade-offs

- **R1：dompurify 的补丁提升落在 monaco 的 sanitize 路径上** → 3.4.15 → 3.4.16 是补丁级，且本项目不使用 monaco 的 Markdown 预览。由 `npm run build` 与 `tests-browser/` 的真实引擎用例覆盖；失败则删掉 override 的版本改动、退回 3.4.15（两条告警随之回来），不影响另外两处。
- **R2：source-map-js 影响 dev 期的 jsdom** → 只在测试环境（`css-tree ← jsdom`），由 `npm test` 覆盖。
- **R3：rustls 是 TLS 栈** → 补丁级升级，由 `cargo test --lib` 覆盖（其中含本地自建 HTTPS 测试服务器与自签证书的用例，以及本轮新增的 PAC 服务器用例）。失败则 `cargo update -p rustls --precise 0.23.44` 退回。
- **R4：漏洞条目数从 8 降到 4，容易被读成"风险清零"** → 剩下四条是**真欠着**的。这一点在 proposal 的「不做」与 README 的新条目里都写明；判据里也说明"数字下降"不等于"暴露面对应下降"。
- **R5：`--precise 0.23.45` 依赖父声明仍允许 0.23.45** → 若将来父声明收窄导致它失败，那是上游变化，按新情况处理，不属本次问题。本次已实测成功。
