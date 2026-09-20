# http-engine Delta

## MODIFIED Requirements

### Requirement: 响应内容与格式化

系统 SHALL 提供响应的多种呈现格式，至少包括：跟随检测、Raw（原样文本）、JSON、XML、HTML（源码）与 Hex（字节视图），用户 SHALL 可对每个响应在其中选择。系统 SHALL 保留预览这一查看方式：HTML 与 SVG 响应 SHALL 提供沙箱预览，且预览 SHALL 以显式开关呈现（默认开启）而非强制替代文本视图。查找、复制与下载 SHALL 可用。

格式选择 SHALL 按「跟随检测 / Raw / JSON / XML / HTML / Hex」解释响应正文：所选格式能够解释时按该格式呈现，SHALL NOT 因解释失败而报错——失败时 SHALL 回退为原样文本呈现。检测到的格式 SHALL 始终以标记呈现（不受用户强制选择影响）。

呈现格式的生效值 SHALL 按三层解析：应用级「响应格式检测」设置（Auto 或强制 JSON）为默认层；请求级设置可覆盖全局（跟随全局 / Auto / JSON）；响应面板上的格式下拉为本次查看的临时覆盖（不持久）。请求级与面板下拉 SHALL NOT 写回任何持久配置。

Hex 视图 SHALL 以「偏移 + 十六进制 + ASCII」三列呈现响应的原始字节，SHALL 与原始视图同样只作用于内联预览前缀；原始字节的取得 SHALL NOT 依赖有损的转码近似（非 UTF-8 响应以后端提供的 base64 字节为准，合法 UTF-8 响应的解码-再编码往返视为无损）。

#### Scenario: JSON 格式化

- **WHEN** 呈现格式为 JSON 且响应正文为合法 JSON
- **THEN** 正文以缩进结构呈现，切回 Raw 时仍显示未格式化文本

#### Scenario: 强制解释失败回退

- **WHEN** 用户把一个非合法 JSON 的响应强制选为 JSON 格式
- **THEN** 界面原样显示正文，不出现错误提示，且格式下拉中的检测格式标记仍指向真实检测到的格式

#### Scenario: 三层解析

- **WHEN** 全局设置为 Auto、某请求覆盖为 JSON、用户又在面板下拉临时选择 Hex
- **THEN** 该响应本次以 Hex 呈现；移除临时选择后初始格式回到请求级的 JSON；移除请求级覆盖后回到全局 Auto

#### Scenario: 面板选择不持久

- **WHEN** 用户在下拉中临时选择 Hex 后发送新的请求
- **THEN** 新响应的初始格式按全局与请求级解析，不沿用上一次的临时选择

#### Scenario: Hex 视图

- **WHEN** 用户对一个文本响应选择 Hex 格式
- **THEN** 界面以偏移、十六进制与 ASCII 三列呈现该响应的原始字节，不可见字符在此视图中可辨识

#### Scenario: 预览是开关而非独裁

- **WHEN** 响应为 HTML 且用户关闭预览开关、选择 Raw 或 HTML 格式
- **THEN** 正文以源码文本呈现，HTML 中的标记不渲染为页面结构

#### Scenario: 结构与原文一致

- **WHEN** 用户查看非文本类型的响应
- **THEN** 系统以适合该类型的方式呈现，且不改变原始内容的可获取性

## ADDED Requirements

### Requirement: 格式化缩进宽度

系统 SHALL 提供应用级的格式化缩进宽度设置，可选值为 2、4 或 8，SHALL 固定使用空格缩进且 SHALL NOT 提供 Tab 选项；缺省值为 2。该设置 SHALL 同时作用于 JSON 与 XML 的格式化输出。

#### Scenario: 修改缩进宽度生效

- **WHEN** 用户把缩进宽度从 2 改为 4，随后查看一个 JSON 响应的格式化视图
- **THEN** 缩进以 4 个空格呈现

#### Scenario: 不提供 Tab

- **WHEN** 用户打开缩进宽度设置
- **THEN** 可选项只有 2、4、8 三个空格宽度，不存在 Tab 或「跟随编辑器」之类的选项
