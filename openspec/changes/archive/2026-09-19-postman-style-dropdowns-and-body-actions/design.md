## Context

本次动的东西横跨三处互不相干的界面区域（会话标签行的环境选择器、Body 类型行、cURL 标签），共同点是「原生或默认控件观感」。相关现状：

- 全局设计 token 在 `App.css` 的 `:root`：`--text-sm/base`、`--space-*`（4 的倍数）、`--radius-sm/md`、`--shadow-2/3`、`--accent`（#4c6ef5）/ `--accent-strong` / `--accent-soft` / `--panel` / `--border` / `--panel-2`。新控件一律复用这些 token，不新造颜色与字号。
- `NodeMenu`（`src/components/NodeMenu.tsx`）已经有一套浮层的关闭机制：document 上的 mousedown（命中 `.node-more` 与自身则放过）、Esc、capture 阶段的 scroll。它的样式是 `.node-menu`：`position: absolute; top: 100%; right: var(--space-1); z-index: 20` + `--shadow-*` 级浮层 + `--panel` 底。
- 会话标签行所在的.row 已显式 `overflow: visible`（`App.css:332` 附近），是为了让环境变量浮层溢出这一行。
- Body 类型行位于 `.pane-body`（`overflow: auto`）内的 `.pane`（`overflow: hidden`）里；`.pane-body.fill` 用于 Scripts / cURL 两页（`overflow: hidden`）。
- `ResizeStrips.tsx:55` 的拖拽排除清单写的是 `button, select, input, textarea, .env-select, .window-controls`；会话标签行的拖拽排除清单在 `App.tsx:1548` 那段注释附近。

动机与范围见 proposal.md；行为契约见 `specs/ui-layout/spec.md` 与 `specs/ui-polish/spec.md`。

## Goals / Non-Goals

**Goals:**

- 一个可被多处复用的下拉组件，替代运行环境自带的原生下拉，且菜单行为与既有行内菜单一致而不是另起一套。
- 三处接入点的结构变化：语言选择紧跟 `raw`、类型行右端放格式化动作、cURL 动作行上移。
- 改动过程中不引入新依赖（应用离线优先，`package.json` 里没有也不该出现 popper / floating-ui 这类定位库）。

**Non-Goals:**

- 不迁移表单里的其它原生 select（form-data 字段类型、认证方式、API Key 位置、协议版本）。它们仍是原生控件，本次只保证新组件的接口不排斥以后接入。
- 不做深色主题、不做动画规范统一（本次新菜单不引入动效，与其它浮层保持一致）。
- 不改变任何数据模型、不新增后端命令。

## Decisions

### D1：`Dropdown` 是受控组件，只做「选一项」，不做数据获取

```tsx
interface DropdownOption<T extends string> {
  value: T;
  label: string;
}

<Dropdown<T>
  label: string              // 无障碍名称，替代原 <select aria-label="环境">
  value: T
  options: DropdownOption<T>[]
  onChange: (value: T) => void
  searchable?: boolean       // 环境选择器用；语言选择不用（5 项）
  align?: 'left' | 'right'   // 见 D3
  className?: string         // 外层钩子类名（如 .raw-language），供样式与测试定位
  testId?: string
  disabled?: boolean
/>
```

**为什么**：三处接入点的写法原本都是「`<select>` + value + onChange」，保持同样的受控形状，替换是局部改动而不是重构调用方。

**备选**：把 cURL / 类型行的动作也塞进同一个组件（作为"操作菜单"）。拒——动作是即时执行的命令，不是取值，混进来会让 `onChange` 的语义分裂。Action menu 仍用 `NodeMenu`。

### D2：把关闭逻辑从 `NodeMenu` 抽成 hook，而不是复制一份

新增 `src/lib/useMenuDismiss.ts`（mousedown 命中白名单 → 放过 / Esc / capture scroll → 关闭），`NodeMenu` 与 `Dropdown` 都消费它，命中白名单作为参数传入（`NodeMenu` 传 `.node-more`，`Dropdown` 传 `.dropdown`）。

**为什么**：这两处的关闭语义必须完全一致（spec 里写的是同一套关闭规则），复制一份等于承诺它们会一起漂移。

**备选**：让 `Dropdown` 直接复用 `NodeMenu` 组件再配一组互斥 item。拒——`NodeMenu` 的语义是「就地执行操作」：item 选中即执行，没有"受控值"的概念，也没有选中态持久化的需求；硬套会把 aria 语义带偏（`Dropdown` 是 listbox + 选中标记，不是 menu + menuitem）。

### D3：菜单用 `position: absolute` + `position: relative` 的根节点定位，不用 portal / fixed

与 `.node-menu` 同一套做法：给下拉根节点 `position: relative`，菜单 `position: absolute; top: 100%`；靠右的情形加 `.dropdown-menu.align-right { left: auto; right: 0 }`。

**为什么**：

- 不引入依赖；fixed + portal 还要自己算 `getBoundingClientRect` 并在滚动 / 缩放时重定位，成本远高于收益。
- 会话标签行已经 `overflow: visible`，环境菜单能溢出这一行。

**代价（已知）**：Body 类型行的菜单位于 `.pane`（`overflow: hidden`）内，理论上会被面板边界裁剪。这个菜单只有 5 项、且类型行贴在正文区顶部，实际不会被裁；菜单同时设 `max-height` + 自身滚动作为兜底。若将来出现被裁的接入点，再单独引入 portal，不在本次做。

### D4：类型行改成「三段」结构，语言选择放回 `raw` 后面

```tsx
<div className="body-kind-row" role="radiogroup">
  {BODY_KINDS.map(...)}                       {/* none ... raw ... binary */}
  {raw && <Dropdown className="raw-language" ... />}   {/* DOM 顺序紧接 raw，不再 margin-left:auto */}
  <span className="grow" />
  {raw && language === 'json' && <button className="text-action">Minify</button>}
  {raw && language === 'json' && <button className="text-action">Beautify</button>}
</div>
```

`.raw-language` 去掉 `margin-left: auto`；动作块用 `margin-left: auto` 顶到右端。

**为什么**：`raw` 的语言是 `raw` 自身的属性，视觉上必须归属到它身边；原来的 `margin-left:auto` 让一行两端各挂一个控件，中间是空的。

**备选**：把语言选择放在 radio 组之前。拒——先選类型再选语言是既有阅读顺序。

### D5：`Minify` / `Beautify` 只在 JSON 时渲染入口，不做禁用态

```ts
// lib/editing.ts 里加纯函数
export function formatRawBody(text: string, mode: 'beautify' | 'minify'): string
```

只依赖 `JSON.parse` / `JSON.stringify(text, null, 2)` 与 `JSON.stringify(parsed)`。解析失败时抛错，调用方不写回草稿，改为在类型行下方渲染既有的 `.notice danger`。空正文直接不渲染入口。

**为什么**：XML/HTML/JavaScript 都没有现成的解析器可用，加依赖换三条冷路径不划算；隐藏入口比展示一排永久禁用按钮干净（与既有「行操作按钮按需显现」的思路一致）。

### D6：cURL 的动作行移到 `<textarea>` 之前

```tsx
<div className="curl-block">
  {error && ...}
  <div className="row"><span className="grow" /><button ...重新生成/><button ...复制/></div>
  <textarea className="curl-command" ... />
  {warnings.length > 0 && ...}
</div>
```

删除原先位于最后一行的 `<span className="muted">可以就地修改这段命令……</span>`。`curl-regenerate`、`curl-copy` 两个 `data-testid` 原样保留。

**为什么**：命令能从第一行开始显示，不用先读一段说明；两个动作的顶部位置也更接近用户切入该标签后的第一视线。

### D7：拖拽排除清单无需改动，但换 portal 就必须回头改

会话标签行的拖拽与双击最大化判定只有一个实现：`ResizeStrips.tsx:52` 的 `isInteractiveSessionBarTarget`，它的选择器是 `'button, select, input, textarea, .env-select, .window-controls'`；`App.tsx:1553` 只是调用它，分隔条也共用同一个函数——**不存在两处需要分别维护的白名单**。

`Dropdown` 的触发器渲染为 `<button>`，菜单在无 portal 的前提下挂在 `.env-select` / 组件根节点内，两者都已落在上面那条选择器里。因此本次**不需要**改动白名单。

由此多一条约束：这是 D3 选 `absolute` 而不是 portal 的一个附带收益；将来若因面板裁剪改用 portal 渲染菜单，菜单就脱离了 `.env-select` 子树，必须同步把 `.dropdown` 补进 `isInteractiveSessionBarTarget`，否则在下拉上按下指针会拖动窗口。

## Risks / Trade-offs

- **[菜单被面板裁剪]** → D3 已限定：本次只有 5 项的小菜单落在正文区顶部，并加 `max-height` + 内部滚动兜底；真出现裁剪再引入 portal。
- **[既有测试定位器失效]** → `tests/app.test.tsx` 的 588 / 3395 / 4217 行依赖 `.env-select select` 与 `getByLabelText('环境')`，浏览器用例 307 行同理。缓解：新组件用同一个 `aria-label`（`环境` / `raw 语言`）并提供 `data-testid`，多数定位器只需把 `select` 换成 `button`。
- **[会话标签行被撑高]** → 触发器 padding 收紧到与标签同高（沿用现有 `.env-select select` 的做法：目标是 `--chrome-row: 40px` 不变）；浏览器用例里已有钉住该行的断言。
- **[标题栏拖拽被误触发]** → 见 D7：触发器是 `button`、菜单在 `.env-select` 子树内，已命中既有选择器，本次不动白名单；只有将来改用 portal 渲染菜单时才需要补，且必须同一次改动里完成。
- **[两处关闭机制漂移]** → D2 抽 hook；如果实现时觉得抽 hook 费事而选择复制，则本条风险不降。

## Migration Plan

1. 先归档 `simplify-editor-chrome-and-curl-tab`（与本变更共用 `App.tsx` / `RequestEditor.tsx` / `CurlSnapshot.tsx` / `App.css`），确认 `npm run build` 干净。
2. `useMenuDismiss` hook + `NodeMenu` 改为消费它 → 既有菜单用例全绿（这一小步本身就是回归保护）。
3. 新增 `Dropdown` 组件与 `.dropdown` 样式，先不接任何接入点。
4. 环境选择器接入（含搜索）→ 改三处测试定位器。
5. Body 类型行：语言选择移位 + 右侧两个动作 + `formatRawBody` 纯函数 + 单测。
6. cURL 动作行上移、删说明文案。
7. `npx tsc --noEmit`、`npm test`、`npm run build`、`npm run test:browser`（浏览器自动化复用本机 Chrome，不下载 Playwright 的 Chromium）。

回滚：每一步都是可单独 revert 的提交，DOM 结构的改动与测试定位器的改动在同一个提交里，因此不存在"代码回滚了但测试还指着新结构"的中间态。

## Open Questions

- 其它原生 select（字段类型、认证方式、协议版本）以后是否也换成 `Dropdown`？本次刻意不做，但如果答案明确为"是"，`Dropdown` 的接口应当预留 `disabled` 选项与分组能力——本次只留 `disabled`，分组没有证据支持先不做。
- 菜单展开时是否要自动把焦点移入搜索框？本次按"焦点的位置由用户决定"处理：展开后焦点仍在触发器上，方向键直接作用于选项；若用户反馈希望 Tab 进搜索框，那是纯 CSS/JSX 局部调整，不影响 spec 与任务拆分。
