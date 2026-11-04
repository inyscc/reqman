# Tasks

## 1. 行单击收窄（D1、D3、D4）

- [x] 1.1 `src/components/WorkspaceTree.tsx`：行 `onClick` 去掉 `actions.onToggle(id)`，只留 `actions.onSelectEntity(entity)`；`detail === 2` 的守卫保留，注释改为「防异步打开被派发两次」；行 `title` 由「打开 X（折叠 / 展开）」改为「打开 X」。验证：`tests/app.test.tsx` 的「单击目录行打开面板但不改变展开」用例。
- [x] 1.2 `src/components/WorkspaceTree.tsx`：行 `onKeyDown` 的 Enter 分支同样去掉 `actions.onToggle(id)`。验证：同文件「Enter 与单击同义：只打开面板」用例。

## 2. 测试改写

- [x] 2.1 `tests/app.test.tsx`：「集合树的展开手势」用例组按新语义改写——单击不改变展开、箭头是唯一折叠入口、Enter 不折叠、双击只开一个标签、已折叠目录被单击后仍折叠。验证：`npx vitest run tests/app.test.tsx` 全绿。
- [x] 2.2 `tests-browser/tree-expansion-gestures.spec.ts`：真实引擎用例同步（单击不折叠、箭头折叠、Enter 不折叠、双击不产生第二个标签）。验证：该文件串行跑绿。

## 3. 校验

- [x] 3.1 `npx tsc --noEmit` 退出码 0；`npx vitest run` 全绿。
- [x] 3.2 `npx vitest run --config vitest.browser.config.ts tests-browser/tree-expansion-gestures.spec.ts --maxWorkers=1` 全绿。
- [x] 3.3 `openspec validate folder-row-opens-tab --strict` 通过。

## Workflow follow-up

- 归档本 change，并把 `ui-layout` 的 delta 合并进主规格。
