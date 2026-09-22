## Context

动机见 `proposal.md` 的 Why。这里只放理解方案所必需的状态与约束。

顺序这件事的数据层**已经就绪**，缺的只是写入口：

- `environments` 表本来就有 `sort_order`，`list_environments` 按 `ORDER BY sort_order, name` 取（`src-tauri/src/storage/variables.rs:30-40`）；但唯一的写入点是创建时的 `MAX(sort_order) + 1`。
- 同族的两条重排命令已经存在且口径统一：`variable_reorder`（作用域 + 归属 + 有序 id 列表）与 `collection_reorder`（工作区 + 有序 id 列表），都是"下标即 `sort_order`"、单事务、整批校验归属。环境缺的是同族的第三条。
- 侧栏列表与右上角选择器读的是**同一份** `App` 的 `environments` 状态（`EnvironmentsPanel` 只接受它作为 prop，不持有副本），所以顺序的变化必须发生在 `App` 层。

拖拽与滚动两侧都有现成范式可复用，不需要发明新机制：

- HTML5 DnD 在本仓库有两套范式：变量表（`VariablesPanel.tsx`，单层列表、拖到目标行 = 移到该行位置、无落点指示）与集合树（`treeMoves.ts` 纯逻辑 + 插入线落点）。桌面壳内 HTML5 DnD 可用性由 `fix-html5-dnd-in-tauri-shell` 保证（窗口构造里关掉外壳的拖放处理器，`security_audit.rs` 有一条源码级守卫钉住这一行）。
- 悬浮滚动条 `OverlayScrollbar` 已被集合树与键值表使用：只在 `scrollHeight > clientHeight` 时渲染，用 `targetRef` 读几何，并以 `targetRef.offsetTop` 定位——因此需要一个 `position: relative` 的定位上下文。
- `useMenuDismiss` 被 `Dropdown` 与 `NodeMenu` 共用；`Dropdown` 的菜单是 `createPortal` 到 `document.body` 的浮层，`NodeMenu` 留在行内。
- 会话标签行的窗口拖拽排除清单是 `ResizeStrips.isInteractiveSessionBarTarget`（`button, select, input, textarea, .env-select, .window-controls`）。

两条已确认的缺陷（成因见 `proposal.md`）：`useMenuDismiss` 的 scroll 判定不看事件目标；portal 出来的菜单不在会话标签行的排除清单里。

## Goals / Non-Goals

**Goals:**

- 环境顺序可拖拽调整、按工作区持久化，且侧栏列表与主区选择器**始终同源**（不存在"先动一个、一个往返后再动另一个"）。
- 选项超出一屏的下拉可滚且全部选项可达；菜单内任意位置的按下指针都不再触发窗口拖拽。
- 侧栏环境列表的滚动指示不占用内容宽度，观感与集合树 / 键值表一致。

**Non-Goals:**

- 不动集合树与变量表的拖拽手势与落点解算——它们没有缺陷。
- 不为环境引入层级：环境是单层列表，只排序、不建分组。
- 不引入第三方滚动条库（复用 `OverlayScrollbar`）。
- 不改 `Globals` 的语义（它仍等价于"取消环境激活"），也不让它参与排序数据。
- 不改其它通用下拉（如 raw 语言选择器）的行为，除共享的那两条缺陷修复之外。

## Decisions

### D1 后端新增 `environment_reorder`：复用既有 `apply_order`，但必须裹在事务里

入参 `(workspaceId, orderedIds)`，下标即 `sort_order`；`orderedIds` 中出现不属于该工作区的 id 时**整批拒绝**，不留半批写入。

工作区级的重排早就有一个通用 helper，复用它才是本仓库的口径：

```
src-tauri/src/storage/mod.rs:47-66
  apply_order(conn, table, ids, scope_column, scope_value)
    -> UPDATE {table} SET sort_order = ?1 WHERE id = ?2 AND {scope_column} = ?3
       （下标即 sort_order；任一 id 不命中即返回 NotFound）
```

**但不能照抄 `reorder_collections`。** 它是 `db.write(|conn| apply_order(...))`，而 `db.write` 只是"经单写者串行化"，**不是事务**（`storage/db.rs:79-89`，事务是 `write_tx`）。那样写在第 k 个 id 不合法时，前 k-1 条的 `sort_order` 已经逐条提交——正是"半批写入"。`reorder_variables` 用的就是 `write_tx` + 整批拒绝（它用例的断言原文即"失败后不应留下半批写入"），环境这条按它来：

```
db.write_tx(|conn| {
    let tx = conn.transaction()?;
    apply_order(&tx, "environments", ordered_ids, "workspace_id", workspace_id)?;
    tx.commit()?;
    Ok(())
})
```

**范围外观察（本次不改）**：`reorder_collections` 因此是非原子的，属既有隐患，先记录、不顺手扩范围。

替代方案是前端连发 N 条"移动一位"或复用 `environment_rename`。弃：写次数随规模增长、非原子，表现出来就是"有时对、有时差一格"——本仓库已经因为同类非原子写入吃过一次亏（见 `fix-html5-dnd-in-tauri-shell` 的 D5）。

必须成对改动、否则 `cargo test` 直接红：`src-tauri/src/lib.rs` 的注册，与 `security_audit.rs::the_command_surface_is_the_audited_one` 里那条**等长**的命令面断言。

### D2 乐观顺序落在 `App`，不是面板本地

变量表把顺序放在面板本地 state，因为那份列表没有第二个消费者。环境不是：右上角选择器也读同一份列表。因此顺序由 `App` 持有——拖拽后立即 `setEnvironments(重排结果)`，写入失败回滚到拖动前的数组。

替代方案是面板本地 `order` + `onChanged()` 重取。弃：两处会不一致一个往返的时间，而这正是"瞬时看不出、刷新才对不上"那类错位。

### D3 落点用插入线（上 / 下半区），与集合树同款

落在某行的**上半区** = 插到该行之前，**下半区** = 插到该行之后；指示就是那一侧的一条线（2px 强调色），线画在哪里、松手后就落在哪里。

这条**被产品决策推翻过一次**，记下来免得绕回去：初版取变量表的"拖到哪一行 = 取该行的位置 + 整行高亮"，理由是环境列表短、行级落点够精确。但它有个说不清的角落——"取该行的位置"到底是插到该行之前还是之后，**用户看不出来**；插入线把这个位置直接画出来，没有二义性。集合树本来就这么做，两处也就此一致。

换算照 `buildMove` 的口径：先在**去掉拖动项**的列表里定位目标行，再按下标插入（`before` 不加、`after` 加一）。这样"拖动项原本排在目标之前 / 之后"两种情形不必分别修下标，也不会出现"有时对、有时差一格"。

仍然**没有**「移入」这第二种意图：环境没有可承载子项的层级，所以只有这一种落点。

### D4 `Globals` 不进排序数据

`Globals` 不是 `Environment`（它只是 `environmentId === null` 的固定首行）。因此：它 SHALL NOT 可拖、SHALL NOT 作为落点，`orderedIds` 也只含真实环境 id。这条不需要额外机制，但必须在实现里显式写出来——否则最自然的做法（给每一行都挂 `draggable`、每一行都接受 drop）会让环境跑到 `Globals` 上面去。

### D5 搜索态禁用拖拽（沿用集合树先例）

`query` 非空时 `draggable = false` 并清空落点。理由与集合树同一句：可见子集不是完整顺序，落点没有意义。

### D6 菜单的"滚动即关闭"按事件目标豁免

`useMenuDismiss.onScroll` 读 `event.target`：目标落在菜单（豁免选择器）或 `ref.current`（触发器所在根）之内则忽略，其余照旧关闭。

这样同时满足两侧要求：菜单**之外**的容器滚动仍然关闭（既有场景「滚动关闭」），菜单**自身**滚动不再关闭（新场景「菜单自身滚动不关闭菜单」）。

替代方案是给 `.dropdown-options` 加 `onWheel` + `stopPropagation`。弃：`scroll` 不是用户手势——拖动菜单自身的滚动指示条同样产生 scroll，拦 wheel 只覆盖其中一条路径。

### D7 会话标签行的排除清单覆盖浮层菜单

在 `isInteractiveSessionBarTarget` 的排除选择器里补上菜单根（`.dropdown-menu`）。

为什么补在这里、而不是在 `Dropdown` 里 `stopPropagation`：这条策略的所有权已经在该函数（它已经在为 `button` / `input` / `.env-select` / `.window-controls` 兜底），而 `Dropdown` 的菜单是本应用**唯一**会被挂到文档根、从而绕过 DOM 祖先判定的浮层。把判定留在唯一的地方，将来再加浮层时只需要回答一个问题："它会不会离开会话标签行的 DOM 子树？"

替代方案是在菜单根上 `onMouseDown={stopPropagation}`。可行，但策略就分成两处（浮层自己 + 排除清单），而 `NodeMenu` 这种行内菜单本就不需要它，容易漏。

### D8 侧栏列表的滚动指示改用既有 `OverlayScrollbar`

`.env-list` 加 `scrollbar-width: none`（与 `.tree-root` 同款），渲染 `<OverlayScrollbar targetRef={...}/>`，并让 `.env-panel` 成为 `position: relative` 的定位上下文。

为什么不是"把原生滚动条再调窄"：占位型滚动条的根本问题是**占宽**——实测溢出时 `gutter = 10`、行宽 263 → 253，不溢出时回到 0/263。调窄只是把 10px 变成 6px，滚动条出现 / 消失时整行横跳依旧。本次同时把 `ui-polish`「全局细滚动条」收紧到"不占内容宽度"，顺带给集合树与键值表那套已经实现的悬浮条补上规格依据。

## Risks / Trade-offs

- [你报的"侧栏滚轮完全没反应"与我在真机引擎里两次量到的结果不一致（滚轮事件正常交货、无 `preventDefault`、`scrollTop` 正常推进）] → 本变更按"能滚但不占宽、且要有可见可拖的指示"处理；**结局**：以真机截图核对，侧栏那份当时是 Globals + 13 个环境共 14 行（行距约 34px → 476px），未超出 491px 的可用高度，滚轮"没反应"是"没有多余内容"而非缺陷；第二成因不存在，本风险未兑现。注意这只解释了"不动"，不解释"占宽"——列表一旦溢出（再加一个环境就到），原生占位滚动条仍会吃掉 10px 行宽，那正是 D8 要修的。
- [重排只重写传入 id 的下标，未出现在列表里的条目保持原序号] → 前端**始终传完整列表**（当前工作区的全部环境），这条写进任务的验证点；后端与变量侧口径一致，不引入新语义。
- [行的 `draggable` 与行内就地改名的输入框冲突（在输入框里拖选文字可能变成整行拖拽）] → 与变量表同样的既有取舍，先按同款实现；实现期实测该手势，若不顺手则退化为拖拽把手。这条取舍以实测为界。**结局**：实测两个担心都不成立——Chromium 给表单控件自己的 `user-select`，行上的 `user-select: none` 管不到输入框内的选中；text input 对指针的优先级也高于祖先的 `draggable`，所以在输入框里拖选既不会把整行拖走、也不会让改名态失焦。因此不引入"改名中禁用拖拽"这层额外状态，也不做拖拽把手。回归保护留在浏览器用例里（断言"行不被拖走 + 改名态不被打断"，另在拖整行时用 `window.getSelection()` 断言不选中文字）；"输入框里的文字确实被选中"这半句只作为实测结论记录——它对 CPU 争用敏感（整套并行跑时同一条手势会量到 0），写成断言会变成 flaky。
- [`OverlayScrollbar` 用 `targetRef.offsetTop` 定位，而 `.env-panel` 有纵向内边距] → 让 `.env-panel` 作为定位上下文即可（`offsetTop` 是相对 offsetParent 的偏移，内边距会被正确计入）；用浏览器用例钉住 `gutter === 0` 与 thumb 在溢出时可见。
- [排除清单是"点名制"，将来新增浮层可能漏改] → 在 `isInteractiveSessionBarTarget` 的注释里写明判据（凡脱离会话标签行 DOM 子树的浮层都要在这里点名），并在 `tests-browser` 留下一条"从菜单内按下不触发窗口拖拽"的用例作为回归信号。

## Migration Plan

无数据迁移：`sort_order` 的字段与取值域都不变，只是新增一条可整体重写的写入路径。回退时撤掉命令注册与面板手势即可，既有数据仍是合法的 `sort_order`。
