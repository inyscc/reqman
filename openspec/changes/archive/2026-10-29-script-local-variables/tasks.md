# Tasks

## 1. 运行时：把本地作用域接进链路

- [x] 1.1 `src/lib/scriptRuntime.ts`：`ContextScope` 增加 `local`；`executeOne` 的 `options.context` 喂入 `_variables`（D1）、回调里回读 `execution._variables.values`。验证：新增用例断言 `pm.variables.set` 的值出现在结果的 `local` 里。
- [x] 1.2 `runScriptPhase`：`scopes.local` 逐段接力（前一段的写入后一段读得到）；结果新增 `local` 与 `localSecretNames`；新增 `initialLocal` 入参供后置阶段接住前置的写入（D3）。验证：新增「段与段之间接力」「后置阶段接住前置」两条用例。

## 2. 交给本次请求

- [x] 2.1 `src/App.tsx` 的 `performSend`：前置阶段结束后取 `pre.local` / `pre.localSecretNames`，随 `client.sendRequest` 一起送出；后置阶段用同一个 `scriptLocal` 作为 `initialLocal`。验证：`tests/app.test.tsx` 新增用例断言 `sendRequest` 的入参里带上了脚本写入的本地值。

## 3. 脱敏

- [x] 3.1 本地取值等于某个已揭示的 secret 明文时，把该名字放进 `localSecretNames`（D4），交给后端 `local_secret_names`。验证：`cargo test` 全绿；该名单进入 `ScopeLayers.secret_names`，日志与错误消息的掩码沿用既有路径。

## 4. 与脚本内请求的关系

- [x] 4.1 `pm.sendRequest` 的 `local` 合并顺序补上本地作用域（最后合并 = 最高优先级），与 Rust 侧层次顺序一致。验证：新增用例断言同名时取本地那一份（环境里另有同名旧值）。

## 5. 校验与规格

- [x] 5.1 规格与实现一致：`variable-engine`「本地变量与迭代数据」的四条场景、「脚本对变量的读写」的追加句各有对应断言。
- [x] 5.2 `npx tsc --noEmit`、`npm test`（582 个用例）退出码 0。
- [x] 5.3 `cargo test --lib`（399 个用例）全绿，含新增的 `local_variables_take_part_in_resolution_under_strict_mode`。

## Workflow follow-up

- 实现与验证全部完成后归档该 change，并把 `variable-engine` 的 delta 合并进主规格。
- 未做：浏览器用例（`npm run test:browser`）与 `npm run build`——本变更只动前端取值链路与一处位置参数，未动打包与 CSP 相关路径；如需发版前再跑一遍。
