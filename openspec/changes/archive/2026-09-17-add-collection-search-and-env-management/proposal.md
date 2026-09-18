## Why

集合树在大工作区下只能靠肉眼逐层翻找，导入入口又埋在底栏模态里，日常使用成本高；环境虽然数据层已支持多环境（`environment_create` / `environment_rename` / `environment_delete` 全部存在），但界面上没有任何创建或维护入口，且发送请求时主区完全看不到当前生效的是哪个环境。

## What Changes

- Collections tab 顶部改为一行工具栏（对齐 Postman）：搜索框 + 新建集合与导入两个图标按钮。原「集合」标题行删除——侧栏 tab 名已经是 Collections，再写一遍是重复信息。
  - 搜索按**请求名称**与**请求 URL** 过滤集合树，纯前端计算，不写入后端、不改变选中态。
  - 命中的请求保留并自动展开其所在的集合/文件夹；集合与文件夹名本身也参与匹配，名字命中时以其为根的子树整棵保留。
  - 搜索无结果时树区域显示空态提示；清空搜索框后恢复原有折叠状态。
  - 「导入」按钮打开既有的导入/导出模态（复用 `ImportExportPanel`）。
- Environments tab 补全多环境管理：
  - 工具栏新增「新建环境」入口（图标按钮，与 Collections tab 同款式），创建后环境立即出现在列表中；栏内不再重复 tab 名。
  - 环境列表项提供操作菜单：重命名、删除；删除前需二次确认。
  - 删除当前激活的环境后，激活态回落到 Globals。
  - 变量的编辑移到主区的**环境编辑器**：侧栏（280px）只放环境列表，变量表格在主区铺开；切回 Collections 即恢复原来打开的请求。
  - 前端命令层补上 `environmentRename`（后端 `environment_rename` 命令已存在，仅缺绑定）。
- 主区会话标签行的右侧新增**全局环境下拉**（Postman 语义）：
  - 选项为「无环境」+ 全部环境，选中即切换全局激活环境，与侧栏 Environments tab 的激活态是同一份状态、双向同步。
  - 该下拉不绑定到具体请求：切换后当前的解析预览、发送与脚本运行时环境同步改变。
  - 未选中任何请求时该下拉依然可见（它属于工作区级状态）。
- **BREAKING**（spec 层面）：撤销上一个变更 `rework-app-layout` 中 D3 的结论「不提供环境选择下拉」。当时的理由是「两个激活入口会互相打架」；本次通过让下拉与侧栏共享同一个 `environmentId` 状态（不存在两份激活态、无独立持久化）来消解该风险。

## Capabilities

### New Capabilities

（无。本变更不引入新能力，全部落在既有的 `ui-layout` 上。）

### Modified Capabilities

- `ui-layout`: 集合树新增搜索与导入入口；Environments tab 新增环境的创建/重命名/删除；会话标签行右侧新增全局环境下拉，并移除「界面中不存在独立的环境选择下拉框」这一场景。

## Impact

- 前端组件：`src/components/WorkspaceTree.tsx`（工具栏与过滤）、`src/components/EnvironmentsPanel.tsx`（环境 CRUD）、`src/App.tsx`（session-bar 右侧承载环境下拉、导入入口接线）、新增环境选择器组件与 `src/App.css` 样式。
- 前端命令层：`src/lib/commands.ts` 补 `environmentRename`（对齐既有 `environment_create` / `environment_delete` 绑定风格）。
- 后端：**零改动**。所需命令与存储能力均已存在并有既有测试覆盖。
- 测试：`tests/` 下与集合树、Environments tab、session-bar 相关的定位器与用例需同步迁移或新增；搜索过滤与环境下拉同步需要新增用例。
- 依赖：不新增任何依赖。
