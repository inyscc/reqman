## 1. curl 生成：`-d`、`@` 回退与参数序列

- [x] 1.1 在 `src-tauri/src/interchange/curl.rs` 增加数据体参数 helper：取值以 `@` 开头时产出 `--data-raw`，否则产出 `-d`；raw 正文与 `x-www-form-urlencoded` 两处都改用它（现有 `curl.rs:83`、`:92`）。验证：新增单测覆盖「普通取值 → `-d`」「取值以 `@` 开头 → `--data-raw`」两条，并更新既有断言 `--data-raw` 的三处测试（`:218`、`:292`、`:302`）
- [x] 1.2 给 `CurlCommand` 增加 `parts: Vec<String>`（逐项已 shell-quote 的参数），`command` 保留为多行拼接结果；`curl_command` 同时填两者。验证：新增单测断言 `parts` 与 `command` 的参数序列一致，且 `command` 仍是多行形态（`" \\\n  "` 分隔）
- [x] 1.3 跑 `cargo test` 在 `src-tauri` 下，确认 curl 模块测试全绿

## 2. cURL 正文压缩：设置存储与解析

- [x] 2.1 请求设置新增压缩三态字段（`inherit` / `compress` / `raw`，缺省 `inherit`），Rust 与 TS 两侧的类型都补上并带缺省回落。验证：新增/更新序列化测试，确认旧数据（缺该字段）反序列化后为 `inherit`
- [x] 2.2 新增应用级「cURL 正文压缩」设置键（缺省开启），并在既有的设置读写路径（`src/lib/requestPreferences.ts` 或同级模块 + Rust 侧 setting key）中读取。验证：单测覆盖缺省、显式关、坏值回落缺省
- [x] 2.3 在 `curl_command` 中解析生效值并压缩内嵌 raw JSON 正文——复用 `formatRawBody(text, 'minify')` 的同一实现（Rust 侧对应实现需与前端 `src/lib/editing.ts` 的 `Minify` 结果一致，两者用同一份 JSON 压缩语义）。非 JSON / 解析失败 / 空一律原样。验证：单测覆盖「压缩生效 → 与 Minify 结果一致」「显式不压缩 → 与请求体逐字节一致」「非法 JSON → 原样且无 warning」

## 3. cURL 快照标签的呈现（修订：动作行不放开关）

- [x] 3.1 `src/components/CurlSnapshot.tsx`：动作行只保留「重新生成 / 复制」，**不承载**布局或压缩开关；据此移除 `edited` 与开关相关分支。验证：组件测试断言动作行上不存在布局 / 压缩开关（原 `curl-layout`/`curl-compress` 用例删除）
- [x] 3.2 文本块初值按**生效布局**呈现（取值来源见 8.1/8.2）。验证：组件测试——请求级设为「单行」时文本块为单行，参数与多行完全一致
- [x] 3.3 `src/components/RequestEditor.tsx` 的 Settings 标签新增「cURL 正文压缩」三态行（与「响应格式」「折行」同款行式布局）。验证：组件测试断言三态可选且改动写回请求设置
- [x] 3.4 设置模态新增「cURL 正文压缩」开关项（独立于「编辑器与折行配置」那一节），读写应用级缺省。验证：`tests/app.test.tsx` 或设置面板测试断言开关渲染、改动即持久化且无保存按钮

## 8. 修订：布局升级为两层配置 + 压缩按内容判定

- [x] 8.1 Rust：`RequestSettings` 新增 `curl_line_layout`（`inherit` / `single` / `multi`，缺省 `inherit`）并保持往返；应用级新增 setting key `curl_line_layout`（缺省 `multi`）。验证：serde 缺失回落单测 + 保存-读回单测
- [x] 8.2 前端：`src/lib/requestPreferences.ts` 增加布局缺省（读取 / 写入 / 解析 / 生效值解析）与进程内当前值 + 应用订阅；设置模态新增「cURL 单行」开关；`RequestEditor` 的 Settings 标签新增「cURL 命令布局」三态行
- [x] 8.3 两个入口按**同一份生效布局**拼接 `parts`：请求编辑器的 cURL 标签与导入 / 导出模态。验证：用例——布局设为「单行」时两处均为单行且内容一致
- [x] 8.4 Rust：压缩改按**内容**判定（去掉 `content_type == "application/json"` 这一道门）：预览 JSON 成功即用紧凑形式，失败即原样。验证：单测——语言为 text 的合法 JSON 正文同样被压缩；非法 JSON / 空正文原样且无 warning
- [x] 8.5 受影响的既有用例与 spec 场景同步更新，并跑 `tsc` / `vitest` / `cargo test` / `openspec validate`
- [x] 8.6 cURL 命令文本块**始终软折行**（`white-space: pre-wrap` + `overflow-wrap: anywhere`），不提供折行开关、不跟随「折行」设置（spec: ui-layout「cURL 快照标签」）。验证：真实引擎用例——超长单行命令的文本块不出现横向滚动，且动作行只有两个动作

## 4. 发送态按请求标签隔离，允许多条在飞

- [x] 4.1 `src/App.tsx`：把 `sending` 单槽改为按 tab key 的容器，每项持有自己的 `attemptId` 与取消出口；`openAttempt()` 返回自带取消回调与标志的会话对象，不再写共享 ref（`:385-388`、`:1419-1436`）。验证：`tests/app.test.tsx` 新增用例——A 在飞时切到 B，B 的地址栏呈现「发送」、响应区无遮罩与「发送中」标识
- [x] 4.2 `performSend` 不再置 `busy`，响应与脚本报告仍写回发起它的标签。验证：新增用例——A 在飞时在 B 上发起发送，两条各自推进、各自写回自己的响应
- [x] 4.3 取消入口按会话精确：取消 A 不影响 B；后开的 B 不夺走 A 的取消能力。验证：新增用例——两条在飞，取消其中一条，另一条继续并在结束时正常收尾

## 5. 底栏、错误与脚本门禁的收敛

- [x] 5.1 `src/components/BottomBar.tsx`：状态文案改为由「是否存在在飞发送」派生（由 `App.tsx` 传入派生值），保存/改名不再显示「发送中」。验证：`tests/app.test.tsx` 更新/新增用例——保存进行中状态条不显示「发送中」；有在飞发送时显示「发送中」
- [x] 5.2 发送相关错误（请求失败、脚本错误）按发起它的 tab key 承载并呈现，避免并发串台（spec: ui-layout「请求级错误提示」）。验证：新增用例——A 的发送报错时切到 B，B 不显示该错误，切回 A 仍能看到；并发时 A 的错误不被 B 的结果覆盖
- [x] 5.3 脚本门禁归属到触发它的那条发送，并发时互不覆盖，「允许执行并继续」重发的是触发它的那一条而非当前激活的请求（spec: pm-script-runtime「脚本来源的可执行性门禁」）。验证：新增用例——两条并发发送各自请求确认；在 B 上点「允许执行」继续的是 B，A 的门禁仍待选择

## 6. 关闭在发标签即撤销

- [x] 6.1 关闭标签时若该标签有在飞会话，调用其取消出口并向后端 `cancel_send(attempt_id)`，丢弃结果。验证：新增用例——关闭在发标签后假后端收到对应 `cancelSend` 调用，且该标签被移除、界面不进入错误态

## 7. 回归与收口

- [x] 7.1 跑前端单测（`vitest` 的 `tests/`）与 `cargo test`，确认既有 curl、发送、折行、设置相关用例全部通过（含被本改动更新的断言）
- [x] 7.2 手工核对 spec 场景：`postman-interchange`「导出 curl」、`ui-layout`「地址栏 / 发送中的响应区反馈 / 底部状态条 / cURL 快照标签 / cURL 正文压缩 / 设置模态的编辑器与折行配置」、`http-engine`「请求取消」逐条对应到实现
- [x] 7.3 `openspec validate rework-curl-output-and-send-state` 通过
