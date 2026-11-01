# Tasks

## 1. 预览标签

- [x] 1.1 `src/App.tsx`：`SessionTab` 加 `preview`；新增 `insertTab`（就地顶替预览槽位，脏标签不顶替，撤销被顶替标签的在飞发送）/ `pinTab` / `activateTab`（D1 / D3）；`openRequest` / `openEntity` 接一个 `pin` 选项，树单击默认预览。验证：新增用例断言「连点两个请求只剩一个标签，且位置不变」。
- [x] 1.2 转常驻的判定：点标签、`editDraft`、实体内容改动、发送、`renameRequest` / `renameEntity`、树里再次选中同一请求（D2）。验证：分别有用例断言「打开另一个请求时不顶替」。
- [x] 1.3 显式新增一律常驻：`createRequest`、`duplicateRequestById`、启动恢复（D4）。验证：恢复用例断言新单击的请求是预览、旧的常驻不被顶替。
- [x] 1.4 预览标签以斜体名称呈现，并带一句「点击后保留」的提示。验证：用例断言 `className` 含 `preview`。

## 2. 标签栏可读性与入口

- [x] 2.1 `.session-tab-name` 给可读下限（D5），标签不再被压成残片。验证：浏览器用例断言每个标签的名称宽度不小于下限。
- [x] 2.2 溢出时两端出现覆盖式滚动按钮（D6）；激活标签自动滚进可见区（D7）。验证：浏览器用例断言溢出时出现按钮、点击后 `scrollLeft` 变化；切到远端标签后该标签完整可见。
- [x] 2.3 新增 `src/components/TabListMenu.tsx`：「全部标签」菜单，复用 `useMenuPlacement` / `useMenuDismiss`，行内跳转与关闭是两个并列按钮（D8）；`.tab-menu` 加进会话行的窗口拖拽排除清单。验证：用例断言菜单列出全部标签、点选跳转、关闭带未保存守卫。

## 3. 拖动排序

- [x] 3.1 `src/lib/environmentMoves.ts`：把算法抽成 `moveIdInOrder`，环境侧保留 `moveEnvironmentId` 原名；`src/App.tsx` 用它算标签的新顺序（D9）。
- [x] 3.2 标签加 `draggable` 与起拖/悬停/放下处理，落点按水平中点前后；插入线用 `drop-before` / `drop-after` 类；松手重排 `tabs` 并顺带转常驻。验证：用例断言插入线类名与重排结果。

## 4. 校验与规格

- [x] 4.1 受「单击即新增」旧行为影响的既有用例改为先把标签点成常驻（`tests/app.test.tsx`、`tests-browser/session-bar-and-tables.spec.ts`、`tests-browser/variable-table-and-collection-panel.spec.ts`）。
- [x] 4.2 `npx tsc --noEmit`、`npm test` 退出码 0。
- [x] 4.3 `npm run test:browser`（相关 spec 至少 session-bar / 树手势 / 变量表三条）全绿。

## Workflow follow-up

- 实现与验证全部完成后归档该 change，并把 `ui-layout` 的 delta 合并进主规格。
- 已归档：`openspec/changes/archive/2026-11-01-preview-tabs-and-tab-strip/`；`ui-layout` 的 delta 已合并进主规格（会话标签栏 / 会话标签的生命周期 / 会话标签集合的持久化 改写，「会话标签的拖动排序」新增）。
- 验证记录：`npx tsc --noEmit` 干净；`npm test` 597 个用例全绿（新增 10 条）；`npm run test:browser` 的 session-bar / 变量表 / 树手势三条 spec 全绿（含真实引擎里的拖动换位与溢出入口）。
