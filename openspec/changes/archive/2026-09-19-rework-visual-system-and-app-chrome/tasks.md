## 1. 视觉基底（不改 DOM）

- [x] 1.1 在 `src/App.css` 的 `:root` 建立 token：保留既有 11 个变量名（`--bg` `--panel` `--panel-2` `--border` `--text` `--muted` `--accent` `--accent-fg` `--danger` `--warn` `--ok`），新增 `--space-*`（4 的倍数）、`--radius-*`（2 档）、`--shadow-*`（3 档）、`--text-*`（4 级字号）、`--ease-*` — 验证：`npm run build` 通过，且这一步只新增变量、界面观感不变
- [x] 1.2 字体栈替换为系统字体栈（UI：`'Segoe UI Variable Text', 'Segoe UI', system-ui`；等宽：`'Cascadia Mono', Consolas, ui-monospace`），并把字号分为正文 13px / 树与表格 12px / 元信息 11px / 标签名称 13px semibold 四级 — 验证：`package.json` 与 `index.html` 均无新增依赖或字体引用；界面上四档字号可区分，不再是全站一个字号
- [x] 1.3 建立浮起层次：把 `--shadow-1/2/3` 应用到浮层（模态、节点菜单、通知条、下拉），描边值按层次分派到 `--border` / `--border-strong`。**保留 `border: 1px solid`，不做 inset 替换**——原 rationale 已被证伪（`* { box-sizing: border-box }` 已使显式设宽高的元素不受 border 影响），且转换会让约 11 处 `border: none` / `border-color: transparent` 失效、静默长出边框 — 验证：模态、节点菜单、通知条获得由低到高的可辨层次；图标按钮、窗口控制按钮、ghost 按钮、树折叠控件上都不出现多余边框
- [x] 1.4 收敛间距与圆角：`App.css` 中 1/2/3/5/8/10/14px 归到 `--space-*`，4/5/6/8px 归到 `--radius-*`（`999px` 只留给徽章的 pill 形态） — 验证：文件内不再出现 scale 之外的字面 padding / radius 值
- [x] 1.5 重做强调色的三态：选中、悬停、活动各自取值，替换 `color-mix(in srgb, var(--accent) 25%, transparent)` 那种褪色选中态 — 验证：侧栏树选中行、键值表行悬停、标签页活动态三者互不混淆
- [x] 1.6 焦点环与动效基线：统一的 `:focus-visible` 环；可点击元素补 `:active` 反馈；模态与菜单的入场用 `--ease-*` 且时长 ≤300ms；遵循 `prefers-reduced-motion` — 验证：键盘 Tab 能看见焦点环；按钮按下有反馈；打开模态是过渡而非瞬变
- [x] 1.7 清理死样式与散落硬编码：删除 `.sidebar-head` 规则；`pre.body` 的 `#f6f8fa`、`iframe.preview` 的 `#fff`、各处 `rgba(...)` 阴影归入 token — 验证：`App.css` 中 `:root` 之外不再出现 hex 字面量

## 2. 顶部一行化

- [x] 2.1 `.main` 的 `grid-template-rows` 由 `auto auto minmax(0, 1fr)` 改为 `auto minmax(0, 1fr)`，删除 `.crumb-bar` 相关规则，**并把 `.request-region` 与 `.response-region` 的 `grid-row: 3` 改为 `grid-row: 2`**（否则两者会落到已不存在的第三行）；顺带清掉 `.main` 上方那段已失效的注释（它仍写着「请求区 45fr / 响应区 55fr」，而代码早就是 `1fr:1fr`） — 验证：主区顶部从窗口上沿到地址栏之间只剩一行，且请求区与响应区正常显示、未塌陷
- [x] 2.2 在 `App.tsx` 的 `.session-bar` 内把标签与面包屑合并为同一个元素，形态为「所属集合名 › 方法徽标 + 名称输入框 + 关闭」；保留 `data-testid="session-bar"` 与 `session-tab`，保留 `aria-label="请求名称" / "集合名称" / "文件夹名称"`，以及 `requestNameRef` / `entityNameRef` 的重命名焦点接管 — 验证：请求名在界面上只出现一次；选中集合或文件夹时改名入口仍可用且能接管焦点
- [x] 2.3 「另存为」「删除」保留文字标签，改为指针悬停或行内键盘聚焦时显现，用 `visibility` 切换而非条件渲染 — 验证：无悬停且无焦点时二者不可见；`tests/app.test.tsx` 的 4 处 `getByText('另存为' / '删除')` 断言无需修改
- [x] 2.4 合并后的这一行设 `overflow: hidden`，环境选择器与窗口控制按钮设 `flex: none` — 验证：把窗口缩窄后环境选择器与三个窗口控制按钮仍完整可见、互不遮挡
- [x] 2.5 把 `isInteractiveSessionBarTarget` 的 `closest()` 由 `'button, select, .env-select, .window-controls'` 扩为 `'button, select, input, textarea, .env-select, .window-controls'` — 验证：在名称输入框内按下拖动不移动窗口、双击不切换最大化；在同一行的空白处拖动仍能移动窗口
- [x] 2.6 更新 `tests/app.test.tsx` 中针对 `.crumb-bar`、`session-bar`、`session-tab` 的 3 处断言以匹配合并后的结构 — 验证：`npm test` 全绿

- [x] 2.7 **顶部与侧栏的基线对齐**（实现期用户指出，超出原任务清单）：新增 `--chrome-row`（40px）让 `.sidebar-tabs` 与 `.session-bar` 显式等高——两行分处 `.app` 网格的两个格子，高度各自由内容撑，此前是 45.5px vs 55.5px，两条下边线差 10px；新增 `--sidebar-inset`（8px）把工具栏、树、环境列表的左基线收到 `.sidebar-body` 上（此前 `.tree-toolbar` 贴边在 x=0，而树行与环境面板在 x=8，切 tab 时横跳）；chrome 行与 `.status-bar` 内的按钮紧凑化——那个 `×` 关闭按钮吃全局 `button { padding: 6px 12px }`，是行高被顶到 55.5px 的元凶，底栏的三个入口按钮同样把 32px 的栏塞满 — 验证：浏览器实测 `.sidebar-tabs` 与 `.session-bar` 均为 40px；`.sidebar-tab` / `.tree-toolbar` / `.tree-root > li > .node` / `.env-item` 的左边界同为 8、右边界同为 271

- [x] 2.8 **集合 / 文件夹的种类标注改用图标**（实现期用户指出，超出原任务清单；对齐 Postman 的标签形态）：新增 `src/components/icons.tsx` 导出 `FolderIcon` 与 `CollectionIcon`（树与会话标签头共用同一份绘制，原先 `FolderIcon` 是 `WorkspaceTree.tsx` 内的私有函数），会话标签头里那两个「集合」「文件夹」汉字徽标换成图标，并给图标 `role="img"` + `aria-label` 使种类对辅助技术仍可读 — 验证：`npm run build` 通过、`npm test` 全绿；浏览器中选中集合与文件夹时标签分别显示集合图标与文件夹图标，不再出现那两个汉字

## 3. 方法徽章收敛

- [x] 3.1 新增 `.method-badge`，按是否幂等分两组配色：`GET` / `HEAD` / `OPTIONS` 一组，`POST` / `PUT` / `PATCH` / `DELETE` 与未知方法一组 — 验证：同一组方法呈现同一颜色，两组颜色不同
- [x] 3.2 把 `WorkspaceTree.tsx` 的 `.tree-method` 迁移到 `.method-badge` — 验证：树中方法标签使用新形态与配色，且视觉权重仍轻于名称
- [x] 3.3 会话标签行的方法徽标改用 `.method-badge` — 验证：树中与会话标签行里同一个方法呈现一致的形态与颜色
- [x] 3.4 `RequestEditor.tsx` 的方法选择框改为 `appearance: none`、由容器承载徽章配色与自绘 caret，保留下拉与键盘的原生行为 — 验证：选择框按当前方法着色；`tests/request-editor.test.tsx` 全绿且下拉选择仍可用

## 4. 分栏拖拽与比例持久化

- [x] 4.1 `.main.with-response` 改为三列 `minmax(0, var(--split, 50%)) 5px minmax(0, 1fr)`；**把 `.response-region` 的 `grid-column: 2` 改为 `3`**（中间那列让给 gutter 命中区），**并摘掉它现有的 `border-left: 1px solid var(--border)`**（否则分隔线与 gutter 会组成双线），gutter 元素加 `col-resize` 光标 — 验证：选中请求后两列之间出现可拖的分隔线，且视觉上只有一条线；未选中请求（或主区被环境编辑器占用）时不存在分隔线
- [x] 4.2 实现拖动：`pointerdown` 时捕获指针，`pointermove` 用 `requestAnimationFrame` 节流写 `--split`，`pointerup` 收尾；拖动期间 `user-select: none` — 验证：拖动跟手且两侧内容同步重排，拖动过程中不会选中页面文字
- [x] 4.3 拖动期间给两侧 pane 加 `pointer-events: none`，结束后恢复 — 验证：把分隔线拖过响应区渲染的沙箱 iframe 上方时依然跟手，指针不被 iframe 吞掉
- [x] 4.4 把比例钳制到两侧都留有可用宽度的区间 — 验证：拖到任一端的极限位置时该侧停止收缩，另一侧正文仍可阅读
- [x] 4.5 落库与读取：`pointerup` 时 `settings_set('ui_layout', <workspaceId>, <比例>)`；工作区加载时 `settings_get` 读回，值缺失或不可解析则回落默认比例 — 验证：调整比例后重新加载该工作区恢复该比例；切到另一个从未调整过的工作区呈现默认比例
- [x] 4.6 拖动分隔线不改变当前选中项、不影响未保存内容、不触发未保存守卫 — 验证：在存在未保存改动时拖动分隔线，不出现三选一提示，且改动仍在

## 5. 空间回收与清理

- [x] 5.1 响应区 `pane-header`：把 status / elapsed / size / http_version / 代理 由 5 个并列徽章收成一段紧凑文本（status 仍单独着色），去掉 `flex-wrap` 改为 `overflow: hidden` 且次要项可截断 — 验证：改变窗口宽度时头部高度恒定、不折行，状态码与耗时仍可读
- [x] 5.2 正文区上方的「原始 / 格式化 + content_type」收紧为一行紧凑工具条，`.pane-body` 内 `.stack` 的 gap 由 8px 收到 4px — 验证：该区域高度下降，且「Body / Headers / 脚本」与「原始 / 格式化」两个维度在视觉上仍分组清晰、不被混为一组
- [x] 5.3 主区留白收紧：`.pane-body`、`.request-toolbar`、`.tabs` 三处的 10px 内边距统一到 6–8px — 验证：表格首列起点前移、正文可视宽度增加，且新增/编辑行的可点击高度仍满足使用
- [x] 5.4 清理静态内联 `style`：`ResponsePanel.tsx` 的 `border: '1px solid #ddd'` 与两处 `wordBreak`、`RequestEditor.tsx` 的 `width: 120` / `28` / `200` / `90` / `auto` 与 `padding: '4px 10px'`、`VariablesPanel.tsx` 与 `PreviewBar.tsx` 的静态值 — 验证：`src/**` 中剩余的内联 `style` 只剩运行时才知道的值（如拖动中的 `--split`）
- [x] 5.5 硬编码终检：搜出 `App.css` 与 `src/**` 中残留的 hex / rgba / scale 之外的像素值，逐条归入 token 或改写为类 — 验证：检查结果为空
- [x] 5.6 `index.html` 的 `<title>` 与 favicon 换成产品自身的值 — 验证：窗口标题不再是 `Tauri + React + Typescript`，favicon 不再是 Vite 默认图标

## 6. 校验

- [x] 6.1 `npm test` 全绿 — 验证：无回归；若需真实浏览器引擎，复用本机已安装的 Chrome，禁止下载 Chromium 二进制
- [x] 6.2 `npm run build` 通过 — 验证：无类型与编译错误
- [x] 6.3 逐条对照 `specs/ui-layout`（含新增的「主区左右分栏与可调比例」）与 `specs/window-chrome` 的场景验证一遍 — 完成方式：真手势 / 真样式 / 真持久化的那些场景搬进真实浏览器跑（本机 Chrome，桩掉 Tauri IPC 与 settings 表），**13/13 通过**；jsdom 能验的「比例钳制 / 按工作区 keying / 写入失败降级」补成 `tests/layout.test.ts`（6 条）。实测记录：顶部标签行与请求区相接且行高 40；侧栏四类元素左边界同为 8、右边界同为 271（w=263）；请求级操作显隐不改变标签位置（left/w 保持 288/283.6）；名称框内拖动与双击不产生窗口拖拽或最大化；行内空白拖动 / 双击各触发 1 次；侧栏内拖动不触发拖拽；方法徽章 GET=`rgb(6,118,71)`、POST=DELETE=`rgb(181,71,8)` 且方法选择框同色；拖动分隔线得 `--split=70%`（请求区 700 / 响应区 295）；拖到极限被钳到 75%（响应区仍 245px）；落库 `0.75`、改写成 `0.62` 后重载读回 62%；窗口控制按钮与八个方向的缩放边条各自发出对应命令；未选中请求时分隔线随响应区一同消失
- [x] 6.4 确认本次未改动 Rust 侧、未改动命令契约与持久化 schema — 验证：`src-tauri/` 无 diff，新增的只有一条 `ui_layout` settings 记录
