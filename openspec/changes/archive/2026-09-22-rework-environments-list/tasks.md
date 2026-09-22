## 1. 后端：环境重排入口

- [x] 1.1 在 `src-tauri/src/storage/variables.rs` 新增 `reorder_environments`：复用 `storage/mod.rs` 的 `apply_order`（表名 `environments`、scope 列 `workspace_id`），但**必须裹在 `write_tx` 里**——`reorder_collections` 用的 `db.write` 不是事务，照抄会得到半批写入（见 design D1）；验证：存储层新增用例通过——重排后 `list_environments` 按新顺序返回，且传入一个不属于该工作区的 id 时整批不写入（逐条断言全部 `sort_order` 保持原值）
- [x] 1.2 在 `src-tauri/src/commands.rs` 暴露 `environment_reorder` 并在 `src-tauri/src/lib.rs` 注册，同时把命令名补进 `security_audit.rs::the_command_surface_is_the_audited_one` 的 `expected` 列表；验证：`cargo test` 通过（漏补审计列表会因那条等长断言直接失败）
- [x] 1.3 在 `src/lib/commands.ts` 的 `Commands` 接口补 `environmentReorder(workspaceId, orderedIds)`，并给 `tests/app.test.tsx` 的假 client 补同一实现；验证：`npx tsc --noEmit` 无错、`npm test` 通过

## 2. 环境列表的拖拽排序

- [x] 2.1 `App.tsx` 持有乐观顺序：拖拽落定后立即把重排结果写进 `environments` 状态（侧栏列表与主区环境选择器因此同步），写入失败回滚到拖动前的数组并用既有错误条提示；验证：单测断言四件事——拖拽后顺序立即变化、会话标签行的环境选择器菜单里顺序同步、失败时回滚到拖动前的顺序、重排不改变激活环境且不影响主区已打开内容与变量表格（规格「拖拽不影响激活态与已打开内容」）
- [x] 2.2 `EnvironmentsPanel.tsx` 给环境行挂上 HTML5 拖拽（`draggable` + `dragstart` / `dragover` / `drop` / `dragend`），落点语义为"拖到某一行 = 落到该行的位置"（抽出等价的纯函数，与变量表的 `moveId` 同口径）；验证：纯函数单测覆盖"前移到后""后移到前""拖回原处不产生写入"三种情形
- [x] 2.3 `Globals` 行不可拖、也不接受落点，传给后端的 `orderedIds` 只含真实环境 id；`query` 非空时禁用拖拽并清空落点；验证：单测断言搜索态下拖拽不生效、在 `Globals` 上放下不产生任何写入、`orderedIds` 不含 Globals 的占位值
- [x] 2.4 在 `App.css` 画出落点**插入线**（落在某行的上 / 下半区，线就画在那一侧，与集合树同款），并让环境行与集合树行一样禁选文本（`user-select: none`）；验证：浏览器用例中拖拽悬停时目标行出现 2px 强调色插入线（`::after` 的 height / background），且只有它那一侧有，拖动过程不选中文字

## 3. 侧栏列表的悬浮滚动条

- [x] 3.1 `.env-list` 隐藏原生滚动条（`scrollbar-width: none` + `::-webkit-scrollbar` 归零），接入既有 `OverlayScrollbar`，并让 `.env-panel` 成为它的定位上下文（`position: relative`）；验证：浏览器用例断言溢出时 `gutter === 0`（`offsetWidth - clientWidth`）且悬浮条存在、不溢出时悬浮条不存在且行宽与溢出时一致，并**补一条该组件此前完全缺失的用例**——按住悬浮指示条拖动后容器确实滚动、松手后指示条位置与滚动位置同步（规格「悬浮指示条可拖动」）
- [x] 3.2 复核高度链在改名中、删除确认条展开、空态、搜索无命中四种状态下都成立（`flex: 1; min-height: 0` 不被新增元素破坏）；验证：浏览器用例在这两种展开态下仍能滚动列表

## 4. 通用下拉的两条修复

- [x] 4.1 `useMenuDismiss` 的 `onScroll` 改为按事件目标豁免——目标落在豁免选择器或 `ref.current` 之内则忽略，其余照旧关闭；验证：单测断言"菜单自身滚动不触发 `onClose`"与"祖先容器滚动仍触发 `onClose`"两条同时成立
- [x] 4.2 会话标签行的排除清单补上浮层菜单根（`ResizeStrips.isInteractiveSessionBarTarget`），并在该函数注释里写明判据（凡脱离会话标签行 DOM 子树的浮层都要在此点名）；验证：浏览器用例里**先让假后端具备可观测性**——`FAKE_TAURI` 要记录每次 `invoke` 的命令名，并补上 `metadata.currentWindow.label`（缺了它 `getCurrentWindow()` 会抛，`startDragging` 根本走不到 invoke，用例会**假阳性通过**）；在此之上断言从菜单的选项间隙 / 菜单空白处 / 菜单自身滚动指示条上按下均不触发 `plugin:window|start_dragging`，且**必须有正向对照**——在会话标签行空白处按下必须记到 `start_dragging`（对照组不绿，这条断言没有意义）
- [x] 4.3 下拉在选项超出一屏时可滚且选项全部可达；验证：滚轮路径由浏览器用例驱动（菜单保持展开、`scrollTop` 变化、最后一项可选）；「拖动菜单自身的滚动指示条（原生细条）」这条路径在 headless 下驱动不了（覆盖式滚动条不是独立命中目标），改由两层覆盖——单元级 `fireEvent.scroll(菜单的选项区)` 断言「任何来源的自滚动都不关闭菜单」，浏览器用例断言「在该区域按下不关菜单、也不拖窗口」

## 5. 真实引擎回归与真机验收

- [x] 5.1 `npm run test:browser` 全绿：新增用例通过，且既有集合树拖拽、表格吸顶、会话标签行溢出三条回归用例不受影响；验证：命令退出码为 0 且无 failed
- [x] 5.2 在 Windows 的 `npm run tauri dev` 窗口里真机走一遍：拖动环境改变顺序（落点线画在上 / 下半区、松手后就落在线的位置；重启后顺序保持）、从右上角下拉里滚动选择靠后的环境、在菜单任意位置按住拖动时窗口不移动；验证：三个动作均如预期，且侧栏环境列表滚动条出现 / 消失时行宽不跳
