# Design

## Context

动机见 `proposal.md - Why`。与设计相关的现状：

- **取值判定已经有一份可复用的实现**：`src/components/VariablesPeek.tsx` 是会话标签行的只读浮层，它按"名称 → 生效条"构造映射——集合级条目先放、当前作用域（环境或全局）后放，后者覆盖前者；禁用条目根本不进映射。这与 `variable-engine`「作用域优先级」的 `local > data > environment > collection > global` 一致，因此"哪一条生效"的判据在本项目里已有一处实现（`src/lib/variables.ts` 的 `effectiveByName`）。
- **后端对 secret 下发的就是掩码**：`variable_list` / `globals_list` 返回的 `current.value` 对 secret 是掩码。拿明文只有一条既有出口：`secret_reveal(id)`（`src/lib/commands.ts` 的注释即"显式揭示 secret 明文，是拿到明文的唯一入口"）。
- **四个编辑面是三套不同的实现**：
  - 地址栏：`RequestBand` 里的原生 `<input>`，上面叠着一层自研高亮（`highlightUrl` 把 `{{var}}` 切成 `<span class="var">`）。该叠层带 `pointer-events: none` 与 `aria-hidden`——它必须让指针落到 input 上，否则光标定位与选取就废了。
  - 参数表 / 请求头表：`KeyValueTable` 的原生 `<input>`，**没有任何变量高亮**。
  - Body raw：`CodeSurface` 里的 Monaco（`monaco.editor.create`），语言服务与主题都在 `src/lib/monacoEnv.ts` 注册。
- `ui-layout`「地址栏」明文要求：地址栏下方 SHALL NOT 存在可折叠的解析预览条，也 SHALL NOT 存在任何常驻的解析结果展示区。这条把提示的形态钉死为**叠加浮层**。
- `variable-engine`「动态变量」与它的既有测试规定：同一动态变量两次出现应得到**不同**值（每次独立求值）。

## Goals / Non-Goals

**Goals:**

- 指针停在 `{{name}}` 上就地给出"当前解析所用的取值 + 来源作用域"，且在四个编辑面上表现一致。
- 取值判定与发送同源——复用既有那一处判定，不写第二套。
- 把 secret 明文的边界收敛到既有的揭示出口与"仅在提示显示期间存在"。

**Non-Goals:**

- 不给参数表 / 请求头表顺带加变量高亮（那是另一个诉求）。
- 不做"点击占位符跳到变量定义"，也不在提示里提供编辑变量的入口。
- 不为 hover 新增后端命令。
- 不改变量面板的揭示状态（那是另一处独立的开关）。

## Decisions

### D1 取值来源：复用生效条判定 + 既有的 `secret_reveal`，不新增后端命令

hover 要回答的问题只是"这个名字当前的值是什么、来自哪一层"，不是"把这段文本替换成什么"——后者才是发送与 `variables_preview` 的事。因此复用 `effectiveByName` 那一处判定，取值取生效条的 `current.value`；对 secret，`variable_list` 下发的是掩码，需要明文时调用既有的 `secret_reveal(id)`。

**替代方案（否）**：新增一条"解析单段文本"的后端命令。它能顺带覆盖路径变量与动态变量，但要多过一遍 `lib.rs` 的注册与 `security_audit` 的命令白名单，而 hover 的语义并不需要整段替换——当前不需要就不加，将来若要做"预览整段替换"再说。

**替代方案（否）**：用 `variables_preview` 的整请求解析结果喂 hover。它的 `used` 只有**名字**没有值，且给不出"这个值来自哪一层"，也无法覆盖尚未参与预览的名字。

### D2 惰性装载：悬停时才取变量列表，且只在内存里留一份

与 `VariablesPeek` 同款——它在浮层打开时才去 `variableList` / `globalsList`。提示同样按需装载，按作用域缓存到本次会话内存，不进入 `App` 的渲染路径。

**替代方案（否）**：在 `App` 里常驻三份变量列表并向下下发。会把一个"按需看"的能力变成常驻状态，还要为"改了变量之后何时失效"再立一套规则。

### D3 三套输入实现各接一次，共用同一个命中判定与同一个提示组件

- **地址栏**：不改叠层的命中——它 `pointer-events: none` 是有原因的。改为在 **input 自己的 `mousemove`** 上，用与 input 同字体的测量把 `clientX` 换算成字符下标（并补偿 input 的 `scrollLeft`），再判断该下标是否落在某个 `{{...}}` 区间里；区间用与 `highlightUrl` **同一条正则**切出来，因此叠层高亮的范围与可悬停的范围永远一致。
  **替代方案（否）**：给叠层里的 `.var` span 开 `pointer-events: auto`。命中判定会变成 O(1)、连测量都不用，但 span 会吃掉指针事件：点击落到 span 上，光标无法定位到 URL 的该处，选取也会被破坏——在地址栏这种位置不可接受。
- **参数表 / 请求头表**：同样是原生 input，复用同一个命中判定 hook。
- **Body raw**：走 Monaco 的 `registerHoverProvider`——这是 Monaco 里唯一正规的悬停通道。`provideHover(model, position)` 给出 offset，据此判断是否落在 `{{...}}` 内。注册收在 `src/lib/monacoEnv.ts`（与主题、语言服务的既有注册同处），"当前作用域"经一个可注入的数据源接上，因为 provider 的回调是静态注册的。
  **替代方案（否）**：把 Body 也换成自研输入面。与 `code-editors`「三处编辑面必须用 Monaco」的既有要求冲突。

### D4 提示内容按四条分支呈现

| 命中的名字 | 呈现 |
|---|---|
| 可解析的用户变量 | 名称 + 取值 + 来源作用域（environment / collection / global） |
| 无法解析 | 名称 + 「未解析」，不给任何看似有效的取值 |
| 动态变量（`{{$name}}`） | 说明它是每次独立求值的动态变量，**不给具体取值** |
| secret 变量 | 名称 + **明文**取值 + 来源作用域（按用户要求） |

来源作用域取自命中那一条所在的 scope，因此同名遮蔽时用户一眼看出是哪一层在生效。

动态变量不给值是有意的：既有测试明确"同一动态变量两次出现应得到不同值"，给出一个具体值必然与实际发出的请求不符——那比"没有提示"更糟。

### D5 secret 明文的边界

明文只经 `secret_reveal(id)` 取一次，存在该次提示的组件状态里，指针移开即丢弃；不写日志、不进剪贴板、不落任何持久化形态；不改变变量面板里那条变量的揭示状态。

**已知代价（有意接受）**：这等于把"显式揭示"从一次点击扩展成"悬停即显示"——屏幕共享或录屏时指针划过 URL 就会显示明文。产品上这是用户明确要求的行为，规格据此把"可以拿到明文"写成两条可枚举的出口，并明确"除这两条之外界面保持掩码"。

## Risks / Trade-offs

- [悬停即显示明文，屏幕共享 / 录屏时可能外泄] → 有意接受的取舍；边界收敛到"只在提示显示期间存在于组件状态、不缓存、不进日志、不改存储形态"，并在规格里枚举两条出口。
- [提示的取值与发送不一致（前端漂移出第二套判定）] → 复用 `effectiveByName` 这一处判定（`VariablesPeek` 已在用），不新写判定；验证里加"同名遮蔽时提示给出来自 environment 的值"。
- [原生 input 的字符命中判定在字体、缩放、横向滚动下不准] → 用与 input 同字体的测量并补偿 `scrollLeft`；验证覆盖"地址栏横向滚动后仍能命中"。
- [Monaco 的 hover provider 重复注册或泄漏] → 注册收在 `monacoEnv` 的单例路径上，`CodeSurface` 卸载时不做重复注册；验证覆盖"切换请求后悬停仍有效"。
- [提示遮挡正在阅读的文本] → 提示锚在占位符下方、空间不足时上翻，且带 `pointer-events: none`，不挡指针、不影响输入。

## Migration Plan

无数据迁移：不涉及存储格式与既有数据的读取含义；不新增后端命令，因此不动 `security_audit` 的命令白名单。
