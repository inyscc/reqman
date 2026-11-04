# Tasks

## 1. 共享标签 key（D2）

- [x] 1.1 `src/lib/sessionTabs.ts`：导出 `entityTabId(kind, id)`；`src/App.tsx` 删掉本地同名常量、改为导入，行为不变。验证：`npx tsc --noEmit`。

## 2. 行单击按「标签是否已打开」分流（D1、D3）

- [x] 2.1 `src/App.tsx`：由 `tabs` 派生已打开的实体标签 key 集合（`openEntityTabs`），传给 `WorkspaceTree`。
- [x] 2.2 `src/components/WorkspaceTree.tsx`：新增 `openEntityTabs` 入参（props → `TreeActions`）；`EntryRow` 算出 `tabOpen`，行 `onClick` 与 Enter 在 `onSelectEntity` 之后仅当 `tabOpen` 为真时调 `onToggle(id)`；行 `title` 在已打开时恢复「折叠 / 展开 X」的说法。
- [x] 2.3 校验「第一次单击只打开」不受同一击里刚插入的标签影响：`tabOpen` 取本击派发前的集合（同步读取 props）。

## 3. 测试

- [x] 3.1 `tests/app.test.tsx`：`renderTree` 支持传入已打开的标签 key；补「标签已打开时单击折叠 / 展开」「集合已开、文件夹未开时仍只是打开」「双击只切换一次」「Enter 同样切换」「搜索态即使已打开也不写折叠集合」；集成用例补「第二击折叠、第三击（箭头）展开回去」。
- [x] 3.2 `tests-browser/tree-expansion-gestures.spec.ts`：真实引擎补「标签已打开后连点切换」与「双击只切换一次」；原「单击不动树」用例改名为「标签还没打开时……」。
- [x] 3.3 `npx vitest run tests/app.test.tsx --maxWorkers=1` 全绿；`npx tsc --noEmit` 退出码 0。
- [x] 3.4 `npx vitest run --config vitest.browser.config.ts tests-browser/tree-expansion-gestures.spec.ts --maxWorkers=1` 全绿。

## 4. 校验

- [x] 4.1 `openspec validate folder-row-toggles-when-tab-open --strict` 通过。

## Workflow follow-up

- 归档本 change，并把 `ui-layout` 的 delta 合并进主规格（归档后把两个仍沿用旧说法的场景名改成「首次单击……」）。
