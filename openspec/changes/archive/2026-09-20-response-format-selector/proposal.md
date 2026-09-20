# Proposal: response-format-selector

## Why

响应面板当前的呈现方式由内容类型全自动决定：HTML/SVG/Markdown 强制进沙箱预览、格式化仅按检测到的 JSON/XML 自动选择，用户没有任何选择权。当响应包含不可见字符、编码异常或需要换一种视角阅读时（例如把非 JSON 响应强制按 JSON 排版、查看字节级 Hex），用户无从下手。Postman/Insomnia 均提供「自定义选择响应体格式化形式」的能力，这是 API 工具的基线体验。

## What Changes

- 响应面板 Body 工具条：以一个格式下拉（跟随检测 / Raw / JSON / XML / HTML / Hex）替换现有的「原始 / 格式化」双 tab；「原始」即 Raw 选项，概念合并、维度收敛。
- 下拉语义为「强制解释」：所选格式与检测格式不符时尽力解释，解释失败静默回退为原样文本，不报错、不加噪声；检测到的格式在下拉中始终以标记呈现。
- 呈现格式按三层解析：全局设置（Auto / JSON）→ 请求级覆盖（跟随全局 / Auto / JSON，存于请求 settings）→ 响应面板下拉（临时覆盖本次查看，不持久）。
- 全局设置模态新增「响应格式检测：Auto / JSON」与「格式化缩进宽度：2 / 4 / 8 空格」两项配置；格式化固定使用空格缩进，不提供 Tab。缩进宽度作用于 JSON 与 XML 的格式化输出。
- Hex 视图：以「偏移 + 十六进制 + ASCII」三列呈现原始字节。数据链路经核实无需后端改动：非 UTF-8 响应后端已提供 `body_base64`，合法 UTF-8 的「解码字符串 → TextEncoder 再编码」是无损往返，前端组合两者即可得到真实原始字节。Hex 与现有原始视图一致只作用于内联预览前缀。
- 预览角色调整：`planPreview` 从「自动独裁者」降级为「预览开关的执行者」。HTML/SVG 响应默认仍自动进入沙箱预览（保持现有体验），用户可切到下拉中的文本视图（Raw/JSON/HTML 源码等）查看源码。
- 不做：YAML / JavaScript / Markdown 格式化、Base64 视图、深色主题、请求级缩进配置。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `http-engine`: 「响应内容与格式化」需求扩展——呈现格式改为用户可选（含强制解释与失败回退语义）、三层格式解析（全局/请求级/面板临时）、Hex 视图与文本响应字节可用性、格式化缩进宽度可配置。
- `ui-layout`: 新增响应区正文工具条（格式下拉 + 预览切换 + 检测格式标记）的布局要求；设置模态新增响应呈现配置节（格式检测、缩进宽度）；请求 Settings 标签页新增响应格式覆盖项。
- `code-editors`: 「响应正文的只读编辑面与大正文降级」中「原始 / 格式化」切换的措辞更新为格式下拉，行为约束随新模型对齐。

## Impact

- 前端：`ResponsePanel.tsx`（工具条重构、预览开关、Hex 渲染）、`lib/sandbox.ts`（`prettyJson`/`prettyXml` 接受缩进参数、`planPreview` 角色调整）、`lib/types.ts`（`RequestSettings` 增加 `response_format`；设置读写）、`SettingsPanel.tsx`（新增两个全局配置项）、`SettingsEditor`（请求 Settings 标签页新增覆盖项）、ui-polish 通用下拉组件（`Dropdown.tsx`）复用；新增 `lib/responsePresentation.ts` 承载应用级配置与三层解析。
- 后端（Rust）：`storage/model.rs` 的 `RequestSettings` 增加 `response_format`（`ResponseFormatOverride`，缺省 `Inherit`）。实现期发现：serde 默认丢弃未知字段，纯前端字段会在保存时丢失，因此「随请求保存与恢复」必须落到模型上；旧数据经 `#[serde(default)]` 缺省为 `Inherit`，无需迁移。Hex 不需要后端改动（见上）。
- spec：`http-engine`、`ui-layout`、`code-editors` 三处 delta；`storage-foundation`「应用设置持久化」为开放式措辞（「至少包含全局代理配置」），新增应用设置无需改该 spec。
- 兼容性：请求文件新增可选字段 `response_format`（缺省 = 跟随全局），旧数据无需迁移；全局设置缺省 = Auto、缩进 2，与现状行为一致。
