## Context

动机见 `proposal.md`；行为约束见 `specs/ui-layout/spec.md`（本变更的 delta）。影响实现选择的现状：

- `App` 已经持有全部相关状态：`trees` / `displayTrees`（`applyOverlay` 之后的树）、`environments`、`environmentId`、`variables`，以及侧栏内部 tab 状态 `sidebarTab`。布局改造（`rework-app-layout`）之后组件边界已经清晰，本次不需要再动边界。
- `WorkspaceTree` 是纯受控组件：树数据与选中态由 `App` 传入，只有折叠/悬停/菜单/删除确认这些**视图态**在组件内部（`collapsed` / `activeId` / `menuId` / `confirmId`）。搜索与它同类，因此归属组件内部。
- 主区顶部已有 `session-bar` 这一行（`App.tsx` 内联渲染，目前只有一个会话标签），右侧是空白——环境选择器正好落在同一行，无需新增行。
- 命令层已有 `environmentActive`（读）与 `environmentSetActive`（写）、`environmentCreate`、`environmentDelete`；**唯独缺 `environmentRename`**（后端命令 `environment_rename` 与 `storage::rename_environment` 均已存在）。后端本次零改动。
- 现存测试 `tests/app.test.tsx` 等以用户旅程定位元素（`workspace-tree`、`+ 集合`、「集合」标题等），工具栏重排会触及。

## Goals / Non-Goals

**Goals:**

- 搜索是**纯前端视图态**：不进 `App` 状态、不落库、不改变选中、不影响既有折叠状态。
- 环境选择器与侧栏激活态**共用唯一状态源**，从结构上排除「两个激活入口互相打架」的可能（这正是上一个变更否决下拉的理由）。
- 最大复用既有件：导入复用 `ImportExportPanel` 模态，环境项菜单复用集合树的菜单交互，不新造第二套。

**Non-Goals:**

- 不做请求级环境绑定（`saved_requests` 不加列）。
- 不做搜索语法（`method:` / `name:` 前缀、正则、作用域限定），只做名称与 URL 的包含匹配。
- 不做自绘窗口控件（独立后续变更）。
- 不改任何后端命令、表结构或依赖。

## Decisions

### D1: 搜索过滤落在 `WorkspaceTree` 内部

`WorkspaceTree` 新增本地 `query` state，对传入的 `trees` 做 `useMemo` 过滤。`App` 完全不知道搜索的存在。

理由：搜索是典型的「组件内视图态」，与 `collapsed` 同源；放进 `App` 会污染一个已经持有 25+ 状态的组件，且没有任何外部消费者（spec 明确要求过滤不改变选中态、不落库）。

备选：`App` 持有 `query` 以便未来做「全局搜索面板」——否决，届时再上移成本也很低。

### D2: 过滤算法——自底向上裁剪，名前命中保留整棵子树

```
match(text) = text.toLowerCase().includes(query.toLowerCase())

request 节点:  name 命中 或 url 命中        -> 保留
folder / collection 节点:
    自身 name 命中                        -> 保留整棵子树（不裁剪）
    否则递归子节点:
        有任一子节点保留                    -> 保留该节点 + 仅保留命中的子节点
        无子节点保留                        -> 裁剪
```

`url` 取请求已保存的原始 URL（含 `{{var}}` 占位符），子串匹配天然覆盖 `{{base}}/users/{{id}}` 这类写法。

理由：与 Postman 的过滤行为一致；「名前命中保留整棵子树」避免用户搜文件夹名时只看到零星几个子项而失去上下文。

**折叠交互**：搜索态下强制全展开（渲染时忽略 `collapsed`），并**禁用**折叠按钮，避免出现「点了折叠但视图不折叠」的哑状态；清空搜索后恢复用户原有的 `collapsed`（`Set` 本身没被改动，天然恢复）。

备选：只展开命中项的所有祖先、其余按 `collapsed` 呈现——更精细，但需要在过滤结果里额外标注「祖先链」，收益不抵复杂度；且 spec 的「命中路径自动展开」已被强制全展开满足。

空 `query` 时直接返回原 `trees` 引用（不产生新数组），避免无谓重渲染。

### D3: 环境选择器用原生 `<select>`，与侧栏共享 `environmentId`

`session-bar` 右侧渲染一个受控 `<select>`：选项为「无环境」+ `environments`，值绑定 `environmentId ?? ''`，`onChange` 调用与侧栏 `onActivate` **同一个**回调。选择「无环境」即 `null`（等价于 Globals）。

理由：项目内已有原生 `select` 的一致用法（`RequestEditor` 的方法、请求体类型、认证类型选择器），可访问性与键盘操作免费，测试可直接 `selectOptions` 驱动。自绘下拉（像 Postman 那样带搜索与分组）需要外部点击、键盘导航、焦点管理等一整套，`NodeMenu` 已经写过一次，没必要为环境再写一遍。

**明确不做**：不把选择器状态复制一份到 `App` 之外，也不做「未保存的临时选择」——选择立即生效，与侧栏行为完全对称。

### D4: 切换环境时持久化激活态

现状：侧栏点击环境只调 `setEnvironmentId`，**从不调用** `client.environmentSetActive`；而启动时 `loadEnvironments` 又会调 `environmentActive` 读回数据库里的 `is_active`。也就是说，目前的激活态是内存态的，重启后回到数据库里最后一次（可能来自 Postman 导入的）激活环境——那个读操作实际只对导入生效。

决定：本次一并接线——激活、切换与取消（`id` 为 `null`）时都调用 `client.environmentSetActive(workspaceId, environmentId)`，让「选择的环境跨重启保留」成立，并让既有的 `environmentActive` 读取恢复其设计用途。后端 `set_active_environment` 已在同一工作区内先清空再置位，且会校验环境归属，语义与 spec 的「按工作区持久化」一致。

实现落点：把 `App` 里传给侧栏与主区选择器的 `onActivate` 收敛为**同一个回调** `activateEnvironment(id | null)`——先 `setEnvironmentId(id)`（乐观更新），再 `await client.environmentSetActive(workspaceId, id)`；失败时 `setError(describeError(caught).message)` 并把状态回滚到调用前的值。取消场景（`null`）同样落库，使该工作区的记录回到「无激活环境」。

备选：只在主区下拉里落库、侧栏不落库——否决，会让两个入口行为不一致，而 spec 要求它们是同一份状态。

### D5: 环境管理复用集合树的菜单交互

- 新建环境放在 `EnvironmentsPanel` 头部的工具栏，与 Collections tab 的工具栏同款式（图标按钮，见 D7）。
- 环境项的操作菜单把 `WorkspaceTree` 内部的 `NodeMenu` 提取为共享组件 `src/components/NodeMenu.tsx`（外部点击 / Esc / 滚动关闭三件事已实现且被测试覆盖），`WorkspaceTree` 改为从该文件导入。**保留 `.node-menu` / `.node-more` 类名**，避免既有测试定位器失效。
- 删除确认不再另造交互：在列表内就地渲染一条确认行，复用现有 `.node-confirm` 样式与「先确认再执行」的语义。

备选：为环境单独写一套菜单与确认。否决——第三份重复实现，且两处行为会漂移。

### D6: 环境重命名用「就地输入」而非模态

重命名走列表项内的输入框（`EntityScriptPanel`/面包屑的改名风格），回车或失焦提交，空名称拒绝并还原原值（与「集合与文件夹的重命名」既有语义对齐）。

备选：复用面包屑改名（环境不在集合树里，面包屑里没有它的位置）；或 `window.prompt`（不可测、样式不一致）——均否决。

### D7: Collections tab 工具栏只有搜索框与两个图标按钮

侧栏 tab 名已经是 Collections，工具栏里再放一行的「集合」标题是重复信息，删掉；新建集合与导入都改成图标按钮（加号 / 导入箭头），可见文字只留在 `aria-label` 与 `title` 里——悬停提示与读屏都不丢，测试也能用 `getByLabelText` 定位。整行结构是「搜索框（占满剩余宽度）+ 两个 22px 图标按钮」。

理由：对齐 Postman 的工具栏形态（图标而非文字按钮），且这一行本来就窄，文字按钮会把搜索框挤到不足一半宽度。

备选：保留文字按钮——在 300px 宽的侧栏里搜索框过窄，否决。

同一个款式也用在 Environments tab 的工具栏：栏内不再出现与 tab 名重复的「环境」标题，新建环境是图标按钮。

### D8: 环境变量编辑器落在主区，侧栏只放列表

侧栏固定 280px，变量表格嵌在环境列表下面既读不清、又把列表本身挤没了。改成：侧栏停在 Environments 时，主区（`request-region`）渲染 `VariablesPanel`，侧栏只保留环境列表。会话标签显示「环境」徽标 + 环境名，面包屑显示「环境 / 名称」，让主区的上下文提示与请求态一致。

规则是**侧栏 tab 决定主区内容**：`sidebarTab === 'environments'` → 主区是环境编辑器；切回 Collections → 恢复原来的请求/实体。`draft` 与 `entityDraft` 本来就不受 tab 影响，所以未保存的编辑不会丢。

连带变化：主区被环境编辑器占用时不再渲染响应栏（`with-response` 与响应列一起关掉）——响应属于请求，留着会把变量表格挤成半宽；`VariablesPanel` 的 `hideHeader` 恢复默认，主区需要「环境变量 / 作用域」这行标题。

同时去掉两处重复文案：Environments 栏不与 tab 名重复写「环境」，会话标签行的选择器旁边也不再放「环境」标签（选择器自身已显示「无环境」或环境名）。

备选：必须点某个环境项才把主区切成编辑器（Postman 的多标签语义）——引入「主区视图栈」，与现有单 draft 模型冲突；否决。

## Risks / Trade-offs

- [既有测试大面积触及工具栏与 `session-bar` 结构] → tasks 中单列测试迁移任务：`tests/app.test.tsx` 等以用户旅程定位器的用例改为先点 tab/按钮再断言；新增搜索过滤与环境下拉同步的用例；`npm test` 必须全绿。
- [过滤结果里出现「更多」菜单/折叠按钮的哑状态] → D2 已定：搜索态禁用折叠控件；菜单可正常使用（重命名会跳到主区，过滤态不受影响）。
- [切换环境后解析预览闪烁或竞态] → 复用现有 `previewSequence` 序号机制（`App` 中已按序号丢弃过期响应），新增触发源无需额外处理。
- [环境下拉让 `session-bar` 在窄窗口下换行] → 选择器设固定最大宽度并允许标签区域收缩（`min-width: 0` + 省略号），保证两者同排不换行（spec 要求同一行）。
- [提取 `NodeMenu` 引入的回归面] → 保持类名与 DOM 结构不变，仅移动文件与导出；先跑 `tests/` 中与树菜单相关的用例再改环境面板。

## Open Questions

- 搜索命中关键字是否需要在树中高亮（Postman 会高亮命中片段）？可后续单独做，不影响本变更的 spec 与任务划分。
