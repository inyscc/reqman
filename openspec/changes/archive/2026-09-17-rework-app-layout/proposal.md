# Proposal: rework-app-layout

## Why

当前界面是三栏（左栏集合树+杂项面板、中栏请求编辑器、右栏解析预览+响应），与 Postman 式的「侧栏导航 + 上下分栏主区」心智模型不一致：左栏把集合树与变量/导入导出/Cookie/设置面板叠放在一起，解析预览独占一整栏，空间利用率低。参考 Postman 桌面端布局（`1.json` 界面快照、`postman.png` 截图）重构主界面，把导航收敛为侧栏双 tab，主区按「请求在上、响应在下」排布。

## What Changes

- **侧栏重构**：去掉工作区选择器与环境选择下拉；侧栏顶部固定两个内部 tab —— Collections 与 Environments。Collections tab 承载现有集合树；Environments tab 承载环境列表（点击激活）与变量编辑，全局变量（Globals）作为该 tab 内的固定项。
- **主区左右分栏**：请求区在左、响应区在右，固定比例、分隔线不可拖拽；响应栏**只在选中请求时出现**，未选中请求（含选中集合/文件夹）时请求区独占主区整宽。
- **主区顶部新增会话标签行**：仅视觉壳，始终只有一个标签（方法徽标 + 请求名），不做多开。
- **主区第二行**：面包屑（集合 / 请求名）+ 保存 / 另存为 / 删除操作。
- **地址栏**：方法 + URL + 发送；URL 中 `{{var}}` 高亮显示。
- **解析预览**：从独立栏挪到地址栏下一行的可折叠条；未解析变量警告常驻可见（保持既有 spec 硬要求）。
- **请求标签**：命名对齐 Postman —— Params / Authorization / Headers / Body / Scripts / Settings（当前为小写英文）。
- **低频面板模态化**：Cookie / 设置 / 导入导出 改为底部状态条上的按钮触发的模态弹窗。
- **底部状态条**：新增，承载状态/提示与三个模态入口按钮。
- **配色改为浅色**：整体换成 Postman 风的浅色配色（白/浅灰底、深色文字、蓝色主色），深色配色删除，不提供深色变体。
- **BREAKING（仅 UI 层）**：工作区选择器移除（固定使用当前激活工作区，后端能力不变）；环境选择下拉移除；变量/导入导出/Cookie/设置的常显入口移除；深色外观移除（无切换开关）。

## Capabilities

### New Capabilities

- `ui-layout`: 应用整体布局 —— 侧栏双 tab（Collections / Environments）、主区上下分栏、会话标签视觉壳、解析预览折叠条、模态化低频面板与底部状态条。

### Modified Capabilities

（无 —— 后端能力（variable-engine、http-engine 等）的需求不变。）

## Impact

- 代码：`src/App.tsx`（布局重构、状态下放）、`src/App.css`（栅格与样式）、`src/components/WorkspaceTree.tsx`（移入 Collections tab）、新增侧栏 tab 容器 / 环境面板 / 模态容器 / 底栏组件；复用 `PreviewBar`、`VariablesPanel`、`CookiePanel`、`SettingsPanel`、`ImportExportPanel`、`EntityScriptPanel`、`ResponsePanel`。
- 测试：`tests/app.test.tsx` 依赖旧布局的断言需同步更新 —— `getByLabelText('工作区')` / `getByLabelText('环境')`（L351-352）、`getByText('导入/导出'|'变量'|'Cookie'|'设置')` 开关、请求 tabs 文本定位（如 `getByText('scripts')`）。
- 非目标：多开会话标签、可拖拽分栏、深色变体与主题切换（roadmap P1，另开 change）、多工作区 UI、真实模态动画。
