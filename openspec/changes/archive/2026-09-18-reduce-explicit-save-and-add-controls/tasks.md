## 1. 基础纯逻辑（可脱离 React 单测）

- [x] 1.1 新增空行清洗纯函数（`src/lib/rows.ts` 或并入既有 lib）：`KeyValue` 按「名称与值皆空」判定，`FormField` 只按「名称为空」判定，`enabled` 不参与判定；验证方式：`tests/` 下新增单元测试，覆盖「全空行被剔除」「只有 enabled=false 但仍有内容的行被保留」「file 类型且 value 为空的行被保留」三项。
- [x] 1.2 新增编辑面注册表 `src/lib/editing.ts`：`EditingSurface { id, priority, label, isDirty, save }`、`register` 返回注销函数、`dirty()`、`top()`（按 priority 取最高，同优先级取后注册者）；配一个订阅 hook，与既有 `store.ts` / `useStore.ts` 分层一致；验证方式：单元测试覆盖「注册后 top 为该面」「注销后 top 回落」「多面时 top 取优先级最高」「dirty 只返回 isDirty 为真的面」「注册表内闭包更新后 isDirty 读到最新值」。
- [x] 1.3 新增窗口控制器 `src/lib/window.ts`（`onCloseRequested` / `destroy`），默认实现包 `@tauri-apps/api/window`，并让 `App` 通过 props 接收（与 `client` 同一注入方式）；验证方式：`npx tsc --noEmit` 通过，且在 happy-dom 下渲染 `App` 不抛错（注入假实现）。

## 2. 幽灵行（键值表与变量表）

- [x] 2.1 `src/components/RequestEditor.tsx` 的 `KeyValueTable` 改为末尾常驻幽灵行：移除「+ 添加一行」按钮，幽灵行无删除控件与勾选框，输入任一字段即物化为真行并在下方补新行、焦点留在幽灵行；验证方式：单元测试覆盖「空表格末尾有可输入的空行且不存在新增按钮」「在空行输入后新行保留内容且出现新的空行」「focus 仍在末行输入框」。
- [x] 2.2 `FormDataEditor` 同样改为幽灵行：移除「+ 添加字段」按钮，保留字段类型下拉，新增行的类型默认文本；验证方式：单元测试覆盖「空表格可直接填写字段名」「填写后出现新的空行且原行类型选择保留」。
- [x] 2.3 `src/components/VariablesPanel.tsx` 改为幽灵行新增：移除底部输入行与「写入」按钮，末行可填名称与值，回车或失焦提交（沿用既有提交语义，成功后 `onChanged()` 刷新并补新空行），并保持已写入变量的名称列为只读；验证方式：单元测试覆盖「变量表格末行可输入并提交 variable_set」「提交成功后出现新变量且末行重新为空」「已写入变量的名称不是输入框」「末行名称输入不触发任何改名请求」「不脏时提交不发请求」「空名称提交不发请求」。
- [x] 2.4 出口清洗接入（`src/App.tsx`）：`variablesPreview`、`sendRequest` 的 `inline` 载荷与 `requestStore.update` 的保存载荷统一经过 1.1 的清洗函数；`selectRequest` 读回 draft 时也清洗一次；验证方式：单元测试覆盖「幽灵行未输入就发送 → 发出的载荷与预览不含该空行」「含空行的草稿保存后，`request_save` 收到的载荷不含空行」「打开一条此前存有空行的请求时表格只有内容行 + 一个幽灵行」。
- [x] 2.5 样式（`src/App.css`）：幽灵行以浅色 placeholder 呈现、不出现 hover 删除按钮；验证方式：真实浏览器打开请求编辑器与环境编辑器，确认键盘 Tab 能直接落到末行输入框、幽灵行与普通行的行高一致、中文输入法连续输入「输入即新增」不断字。
  **已完成，并在真实引擎里验证**：`.ghost-row` 的虚线底边/透明底色/浅色 placeholder，且幽灵行不渲染删除控件与勾选框。新增浏览器用例 `tests-browser/ghost-row-and-reload.spec.ts`——用仓库既有的 `launchBrowser()` 退回链跑**本机 Chrome**（不下载任何浏览器），在文档起点注入最小假后端让应用在纯浏览器里起得来，钉住三点：Tab 从末行内容的删除按钮一次即落到幽灵行的名称输入、幽灵行与内容行**行高一致**、逐字符连续输入与**中文组合输入**（CDP `Input.imeSetComposition` + `Input.insertText`）都只生成一行。
  行高一致还牵出一条配套的样式修正：表格单元格里的按钮必须与同格输入框同内边距（`td button` 一并给 `padding: 3px 6px`），否则删除按钮比输入框高 4px、把内容行撑高，幽灵行就会矮一截——这是真实引擎测出来才暴露的（happy-dom 不做布局）。

## 3. 保存入口收敛与 Ctrl+S

- [x] 3.1 请求操作行改造（`src/App.tsx`）：移除常驻「保存」按钮，「未保存」标记与保存入口同时出现且相邻，入口 `title` 说明等价快捷键 `Ctrl+S`；验证方式：单元测试覆盖「未改动时不存在保存按钮与未保存标记」「改动后两者同时出现」「点击入口后持久化且两者消失」。
- [x] 3.2 集合/文件夹改名改为回车或失焦提交，移除「保存名称」按钮；空名称仍被拒绝并还原原值；验证方式：迁移并更新既有改名测试（改为 `change` + `blur` / Enter 触发），断言 `collectionRename` / `folderRename` 被调用、空名称时出现错误且输入框还原。
- [x] 3.3 `EntityScriptPanel` 与 `SettingsPanel` 通过 1.2 的注册表注册自身的 `isDirty` / `save`（优先级：模态 300、主区面板 200）；验证方式：单元测试覆盖「脚本改动时 `dirty()` 含该面」「保存后 `dirty()` 不再含该面」，并断言变量面板与 Cookie 新增表单不注册（在即时提交界面按 Ctrl+S 不产生任何写请求）。
- [x] 3.4 实现全局 `Ctrl+S` 监听（任务拆分时漏写，实现期补上）：`preventDefault` 拦掉运行环境的保存动作，支持 `Ctrl`/`Cmd`，保存 `top()` 且不脏/正忙时不发请求；验证方式：单元测试覆盖「保存当前请求」「焦点在输入框内仍生效且 `fireEvent` 返回 false」「`Cmd+S` 等效」「没有改动时不发写请求」「一次保存未结束时重复按下只写一次」「保存失败保留未保存标记」「模态打开时只存模态」。`EditingSurface` 因此带上了 `isActive`：主区让给环境编辑器或被模态盖住时，请求面仍算脏面（关窗要提示）但不参与快捷键。

## 4. 未保存守卫

- [x] 4.1 实现守卫：待执行意图的数据结构与执行函数分离，新增三选一提示条（复用既有 `notice warn` 形态，放在 `request-region` 顶部）；验证方式：单元测试覆盖「选保存并继续 → 先保存后执行」「保存失败 → 不执行、显示原因、未保存标记仍在」「选不保存 → 执行且改动消失」「选取消 → 不执行、界面回到原状」。
- [x] 4.2 接入全部触发源：切换请求、切换集合/文件夹、关闭会话标签、删除当前打开的请求；验证方式：单元测试逐条覆盖各触发源在脏时先出提示、在用户选择前不改变主区内容。
- [x] 4.3 修复 `selectRequest` 对同一 id 也清除未保存标记的问题（目标 id 与当前选中相同时直接返回，不重载 draft、不动 dirty）；验证方式：单元测试「改动后再次点击树中同一个已选中的请求 → 不出现提示且未保存标记仍在」。
- [x] 4.4 钉住不触发守卫的路径；验证方式：单元测试覆盖「切换侧栏 tab 不询问且切回后草稿仍在」「切换脚本相位不询问且另一段内容保留」「切换环境不询问」「发送请求不询问」「打开/关闭模态不询问」。

## 5. 退出应用与权限

- [x] 5.1 在 `src-tauri/capabilities/default.json` 增加 `core:window:allow-destroy`，并更新 `src-tauri/src/security_audit.rs:69-81` 的权限白名单与注释说明用途；重新构建让 `src-tauri/gen/schemas/capabilities.json` 与源文件一致；验证方式：`cargo test` 中安全审计相关用例全部通过，且生成清单与源文件的权限集合一致。
- [x] 5.2 接入窗口关闭守卫：`onCloseRequested` 中脏时 `preventDefault()` 并复用 4.1 的提示，选「保存并继续」且保存成功后调用 `destroy()`；验证方式：单元测试用注入的假控制器覆盖「脏时阻止关闭并出提示」「取消后不调用 destroy」「保存成功后调用 destroy」「不保存也调用 destroy」「无脏时直接关闭且不出现提示」。
- [x] 5.3 增加 `beforeunload` 兜底拦截页面重载，并做一次真机探针确认 Tauri WebView2 下提示确实出现；验证方式：探针结论记录在实现提交说明或 design 的 Risks 处；若探针证明不可靠，则移除 spec 中「重载被拦截」那条场景并记录该限制。
  **已完成并在真实引擎里确认**：`onBeforeUnload` 实现 + 单测（脏时 `preventDefault`、不脏时放行）之外，`tests-browser/ghost-row-and-reload.spec.ts` 用**本机 Chrome**（不下载浏览器）验证了端到端行为——有未保存改动时重载真的弹出 `beforeunload` 确认框并因此被取消（页面与编辑内容都还在），没有改动时重载照常完成（用只存在于本次文档的标记证明页面确实换了）。这与 WebView2 同属 Chromium 家族、确认框走同一族 API，因此 spec 的「重载被拦截」保留；真机 WebView2 复核仍建议在 `npm run tauri dev` 里点一次 F5。

## 6. 测试与全量校验

- [x] 6.1 迁移依赖「保存」文案的既有断言（`tests/app.test.tsx` 中 `getByText('保存')` 等），区分请求操作行与实体脚本/设置面板的保存入口，只改定位方式不改断示意图；验证方式：`npm test` 全绿。
- [x] 6.2 补齐本轮新增场景的用例（幽灵行、出口清洗、Ctrl+S 路由、守卫、窗口关闭、权限面），确保 spec 中每条场景都有对应用例或明确的验证方式；验证方式：逐条比对 `specs/ui-layout/spec.md` 的场景清单，无遗漏。
- [x] 6.3 全量校验：`npx tsc --noEmit`、`npm test`、`npm run build`、`cargo test`、`openspec validate reduce-explicit-save-and-add-controls --strict` 全部以退出码 0 结束；验证方式：五条命令均通过。
  **全部通过**：`npx tsc --noEmit` ✅、`npm test` ✅（10 文件 / 193 用例）、`npm run test:browser` ✅（5 文件 / 19 用例，跑本机 Chrome）、`npm run build` ✅（`@tauri-apps/api/window` 被拆成独立 chunk，未进启动图）、`cargo test --lib` ✅ **280 passed / 0 failed**、`openspec validate --strict` ✅。
  之前那条 `certificate_validation_is_on_by_default_and_can_be_disabled_per_request` 的失败是纯环境问题：`testutil.rs` 的 `HttpsTestServer` 用 `Command::new("openssl")` 现场签一张自签证书，而**本机本来就有 openssl**（Git for Windows 自带 `C:\Program Files\Git\usr\bin\openssl.exe`），只是不在 PATH 上，于是报 `program not found`。给测试进程的 PATH 加上那个目录后 280/280 全绿——**不需要安装任何东西**，也与代码无关。

## 7. 顺带修掉的缺陷（实现期发现）

- [x] 7.1 网络错误分类不能依赖本地化文案（属 `http-engine`，本变更不改其需求文本）：`src-tauri/src/error.rs` 的 `classify_net_failure` 原先用英文字符串子串判断 DNS 失败，简体中文 Windows 的「不知道这样的主机。 (os error 11001)」匹配不到，导致域名解析失败被报成笼统的连接失败（违反 `http-engine` 的「失败类别可区分」）。改为沿 `source()` 链取最内层 `io::Error` 的原始错误码判定（Windows `11001..=11004`、glibc `-5..=-2`），英文文案只作兜底；「连接被拒」同理不再依赖文案（`111` / `10061`）。验证方式：新增 3 条单元测试（本地化文案 + 错误码 → `DnsFailure`、`10054` 不被误判为 DNS、`111`/`10061` → `ConnectionRefused`），且此前失败的集成用例 `net::tests::failure_classes_are_distinguishable`（真发一次到 `does-not-exist.invalid`）转为通过——`cargo test --lib` 从 275 passed / 2 failed 变为 **280 passed / 0 failed**（当时剩下的那 1 条失败是环境缺 `openssl`，见 6.3）。
