## Why

环境一多，Environments tab 的两份列表就都不好用：侧栏那份的顺序由创建先后决定，用户改不了（而集合树与变量表早已支持拖拽排序）；右上角那份**根本滚不动**——一滚菜单就关，改去抓它的滚动条则会连窗口一起被拖走。

后者不是观感问题，是两处实现缺陷叠加的结果，且都违反已有规格文字：

- `useMenuDismiss` 把 `document` 上 capture 阶段的**任何** scroll 都当成"容器滚动"关掉浮层，菜单自身那个 `overflow-y: auto` 的选项区不算例外。于是 `max-height: 240px` 形同虚设：31 个环境里只有前 ~8 个可达，`ui-polish` 明文的「选项过多时菜单内部滚动、所列选项全部可达」落空。
- 菜单由 `createPortal` 挂到 `document.body`，而 React 的事件冒泡走 React 树。菜单里非 `button` / `input` 的区域（**正是选项滚动条所在的位置**）按下指针，会冒到会话标签行的 `onMouseDown`，命中 `startDragging()`——真机上表现为整个窗口跟着鼠标移动。`ui-polish` 已写明「菜单内的操作同理 SHALL NOT 冒泡为容器拖拽」，排除清单漏了 portal 出来的子树。

顺带暴露出第三件事：侧栏那份列表本身能滚（真机引擎实测 `scrollTop` 正常推进、无 `preventDefault`），但它是侧栏里**唯一**还在用原生占位滚动条的列表——内容溢出时实测吃掉 10px 行宽，滚动条出现/消失时整行连同右端控件横跳。这正是集合树与键值表当初手写 `OverlayScrollbar` 要消掉的缺陷类，只是当时没补规格（`polish-sidebar-and-tables` 的 design 明确写着"不引入真·overlay，细条近似，将来确需再议"）。

## What Changes

- **环境列表支持拖拽排序**：行可拖、松手即落到指示的位置；乐观重排、写入失败回滚；`Globals` 是固定项，既不可拖也不作为落点；搜索过滤生效时禁用拖拽（可见子集不等于完整顺序）；顺序按工作区持久化，复用已有的 `environments.sort_order`，新增 `environment_reorder` 写入口。
- **通用下拉恢复可滚**：菜单**自身**的滚动不再关闭菜单（"容器滚动即关闭"收窄为"菜单之外的容器滚动"）；菜单内任意位置的按下指针都不再冒泡成窗口拖拽。
- **侧栏环境列表的滚动指示改为悬浮条**，与集合树、键值表同款：不占用内容宽度、仅内容溢出时出现、悬停或拖动时可见且可用鼠标拖动。
- 规格层面由上到下把这三件事钉住（见 Capabilities），其中悬浮条一项同时给既有的集合树 / 键值表实现补上缺失的规格依据。

## Capabilities

### New Capabilities

（无——三件事都是既有能力的行为修正或补全，没有引入新的能力类别。）

### Modified Capabilities

- `ui-layout`: 新增「Environments tab 环境列表的拖拽排序」——顺序可通过拖拽调整并持久化、插入位置即最终落位、`Globals` 不参与排序、搜索态不可拖、拖拽不改变激活态与主区已打开的内容。
- `ui-polish`: 「通用下拉的观感与菜单行为」把「容器滚动即关闭」限定为**菜单之外的容器**，并明确菜单内任意位置的按下都不得冒泡为所在容器的拖拽；「全局细滚动条」由"细滚动条近似"收紧为**不占用内容宽度的悬浮滚动指示**，滚动条的出现 / 消失不得改变内容宽度。

## Impact

- 代码（后端）：`src-tauri/src/storage/variables.rs`（新增 `reorder_environments`）、`src-tauri/src/commands.rs`、`src-tauri/src/lib.rs`（注册），以及 `src-tauri/src/security_audit.rs` 里那条**等长**的命令面断言（漏改必红）。
- 代码（前端）：`src/lib/commands.ts`（`environmentReorder`）、`src/App.tsx`（乐观顺序与失败回滚）、`src/components/EnvironmentsPanel.tsx`（HTML5 拖拽手势与落点指示）、`src/lib/useMenuDismiss.ts`（滚动判定）、`src/components/ResizeStrips.tsx`（会话标签行的排除清单）、`src/App.css`（落点指示样式、悬浮条的定位上下文）。
- 行为：环境顺序在侧栏与右上角下拉里同步变化（同一份 `environments` 状态）；下拉在选项超过可视高度时可滚且选项全部可达；从下拉里按下指针不再移动窗口。
- 数据：`environments.sort_order` 的写入语义扩展——此前只在创建时赋值，现在可整体重写（下标即 `sort_order`，单事务、整批校验归属）。字段与取值域不变，**既有数据无需迁移**。
- 依赖与权限：不新增运行时依赖（悬浮条复用既有 `OverlayScrollbar`）、不放宽权限。新增的 `environment_reorder` 是具名领域能力，不接受路径也不引入通用入口，但必须同步审计白名单。
- 测试：`tests/app.test.tsx` 的假 client 需补 `environmentReorder`（否则既有 harness 类型不全）；`tests-browser` 新增真实引擎用例——拖拽排序落位、下拉可滚且选项可达、从下拉内按下不触发 `start_dragging`、侧栏列表 `gutter` 为 0（不随溢出变化）。
