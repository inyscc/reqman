# Tasks

## 1. 文本化：行尾符与结构化值

- [x] 1.1 `src/lib/scriptRuntime.ts`：新增 `normalizeNewlines`，`formatConsoleArg` 对字符串参数与 `String()` 兜底结果都做 `\r\n?` → `\n` 归一（D1）。验证：`tests/bridge-protocol.test.ts`「console 输出的换行」的「字符串里的换行原样保留」「\r\n 与孤立的 \r 都折成 \n」。
- [x] 1.2 `src/lib/scriptRuntime.ts`：对象 / 数组先取紧凑形态，超过 `CONSOLE_INLINE_LIMIT`（80）改用 `JSON.stringify(value, null, 2)`；短对象保持一行（D2）。验证：同上的「超出可读长度的对象摊成缩进 JSON」「短对象仍是一行」。
- [x] 1.3 `src/lib/scriptRuntime.ts`：新增 `truncateConsoleText`，按最终形态截断，提示以 `\n…（已截断）` 独占一行（D3）。验证：同上的「截断提示独占一行」。

## 2. 呈现层

- [x] 2.1 `src/App.css`：`.script-console li` 增加 `tab-size: 2`（D4）。验证：规则存在且未改动既有的 `white-space: pre-wrap` / `overflow-wrap: anywhere`（人工确认制表符对齐）。

## 3. 集成校验

- [x] 3.1 短输出的既有断言不变：`console.log({a:1,nested:{b:[1,2]}}, [1,2], 42)` 仍是紧凑形态（`tests/bridge-protocol.test.ts` 的「console 的对象参数按结构呈现…」未改）。
- [x] 3.2 类型检查与全量测试：`npx tsc --noEmit` 退出码 0；`npx vitest run` 626 条全绿（本 change 新增 5 条）。

## Workflow follow-up

- 归档本 change，并把 `pm-script-runtime` 的 delta 合并进主规格。
