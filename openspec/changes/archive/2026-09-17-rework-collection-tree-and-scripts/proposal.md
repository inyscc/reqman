## Why

集合树目前只能做三件事：新建集合、在集合/文件夹下新建请求、删除集合。后端早已提供 `folder_create`（接受任意父级、带环检测）、`folder_rename`、`folder_delete`、`collection_rename`，前端却一处都没接——目录层级只能靠导入 Postman 集合产生，用户无法在应用内组织目录，也不能给集合或文件夹改名。与此同时树节点恒展开、操作按钮常驻、字号偏大，与 Postman 那种紧凑安静的观感差距明显。脚本编辑区把前后置脚本纵向堆叠，一次只看到一半，长脚本的定位与切换都很低效。

## What Changes

- **重命名**：集合与文件夹支持改名，复用面包屑输入框（与既有的请求改名一致），不引入树内联编辑
- **目录嵌套**：支持在集合根与任意文件夹下新建子文件夹，层级不限；`folder_create` 的同集合校验与环检测已在后端
- **删除目录**：支持删除文件夹，级联删除其全部子文件夹与请求（外键 `ON DELETE CASCADE`），删除前需要一次确认
- **折叠**：集合与文件夹节点都有折叠控件，默认全部展开；折叠只隐藏子节点，不改变当前选中
- **操作入口默认隐藏**：树节点的操作按钮不再常驻，hover 或键盘聚焦时显示一个 `⋯`，点开为小菜单（新建请求 / 新建子文件夹 / 重命名 / 删除）
- **外观对齐 Postman**：折叠箭头、文件夹图标、小号彩色方法标签、缩进参考线，侧栏字号与行距整体收小
- **脚本区左右两栏**：左栏列出 Pre-request 与 Post-response 并标记哪一段已有内容，右栏为编辑器；请求编辑器的 Scripts 页与集合/文件夹的实体脚本面板都改为该布局

### 本次不做

- 不改变「请求可以放在集合根」这一现状（此前讨论的解读 B）：集合根仍可直接挂请求，约束只落在 UI 层
- 不做拖拽排序、不持久化折叠状态、不做深色主题、不做文件夹移动（后端有 `folder_move`，UI 暂不接）

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `ui-layout`：集合树的交互与外观——折叠、hover 菜单承载的新建/重命名/删除、侧栏字号与密度；以及脚本编辑区的左右两栏布局
- `storage-foundation`：新增文件夹的创建（含嵌套）、重命名与删除语义，删除级联到子文件夹与其中的请求

## Impact

- `src/components/WorkspaceTree.tsx`：折叠状态、`⋯` 菜单、文件夹图标、外观类名
- `src/App.tsx`：接入 `folderCreate` / `folderRename` / `folderDelete` / `collectionRename`，面包屑支持集合与文件夹改名
- `src/components/RequestEditor.tsx`、`src/components/EntityScriptPanel.tsx`：脚本区左右两栏
- `src/App.css`：侧栏作用域的字号行距、菜单、树参考线、两栏布局
- `tests/app.test.tsx`：树交互与脚本切换的用例
- 无新增后端命令：全部复用已有的 `folder_create`、`folder_rename`、`folder_delete`、`collection_rename`
