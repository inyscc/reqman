## 1. 缩进合并为唯一真源

- [x] 1.1 在 `src/lib/editorAppearance.ts` 把缩进数/缩进类型确立为唯一缩进来源，并提供一个纯函数把「缩进数 + 缩进类型」换算成格式化用的缩进单元（空格串 / 单个制表符）。验证：新增单测覆盖 2 空格、4 空格、Tab 三种取值与 1–8 区间边界，`npm test` 通过
- [x] 1.2 把 `src/lib/sandbox.ts` 的 `prettyJson` / `prettyXml` / `renderBody` 改为吃该缩进配置，删除 `IndentWidth` / `INDENT_WIDTHS` 类型与常量。验证：既有 `sandbox` 单测调整后通过，且新增用例断言 Tab 缩进的输出以制表符开头、每层一个制表符
- [x] 1.3 把 `src/lib/editing.ts` 的 `formatRawBody` 改为接收缩进配置（去掉硬编码的 `null, 2`），`RequestEditor` 的 Beautify 传入当前设置。验证：`tests/editing.test.ts` 的断言按新签名调整后通过，并补一条「缩进类型为 Tab 时 Beautify 以制表符缩进」
- [x] 1.4 让 `indentWidth` 退场：`src/lib/responsePresentation.ts` 删除字段与解析函数、`readPresentation` 不再读该键，`src/components/ResponsePanel.tsx` 改为从编辑器外观取缩进（旧键留在存储中不再读取，是否顺带清理不影响验收）。验证：`tests/response-presentation.test.ts` 调整后通过，`npx tsc --noEmit` 无 `indentWidth` 残留引用
- [x] 1.5 在 `src/components/SettingsPanel.tsx` 删除响应呈现区的「格式化缩进宽度」行。验证：`tests/settings-panel.test.tsx` 断言响应呈现区只剩「响应格式检测」一项、界面上不存在第二处缩进设置

## 2. 折行的取值与持久化

- [x] 2.1 在 `src/lib/editorAppearance.ts` 新增折行项（应用级缺省，缺省开启，含读写、归一与订阅）。验证：单测覆盖缺省值、坏值回落缺省、落库键正确
- [x] 2.2 在 `src/lib/types.ts` 的请求设置里新增折行三态字段（`inherit` / `on` / `off`，可缺省，不迁移），并在呈现解析处提供一个生效值解析函数。验证：单测覆盖 inherit/on/off × 全局开/关 的全部组合
- [x] 2.3 设置模态的编辑器配置区新增「换行」开关（该区由四项变五项），请求编辑器的 Settings 标签页新增「折行」行（三态通用下拉，与「响应格式」同款）。验证：`tests/settings-panel.test.tsx` 与 `tests/request-editor.test.tsx` 用例通过，且请求级改动后该请求呈现未保存状态
- [x] 2.4 在 `src/App.tsx` 解析折行的生效值并向下传，同时提供把某请求的折行设为显式值的回调（写请求草稿）。验证：`tests/app.test.tsx` 新增「改动折行后关闭标签触发未保存守卫」用例并通过
- [x] 2.5 在 `src-tauri/src/storage/model.rs` 为请求级折行新增三态枚举与 `RequestSettings` 字段（含 `Default`），前端 `src/lib/types.ts` 的可选字段与之对齐。验证：`cargo test`（在 `src-tauri` 下执行）通过，且照 `src-tauri/src/storage/requests.rs` 中 `response_format` 的往返先例补一条用例——把折行设为非缺省值保存后读回，字段仍在。**不做这步的后果是：字段在反序列化时被丢弃，用户设的请求级折行会在保存后静默回到「跟随全局」**

## 3. 折行的呈现与两处开关

- [x] 3.1 在 `src/components/CodeSurface.tsx` 新增折行选项，创建路径与外观订阅回调共用同一入口。验证：`tests-browser/code-surface.spec.ts` 新增用例断言折行切换后编辑器的折行选项随之变化，且编辑器未被重建（正文内容与折叠状态不变）
- [x] 3.2 让纯文本降级面跟随折行设置：`src/App.css` 的 `.body` 在 `pre-wrap` / `pre` 之间切换，Hex 视图固定不折。验证：浏览器用例断言大正文降级面的换行行为随开关变化、Hex 面始终不折行
- [x] 3.3 在请求 Body 类型行的动作区新增「折行」开关（对任意 raw 语言都出现，与仅在 JSON 语言下出现的 Minify / Beautify 并存）。验证：`tests/request-editor.test.tsx` 与浏览器用例覆盖「xml 语言下最右端只有折行开关、没有格式化动作」
- [x] 3.4 在响应正文工具条的最右端新增折行开关（图标控件，排在内容类型之后）：由容器 `:hover` / `:focus-visible` 驱动显隐（CSS，不用 React 状态），显形前不接收指针事件，显隐不推动工具条排版，只在 Body 视图出现。验证：浏览器用例覆盖「指针不在响应区时不可见、移入后显现」「键盘聚焦时可见可用」「显隐前后正文区宽度与滚动位置不变」「切到 Headers 后不出现」「点击后该请求呈现未保存状态」
- [x] 3.5 让两处开关在一次发送进行中不响应操作（请求正在发送，改动它不产生任何可见效果）。验证：浏览器用例覆盖「发送中点击开关后折行取值与未保存状态都不变」
- [x] 3.6 确认两处开关与请求 Settings 行是同一份取值：在任一处改动后，另外两处显示同一状态。验证：浏览器用例按「类型行关掉 → Settings 行显示关 → 工具条开关打开 → 两处同时为开」走一遍

## 4. 发送中的响应区反馈

- [x] 4.1 把发送态传给 `src/components/ResponsePanel.tsx`（现在只传通用的忙态），并把响应头「发送中」徽章由忙态改挂发送态。验证：`tests/app.test.tsx` 新增「保存请求时响应头不出现发送中标识」用例并通过，受影响的既有断言同步修正
- [x] 4.2 实现半透明遮罩的两种形态（不摆占位行）：响应区尚无内容时遮罩铺满正文区；已有一份响应时遮罩压在其上、响应在遮罩下仍可辨认且不被清空；发送中**正文工具条**（格式下拉 / 预览 / 折行）不可用但保持可见，而头部标签与「保存全文」照常可用；发送结束（成功 / 失败 / 取消）后立即消失。验证：浏览器用例分别覆盖「首次发送铺满且遮罩半透明、无占位内容」「再次发送旧响应仍在遮罩下」「发送中切到 Headers 照常呈现且不被遮罩」「取消后恢复」四种情形
- [x] 4.3 遮罩色与进度线色进 `:root` token，新增进度线关键帧（顶边一条 2px 线、跑动的那一段 32% 宽、周期 1.4s、用 `transform` 驱动），并在 `prefers-reduced-motion: reduce` 下撤掉跑动的那一段。验证：`App.css` 的 `:root` 之外无新增 hex 字面量（grep 校验），浏览器用例断言进度线贴在正文区顶边、高度不超过 3px、不盖满整行，且在减少动效偏好下遮罩与「发送中」标识仍在、无动画

## 5. 全量验证

- [x] 5.1 类型检查、单测与构建全绿。验证：`npx tsc --noEmit`、`npm test`、`npm run build` 三条命令退出码为 0
- [x] 5.2 浏览器用例全绿（复用本机 Chrome，不下载 Playwright 的浏览器二进制）。验证：`npm run test:browser` 全部通过
- [x] 5.3 规格与实现一致。验证：`openspec validate "unify-indent-wrap-and-send-overlay" --strict` 返回 `valid: true`，且 `code-editors`「等宽面的外观与缩进」/「代码编辑面的折行」、`ui-layout`「折行」/「发送中的响应区反馈」/「设置模态的编辑器与折行配置」的每条场景都有对应用例或明确的人工验证
