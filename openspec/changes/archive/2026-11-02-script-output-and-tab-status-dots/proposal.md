## Why

脚本跑完之后，用户只能得到"跑过了"这个结论，拿不到可扫读的状态与可读的输出：

1. **console 输出被压成一行**。`console.log` 打印一段多行文本、或一个对象（`JSON.stringify` 带缩进）时，换行与缩进在界面上全部折叠，几行 JSON 连成一长串，读不出结构——脚本 console 本来就是用来读这些的。
2. **测试结果要点开才知道**。断言写在「脚本」标签页里，标签页外没有任何提示——一次发送后是"全绿"还是"挂了一条"，必须先点进标签才看得见。
3. **请求写了脚本也没有任何信号**。请求编辑器外层的 Scripts 页签与其它页签长得一样，脚本藏在一个不点开就看不见的地方；集合面板的「脚本」页签早有绿点，请求侧没有。

## What Changes

- **console 输出按原文换行**：多行文本保留换行与缩进，超长单行在容器内折行；输出按等宽呈现，多行 JSON 的缩进才对得齐。
- **响应区「脚本」页签的结果点**：该次发送有测试断言时，页签上显示一个状态点——全部通过为绿色、任一失败（含脚本抛未捕获错误）为红色；只有 console 输出、没有任何断言时不点。
- **请求编辑器 Scripts 页签的已配置绿点**：请求的前置或后置脚本有非空白内容时，页签上显示一个绿点，输入即时反映；纯空白不算。

规格上两处新增：`pm-script-runtime` 的 console 呈现要求补上"换行与缩进不得折叠"；`ui-layout` 新增一条「页签上的状态点」，把三类页签标记（请求 Scripts、集合面板脚本页签、响应区脚本页签）的口径写在一处——同一个视觉信号，三种含义各说清楚。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `pm-script-runtime`:
  - 「脚本 console 输出的收集与呈现」：输出 SHALL 按原文保留换行与缩进，SHALL NOT 把多行输出折叠为一行；超长单行 SHALL 在容器内折行。新增「多行输出保留换行」场景。
- `ui-layout`:
  - 新增「页签上的状态点」：请求编辑器 Scripts 页签的"已配置"绿点（按草稿判定、输入即时生效、纯空白不算）、集合面板脚本页签既有的同类标记，以及响应区脚本页签的"结果点"（全通过绿 / 有失败红 / 无断言不点）。每个点 SHALL 带可供辅助技术读取的名称，SHALL NOT 只靠颜色或额外文字标签表达。

## Impact

- **代码**：`src/components/ScriptReport.tsx`（console 容器挂 `.script-console`），`src/components/ResponsePanel.tsx`（结果点及其判定），`src/components/RequestEditor.tsx`（Scripts 页签的已配置点），`src/App.css`（`.tab .tab-dot`、`.script-console`）。
- **数据**：不改表、不改命令、不改存档。两个点都是纯视图态，状态由既有字段（`pre_request_script` / `test_script`、`TestAssertion[]`、脚本阶段错误）即时算出，不额外持久化。
- **兼容**：既有页签的名称与点击行为不变，圆点只是附加节点；既有测试读的 `脚本` / `Scripts` 文本仍可按名取到。
- **测试**：新增 `tests/response-panel.test.tsx`（结果点六种情形 + console 多行）；`tests/request-editor.test.tsx` 追加「Scripts 页签的已配置标记」四条。
