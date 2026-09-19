## Why

界面当前的观感问题不在布局，而在**没有视觉体系**：

- 全站只有一个字号（`body { font: 13px/1.5 }`），且声明的 `Inter` 从未被加载（`index.html` 里没有任何字体引用），实际渲染一律落到 Segoe UI，层级只能靠 `font-weight: 500` 勉强区分；
- 输入框、按钮、表格单元格、会话标签共用同一组 `--panel-2` + `1px solid var(--border)`，整屏是平铺的灰色矩形；浮起层次只有模态与节点菜单两处有阴影；
- 强调色只有一档，选中态用 `color-mix(in srgb, var(--accent) 25%, transparent)`，在浅灰底上呈褪色的粉紫调；方法色却是 5 个硬编码 hex（`#067647` / `#b54708` / `#1a73e8` / `#7048e8` / `#d92d20`）；
- 圆角并存 4 / 5 / 6 / 8 / 999px，内边距并存 1 / 2 / 3 / 5 / 6 / 8 / 10 / 14px，没有 scale；
- 部分颜色完全在 token 体系之外（`ResponsePanel.tsx` 的内联 `border: '1px solid #ddd'`、`pre.body` 的 `#f6f8fa`）。

与此同时，**核心工作区在垂直与水平两个方向都被压缩**：

- 主区顶部叠了两行 chrome（会话标签行 + 面包屑行），而两行渲染的是同一个 `draft.name` —— 请求名被渲染了两次，第二次只提供可编辑能力；
- 响应区工具条分两层：`pane-header` 里塞了「响应」+ 最多 6 个徽章（5 个常态元信息徽章 + 发送中的状态徽章）+ tabs + 「保存全文」，且 `flex-wrap: wrap` 会在窗口变窄时折行使高度不可预测；`pane-body` 内又是一行「原始 / 格式化」；
- 左右分栏比例为固定值且明确不提供拖拽，而「看响应正文」是这个产品的核心动作——它被锁死在一半宽度，`pre.body` 还带 `word-break: break-word`，半宽 JSON 换行很碎。

这次变更把视觉基底与顶部 chrome 一起重做，并把回收出的空间让给请求表与响应正文。

## What Changes

- **建立视觉基底**：按 `design.md` 的 D0 落一套冷中性色阶 + 靛蓝主色 + 描边分层，并建立间距、圆角、字号、层次、动效的 scale；字体改用纯系统字体栈（`Segoe UI Variable` / `Segoe UI`；等宽 `Cascadia Mono` / `Consolas`），以符合「离线、本地优先」的约束——不引入字体文件、不引入 CDN、不新增依赖。把散落在内联样式与 CSS 中的硬编码色值收回 token。
- **顶部 chrome 合并**：面包屑行并入会话标签行，主区顶部 chrome 由两行减为一行。标签即面包屑（`所属集合 › METHOD [名称] ×`），请求名只渲染一次。窗口控制按钮、全局环境选择器与窗口拖拽区仍由这一行承载。**净省约 26px**——合并后的行要容纳名称输入框，行高会从 34px 升到约 40px，所以省下的是一整行 32px 减去这 6px 增量。
- **拖拽区排除清单**：合并后请求 / 实体名称输入框落入拖拽行，须补进会话标签行交互控件的排除清单，否则在名称框内按下拖动会移动窗口。
- **方法徽章收敛**：新增 `.method-badge` 语义类，**让「方法」这一种语义不再复用 `.badge`**（其余五种——「环境」「集合」「文件夹」「使用中」「未保存」——继续用 `.badge`，它不是被废弃）；方法色由 5 档收敛为 2 组（幂等方法 / 有副作用方法）；集合树、会话标签行与请求方法选择框三处共用同一形态。
- **响应区工具条收紧**：`pane-header` 内的 5 个常态元信息徽章（status / elapsed / size / http_version / 代理）收成一段紧凑文本（status 仍单独着色），去掉 `flex-wrap` 使头部高度可预测；正文区上方的「原始 / 格式化」工具条收紧并与 `content_type` 同行。（原计划是把这两层合并成一层，`design.md` D6 说明了为什么不合并——两组标签分属不同维度。）
- **主区留白收紧**：`.pane-body`、`.request-toolbar`、`.tabs` 三处的 10px 内边距统一为 6–8px。
- **左右分栏可拖**：分栏比例由固定值改为可拖拽，并按工作区记住上次比例。
- **请求级操作按需显现**：另存为 / 删除保留文字标签，改为指针悬停或键盘聚焦时显现（沿用既有「行操作按需显现」惯例）；用 `visibility` 切换而非条件渲染，避免行宽跳动并保持可访问性。
- 明确**不做**：深色主题（`ui-layout`「浅色配色」的既有约束不变）、侧栏折叠（需先有图标系统）、命令面板、解析预览条默认折叠。

不属于 BREAKING：本变更只增加能力与替换实现，不删除任何用户可达的既有行为。

## Capabilities

### New Capabilities

（无。）

本变更不引入新能力。视觉基底的 token 尺度属于实现约定而非可观测行为，落在 `design.md` D0 中，不为此新造 spec。

### Modified Capabilities

- `ui-layout`：
  - 「会话标签视觉壳」改为该行**同时**承载面包屑与请求级操作，而非只承载标签；集合 / 文件夹两种面的种类标注由「集合」「文件夹」两个汉字徽标改为**同类小图标**（与树中同一份绘制，见 `src/components/icons.tsx`）；
  - 「面包屑与请求操作行」删去「在会话标签下方」，改为与标签同行；补入「请求级操作按需显现且不引起水平跳动」；
  - 「集合树的外观与密度」补一句：请求节点的方法徽章与主区会话标签行、方法选择框共用同一形态与同一组颜色语义；
  - 「主区左右分栏与响应栏可见性」**整条替换**为「主区左右分栏与可调比例」——原需求内的场景「分隔线不可拖拽」与新行为直接冲突，无法通过 MODIFIED 保留（走 REMOVED + ADDED，与 `2026-09-17-add-collection-search-and-env-management` 处理冲突场景的方式一致）。
- `window-chrome`：
  - 「会话标签行拖拽区」的交互控件排除清单补入请求 / 实体名称输入框。

## Impact

- `src/App.css`：主改动面（D0 的 token、字体、描边分层、三态、留白、动效）。
- `src/App.tsx`：`.session-bar` 与 `.crumb-bar` 合并为一行。
- `src/components/ResizeStrips.tsx`：`isInteractiveSessionBarTarget` 的 `closest()` 选择器补入 `input` / `textarea`。
- `src/components/RequestEditor.tsx`：方法选择框改为徽章形态；清理该文件内的静态内联 `style`（`width: 120` / `28` / `200` / `90`、`padding: '4px 10px'`）。
- `src/components/ResponsePanel.tsx`：`pane-header` 的元信息收紧为紧凑文本并去掉 `flex-wrap`；去掉内联 `border: '1px solid #ddd'` 与 `wordBreak` 硬编码。
- `src/components/WorkspaceTree.tsx`：`.tree-method` 迁移到 `.method-badge`。
- 新增：分栏拖拽的命中区；分栏比例经既有 `settings_set('ui_layout', <workspaceId>, …)` 持久化（见 `design.md` D7），不需要新命令、不需要动 Rust。
- `index.html`：`<title>` 与 favicon 仍是脚手架默认值，随视觉基底一并处理。
- 测试：`tests/app.test.tsx` 共 **3 处**断言依赖行结构（约 580 行的 `session-tab`、637 行的 `.crumb-bar`、3172 行的 `session-bar`），随行合并更新；「另存为 / 删除」的 4 处 `getByText` 断言保持不变。
- 依赖：**不新增**任何 npm 依赖，不新增字体文件。
