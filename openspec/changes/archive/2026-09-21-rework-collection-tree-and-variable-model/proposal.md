## Why

两条各自独立、但都表现为「能力已经在后端存在，界面上却没有入口」的问题：

集合树在 `rework-tree-expansion-gestures` 里把「单击目录行 = 打开实体面板」换成了「单击 = 切换展开」，于是集合与文件夹的脚本面板只剩「hover → ⋯ → 编辑脚本」这一条路；更早的「选中集合/文件夹在主区打开实体脚本面板」需求至今仍挂在 `ui-layout` 上——规格自身已经互相矛盾。同一棵树还缺两件与之同源的事：右键只挂在请求行上（集合 / 目录 / 环境行的右键会落到运行环境自带的菜单，与 ⋯ 的表现不一致），以及完全没有拖拽排序。

变量模型比 Postman 少三样东西：键不能改、变量不能禁用、变量没有描述。而「集合变量」的解析、脚本读写、导入导出与只读浮层其实**早就实现了**（`variable-engine` 的「全局变量与集合变量」、`Scope::Collection`、`pm.collectionVariables`），缺的只是界面上没有任何地方能编辑它——这正好与「单击集合即打开实体面板」互为前提。

## What Changes

- **BREAKING**（交互语义变更）集合与文件夹行：单击（名称或行内空白区）由「切换展开」改为**打开该实体的面板并同时切换展开**（Postman 模型）。折叠箭头仍只切换展开；单击不再是纯视图动作，目录行重新产生选中。
- **BREAKING**（后端 API）`children_reorder` 的入参由「folder_ids + request_ids 两个独立序列」改为**一个有序列表**（每项带种类）。现有签名给两类条目各自从 0 编号，无法表达「目录与请求交错」，而树的渲染恰恰是按共享 `sort_order` 混排的。
- 右键菜单入口从「只对请求节点」扩展到**集合、目录与环境行**：同一份菜单、同一个展开状态、同样不改变选中。
- 集合树新增**拖拽排序与移动**：同级拖拽可任意交错目录与请求；拖入目录或集合根 = 移动（请求与目录都支持）。跨集合移动**不支持**（存储层现有校验明确拒绝，且牵出跨集合的脚本/变量/认证继承语义）。
- 变量持久化模型扩展：一次迁移为 `variables` 表**去掉 `UNIQUE(scope, owner_id, name)`**、新增 `enabled`、`description`、`sort_order`。
- 变量采用 **Postman 的重复键模型**：同名变量可共存，生效的是同名组里**最靠下的启用行**；同名组里全部禁用时该名字视为未定义。被更靠下的启用行遮蔽的启用行在行尾呈现「被覆盖」标记。
- 变量表格新增**启用勾选框、键就地改名、描述（键名下方）、Secure 开关、拖拽排序**；编辑器内的写入改为按 id 进行，脚本 `pm.*` 仍按名 upsert。
- 集合的实体面板改为**变量 / 脚本两个页签**（默认变量），集合变量因此获得编辑入口；文件夹面板保持原样。
- 导入 / 导出翻转：源文档中**禁用的变量由「跳过并记录」改为导入为禁用状态的变量**，导出写 `disabled: true`；变量描述参与往返。
- `window-chrome` 的「侧栏 SHALL NOT 提供拖拽能力」收窄为**窗口拖拽**能力，以免与侧栏内的条目拖拽相互否定。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `ui-layout`: 「集合树的展开与折叠」中「单击目录行是纯视图动作」整段作废，改为单击 = 打开实体面板 + 切换展开；「Collections tab 承载集合树」与「集合树的操作入口默认隐藏」的右键条款改为集合 / 目录 / 环境通用；新增「集合树的拖拽排序与移动」与「集合面板的变量与脚本站签」；「变量值的就地编辑」的名称只读条款与「键值表的幽灵行」相关约束让位于新的变量表格契约（含启用、描述、重复键与拖拽）。
- `variable-engine`: 「全局变量与集合变量」补上集合变量的**可编辑性**；「作用域优先级」内的同名解析规则细化为「同名组内最靠下的启用行生效，全部禁用则未定义」；「脚本对变量的读写」明确脚本按名 upsert 在重复键模型下作用于生效行。
- `storage-foundation`: 「环境与变量的持久化」扩展为同时保存启用状态、描述与顺序，且同一（作用域 + 归属）下**允许同名变量共存**；「schema 版本迁移」补上本次表重建的迁移要求。
- `postman-interchange`: 「导入集合变量」把禁用变量由「跳过并记录」改为「导入为禁用状态」；「导入环境与全局变量」沿用同一规则；「导出 Postman 文档」的保真清单补上禁用状态与描述。
- `window-chrome`: 「会话标签行的窗口拖拽区」末句的拖拽能力边界收窄为窗口拖拽，不否定侧栏内的条目拖拽。

## Impact

- 代码：`src/components/WorkspaceTree.tsx`（单击语义、右键、拖拽）、`src/components/EnvironmentsPanel.tsx`（右键）、`src/components/VariablesPanel.tsx`（表格契约整体重写）、`src/components/VariablesPeek.tsx`（禁用与遮蔽的呈现）、`src/components/EntityScriptPanel.tsx`（页签）、`src/App.tsx`（实体标签的内层页签、拖拽落库、按作用域取变量）、`src/lib/scriptRuntime.ts`（按名读写改为定位生效条）、`src/lib/commands.ts`、`src/lib/types.ts`、`src/App.css`。
- 后端：`src-tauri/src/storage/migrations.rs`（新增迁移版本，重建 `variables` 表）、`storage/variables.rs`（排序、启用、描述、重复键与按 id 写入）、`storage/model.rs`、`storage/workspace.rs`（`reorder_children` 签名）、`commands.rs` / `lib.rs` / `security_audit.rs`（命令与审计白名单同步）、`interchange/parse.rs` / `import.rs` / `export.rs`（禁用与描述往返）。
- 行为：变量列表的顺序由用户控制（新增追加末尾、改名不移动位置），因此解析结果不再由名称字母序决定；禁用一个变量会让被它遮蔽的上一条重新生效。
- 数据：一次**不可逆的表结构迁移**（去唯一约束 + 三列新增）。迁移前仍按既有机制保留备份；迁移失败时版本不推进、原数据可用。
- 测试：`tests/app.test.tsx` 中依赖「单击目录行不打开面板」的用例组、变量名称只读用例、`tests-browser/tree-expansion-gestures.spec.ts` 的单击语义；新增树拖拽与变量表格的浏览器用例、Rust 侧同名组解析 / 迁移 / 互转往返单测。
