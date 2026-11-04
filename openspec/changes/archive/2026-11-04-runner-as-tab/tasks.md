# Tasks

## 1. 标签模型的第三类

- [x] 1.1 `SessionTab` 增加 `RunnerSessionTab`（`kind: 'runner'`，key 为 `runner:<kind>:<id>`，携带 title / items / gate / collectionId），`isTabDirty` / `tabName` / `tabExistsInTrees` / `toTabListEntry` 各自补一支——验证：`npx tsc --noEmit` 无错
- [x] 1.2 标签行与「全部标签」菜单认识运行器：新增 `RunnerIcon`（实心三角），两处按 `kind` 三分支——验证：`tests/app.test.tsx` 里运行器标签的 `data-tab-kind` 为 `runner`，标题含「运行「」
- [x] 1.3 标签集合持久化跳过运行器；激活项停在运行器时记 `null`——验证：`readTabs` 恢复出的集合里不含 `runner` 条目（解析层本来也只认两种）

## 2. 打开与关闭

- [x] 2.1 `openRunner` 改为开/聚焦运行器标签（同一 key 只 `setActiveTabKey`）——验证：`tests/app.test.tsx`「同一目标重复点「运行」只聚焦既有的运行器标签」
- [x] 2.2 打开前 `pinTab` 来源实体标签，避免运行器占掉预览槽位把来源顶替——验证：打开运行器后标签行仍有两个标签，且其中一个是 `data-tab-kind="entity"`
- [x] 2.3 门禁是异步的：回来时若目标已不存在则不开标签；关闭标签走 `closeRunnerTab`（先撤在飞的那条再摘标签）——验证：手动验证（删除集合后运行器标签随之消失，`removeTabsWhere` 的对账覆盖）

## 3. 呈现与生命周期

- [x] 3.1 主区新增 `.runner-tab-pane`：所有运行器标签常驻渲染、`hidden` 控制显隐；`main.runner-active` 时请求带与分栏区让位——验证：切到请求标签再切回，明细仍在（`tests/app.test.tsx` 的运行器用例连续操作）
- [x] 3.2 `executeRunRequest` / `cancelRunRequest` 改为按标签 key 分账（`Map<tabKey, SendAttempt>`），两个运行器各跑各的、停止只撤自己那条——验证：`tests/app.test.tsx` 逐条发送与停止相关用例
- [x] 3.3 删除 `.modal-runner` 一组样式，运行器不再出现在模态层；`RunnerPanel` 的 `onClose` 接 `closeRunnerTab`——验证：`npm test` 全绿，模态用例不再出现 `role="dialog"`

## 4. 规格与回归

- [x] 4.1 `openspec/specs/collection-runner/spec.md` 增补「运行器的承载与切换」与「明细就地呈现」两条——验证：归档后 `openspec/specs` 与实现一致
- [x] 4.2 `openspec/specs/pm-script-runtime/spec.md` 里「运行器是模态所以明细仍列输出」的理由改写为「按请求归拢」——验证：同上
- [x] 4.3 全量测试：`npx vitest run`（740 passed）
