# Tasks

## 1. 抽出可复用的执行流水线

- [x] 1.1 新增 `src/lib/requestExecution.ts`：把 `App.tsx` 里 `performSend` 的「解析 → 前置脚本 → 合并头/体 → 发送 → 后置脚本」原样搬进来，产出 `RequestExecutionOutcome`（D1）。验证：`npx vitest run tests/app.test.tsx` 269 条全绿（脚本编排、门禁、取消、改写、错误归属都在其中）。
- [x] 1.2 `App.tsx` 的 `performSend` 改为调用它，界面侧的留痕（写标签、报错、门禁提示、收尾）留在原地，行为不变（D1）。验证：同上；`npx tsc --noEmit` 干净。

## 2. 运行器逻辑

- [x] 2.1 新增 `src/lib/requestRunner.ts` 的 `collectRunRequests`：按树顺序深度优先拍平子树，目录就地展开并带上路径；目标是目录时只跑它自己的子树（D2）。验证：`tests/request-runner.test.ts` 的「拍平一棵子树」四条。
- [x] 2.2 同文件 `statusOfOutcome`：取消 → 门禁 → 请求失败 → 断言失败 / 脚本报错 → 通过，跳过的断言算通过（D4）。验证：同文件的「一条请求的结局」八条。
- [x] 2.3 同文件 `runSequence`：第一条不等、两条之间等、停止在开跑前与间隔中都能生效、`stopped` 立刻收手（D3）。验证：同文件的「顺序执行与间隔」六条（等待与停止判定均可注入，无需假时钟）。

## 3. 运行器界面

- [x] 3.1 新增 `src/components/RunnerPanel.tsx`：名单默认全选、可逐条取消与全选/全不选、间隔输入（毫秒）、运行/停止、进度、逐条状态与耗时（D2 / D3）。验证：`tests/runner-panel.test.tsx` 的「运行器的名单与选择」「运行中的结果与明细」「脚本门禁与停止」。
- [x] 3.2 明细复用 `ScriptReport` 呈现断言与 console；出错与失败给出原因，停止只给一行灰字、不冒充错误（D4）。验证：同文件的「点开一条能看到它的断言与 console 输出」「请求失败时明细给出原因」「停止会中止在飞的那一条」。
- [x] 3.3 门禁在开跑前问一次：未获准时运行按钮不可用，选择后可跑；「不执行脚本」时每一条都以 `skipScripts` 执行（D5）。验证：同文件的「脚本未获准执行时先让人选」「选择"不执行脚本"时…」。
- [x] 3.4 卸载即停止：面板被 × / Esc / 遮罩关掉时置停止标志、唤醒间隔等待、撤掉在飞的那一条（D6）。验证：`tests/runner-panel.test.tsx` 的停止用例（取消出口被调用、后续不再开跑）。

- [x] 3.5 版面按 D8 重排：三列（名单 / 明细 / 设置）、行内去掉目录路径、状态列在有结果后定宽、窄窗口收窄右列。验证：`tests/runner-panel.test.tsx` 与 `tests/app.test.tsx` 的运行器用例全绿；1440×900 与 1024×720 两档截图人工核对。

## 4. 接线

- [x] 4.1 `src/components/EntityScriptPanel.tsx`：面板头右上角的「运行」按钮（集合与文件夹共用）。验证：`tests/app.test.tsx` 的「面板头右上角的「运行」打开运行器…」。
- [x] 4.2 `src/App.tsx`：打开运行器时算名单、取名字、查门禁；逐条执行走 `executeRequest`（`dirty: false`，用库里那一份，D7）；停止撤销在飞请求。验证：`tests/app.test.tsx` 的「点运行后逐条发出…」「只勾一条时另一条不发」。
- [x] 4.3 `src/App.css`：运行器与按钮样式（模态铺开成工作区、三列、状态点与进度条）。验证：组件测试断言 testid 与状态属性；版面在 1440 与 1024 两种宽度下截图核对。

## 5. 集成校验

- [x] 5.1 发送路径不回归：`npx vitest run` 全量 656 条通过（原 626 + 新增 30）。
- [x] 5.2 类型检查：`npx tsc --noEmit` 退出码 0。

## Workflow follow-up

- 归档本 change，并把 `collection-runner` 的 delta 合并进主规格（新能力，需要 Purpose）。
