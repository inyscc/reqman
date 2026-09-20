# Design: response-format-selector

## Context

现状与动机见 proposal.md。实现侧关键事实（已核实）：

- 呈现链路：`ResponsePanel` 用 `planPreview`（`lib/sandbox.ts`）决定 text/iframe/image/binary，文本路径再按 `pretty` 布尔叠加 `prettyBody`（JSON/XML 自动检测格式化）。
- 后端 `src-tauri/src/net/mod.rs`：`body_text` 是对内联预览前缀的**严格** UTF-8 解码（`String::from_utf8(...).ok()`）；解码失败时 `body_base64` 给出同一前缀的 base64。因此前端用 `body_base64 ?? TextEncoder.encode(body_text)` 恒可取得真实原始字节——合法 UTF-8 的解码-再编码是无损往返。**Hex 不需要后端改动。**
- 设置基建：`settingsGet/settingsSet` 具名命令（scope + key），分栏比例（`lib/layout.ts`）、会话标签（`lib/sessionTabs.ts`）、`pm.sendRequest` 策略（`lib/scriptRuntime.ts`）都走这条路。设置模态 `SettingsPanel` 已有自动落库与未保存守卫的完整纪律。
- 请求级设置：`SavedRequest.settings`（`RequestSettings`），Settings 标签页由 `RequestEditor` 内的 `SettingsEditor` 承载，已计入未保存守卫与「重启后完整恢复」（storage-foundation）。**注意**：Rust 侧 `RequestSettings`（`storage/model.rs`）是定长结构体、没有兜底字段，serde 会丢掉未知字段——纯前端新增的字段存不下去。实现期据此补了后端字段（见 D8）。
- 通用下拉：`components/Dropdown.tsx`，spec: ui-polish「通用下拉的观感与菜单行为」；请求体语言选择已在用。原生 `<select>` 被该 spec 禁止。
- 浏览器测试基建：`tests-browser/`（Playwright，复用本机 Chrome）；单元测试 `tests/`。

## Goals / Non-Goals

**Goals:**

- 用户对响应呈现格式有最终选择权，且强制解释失败不产生噪声。
- 三层格式解析（全局 → 请求级 → 面板临时）各司其职、可独立回退。
- Hex 视图呈现真实原始字节，纯前端实现。
- 缩进宽度全局可配，固定空格。

**Non-Goals:**

- YAML / JavaScript / Markdown 格式化、Base64 视图。
- 请求级缩进配置（缩进是个人阅读偏好，全局一层足够）。
- Hex 视图覆盖完整大正文（与原始视图一致，仅内联预览前缀；完整内容走「保存全文」）。
- 后端改动。

## Decisions

### D1. 「原始 / 格式化」双 tab 合并为一个格式下拉

`pretty: boolean` 替换为 `format: 'auto' | 'raw' | 'json' | 'xml' | 'html' | 'hex'`。`raw` 就是原「原始」，`auto`（跟随检测）就是「格式化但按检测选择器」的泛化。备选方案是保留双 tab 另加格式下拉——否决，因为「原始」与「Raw」是同一概念，两个维度会产生说不清的状态组合（原始 tab + 强制 JSON 同时成立是什么？）。

### D2. 强制解释的执行点放在纯函数层

新增一个纯函数（如 `renderBody(format, detected, body)`，落点 `lib/sandbox.ts`），输入所选格式、检测格式与正文，输出 `{ view: 'text' | 'hex', language, text }`。解释失败（如 JSON.parse 抛错）在函数内回退为原样文本，不外抛。检测格式的判定逻辑复用现有 content-type 嗅探（`responseLanguage`/`prettyBody` 的分支收拢为一处），供下拉勾标与解释共用。单元测试围绕这个函数写，不依赖 UI。

### D3. 三层解析函数 + 各层存储

解析顺序：请求级 `response_format` → 全局设置 → `auto`。

```
resolveInitialFormat(global: 'auto'|'json', request: 'inherit'|'auto'|'json')
  -> 'auto' | 'json'    // 面板初始值；'hex' 等只能来自临时下拉
```

- 全局设置：settings 表新增 scope（如 `response_presentation`），两个 key：`format_detection`（`'auto' | 'json'`）、`indent_width`（`2 | 4 | 8`）。读写经具名命令，与 layout/sessionTabs 同纪律。
- 请求级：`RequestSettings` 增加可选字段 `response_format?: 'inherit' | 'auto' | 'json'`，缺省/缺失 = `inherit`。旧请求数据无需迁移；postman-interchange 导入不受影响（非标准字段，导入器忽略未知字段即可）。
- 面板临时选择：`ResponsePanel` 的组件 state，新响应到达时重置为解析结果（现有 `pretty` state 本就随响应刷新，行为连续）。

### D4. Hex 纯前端，字节来源双通道

`rawBytes = body_base64 ? atob→Uint8Array : TextEncoder.encode(body_text)`。论证见 Context：这条组合恒为真实字节。Hex 渲染为 `<pre>`（非 Monaco——code-editors delta 已明确 Hex 不用富代码编辑器），每行 16 字节：偏移（8 位十六进制）+ hex 列 + ASCII 列（不可打印字符显示 `.`）。仅处理内联预览前缀，与原始视图边界一致；`truncated` 的既有提示已覆盖「只见前缀」的告知。

### D5. `planPreview` 降级为预览开关的执行者

`ResponsePanel` 增加 `preview: boolean`（默认 true）。呈现分派变为：

```
previewable(content_type) && preview && format === 'auto'  -> SandboxedPreview
format === 'hex'                                            -> HexView
其余                                                        -> 文本路径（D2 的输出）
```

备选：保持 planPreview 全自动、格式下拉只作用于非预览内容——否决，会出现「预览盖着、选了 JSON 却看不见」的怪状态。注意 Markdown 响应：不在格式集合里，`format === 'auto'` 时沿用现有 iframe 行为，Raw 时显示源码文本，与 HTML 同一条路径。

### D6. 缩进宽度参数化

`prettyJson(body, indent: 2|4|8)` 与 `prettyXml(body, indent)`（内部 `' '.repeat(indent)`）。调用点从全局设置读取当前值。固定空格、不提供 Tab 是产品决策（用户明确要求），不是技术限制。

### D7. UI 落点

- 工具条：`response-view-bar` 内以 `Dropdown`（通用下拉）替换双 tab；勾标用 Dropdown 现有的「当前选中项标记」机制区分「当前值」与「检测格式标记」（检测标记需要一个新的、可选的 per-option 装饰口子，这是对 Dropdown 的小扩展）。
- 设置模态：`SettingsPanel` 新增一节，沿用其自动落库 + 基线脏判据 + `useEditingSurface` 注册的既有纪律。
- 请求 Settings：`SettingsEditor` 增加一项三选（跟随全局 / Auto / JSON），随 `settings` 一起 patch，守卫自动覆盖。

### D8. 请求级字段必须落到 Rust 模型上（实现期发现）

原影响面评估漏了一条：`RequestSettings` 在 Rust 侧是定长结构体（`#[serde(default)]`，无 `flatten`/`extra` 兜底），未知字段在反序列化时被丢弃、序列化时不再出现。因此只改前端的话，`response_format` 会在「保存 → 重开」后消失，与 spec 的「随请求一并保存与恢复」直接冲突。

决策：在 `storage/model.rs` 增加 `ResponseFormatOverride { Inherit, Auto, Json }`（缺省 `Inherit`）并挂到 `RequestSettings`。备选是加一个 `serde_json::Value` 兜底袋——否决，它会把「未知字段一律保留」变成全局约定，掩盖后续同类遗漏；显式字段让每一次新增都被迫经过类型定义。旧数据无需迁移（`#[serde(default)]`）。

## Risks / Trade-offs

- [Dropdown 扩展勾标侵入既有组件] → 装饰做成可选 prop，无消费方时零影响；现有 Dropdown 测试全量回归。
- [大前缀的 Hex 字符串膨胀（每字节约 3–4 字符）] → 前缀本身受 `INLINE_PREVIEW_LIMIT` 约束（MB 量级以内），`<pre>` 承载可控；实现时以实际前缀上限复核，必要时对 Hex 视图再设渲染上限并提示。
- [全局 JSON 档 + 面板临时选择的状态歧义] → 面板下拉的当前值永远显示「生效值」，检测标记显示「检测值」，两层信息分开表达；解析函数为纯函数并单测覆盖三种来源的组合。
- [`response_format` 字段泄漏进导出/ interchange 比对测试] → 导出序列化走既有 settings 通道，若快照比对受影响，更新对应快照而非加特判。
- [Markdown/HTML 自动预览行为的既有浏览器测试依赖双 tab 文案] → `tests-browser` 中相关用例随工具条重构一并更新，断言改为对下拉值与预览开关状态的断言。

## Migration Plan

无数据迁移：新字段全部可选、缺省值复刻现状（Auto、缩进 2、预览默认开）。回滚即还原前端代码；settings 表里的新 scope 键残留无害。

## Open Questions

（无——Hex 字节链路已在规划期核实，其余决策均已在探索对话中与用户确认。）
