## Why

上一版让 console 输出按原文排版（`white-space: pre-wrap`），但"按原文"只对**已经带 `\n` 的文本**有效。实际用起来还有三类日志是一行：

1. **打印结构化值**。`console.log(pm.response.json())` 这类输出走的是紧凑 JSON，一整份响应体挤成一行几百字符，内层换行还被转义成字面量 `\n`，读不出层级。
2. **只带 `\r` 的文本**。HTML 里 `\r` 只是普通空白、不断行；老式 Mac 换行、手工拼出来的日志因此整段挤成一行。
3. **截断提示粘在半行后面**。超长输出截断时，`…（已截断）` 直接接在被切断的那一行尾部，读起来像是正文的一部分。

## What Changes

- **行尾符归一**：`\r\n` 与孤立的 `\r` 一律当换行处理，不让它们变成不可见的空白。
- **结构化参数按长度决定摊不摊开**：对象 / 数组的紧凑形态超过可读长度（80 字符）时改用 2 空格缩进的 JSON，每个字段一行；短对象仍保持一行——`{a:1}` 摊成四行反而更难扫。
- **截断提示独占一行**，不再拼接在被截断的残行末尾。
- **制表符按 2 列排**（`tab-size`），让脚本里手写的 `\t` 对齐不至于跟相邻行对不上。

规格上改一处：`pm-script-runtime` 的「脚本 console 输出的收集与呈现」补上"行尾符归一"、"结构化参数展开"与"截断提示独立成行"三条要求。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `pm-script-runtime`:
  - 「脚本 console 输出的收集与呈现」：在既有"按原文保留换行与缩进"之上，补三条——`\r\n` / `\r` SHALL 按换行呈现；对象与数组等结构化参数 SHALL 在超出一行的可读长度时以缩进形态展开为多行，短小者 SHALL 保持单行；输出被截断时提示 SHALL 独立成行。新增三个场景。

## Impact

- **代码**：`src/lib/scriptRuntime.ts`（`formatConsoleArg` 的文本化策略、新增 `normalizeNewlines` / `truncateConsoleText`）、`src/App.css`（`.script-console li` 的 `tab-size`）。
- **数据**：不改表、不改命令、不改存档；呈现层纯函数，无状态。
- **兼容**：短输出与既有断言完全一致（`{"a":1,"nested":{"b":[1,2]}}` 这类紧凑形态仍在阈值内，保持一行）；`.script-console` 的样式钩子与 `ScriptReport` 的结构未动。
- **测试**：`tests/bridge-protocol.test.ts` 新增「console 输出的换行」五条（换行原样、`\r\n` / `\r` 归一、长对象展开、短对象不展开、截断提示独立成行）。
