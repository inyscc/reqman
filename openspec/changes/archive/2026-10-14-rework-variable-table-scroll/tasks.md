# Tasks

## 1. 变量表接入滚动容器（不绘制滚动指示）

- [x] 1.1 在 `src/components/VariablesPanel.tsx` 把表格接进 `.table-scroll-wrap` → `.table-scroll` 结构，**不挂滚动指示**：既不加 `<OverlayScrollbar>`，也不出现原生占位条（`hideHeader` 时可能出现的标题行留在容器**外**）。验证：`tests/app.test.tsx` 中变量面板相关用例通过，`npx tsc --noEmit` 通过，且容器内不存在 `[data-testid="overlay-scrollbar"]`。
- [x] 1.2 在 `src/App.css` 补齐变量表容器的样式（复用既有 `.table-scroll-wrap` / `.table-scroll` 规则，只在必要时加更具体的选择器），确认不产生横向滚动。验证：浏览器用例断言内容溢出前后行宽与贴右缘图标（描述 / secret / 删除、揭示 / 隐藏）的位置不变。
- [x] 1.3 集合实体面板的高度链：确认 `.pane-body.stack.fill` 内容器 `flex:1; min-height:0` 生效，且 `.pane-body.fill` 的 `overflow: clip` **未被改动**（它是给 Body 的 Monaco 补全浮层准备的）。验证：集合变量页行多时在容器内滚动、面板自身不出现整页滚动；`tests-browser/code-surface.spec.ts` 全绿，补全浮层未被裁掉。

## 2. 环境编辑器的高度链与兜底

- [x] 2.1 把 `.pane-body.var-editor` 改为弹性列（`display:flex; flex-direction:column; min-height:0`），环境名行与代理配置区 `flex:none` 保持自然高度，并按「全局细滚动条」给该容器 `scrollbar-width: none`。
- [x] 2.2 让变量表容器在环境编辑器里吃剩余高度并带一个最小高度，`.var-editor` 挂 `<OverlayScrollbar>` 作为极端高度的兜底（design D3）。验证：窗口高度足够时这块界面看不到任何滚动指示（表格侧不画指示、正文区也不溢出）；把窗口压到很矮时代理配置区（PAC 地址 / 白名单）仍然可达。
- [x] 2.3 断言"滚动变量表格时环境名与代理区不随表格滚出视野"。验证：`tests-browser/variable-table-and-collection-panel.spec.ts` 新增用例通过。

## 3. 表头吸顶、两种宿主一致与全量验证

- [x] 3.1 在集合变量页与环境编辑器分别验证表头吸顶：滚动到底部时表头仍钉在容器顶部，滚过的行不从表头下方穿透（变量表表头含列宽拖拽中线，需单独确认定位未被影响）。验证：浏览器用例在两个宿主各覆盖一次。
- [x] 3.2 滚动指示：行数不足一屏时不出现任何滚动指示，布局与引入容器前等价；内容溢出时同样不出现任何滚动指示（既无悬浮细条、也无原生占位条），行宽与贴右缘控件位置不变。验证：浏览器用例对「溢出」与「不足一屏」两种情况都断言容器内不出现 `[data-testid="overlay-scrollbar"]`、原生条占宽为 0，且两种情况下行宽与贴右缘控件位置相同。
- [x] 3.3 规格与实现一致 + 全量验证。验证：`openspec validate "rework-variable-table-scroll" --strict` 返回 `valid: true`，「变量表格的区域滚动」的五条场景与 `ui-polish`「全局细滚动条」新增的例外场景各有对应用例；`npx tsc --noEmit`、`npm test`、`npm run build`、`npm run test:browser`（复用本机 Chrome，不下载浏览器二进制）全部通过。

## Workflow follow-up

- 实现与验证全部完成后，归档该 change，并把 `ui-layout` 与 `ui-polish` 两份 delta 合并进主规格。
- 归档后确认 `openspec/specs/ui-layout/spec.md` 里「变量表格的区域滚动」已就位，且 `openspec/specs/ui-polish/spec.md` 的「全局细滚动条」已收窄到键值表并带上变量表的例外场景。
