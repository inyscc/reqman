# Tasks: response-format-selector

## 1. 纯函数层：格式解释与字节

- [x] 1.1 在 `lib/sandbox.ts` 收拢内容类型嗅探为单一检测函数（JSON/XML/HTML/其他），`responseLanguage` 与格式化共用；现有 `tests/` 单测全部通过
- [x] 1.2 实现 `renderBody(format, detected, body)` 纯函数：强制解释 + 失败静默回退原样；`prettyJson`/`prettyXml` 增加缩进参数（2/4/8，固定空格）；新增单测覆盖解释成功、失败回退、缩进宽度三档（spec: http-engine「响应内容与格式化」「格式化缩进宽度」）
- [x] 1.3 实现 Hex 视图的数据与排版函数：`body_base64 ?? TextEncoder(body_text)` 取原始字节，输出「偏移 + hex + ASCII」三列文本（每行 16 字节，不可打印字符显示 `.`）；单测覆盖 UTF-8、非 UTF-8（base64 通道）、不可见字符三类输入（spec: http-engine Hex 视图场景）

## 2. 全局设置

- [x] 2.1 新增全局设置读写（settings 表新 scope：`format_detection`、`indent_width`），缺省 `auto` / `2`；单测覆盖缺省与往返（spec: ui-layout「设置模态的响应呈现配置」）
- [x] 2.2 `SettingsPanel` 新增「响应格式检测（Auto/JSON）」与「格式化缩进宽度（2/4/8）」配置节，沿用自动落库 + 基线脏判据 + `useEditingSurface` 注册；浏览器测试断言配置持久化与缺省值（spec: ui-layout 配置持久化场景）
- [x] 2.3 设置模态按「不写解释性文案」收敛：删去配置区的段落说明，格式提示改为输入框 placeholder，配置仍由名称与可选值自述；`tests/` 全量通过（spec: ui-layout「设置模态不写解释性文案」）
- [x] 2.4 设置列表改为行式布局：名称在左、控件右对齐且宽度统一、行间细分隔线、长文本项整宽；互斥选项一律换成通用下拉（含策略模式、协议版本、请求级代理模式三个原原生 select），布尔项换成开关；浏览器测试与单元测试全绿（spec: ui-layout「设置列表的行式布局」）
- [x] 2.5 按「语义落在操作上」扫一遍现有文案：删掉自动保存确认与状态行的后果描述（未配置 / 已配置）；关闭证书校验改为危险色开关 + 请求身份行标识，去掉两处解释句子；响应超过格式化阈值改为格式化选项不可选（Dropdown 支持选项级禁用），去掉解释句子（spec: ui-layout「语义落在操作上」）

## 3. 请求级覆盖

- [x] 3.1 `RequestSettings` 增加可选字段 `response_format?: 'inherit' | 'auto' | 'json'`（缺省 `inherit`），类型与默认值函数同步；`tests/` 类型相关用例通过
- [x] 3.2 `SettingsEditor` 增加三选「响应格式：跟随全局 / Auto / JSON」，随 settings 一起 patch；浏览器测试断言覆盖生效与未保存守卫拦截（spec: ui-layout「请求级响应格式覆盖」两场景）
- [x] 3.3 Rust 侧 `RequestSettings` 同步该字段（`ResponseFormatOverride`，`#[serde(default)]` 缺省 Inherit）并断言随请求往返——否则 serde 会把这个前端字段丢掉，「随请求保存与恢复」不成立；Rust 存储往返用例覆盖（spec: ui-layout 请求级覆盖的保存与恢复）

## 4. 呈现链路重构

- [x] 4.1 实现 `resolveInitialFormat(global, request)` 纯函数并单测三种来源的组合（spec: http-engine 三层解析场景）
- [x] 4.2 `ResponsePanel` 用格式下拉（`Dropdown`，扩展 per-option 检测标记口子）替换「原始 / 格式化」双 tab；临时选择随新响应重置为解析值；CodeSurface 语言跟随所选格式，Hex 走独立 `<pre>` 视图（spec: ui-layout「响应区正文工具条」、code-editors delta）
- [x] 4.3 `planPreview` 调整为预览开关的执行者：`preview` state 默认开、仅可预览响应显示开关、关闭或选文本格式时呈现源码；浏览器测试更新既有双 tab 断言并覆盖「检测标记不随强制选择移动」「预览让位给文本视图」（spec: http-engine「预览是开关而非独裁」等场景）

## 5. 集成回归

- [x] 5.1 浏览器端到端：全局设为 JSON → 发送合法 JSON 请求 → Body 初始即格式化；强制选 Hex 查看不可见字符；强制 JSON 对非 JSON 响应静默回退（spec: http-engine / ui-layout 关键场景）
- [x] 5.2 全量回归：`tests/`（vitest）与 `tests-browser/`（本机 Chrome）全部通过；确认 Dropdown 既有测试零回归
