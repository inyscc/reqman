## Why

界面上三处仍使用运行环境自带的原生控件与默认按钮样式：请求体 raw 的语言选择（`RequestEditor.tsx` 的 `.raw-language`）、会话标签行的全局环境选择器（`App.tsx` 的 `.env-select select`）、cURL 标签的「重新生成 / 复制」。原生 `<select>` 的弹出菜单由系统绘制，无法控制观感，与 Postman 那种「文本触发器 + 自绘菜单」的清爽度差距明显。

同时位置也不对：raw 的语言选择被 `margin-left: auto` 推到类型行的最右端，与它所修饰的 `raw` 单选项之间隔着 binary 和整行空白；而类型行的最右侧本可以像 Postman 一样承载 `Minify` / `Beautify` 这类正文动作。cURL 的两个动作则被压在正文下方，用户要读完长命令才能点「复制」。

## What Changes

- **新增通用 `Dropdown` 组件**（新增 `src/components/Dropdown.tsx`）：由「文本触发器 + 自绘浮层菜单」构成而不是原生 `<select>`；支持选项列表、当前选中项的标记、可选搜索框；关闭规则（点击外部、Esc、容器滚动）复用 `NodeMenu` 既有的一整套监听而非另写一套。**非目标**：本次不替换表单内的其它原生 select（字段类型、认证方式、协议版本等），组件留通用接口，后续逐个迁移。
- **环境选择器换成该组件并带搜索**：选项仍在「无环境 / Globals」与全部环境之间，搜索框按环境名做大小写不敏感的过滤（环境数量多时才可辨识的意义成立）。
- **raw 的语言选择紧跟 `raw` 单选项**：从行尾移到 `raw` 单选项之后，它与其余类型选项之间不再隔着整行空白。
- **类型行最右侧承载 `Minify` 与 `Beautify`**：仅在请求体为 `raw` 时出现，样式为 Postman 式的文字按钮（浅色底主色文字），不引入边框占位的控件观感。
- **`Minify` / `Beautify` 只作用于 JSON 语言**：JSON 有自己的解析器（`JSON.parse` / `JSON.stringify`）；xml、html、text、javascript 没有现成解析器，入口在这些语言下**隐藏**而不显示为禁用态。
- **cURL 的动作行移到正文上方并与以上文字按钮同一款式**：由「重新生成」「复制」两个动作构成的行贴在文本块上方、右对齐；原先位于正文下方的「可以就地修改这段命令，改动不会写回请求。」说明文案**删除**（每次进入即重新生成、编辑不影响请求，这些靠行为本身已经足够，不需要再在界面上解释一遍）。正文继续铺满可用高度。

## Capabilities

### New Capabilities

无。下拉组件的观感与行为归入既有的 `ui-polish`，字符串格式化动作归入既有的 `ui-layout`，二者都不单独成能力。

### Modified Capabilities

- `ui-polish`：新增「通用下拉的观感与菜单行为」需求——触发器常态为文本（无表单控件边框），菜单为自绘浮层（选项 hover / 焦点可辨识、当前项有标记、可选搜索），关闭规则沿用既有 `NodeMenu` 的 Outside / Esc / 滚动三条。
- `ui-layout`：
  - 「会话标签行的全局环境选择器」→ 承载方由原生 select 改为通用下拉，并**新增**带搜索的菜单（原来的「选项为无环境与全部环境」「与侧栏激活态同步」「旁无重复标签」等既有语义不变）。
  - 「请求体类型的选择行」→ 修改：raw 的语言选择由「同一行的行尾」改为「紧跟 raw 单选项」，且同一行的最右侧承载 `Minify` / `Beautify`。
  - 「cURL 快照标签」→ 修改：「重新生成」「复制」由正文下方改为正文上方的动作行，按钮款式与 `Minify` / `Beautify` 一致；「复制当前内容而非生成原文」「切后重新生成」等既有语义不变。
  - 新增「raw 正文的格式化动作」需求：`Beautify` 缩进重排、`Minify` 去空白，仅对 JSON 语言提供，其它语言不出现入口；改写结果是正文草稿的一部分，纳入既有的未保存判定（不清洁地绕过 `Ctrl+S` 与守卫）。

## Impact

**前端**

- 新增：`src/components/Dropdown.tsx`；`src/lib/useMenuDismiss.ts`（把 `NodeMenu` 的关闭监听抽成 hook，`NodeMenu` 一并改为消费它）；`src/lib/editing.ts` 里新增纯函数 `formatRawBody`（该文件已有编辑相关的辅助函数，就地扩写而非新建文件）。
- 改动：`src/components/RequestEditor.tsx`（Body 类型行的语言选择与右侧动作）、`src/components/CurlSnapshot.tsx`（动作行上移与按钮款式）、`src/App.tsx`（环境选择器换成 `Dropdown`，`.env-select` 的 DOM 结构随之变化）、`src/App.css`（新增 `.dropdown*` 与 `.text-action` 样式，移除 `.raw-language` 的 `margin-left: auto`）。
- 无需改动（已核实）：`src/components/ResizeStrips.tsx` 的拖拽排除清单。会话标签行与分隔条共用一个 `isInteractiveSessionBarTarget`（选择器为 `button, select, input, textarea, .env-select, .window-controls`），新下拉的触发器是 `button`、菜单挂在 `.env-select` 子树内，两者都已命中；只有将来改用 portal 渲染菜单才需要回头补。

**后端**：不新增、不修改命令；JSON 格式化是纯前端字符串处理。

**测试**

- `tests/app.test.tsx`：588 / 3395 / 4217 三处按 `.env-select select` 与 `getByLabelText('环境')` 取值，需改为按新的可访问名称或 data-testid 定位。
- `tests/request-editor.test.tsx`：461 / 510 / 513 的 cURL 用例依赖 `curl-regenerate`、`curl-copy` 两个 testid，位置变了之后 testid 保留即可，但需补充 raw 语言选择不再按原生 select 驱动的用例。
- `tests-browser/session-bar-and-tables.spec.ts`：307 行原生 select 的定位器需改写；Minify / Beautify 建议至少补一条「JSON 美化后正文缩进变化、其它语言下按钮不存在」的浏览器用例（涉及真实渲染与布局）。

**依赖与顺序**

- 本机还有一条未完成的 change `simplify-editor-chrome-and-curl-tab`（已 22/23），它与本次改动共用 `App.tsx`、`RequestEditor.tsx`、`CurlSnapshot.tsx`、`App.css` 四个文件。建议先归档那条 change，再落地本提案，避免同一段 JSX 上的两处编辑互相打架。
