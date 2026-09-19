## 1. 前置：让位给本变更

- [x] 1.1 归档 `simplify-editor-chrome-and-curl-tab`（与本变更共用 `App.tsx`、`RequestEditor.tsx`、`CurlSnapshot.tsx`、`App.css`），确认 `--change postman-style-dropdowns-and-body-actions` 的四个接入点落在归档后的代码上；验证：`openspec list --json` 只剩这一条 change，且 `npm run build` 通过

## 2. 关闭机制抽成 hook

- [x] 2.1 新增 `src/lib/useMenuDismiss.ts`：把 `NodeMenu.tsx` 里的三条监听（document mousedown 命中白名单则放过、Esc、capture 阶段 scroll）抽出，命中白名单作为入参；验证：`npx tsc --noEmit` 无错
- [x] 2.2 让 `NodeMenu` 改为消费该 hook 并传 `.node-more`，集合树与环境列表的既有菜单行为不变（点外部 / Esc / 滚动关闭，不改变选中）；验证：`npm test` 中菜单相关用例全部通过，且界面上既有菜单仍可开合

## 3. 通用下拉组件

- [x] 3.1 新增 `src/components/Dropdown.tsx`：受控组件（`label` / `value` / `options` / `onChange` / `searchable?` / `align?` / `testId?` / `disabled?`），触发器为 button 且常态无边框无填充（显示当前项文案 + 展开指示），菜单按 listbox 语义渲染并给当前项标记；验证：`npx tsc --noEmit` 无错，孤立渲染时触发器旁可见当前值
- [x] 3.2 接入 `useMenuDismiss`（白名单 `.dropdown`）：点外部、Esc、所属容器滚动都关闭且不写入新值；验证：用例覆盖三种关闭途径后 `onChange` 均未被调用
- [x] 3.3 键盘可用：触发器上 Enter / Space 展开，方向键移动，Enter 选中并关闭、焦点回到触发器，Esc 关闭；验证：用例覆盖「方向键 + Enter 提交正确的值」与「Esc 后仍是原值」
- [x] 3.4 布局：菜单 `position: absolute` 挂在相对定位的根节点下，提供 `align: 'right'` 变体，宽度不短于触发器，`max-height` + 内部滚动，展开不改变所在行高度；验证：浏览器用例断言展开后所在行的高度与相邻元素位置不变
- [x] 3.5 可选搜索（`searchable`）：菜单顶部搜索框按文案大小写不敏感过滤、无命中显示空态、搜索不改动外部值；验证：用例覆盖过滤命中、无命中空态、搜索后关闭菜单值不变
- [x] 3.6 `App.css` 新增 `.dropdown` / `.dropdown-trigger` / `.dropdown-menu` / `.dropdown-search` / `.dropdown-option` 样式，全部复用既有 token（`--panel`、`--border`、`--shadow-2`、`--accent-soft`、`--radius-md`、`--text-sm`）；验证：样式里不出现新写的颜色字面量与新字号

## 4. 环境选择器改用新组件

- [x] 4.1 `App.tsx` 的 `.env-select` 由原生 `<select>` 换成 `Dropdown`（`searchable`、`align: 'right'`，选项为「无环境」+ 全部环境，无障碍名称沿用「环境」）；验证：`npx tsc --noEmit` 无错，界面上不再有原生下拉控件
- [x] 4.2 保持既有语义：切换即 `environment_set_active`、与侧栏 Environments tab 双向同步、选中「无环境」取消激活、未选中请求时仍可见、旁无重复「环境」标签；验证：`tests/app.test.tsx` 中环境相关用例全部通过
- [x] 4.3 更新失效定位器：`tests/app.test.tsx` 的 `.env-select select`（约 3395 行）、`getByLabelText('环境').closest('.env-select')`（约 588 行）、约 4217 行的浮层归属断言，以及 `tests-browser/session-bar-and-tables.spec.ts` 约 307 行的原生 select 定位器；验证：`npm test` 与相关浏览器用例均通过
- [x] 4.4 会话标签行高度不被撑高（目标仍是 `--chrome-row: 40px`）：把 `.env-select select` 的收紧规则迁移到新的触发器上，删掉悬空的旧规则；拖拽方面本次无需改动（触发器是 `button`，已命中 `isInteractiveSessionBarTarget` 的选择器），补一条用例锚住「从下拉上按下指针不会拖动窗口」以防将来回归；验证：既有「环境选择器与窗口控制按钮完整可见」的浏览器用例仍通过

## 5. Body 类型行：语言选择移位

- [x] 5.1 把 `.raw-language` 的 `Dropdown` 从行尾移到 DOM 上紧接 `raw` 单选项的位置（去掉 `margin-left: auto`，改由动作块 `margin-left: auto` 顶到右端），非 `raw` 时不渲染；验证：用例断言 raw 的语言选择紧跟 `raw`，且切到其它类型后界面上不存在该控件
- [x] 5.2 语言选择由原生 select 换成 `Dropdown`（无障碍名称沿用「raw 语言」），保留 `raw_language` 的读写语义；验证：既有「切换 raw 语言」相关用例通过，`patch` 写的值与原先一致

## 6. Body 类型行：Minify / Beautify

- [x] 6.1 新增纯函数 `formatRawBody(text, 'beautify' | 'minify')`（依赖 `JSON.parse` / `JSON.stringify`，失败时抛错）并补单测；验证：单测覆盖重排、压缩、保留语义不变
- [x] 6.2 仅在「类型为 raw 且语言为 json」时渲染两个文字按钮（`.text-action`），其它语言与非 raw 类型下界面上完全不存在入口，也不出现禁用态；验证：用例覆盖四种非 JSON 语言下入口不存在
- [x] 6.3 点击后只改写请求体草稿文本并计入未保存状态（不改变语言选择、不写库），`.notice danger` 呈现解析失败原因，空正文时入口不可用；验证：用例覆盖「点击后标签显示未保存」「非法 JSON 不改写并提示」「空正文入口不可点击」
- [x] 6.4 `App.css` 新增 `.text-action` 文字按钮款式（浅色底主色文字，hover 加深，无填充方块观感）；验证：肉眼与用例一致即可，样式里不出现新的颜色字面量

## 7. cURL 标签：动作行上移

- [x] 7.1 `CurlSnapshot.tsx` 把动作行移到 `<textarea>` 之前并右对齐，删除正文下方的说明文案，`curl-regenerate` / `curl-copy` 两个 `data-testid` 保留；验证：既有 cURL 用例（重新生成覆盖编辑、复制改动后内容、复制成功显示「已复制」）全部通过
- [x] 7.2 两个按钮改用 `.text-action` 款式，与类型行的两个动作同一观感；验证：浏览器用例断言 cURL 动作行位于正文上方且两处按钮款式一致

## 8. 回归与收尾

- [x] 8.1 清理随改动失效的样式（`.raw-language` 的 `margin-left: auto` 等），确认没有悬空的 `.env-select select` 规则；验证：`npm run build` 通过
- [x] 8.2 跑全量：`npx tsc --noEmit`、`npm test`、`npm run build` 均无报错（`334 passed`）；`npm run test:browser` 见下方环境说明
  - **本机限制**：一次跑四个 spec 文件时 Vite 会并发清理同一个 `node_modules/.vite` 临时目录，本机回收站 shim 报 `[safe-delete] 操作失败: Some operations were aborted`，四个 suite 在启动阶段就失败（与本次改动无关）。逐个文件跑时全部通过：
    `session-bar-and-tables`（11 个用例，含新增的「展开环境下拉不抬高会话标签行」与「cURL 动作行在正文上方且两处按钮同款式」）、
    `tree-expansion-gestures`、`host-injection`、`script-runtime`。浏览器引擎复用本机 Chrome，不存在任何 Chromium 下载。
- [x] 8.3 确认后端无需改动（无新增命令、无迁移）：`git status` 不含 `src-tauri/` 下任何文件；`cd src-tauri && cargo test --lib` 报 280 通过 / 1 失败，失败项仍是 `net::tests::certificate_validation_is_on_by_default_and_can_be_disabled_per_request`（起不来自签 HTTPS 测试服务，`program not found`），属本机缺少外部依赖，与本次改动一致且无关
