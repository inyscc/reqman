## Why

三处代码编辑面的显示行为与其设置对不上，用户看到的是"改了什么都没反应"：

- **缩进设置看起来是死的**。设置里有两处缩进："编辑器配置区"的「缩进数」「缩进类型」与"响应呈现区"的「格式化缩进宽度」。前者只写给 Monaco 的模型选项（`tabSize` / `insertSpaces`，`src/components/CodeSurface.tsx:41-58`），只决定**按 Tab 时插入什么**与已有 tab 字符的渲染宽度——已有正文一个字符都不会变；后者只作用于响应格式化，且 `JSON.stringify` 的第三参是数字（`src/lib/sandbox.ts:112`），**永远空格、选不到 Tab**。更要紧的是请求正文的 `Beautify` 硬编码 2 空格（`src/lib/editing.ts:24-27`），连「格式化缩进宽度」都不读。于是"改缩进没反应""选 Tab 也没用"在请求、响应两个方向同时成立。
- **代码编辑面不支持折行**。三处 Monaco 面都没有设过 `wordWrap`（`src/components/CodeSurface.tsx:115-135`），长字段只能横向滚；而同一份内容一旦超过降级阈值落到 `pre.body`，反而是自动换行的（`src/App.css:2564`）——同一个响应，大就换行、正常就不换行。
- **发送期间没有进度反馈**。只有响应头一个「发送中…」徽章，而且它挂在被保存请求 / 保存脚本 / 改名共用的 `busy` 上（`src/App.tsx:376-381`）——保存一个请求也会让响应区显示"发送中"。

Postman 的形状可以对照：它的编辑器设置里只有一份缩进（`Indentation count` + `Indentation type`，官方文档 `settings/general-settings.md`），没有第二套"格式化缩进宽度"；折行则是响应区工具条上的一个按钮与请求体的默认行为，不进设置。

## What Changes

- **缩进收敛为一个概念**：设置模态"编辑器配置区"的「缩进数」「缩进类型」成为全应用唯一的缩进真源，同时驱动三件事——Tab 键插入、缩进参考线、**以及 JSON 与 XML 的格式化输出**（请求正文 `Beautify` 与响应的格式化视图）。「格式化缩进宽度」设置项**删除**。
- **BREAKING**：响应格式化输出的缺省缩进由 **2 空格变为 4 空格**（跟随编辑器缺省）。旧键 `response_presentation:indent_width` 不再读取、**不做迁移**——它是纯阅读偏好，把它灌回会驱动编辑面的新值属于语义污染（见 `design.md` D2）。
- **请求正文 `Beautify` 读同一份缩进配置**：`formatRawBody` 不再硬编码 2 空格。
- **新增折行**，三层取值：应用级缺省（设置模态"编辑器配置区"新增「换行」开关，**缺省开启**）→ 请求级覆盖（请求 Settings 标签页新增「换行」行，`跟随全局 / 开 / 关`，随请求保存并计入未保存守卫，与既有「响应格式」同款）→ 响应区**正文工具条最右端**的图标开关（指针悬停响应区才显形），它是请求级值的快捷入口。
- **折行作用面**：请求 raw 正文与响应正文两处编辑面；大正文降级与二进制回退的纯文本面**跟随**该开关；**Hex 视图固定不折**（三列靠空格对齐）；脚本编辑面不在本次范围内。
- **新增发送中的响应区反馈**：正文区覆盖一层**半透明**的灰白遮罩 + 顶边一条进度线（跑马灯，**不摆占位行**）——无旧响应时遮罩铺满，有旧响应时遮罩压在它之上、它在遮罩下仍可辨认；工具条保持可见、控件不可用。触发条件是**发送态**而非通用的「忙」，响应头那个「发送中…」徽章一并从 `busy` 改挂 `sending`。
- **动效边界显式调整**：遮罩半透明、进度线上跑动的那一段克制（单向、周期 ≥1.2s），`prefers-reduced-motion` 下撤掉跑动的那一段（零动画的识别由遮罩、进度线本身与响应头的「发送中」标识承担）。这**显式覆盖** `2026-09-19-rework-visual-system-and-app-chrome` 的 `design.md` 中"发送中的状态切换不加动效"那条基线——它是进度指示而非过渡动画（见 `design.md` D5）。

## Capabilities

### New Capabilities

（无。）

三条线都落在既有的 `code-editors` 与 `ui-layout` 上：折行的渲染行为归 `code-editors`（该能力已经管辖"代码编辑面"的显示行为），设置项、请求级覆盖、工具条上的折行开关与发送反馈归 `ui-layout`（该能力已经管辖设置模态、请求编辑器的 Settings 标签页与响应区工具条）。

### Modified Capabilities

- `code-editors`：
  - 「编辑器外观可配置」→ 修改：缩进数与缩进类型由"只作用于代码编辑面"改为**同时驱动 JSON / XML 的格式化输出**；新增第五项「换行」（应用级缺省）；删除"编辑器缩进不影响格式化输出"场景（与新行为直接冲突，随需求一并改写）；缺省缩进数仍为 4。
  - 新增「代码编辑面的折行」需求：哪些面折行、三层取值如何解析、降级面跟随、Hex 豁免。
- `ui-layout`：
  - 「设置模态的编辑器配置」→ 修改：四项变五项（新增「换行」，布尔开关），删除"该区与响应呈现区的格式化缩进宽度各自独立"一段，删除"两个缩进项互不影响"场景。
  - 「设置模态的响应呈现配置」→ 修改：两项减为一项（只剩「响应格式检测」），删除「格式化缩进宽度」及其持久化场景。
  - 「raw 正文的格式化动作」→ 修改：`Beautify` 按编辑器外观的缩进数与缩进类型重排，不再固定 2 空格。
  - 新增「请求级折行覆盖」需求：请求 Settings 标签页的「换行」行，三态、随请求保存、计入未保存守卫。
  - 新增「响应区的折行快捷开关」需求：停在响应正文工具条最右端、悬停响应区时显形的图标开关，操作的是请求级值。
  - 新增「发送中的响应区反馈」需求：半透明遮罩 + 顶边进度线（跑马灯）、不摆占位行、两种形态、工具条禁用、发送态触发、动效与 reduced-motion 边界。
- `http-engine`：
  - 「格式化缩进宽度」→ **REMOVED**：该设置整体退场，缩进输出改由 `code-editors`「编辑器外观可配置」管辖。

## Impact

**前端**

- `src/lib/editorAppearance.ts`：新增折行项（读写、归一、订阅）；缩进数/类型成为唯一缩进真源。
- `src/lib/responsePresentation.ts`：`indentWidth` 退场，「响应格式检测」保留。
- `src/lib/sandbox.ts`：`prettyJson` / `prettyXml` / `renderBody` 改为吃 `{count, type}`（Tab 时用 `\t` 重复）。
- `src/lib/editing.ts`：`formatRawBody` 接缩进参数（现在硬编码 `null, 2`）。
- `src/components/SettingsPanel.tsx`：响应呈现区减一项，编辑器配置区加一项。
- `src/components/CodeSurface.tsx`：新增 `wordWrap` 选项（创建时与订阅回调同一入口，与字体/缩进同纪律）。
- `src/components/RequestEditor.tsx`：Settings 标签页加「折行」行；Body 类型行动作区加折行按钮（对任意 raw 语言出现，`Minify` / `Beautify` 仍只在 JSON 语言下出现）。
- `src/components/ResponsePanel.tsx`：折行生效值的解析与下发；响应正文工具条最右端的折行开关；发送遮罩；`busy` → `sending`。
- `src/App.tsx`：把 `sending` 传给 `ResponsePanel`（现在只传 `busy`）；折行偏好的启动读取与改动回写。
- `src/App.css`：折行开关、半透明遮罩、进度线关键帧（**本文件第一个 `@keyframes`**）、`pre.body` 折行随开关、`prefers-reduced-motion` 分支。

**后端**：不新增、不修改命令，但**必须改一处数据结构**。缩进两侧都是应用级设置，沿用既有 `settings_get` / `settings_set`；而**请求级折行住在请求的 `settings` 里**：该列由 Rust 的 `RequestSettings` 反序列化后再整包写回（`src-tauri/src/storage/requests.rs:62,82`、`src-tauri/src/storage/proxy_credentials.rs:45`），前端多出的字段会被静默丢弃——用户设的请求级折行会在下一次保存后回到「跟随全局」。因此 `src-tauri/src/storage/model.rs` 需同步新增该字段（三态枚举 + `Default`），与既有的 `ResponseFormatOverride` 同款（`model.rs:542-561, 665, 677`）。`settings` 是 JSON 列，**不需要数据库迁移**；结构体已带 `#[serde(default)]`，旧行照常读入。折行取值会随导入导出整包往返（`src-tauri/src/interchange/export.rs:123`、`import.rs:250`），与 `response_format` 同等。

**测试**

- `tests/editing.test.ts:111`：`Beautify` 断言写死两空格缩进，改为按传入的缩进配置断言。
- `tests/response-presentation.test.ts`：`indentWidth` 的读写断言随字段退场调整。
- `tests/settings-panel.test.tsx:52-97`：编辑器配置区的项数与「缩进类型」定位不变；补「折行」行的断言。
- `tests-browser/response-format-selector.spec.ts:388-420`：缩进宽度那条用例改写为"改编辑器缩进数即改变响应格式化输出"，期望值从 2 空格变 4 空格。
- `tests-browser/editor-appearance.spec.ts:280-409`：编辑器配置区项数、两缩进项的独立性断言改写。
- `tests-browser/code-surface.spec.ts:223-253`：`tabSize` / `insertSpaces` 的断言保留，补折行选项的用例。

**依赖与顺序**：不新增 npm 依赖，不新增字体文件。当前仓库无在飞的 change（`openspec list` 为空），不存在与其他 change 争用同一段 JSX 的冲突。
