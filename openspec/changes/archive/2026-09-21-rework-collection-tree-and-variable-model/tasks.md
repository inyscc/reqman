## 1. 变量存储：迁移与后端能力

- [x] 1.1 在 `src-tauri/src/storage/migrations.rs` 版本链尾部新增重建式迁移（建新表 → 拷贝并回填 `enabled = 1`、`description = NULL`、`sort_order` 按 `(scope, owner_id, name, id)` 计数 → 删旧表 → 改名 → 重建索引），并加内存库单测验证：迁移后既有变量条数与名称、初始值/当前值、secret 标记全部一致，且全部为启用、描述为空、顺序确定；同时把 `migrations::LATEST_VERSION` 由 3 提升到 4（`storage/db.rs` 的备份恢复版本校验与迁移测试都依赖它）（`cargo test --manifest-path src-tauri/Cargo.toml storage::migrations`）
- [x] 1.2 `src-tauri/src/storage/model.rs` 的 `Variable` 增加 `description` / `enabled` / `sort_order`，并同步 `src/lib/types.ts` 的同名类型；`cargo test --manifest-path src-tauri/Cargo.toml` 与 `npm run build` 均通过
- [x] 1.3 `src-tauri/src/storage/variables.rs`：`list_variables` 改为 `ORDER BY sort_order, name`，读取与写入路径带上三个新列；单测验证按 `sort_order` 返回顺序稳定
- [x] 1.4 按名写入（`upsert_variable`）改为新语义：更新同名组里生效的那条（最靠后的启用行），全组禁用时更新最靠后的一条，名称不存在时追加到末尾；单测验证「已存在同名不新增条目」与「不存在则追加末尾」
- [x] 1.5 `layer_for` 跳过禁用条目，并让 `secret_names` 跟随生效行改写（生效行非 secret 时移除该名字）；单测覆盖「最靠下的启用行生效」「生效行被禁用后退回上一条」「全禁用即未定义」「生效行非 secret 时不掩码」
- [x] 1.6 新增 `variable_create`、`variable_update(id, patch)`（patch 缺省即不变；`value` 同时写初始值与当前值；名称允许重名但拒绝空名；`is_secret` 切换在值不可读时返回可辨识错误）、`variable_reorder(scope, owner_id, ordered_ids)`，注册进 `src-tauri/src/lib.rs` 并同步 `src-tauri/src/security_audit.rs` 的命令白名单；单测覆盖重名写入、空名拒绝、不可读时的 secret 切换被拒，审计测试通过
- [x] 1.7 `src/lib/commands.ts` 暴露三个新命令与新的 `Variable` 字段；`npm run build` 通过

## 2. 变量表格与集合面板

- [x] 2.1 `src/components/VariablesPanel.tsx` 的作用域改为外部显式传入（`scope` + `ownerId`），环境编辑器与全局变量两处调用点同步改；`npm test` 中既有变量面板用例通过
- [x] 2.2 变量行按新形状重做：行首启用勾选框、名称就地编辑、值、名称下方的描述（含唤出编辑的入口）、行尾 `Secure` 开关与揭示/删除；提交语义沿用（回车/失焦提交、Esc 还原、无变化不发请求、失败回滚还原）；用组件测试验证四条提交语义与「名称清空被拒绝」
- [x] 2.3 改名改为按 id 提交并接受重名；测试验证「改成已存在的名称被接受、两条并存且互不影响」
- [x] 2.4 遮蔽标记：同名分组里「自身启用且存在更靠后的启用行」的行呈现被覆盖标记与中文说明「该变量被下方同名变量覆盖」；测试覆盖「两行都启用时只有靠上的一行有标记」「禁用靠后行后两个标记都消失」「只有一行时无标记」
- [x] 2.5 表格行拖拽排序，落库走 `variable_reorder`，采用乐观重排 + 失败回滚；测试验证拖拽后顺序提交、失败时顺序回滚
- [x] 2.6 幽灵行改走 `variable_create`：新增追加到末尾，填入已存在的名称时新增一条同名变量而非覆盖；测试覆盖两种情形
- [x] 2.7 `src/components/EntityScriptPanel.tsx` 增加「变量 / 脚本」页签（仅 `kind === 'collection'` 时渲染，默认变量），`EntitySessionTab` 增加 `innerTab` 并接入标签持久化与恢复；测试覆盖「默认变量页」「切到脚本页后切走再切回仍在脚本页」「文件夹面板无页签栏」
- [x] 2.8 `src/App.tsx` 在激活集合实体标签时加载集合变量、写入后刷新，并把 `scope='collection'` 与集合 id 传给变量面板；测试验证「在变量页新增集合变量后，该集合下的请求可解析到它」
- [x] 2.9 抽出共用的「同名组里谁生效」判定（跳过禁用行、取最靠下的启用行），由遮蔽标记、只读浮层与脚本运行时共用；`src/lib/scriptRuntime.ts` 的 `scopesOf` 改为跳过禁用行，`persistWrites` 的按名定位改为定位生效条；单测覆盖「禁用的行不进入脚本可见的作用域」「两条同名时写入落在生效的那一条」「生效条的值与原值相同时不写错行」
- [x] 2.10 `src/components/VariablesPeek.tsx` 按作用域列出全部条目（含同名与禁用），对「被禁用」与「被遮蔽」分别标注且不把其值呈现为生效值；组件测试覆盖两种标注与「生效条不带标注」

## 3. 导入导出保真

- [x] 3.1 `src-tauri/src/interchange/document.rs` 的 `VariableDoc` 增加 `description`（`DescriptionField`），`parse.rs` 的 `ParsedVariable` 增加 `enabled` 与 `description`；`parse_variables` 不再跳过禁用变量（未命名变量仍跳过并记录）；单测覆盖「禁用变量进入中间表示」「描述进入中间表示」「未命名仍被跳过并记录」
- [x] 3.2 `import.rs` 落盘 `enabled` 与 `description`（集合、环境、全局三条路径）；单测验证导入后禁用状态与描述可读
- [x] 3.3 `export.rs` 对禁用变量写 `enabled: false`、对非空描述写 `description`，并保持条目先后顺序；单测验证导出结果含禁用标记与描述
- [x] 3.4 往返单测：含禁用变量、描述与同名条目的集合/环境导出后重新导入，禁用状态、描述、顺序与条目数量全部一致

## 4. 集合树手势

- [x] 4.1 `src/components/WorkspaceTree.tsx` 的 `EntryRow`：单击行 = 打开实体面板 + 切换展开，折叠箭头只切换展开，Enter 与单击同义，双击只切换一次，搜索态不改变折叠集合但仍打开面板；组件测试覆盖这五条
- [x] 4.2 右键入口扩展到集合与文件夹节点，`src/components/EnvironmentsPanel.tsx` 的环境行同样加上右键；两处都复用各自既有的菜单项与展开状态，且不改变选中/激活；测试覆盖「右键打开同一份菜单」「右键后主区与选中不变」
- [x] 4.3 `reorder_children` 改为单一有序列表 `items: [{ id, kind }]`（下标即 `sort_order`，事务内逐项校验归属）；Rust 单测覆盖「目录与请求交错落库后顺序一致」与「id 不属于该父级时整批拒绝」
- [x] 4.4 树拖拽：落点判定（行的上/下半区 = 插入线排序，文件夹与集合行的中区 = 高亮并移入）、同级排序、同集合内移动（请求 `request_move`、目录 `folder_move`）、拒绝移入自身后代、跨集合不呈现落点、搜索态禁用拖拽、悬停折叠目录自动展开
- [x] 4.5 拖拽落库采用乐观重排 + 失败回滚，且不改选中、不关闭或切换已打开的标签；测试覆盖「拖拽后选中与标签不变」「写入失败时顺序回滚」
- [x] 4.6 窗口拖拽的非回归：用可注入的 `windowCloser` 假实现断言在侧栏内（树节点、变量表格行）拖拽期间 `startDragging` 从未被调用，且窗口拖拽自身的既有用例仍通过

## 5. 端到端验证与测试收口

- [x] 5.1 更新 `tests/app.test.tsx` 中依赖旧语义的用例：单击目录行即打开面板、变量名称不可编辑、「编辑脚本」为唯一入口这三组断言改写为新契约；`npm test` 全绿
- [x] 5.2 更新 `tests-browser/tree-expansion-gestures.spec.ts`（单击语义）与 `tests-browser/session-bar-and-tables.spec.ts`（表格相关）；`npm run test:browser` 全绿
- [x] 5.3 新增浏览器用例：树拖拽（同级排序、拖入目录、搜索态不可拖、按下未移动仍为打开）、变量表格拖拽与遮蔽标记、集合面板页签切换；`npm run test:browser` 全绿
- [x] 5.4 跑完整套件并确认全绿：`npm test`、`npm run test:browser`、`cargo test --manifest-path src-tauri/Cargo.toml`、`npm run build`
- [x] 5.5 迁移与既有行为：`storage::migrations` 的单测覆盖「迁移后变量全部可见、启用、无描述、顺序按名称、取值与 secret 标记不变」（真机核对需要迁移前的数据库副本，此处以该单测为准）；`README` 的「已知限制」已记录这次迁移不可逆、回退需从备份恢复
