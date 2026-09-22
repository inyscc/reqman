## Why

三处代码编辑面（请求体 raw / 脚本 / 响应正文）与各处等宽表面的字体、字号、缩进目前全部写死：字体是 CSS 里的系统栈，Monaco 字号写死 13、缩进写死 2（`CodeSurface.tsx`），而纯文本降级、Hex 与二进制这三条呈现路径用的是 `--text-sm`（12px）。于是同一份响应正文会在跨过体积阈值时字号跳变，用户也无法按自己的阅读习惯调整最基础的可用性问题——长时间读 JSON、写脚本时，字体族与字号是最常被要求可调的一组偏好。参照同类工具把这四项做成编辑器设置，本应用按同一形态补齐。

## What Changes

- 设置模态新增「编辑器」配置节，四项：**字体**（自由文本，可写完整字体栈）、**字号**（px）、**缩进数**、**缩进类型**（Space / Tab）。同时把设置模态的分节顺序调为：编辑器 / 请求 / 响应（原「响应呈现」改名）/ 代理 / 脚本目标策略。
- **字体族与字号作用于所有等宽表面**：三处 Monaco 代码编辑面，以及纯文本降级正文、Hex 视图、二进制回退、cURL 快照文本域等纯文本等宽面。理由是同一份内容会在两条渲染路径间切换，不能有两种字体。
- **缩进数与缩进类型只作用于代码编辑面**：Tab 键插入行为、缩进宽度与缩进参考线。既有的「格式化缩进宽度」（响应格式化输出，2 / 4 / 8 空格，固定空格、不提供 Tab）保持独立、缺省不变——本次不合并，也不改动其语义。
- 缺省值：系统等宽栈（`'Cascadia Mono', Consolas, ui-monospace, SFMono-Regular, Menlo, monospace`）、12px、缩进 4、Space。
- 编辑器字号由 13 归一到 12，消除「同一份正文在大正文降级 / Hex 路径下字号不同」的现状不一致。
- 编辑器缩进 SHALL 不再跟随正文内容推断（关闭 Monaco 的 `detectIndentation`），否则设置会被正文里的既有缩进覆盖而显得不生效。
- 四项按应用设置既有机制落库（新增 `editor_appearance` 作用域），改动立即作用于**当前已打开**的编辑器，跨重启保留；不新增保存按钮。
- 非目标：不随包字体、不挂 CDN（沿用应用离线优先的既有约束）；不新增「重置全部编辑器设置」按钮；不改动引擎侧格式化输出。

## Capabilities

### New Capabilities

（无。设置模态与代码编辑面已分别由既有能力覆盖。）

### Modified Capabilities

- `code-editors`: 新增「编辑器外观可配置」需求——字体族 / 字号作用于代码编辑面与等宽纯文本面，缩进数与缩进类型作用于代码编辑面，四项缺省、即时生效与跨重启保留；并收住「降级 / Hex / 二进制表面与编辑器同族同号」。
- `ui-layout`: 新增「设置模态的编辑器配置」需求——设置模态内的编辑器配置区、四项控件形态与取值区间、无保存按钮的自动落库。

## Impact

- **前端**：`src/lib/editorAppearance.ts`（新增：读写四项、坏值回落缺省、缺省常量）、`src/components/CodeSurface.tsx`（字体与缩进改为外观驱动，`detectIndentation: false`）、`src/components/SettingsPanel.tsx`（新增编辑器节）、`src/App.tsx`（持有外观并在启动时读回、把 `:root` 等宽 CSS 变量切换为运行时注入）、`src/App.css`（`--font-mono` 的缺省值与等宽表面的字号改为受设置驱动）。
- **规格**：`openspec/specs/code-editors/spec.md`、`openspec/specs/ui-layout/spec.md`。
- **测试**：`tests-browser/code-surface.spec.ts`（外观作用于编辑器）、新增/扩展现有设置持久化用例（照 `tests-browser/response-format-selector.spec.ts` 的形态）。
- **后端**：无。`settings_get` / `settings_set` 是通用键值命令，新作用域不需要改 Rust（`setting_keys` 只服务于 Rust 自身读取的键）。
