## Context

动机见 `proposal.md`。设计只需知道下面这几条现状：

- **字体写死在两处、且不一致**。`src/App.css:87-89` 的 `--font-mono` 是系统等宽栈（注释写明「离线优先，不引入字体文件、不挂 CDN」），字号走 `--text-sm: 12px`（`.body` 等纯文本面，`src/App.css:2489-2495`）；而 `src/components/CodeSurface.tsx:87,93` 里 Monaco 写死 `fontSize: 13` / `tabSize: 2`，且**没有设 `fontFamily`**——走 Monaco 自己的平台默认（Windows 为 `Consolas, 'Courier New', monospace`）。
- **同一份正文有两条渲染路径**。`renderBody` 除 hex 外一律返回 `view: 'text'`，`ResponsePanel.tsx:362-389` 只在「二进制回退」与「正文超过 `CODE_SURFACE_MAX_BYTES`」两条分支用 `pre.body`，其余交给 `CodeSurface`。于是同一份 JSON 会因为体积大小在 12px / 13px 之间跳。
- **编辑器是懒加载的 Monaco 薄壳**。`CodeSurface` 的创建效应只依赖 `uri`（`CodeSurface.tsx:123`），三处调用点分别在 `RequestEditor.tsx` / `ScriptPane.tsx` / `ResponsePanel.tsx`（另有一处 dev harness）。
- **Monaco 的字体是选项驱动的，不是 CSS 驱动的**。`node_modules/monaco-editor/esm/vs/editor/browser/domFontInfo.js` 由配置推算出 `fontInfo` 后直接写进 DOM（`domNode.setFontFamily(...)`），字宽度量走 canvas（`glyphRasterizer.js:55` 用选项里的 `fontFamily`）。所以改 `:root` 上的 CSS 变量对编辑器无效。
- **设置落库是通用键值命令**。`settings_get` / `settings_set` 接受任意 `(scope, key)`（`src-tauri/src/commands.rs:987`），`setting_keys` 只服务于 Rust 自身读取的键——**本改动不需要动 Rust**。既有的 `responsePresentation.ts` / `requestPreferences.ts` 是同机制的两个范例：读写失败静默、坏值回落缺省。
- **设置面的既有纪律**（`ui-layout`「设置列表的行式布局」「语义落在操作上」）：行式列表、互斥选项由通用下拉承载、不写解释性文案、示例收进 placeholder；`SettingsPanel` 的落库方式是「改动停止后自动落库 + 基线脏判据 + `useEditingSurface` 注册」，没有保存按钮。

## Goals / Non-Goals

**Goals:**

- 四项外观（字体族 / 字号 / 缩进数 / 缩进类型）可配置、即时生效、跨重启保留。
- 消除「同一份内容跨呈现路径字号不同」的现状不一致。
- 让「编辑器缩进」这个设置对正文内容**权威**——不因正文里已有的缩进而显得不生效。
- 保持现有两条规格边界不动：响应格式化输出的缩进仍由 `http-engine`「格式化缩进宽度」独立管辖（固定空格、不提供 Tab）。

**Non-Goals:**

- 不合并「编辑器缩进」与「格式化缩进宽度」（见 D1）。
- 不随包字体、不挂 CDN（沿用离线优先约束）。
- 不做「重置全部编辑器设置」按钮（见 D3）。
- 不改动引擎侧格式化输出、不改 Rust、不改 `code-editors` 里「小输入面保持轻量」——cURL 快照仍是非富编辑器的 `<textarea>`，只是跟着换字体。

## Decisions

### D1 编辑器缩进与格式化缩进保持两个独立设置（路线 A）

「缩进数 / 缩进类型」是**编辑器专属**的；`http-engine`「格式化缩进宽度」（2 / 4 / 8、固定空格、不提供 Tab、缺省 2）原地不动，两者互不影响。

- 理由一：截图那项的语义是「每个代码层级加几个缩进单位」，管的是代码缩进；格式化输出是另一件事，其规格刚定下「固定空格、不提供 Tab」。
- 理由二：合并（路线 B）要改写 `http-engine` 那条要求、给格式化输出新增 Tab 支持、并把格式化缺省从 2 挪到 4——为一条外观偏好去改引擎级行为，代价与收益不成比例。
- 代价：设置面出现两个都叫「缩进」的项。由 D10 的标签与规格里「两者独立」那条要求收住。
- 备选：路线 B（单一缩进设置同时管编辑器与格式化）——手感更一致、`detectIndentation` 的坑也更小（见 D7），但如上的规格改动面不可接受。

### D2 字体族与字号作用于所有等宽表面；缩进只作用于编辑面

- 字体族 / 字号 → 三处代码编辑面 **+** 纯文本降级正文、Hex 视图、二进制回退、cURL 快照文本域、`.mono` 等一切等宽面。
- 缩进数 / 缩进类型 → 仅代码编辑面（`tabSize` / `insertSpaces` / 缩进参考线 / Tab 键行为）。
- 理由：Context 里那条 12px ↔ 13px 的跳变正是「同一个东西两种字体」的破绽；而缩进对纯文本展示面没有意义。
- 副作用（有意的归一）：Monaco 三处字号由 13 变 12——这是本改动唯一的现状外观变化，与 `--text-sm` 和纯文本面拉齐。

### D3 缺省值，以及相对「截图 1:1」的偏离清单

缺省：系统等宽栈 `'Cascadia Mono', Consolas, ui-monospace, SFMono-Regular, Menlo, monospace` / 12px / 缩进 4 / 空格。

对齐截图时有意偏离的地方（值本身照抄，偏离的都是「缺省与呈现」）：

| 项 | 截图 | 本设计 | 理由 |
| --- | --- | --- | --- |
| 字体缺省 | `IBMPlexMono, 'Courier New', monospace` | 现状系统等宽栈 | 本机不预装 IBM Plex Mono，抄成缺省等于开箱即用掉到 `'Courier New'`，比现状更差；该串作为用户可填的示例（placeholder 见 D10） |
| 缩进类型控件 | 单选按钮 | 通用下拉 | 既有规格「设置列表的行式布局」明确：互斥选项 SHALL 由通用下拉承载，布尔项才用开关。照截图用单选等于同时要改那条规格；用户如坚持单选按钮，需把该规格一并纳入本次改动 |
| 提示句 | 两行英文说明 | 不写 | 「语义落在操作上」：不解释后果与原理；示例改为收进 placeholder |
| Reset 按钮 | 整页右上角 | 不做 | 那是参考应用整页的按钮，不是配置节的动作；现有设置面的动作行形态只用于「恢复为不限制」这类状态清理 |
| 标签文案 | 英文 | 中文（字体 / 字号 / 缩进数 / 缩进类型） | 与「响应 / 请求 / 代理」一致，设置面板通篇中文 |

取值区间：字号 8–32，缩进数 1–8（上界照 `INDENT_WIDTHS` 的 8）。区间外或读不懂的输入不进入设置值——沿用 `SettingsPanel` 里 `NumberUnit` 的既有做法（受控输入把那一下抹掉）。

### D4 落库形态：新作用域 `editor_appearance`，四键，读写失败静默

- 键：`font_family`（原样字符串，空串视为未设置 → 回落缺省）、`font_size`（数字字符串）、`indent_count`（数字字符串）、`indent_type`（`space` / `tab`）。
- 纪律照 `responsePresentation.ts`：写入失败不抛出（只是外观偏好，下一次改动会再写一遍）；读取时坏值各自回落缺省，一条外观坏值不该把编辑器拖进不可用。
- 不动 Rust：`settings_get` / `settings_set` 是通用键值命令。

### D5 注入方式：Monaco 走选项，其余走 `:root` 上的 CSS 变量；不穿 props

- 新增 `src/lib/editorAppearance.ts`：持有当前值 + 订阅、`readEditorAppearance` / `writeEditorAppearance`、缺省常量，以及一个统一的 `applyEditorAppearance(value)`——它同时（a）把值写成 `:root` 的等宽字体变量（供非 Monaco 的等宽面），（b）通知订阅者（`CodeSurface`）。
- `App.tsx` 启动时读回一次并 apply（与既有的 `readPresentation` 并列）；`SettingsPanel` 落库成功后 apply。
- `CodeSurface` 订阅并在值变化时 `editor.updateOptions({ fontFamily, fontSize, tabSize, insertSpaces })`。
- 备选：props 透传（与 `presentation` 同形态）。否决理由：要穿 `RequestEditor` / `ScriptPane` / `ResponsePanel` 三层，而响应正文还有 `pre.body` 这条路同样要吃字号，props 会在每个面各写一遍；React context 则是为一件小事引入新机制。
- 备选：只用 CSS 变量。不可行——D 上文已核实 Monaco 字体会写入 DOM 内联样式与 canvas 度量，CSS 变量管不到编辑器。

### D6 只改 `updateOptions`，绝不把外观放进创建效应

`CodeSurface` 的编辑器只在 `uri` 变化时创建（`CodeSurface.tsx:123` 的刻意设计）。外观必须走 `updateOptions` 这条路，否则每次调字号都会重建编辑器、丢掉滚动位置与折叠状态——而规格明确要求「改动立即作用于当前已打开的编辑面，且不重置查看状态」。这条是给实现者的硬约束，测试侧用「折叠状态保持」钉住。

### D7 `tabSize` + `insertSpaces` + 关闭 `detectIndentation`

Monaco 的 `detectIndentation` 默认为 true，会按模型内容推断缩进并覆盖 `tabSize`。要让「缩进数 4」对内容权威，必须 `detectIndentation: false`；`insertSpaces` 按缩进类型取真/假（Tab 类型下 Monaco 插入制表符）。

- 已知代价（写进规格的取舍）：关掉推断后，粘贴进来本就是 2 空格缩进的内容会与 4 的 Tab 混排。这是「设置权威」的必然代价。
- 备选：留着推断。否决——用户会看到「我设了 4 却不生效」，这比混排更糟。

### D8 与 `ResponsePanel` 里那条「配置一变不重置」区分开

`ResponsePanel.tsx:126-130` 刻意让呈现格式的配置变化不影响**当前正在看的那份响应**（配置只作用于之后的响应）。外观走**相反**的方向：立即重绘当前面。实现时不要复用那条 ref 规避逻辑。

### D9 落库节奏沿用既有机制

`SettingsPanel` 的「改动停止后自动落库（`SETTINGS_AUTOSAVE_DELAY_MS`）+ 基线脏判据 + `useEditingSurface` 注册」照搬，四项进 `dirty()` 与 `baseline`。字号与缩进数是逐字符输入的，这里正好靠既有的 500ms 去抖。

### D10 字体族控件的 placeholder 放缺省栈

自由文本输入（截图形态），不做字体可用性校验——写什么就存什么，浏览器自行回落。「示例收进控件自身的 placeholder」正好满足「语义落在操作上」，placeholder 内容取缺省栈，顺带告诉用户「不填就是这条」。

### D11 测试分层

- 库级单测：坏值与缺失回落缺省、`space`/`tab` 编解码往返（照 `requestPreferences` 那组单测的形态）。
- 浏览器用例（真实 Monaco）：外观作用于编辑器（字号 / 字体族）、缩进类型为 Tab 时插入制表符、缩进设置不被正文内容覆盖、调字号后折叠状态与滚动位置保持（D6）、四项跨重载保留（照 `tests-browser/response-format-selector.spec.ts` 的形态）。
- 空/非空栈、区间外输入：happy-dom 侧的设置面用例即可。

## Risks / Trade-offs

- [字体族是自由文本，用户可能填进本机不存在的族 → 落到 `'Courier New'`] → 缺省不写不存在的族；placeholder 指向缺省栈；不校验（校验需要枚举系统字体，与离线优先和实现成本都不划算）。若日后确认要「随包 IBM Plex Mono」，那是单独一条改动：需要引入字体文件（与 `App.css` 那条离线优先注释所代表的约束冲突，要一并改），且需在字体就绪后调用 Monaco 的 `remeasureFonts()` 重算字宽，否则量出来的是回退字体的宽度。
- [关掉 `detectIndentation` 后，粘贴内容与设置缩进混排] → 已作为规格里的取舍写明；不打算为它加第五项。
- [外观被误写进 `CodeSurface` 的创建依赖 → 每次调整重建编辑器、丢失滚动与折叠] → D6 的硬约束 + 一条浏览器用例钉住。
- [字号/缩进数逐字符输入触发频繁落库] → 沿用 500ms 去抖；区间外输入根本不进状态。
- [字体变量注入触发全站一次重排] → 一次性的，代价可忽略；不做增量优化。
- [规格可能出现两个「缩进」概念被混读] → 两条 delta 各自写明「两者独立、改动其一不影响另一个」，并在设置面用「缩进数 / 缩进类型」（编辑器节）与「格式化缩进宽度」（响应呈现节）区分标签。

## Migration Plan

1. 无数据迁移：四个键不存在时回落缺省，外观与改动前基本一致，唯一差异是 Monaco 字号 13 → 12（有意归一）。用户已有的其它设置不受影响。
2. 落地顺序：`editorAppearance.ts` → `CodeSurface` 订阅 + 选项接线 → `App` 启动读回并注入变量 → `SettingsPanel` 新节 → 测试。
3. 回滚：删掉该节与 `lib`，把 `CodeSurface` 的字体/缩进写回固定值即可；数据库里多出的四个键无害（无代码读取）。

## Open Questions

（已无悬而未决的问题。实现期定掉的一处，记在这里备查。）

- 非 Monaco 的等宽面用独立字号 token `--text-mono`，不复用 `--text-sm`：`--text-sm` 同时被界面文案（下拉、选项、状态行）用着，把字号设置绑在它上面会把整条 UI 字号一起改掉；等宽**正文块**（`textarea`、`pre.body`、Hex）才跟着设置走，行内的 `.mono` 标签（如内容类型）只跟字体族、留在界面字号档位上——它承载的是元数据，不是正文。
