## Why

前置脚本目前改得动请求头、却改不动请求体——这与 Postman 的差距不是"少个便捷功能"，而是让一整类常见用法落不了地：

1. **请求体要按脚本算出来**。签名、加密载荷、按环境拼装的 JSON 体，都要在前置脚本里算完再写进去；现在只能在脚本里算好再 `pm.environment.set`，回头到请求体里手写 `{{payload}}` 引用它——多一层中转，还没法覆盖"请求体原本为空"的情形。
2. **空正文的请求连写都写不了**。喂给沙箱的请求在没有正文时完全没有 `body` 字段，`pm.request.body.raw = …` 直接撞 `Cannot set properties of undefined`，用户看到的是一个莫名其妙的 TypeError。
3. **读写不对称**。后置脚本已经能读到"实际发出的请求体"（上一版做的），前置脚本却改不动它；用户自然会把"能读"理解为"能改"。

## What Changes

- **前置脚本可改写请求体**：`pm.request.body.raw = …` 落到本次**实际发出**的请求上；原本没有正文的请求也能写。
- **按「集合 → 目录链 → 请求」累积**：与请求头同一条路，集合层写的正文，目录层与请求层、以及后置阶段都读得到。
- **只承诺 `raw` 正文**：表单 / 多段 / 二进制正文在沙箱里只是文本投影，脚本改了写不回去；这种情况 SHALL 明确提示，不静默丢弃。
- **未改动时不改变发送路径**：脚本没碰正文时仍按 `saved_id` 发送，不因为"跑过脚本"就改走内联。

规格上改一处：`pm-script-runtime` 的「pm.request 的填充」原本写着"请求体仍是快照、改不动"，现在改为可写（仅 `raw`），并把"脚本对 URL 与请求体的改动不影响发送"这条场景收窄为只讲 URL。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `pm-script-runtime`:
  - 「pm.request 的填充」：请求体从"只读快照"改为"可改写"，与请求头同样的累积与可见性规则；空正文可写；仅 `raw` 形态的改写生效，其它形态不生效但 SHALL 有提示；方法、URL、认证方式仍是快照。相应地把原「脚本对 URL 与请求体的改动不影响发送」场景收窄为「脚本对 URL 的改动不影响发送」，并新增四条场景（改写随请求发出、空正文写入、上层改动对下层可见、表单正文的改写不生效且有提示）。

## Impact

- **代码**：`src/lib/scriptRuntime.ts`（`toSandboxRequest` 一律带 `body`；`readSandboxBody` 回读；`runScriptPhase` 用 `currentBody` 逐段接力）、`src/lib/scriptBody.ts`（新增，`diffRequestBody` / `applyScriptBody`）、`src/App.tsx`（头 → 体的合并顺序、改动即走内联发送、表单被拒时追加一条 warn）、`src/lib/pmDts.ts`（`pm.request.body` 改为必填、`raw: string` 可写）。
- **数据**：不改表、不改命令、不改存档。脚本改的是本次请求的内联副本，不写回库里的请求。
- **兼容**：脚本没碰正文时发送路径与载荷完全不变（既有端到端用例守着这一点）；表单 / 二进制正文的行为从"不存在"变为"不生效但有提示"，不会让原本正常的请求失败。
- **测试**：新增 `tests/script-body.test.ts`（差异合并与形态判定）；`tests/script-phase.test.ts` 增加跨段接力、空正文写入、后置不回传三条；`tests/app.test.tsx` 增加改写生效、未改不回归 `saved_id`、表单被拒有提示三条端到端；`tests/pm-dts.test.ts` 增加 `raw` 可写一条。
