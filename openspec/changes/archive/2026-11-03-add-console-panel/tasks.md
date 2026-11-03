# Tasks

## 1. 输出条目的结构化收集

- [x] 1.1 把 `ConsoleEntry` 的 `args: string[]` 改为 `values: ConsoleValue[]`（`{text, json}`），在 `formatConsoleArg` 旁新增结构保留分支：可序列化、序列化后不超过 32 KiB 时填 `json`，否则留空——验证：`tests/script-runtime.test.ts` 新增一条用例，断言 `console.log({a:1})` 的条目同时拿到 `text` 与 `json`
- [x] 1.2 结构化值在写入 `json` 之前逐叶子脱敏（复用 `maskSecrets` 的取值集合），循环引用退回只留 `text`——验证：单测覆盖「对象里含 secret 取值」与「自引用对象」两种输入
- [x] 1.3 `runScriptPhase` 维护 `currentSegment`，在每段 `executeOne` 之前按 `label` 置位；console 监听器把它写进 `ConsoleEntry.segment`，宿主自造的弃用提示置 `null`——验证：`tests/script-phase.test.ts` 断言集合层与请求层各一条输出，`segment` 分别是 `集合层` 与 `请求层`
- [x] 1.4 `ScriptReport` 改为从 `values.map(v => v.text)` 渲染，呈现行为不变——验证：`tests/response-panel.test.tsx` 既有断言全绿，无需改动断言本身
- [x] 1.5 同步既有测试里所有读 `entry.args` 的地方（`tests/script-runtime.test.ts`、`tests/script-phase.test.ts`、`tests/console-*` 未建时先看 `grep -rn "\.args" tests`）——验证：`npm test` 全绿

## 2. 时间线 store

- [x] 2.1 新建 `src/lib/consoleLog.ts`：条目模型（`network` / `output` 两类，带 `sendId`）、`append`、`settle(id, patch)`、`clear`、`subscribe`/`snapshot`/`version`，容量上限 500 条并按条淘汰最旧——验证：新增 `tests/console-log.test.ts`，覆盖「追加后快照顺序」「settle 只更新同 id 的 network 条目」「超出 500 条后最旧被淘汰且总数仍为 500」
- [x] 2.2 `filterEntries(entries, {query, kind})` 纯函数：query 不区分大小写匹配方法/URL/状态/输出文本，kind 为 `all | network | output`——验证：单测覆盖「按 URL 片段命中」「过滤与搜索叠加」「切回 all 时条目全部回来」「无命中返回空数组」
- [x] 2.3 导出 `useConsoleLog()`（`useSyncExternalStore` 包装），与 `useStoreValue` 同样的引用稳定策略——验证：`tests/console-panel.test.tsx` 里渲染一个读该 hook 的组件，push 后能拿到新快照
- [x] 2.4 正文与结构的上限落在收集侧：网络条目正文只留前 8 KiB 并标 `truncated`——验证：单测传入 20 KiB 正文，断言存下来的是 8 KiB 且 `truncated` 为真

## 3. 发送路径接线

- [x] 3.1 `requestExecution` 的返回值新增 `trace`：方法、已解析 URL、`sendId`（取自 `attempt.attemptId`）、阶段序列、终态（状态码+耗时 / 失败原因 / 取消 / 未发出）、请求头、响应头、正文摘录与截断标记——验证：`tests/request-execution` 相关用例断言成功、失败、取消三种终态各字段齐全
- [x] 3.2 `consoleLog.ts` 提供 `recordOutcome(trace)`：发送开始先 append 一条 `pending` 网络条目，终态到达时 `settle` 同一条；输出条目按 `values` 逐条 append——验证：单测从 pending 到 settle 只产生一条网络条目，且位次不变
- [x] 3.3 `App.tsx` 的手工发送与运行器发送两个调用点都接上 `recordOutcome`，包括 `gated` 与 `UNRESOLVED_CODE` 两种「未发出」——验证：新增用例分别跑这两条路径，断言时间线各出现一条对应终态的条目（这条同时兜住「调用点漏记」）

## 4. 面板呈现

- [x] 4.1 新建 `src/components/ConsolePanel.tsx`：条目标题行（网络条目显示方法、URL、状态、耗时；输出条目显示阶段、层级、级别）、展开区、空态——验证：`tests/console-panel.test.tsx` 断言三类终态各自的标题文案与空态文案
- [x] 4.2 可展开结构树：递归渲染 `json`，默认展开一层，超出时给「展开全部/收起」——验证：组件测试点开一个嵌套对象，断言内层字段出现；循环或 `json` 为空时退化为纯文本且不崩
- [x] 4.3 搜索框与「全部 / 网络 / 输出」过滤条，接 `filterEntries`；无命中与「还没有日志」是两种文案——验证：组件测试分别断言两种空态
- [x] 4.4 新条目跟随：`onScroll` 判定是否停在末尾，停则滚到底；上滚后新条目到达视图不动并出现「回到底部」——验证：组件测试模拟上滚后 push，断言 scrollTop 不变且按钮出现
- [x] 4.5 清空按钮：立即清空且不弹确认，清空后回到空态——验证：组件测试点击后条目为 0、空态出现

## 5. 布局、入口与高度持久化

- [x] 5.1 `BottomBar` 新增 Console 入口，开合两态样式可辨——验证：`tests/settings-panel.test.tsx` 同级的组件测试断言两态的 `data-testid` 不同，且点击回调被调用
- [x] 5.2 `App.tsx` 在主区与状态条之间挂载抽屉，主区 flex 收缩、不覆盖——验证：浏览器测试 `tests-browser/console-panel.spec.ts` 打开抽屉后请求编辑器仍可输入，且主区高度变小
- [x] 5.3 抽屉高度可拖动并按工作区持久化：`layout.ts` 加 `CONSOLE_SCOPE = 'ui_console'` 与 `clampConsoleHeight`（区间 0.15–0.6），复用 `settingsGet/settingsSet`——验证：`tests/layout.test.ts` 覆盖越界收敛与读写往返；浏览器测试断言重启组件后仍取到同一比例
- [x] 5.4 开合状态不持久化，启动默认收起；收起后不留空白带——验证：浏览器测试里重新挂载 App 后抽屉是收起的，且主区高度与未打开时一致
- [x] 5.5 `App.css` 补抽屉与条目样式（浅色配色约束下可读，等宽字体呈现 URL 与正文）——验证：浏览器测试截图人工确认，另加断言状态色在浅底上的对比（沿用既有 `--` 变量，不新增颜色常量）

## 6. 集成验证

- [x] 6.1 `npm test` 与 `npm run test:browser` 全绿——验证：两条命令的退出码为 0
- [x] 6.2 手工冒烟：连续发送三次（成功 / DNS 失败 / 中途取消）后打开 Console，确认三条条目共存、顺序为发起顺序、展开能看到实际发出的头与正文；跑一次集合运行器，确认其请求也在时间线上——验证：按此步骤实际操作并记录观察结果
- [x] 6.3 更新 `README.md` 的能力清单，把全局 Console 写进去（与 `openspec/specs/` 的规格对齐）——验证：README 中能检索到 Console 条目
