# Tasks

## 1. 目录链的解析

- [x] 1.1 发送前按请求 id 取它**当前的**归属，并按 `parent_folder_id` 逐级上溯得到由外到内的目录链；上溯带 visited 集合与深度上限，环或异常数据不得卡死发送，超出上限时按已取到的链执行并报告一次错误（design D1）。验证：单测覆盖"三层嵌套返回由外到内的三个目录""不属于任何目录返回空链""人为造环时不死循环且报告一次错误"。
- [x] 1.2 目录层按链顺序进入前置与后置的编排；未归属目录时目录层不参与（design D5）。验证：`tests/script-phase.test.ts` 覆盖"集合 + 三层目录 + 请求"的完整顺序，以及"未归属目录时只有集合与请求两段"。

## 2. 层级标签与错误报告

- [x] 2.1 把 `runScriptPhase` 的 `scripts` 参数改为携带标签的形态（集合 / 目录名 · 第 N 层 / 请求），删掉 `SCRIPT_LEVEL_LABELS` 与"过滤空脚本时保留原始索引"那段技巧（design D2）。验证：单测断言三段与五段两种形状下标签都正确，`tests/script-phase.test.ts` 全绿。
- [x] 2.2 目录层的报错指明是哪一个目录，同名目录以链上位置区分。验证：新增用例构造两个同名目录，断言报错文本能区分它们。

## 3. 前置与后置共用同一份链

- [x] 3.1 链只在发送前算一次，收到响应后复用，不在响应之后再解析一次归属（design D4）。验证：用例按"发送前算链 → 响应前改变归属"的时序断言后置仍按原链执行（`tests/app.test.tsx`「链只算一次：响应前改归属不影响后置所跑的那条链」）。

## 4. 归属副本的同步（实现卫生）

- [x] 4.1 `applyTreeMove` 更新被移动请求的 `folder_id`，`moveNode` 成功后让受影响请求的 store 副本跟上；主区已打开标签的草稿内容**不被重载**（design D3）。验证：单测覆盖"先打开标签 → 拖进目录 → 该请求的归属为目录"，并断言草稿内容与未保存改动都还在（`tests/app.test.tsx`「拖进目录只同步归属、不重载草稿」）。
- [x] 4.2 端到端确认"拖拽后不重开标签直接发送"。验证：`tests-browser/ancestor-folder-scripts.spec.ts`「拖进另一个目录后不重开标签直接发送」覆盖该链路，断言新直接父级的脚本被执行、旧目录链不再出现。

## 5. 规格一致性、既有结论更正与全量验证

- [x] 5.1 规格与实现一致。验证：`openspec validate "run-ancestor-folder-scripts" --strict` 返回 `valid: true`；`pm-script-runtime`「脚本执行时机与顺序」的八条场景与「脚本超时与错误处置」的四条场景各有对应用例（`tests/folderChain.test.ts`、`tests/script-phase.test.ts`、`tests/app.test.tsx`）。
- [x] 5.2 更正既有结论：不强改归档目录里的文件（归档按惯例只读），确认主规格 `pm-script-runtime`「脚本执行时机与顺序」在归档后是链式表述，且本变更的 `design.md` 里留有"推翻 2026-09-27 那条结论"的记载。验证：两处位置分别为 `openspec/specs/pm-script-runtime/spec.md`（归档时由本变更的 delta 合入）与 `design.md` 的「Migration Plan」段。
- [x] 5.3 架构级回归：脚本沙箱、`pm.*` 能力边界、超时上限、secret 在脚本输出中的掩码都不受链变长影响。验证：`tests/script-phase.test.ts`（超时、secret 掩码、`pm.*` 出口）、`tests/pm-compat.test.ts`、`tests/script-runtime.test.ts` 全绿；真实引擎一侧由 `tests-browser/script-runtime.spec.ts` 的逃逸探针与新增的 `tests-browser/ancestor-folder-scripts.spec.ts` 覆盖。
- [x] 5.4 全量验证。验证：`npx tsc --noEmit`、`npm test`（533 passed）、`npm run build`、`npm run test:browser`（16 files / 115 passed，复用本机 Chrome，未下载浏览器二进制）全部通过。
- [x] 5.5 端到端场景：三层嵌套目录、集合与请求各写一句 `console.log`，发送后前置与后置各出现五条日志且顺序为由外到内。验证：`tests-browser/ancestor-folder-scripts.spec.ts`「三层嵌套目录：前置与后置各五条日志，顺序为由外到内」断言日志条数与顺序。

## Workflow follow-up

- 实现与验证全部完成后，归档该 change，并把 `pm-script-runtime` 的 delta 合并进主规格。
- 归档后确认 `openspec/specs/pm-script-runtime/spec.md` 里「脚本执行时机与顺序」已是"集合 → 递归祖先目录（由外到内）→ 请求"的表述。
