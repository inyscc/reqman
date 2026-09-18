## Context

动机见 `proposal.md`；行为约束见本变更的 `specs/ui-layout/spec.md`。以下是塑造方案的现状事实。

**前端**

- 键值表有两处实现：`src/components/RequestEditor.tsx` 的 `KeyValueTable`（Params / Headers / urlencoded，按钮文案「+ 添加一行」）与 `FormDataEditor`（「+ 添加字段」），两者都是纯受控组件，行身份靠**位置索引**（`key={index}`）。变量新增是第三种形态：`VariablesPanel` 底部一整行输入 + 「写入」按钮。
- 「脏」只有一份：`App` 的 `dirty`（`src/App.tsx:110`），且只覆盖请求。`editDraft` 顺手 `requestStore.markDirty`。发送与预览用 `dirty` 决定走 `saved_id` 还是 `inline`（`src/App.tsx:296-306`、`463-467`）。
- 其余编辑面的草稿锁在组件内部：`EntityScriptPanel` 的 `pre`/`test`（`useState(entity.pre_request_script ?? '')`）、`entityDraft.name`、`SettingsPanel` 与 `CookiePanel` 的本地 state。`store.ts` / `useStore.ts` 这一对是项目既有的「纯逻辑 + 订阅 hook」分层范式。
- 丢弃点：会话标签的关闭按钮直接清 draft（`src/App.tsx:711-720`）；`selectRequest` 无条件 `setDirty(false)` 再换 draft（`src/App.tsx:359-369`），因此点当前已打开的请求会白抹未保存标记；`selectEntity` 直接把 draft 置空。
- `App` 目前没有任何全局键盘监听；只有 `Modal` 监听了 Escape。
- 应用已注入 `client`（`Commands`）以便测试替换真实 IPC（`src/App.tsx:40-43`）。窗口层没有对应机制。
- 既有测试 `tests/app.test.tsx` 通过 `screen.getByText('保存')` 等多处文案定位控件，断言会随按钮增减而失效。

**Rust（只读调查结论，本变更不改这些行为）**

- 构造请求时只按行的 `enabled` 过滤，不看空值：params（`src-tauri/src/variables/mod.rs:312-317`）、headers（`:322-327`）、urlencoded（`:413-420`）、form（`:395-412`）。
- 发送路径对每个 header 调 `validate_header`，空名直接返回 `InvalidInput`「请求头名称不能为空」（`src-tauri/src/net/headers.rs:35-38`）。预览路径不校验，且会把 enabled 的空行带进预览结果（`src-tauri/src/variables/mod.rs:563-567`）。
- `request_save` 只规范化 `name` 与 `method`，`params`/`headers`/`body` 整块 JSON 原样落库（`src-tauri/src/storage/requests.rs:199-238`、`src-tauri/src/storage/mod.rs:30-32`）。
- 全后端没有 `#[serde(deny_unknown_fields)]`（`src-tauri/src/storage/model.rs:130-136` 等），因此前端给行多加字段不会反序列化失败，**但会被原样写进数据库**。

**权限**

- `src-tauri/capabilities/default.json` 只授予四项：`core:app:default`、`core:event:default`、`core:window:default`、`core:webview:default`。
- 生成的 ACL 清单显示 `core:window:default` **不含** `allow-close` / `allow-destroy`。
- `@tauri-apps/api` 的 `onCloseRequested` 在 handler 未 `preventDefault()` 时会自行调用 `destroy()`，而 `destroy()` 需要 `core:window:allow-destroy`。
- `src-tauri/src/security_audit.rs:69-81` 把允许的权限钉成上述四项的白名单，另一条测试还会核对生成清单与源文件一致。

## Goals / Non-Goals

**Goals:**

- 让「新增一行」和「保存」不再需要常驻按钮，同时**不降低**可发现性：状态指示器本身承担操作入口。
- 消灭"用户点出来的空行"这一整类问题（不再产生、不再残留、不再落库、不再进入请求）。
- 用一个统一机制同时支撑快捷键保存与未保存守卫，而不是给每个编辑面各写一份。
- 窗口退出与页面重载都不静默丢弃未保存内容，并且这次放宽权限是**显式、被审计记录**的。

**Non-Goals:**

- 不做请求的自动保存（理由见 D7）。
- 不在后端增加空行过滤：`enabled` 已经是唯一的行级开关，再叠一层空值过滤会让"禁用行"与"空行"的语义互相干扰；前端出口清洗已足够。
- 不把 Cookie 新增表单改成幽灵行（六字段 + 下拉，且新增是不可撤销动作）。
- 不做变量重命名（既有规格已划在范围外）。
- 不改任何 Rust 命令、存储与网络行为。

## Decisions

### D1: 幽灵行是纯视图态，行身份沿用位置索引

幽灵行**不进入 `rows`**：用户没输入时它不存在于模型里，所以预览、发送、保存都看不到它。任一字段被输入后该行物化为普通行（追加到末尾），幽灵行随之往下平移。

一个实现细节决定了它的形态：幽灵行的那两个输入框在物化前后必须是**同一个 DOM 元素**，否则中文输入法会在第一个字符后被切断（浏览器对 DOM 移动/重挂会重置 composition）。因此物化时只做「在末尾追加」，幽灵行始终是渲染出来的最后一个元素，正在输入的元素不会被移动。

由此推出「新的空行何时出现」：内容进模型的时机是**每一次按键**（所以还没失焦就发送也不会丢内容），而幽灵行交还给空态、下方补出新空行的时机是**用户结束这一行**（回车或焦点移出整行）。刻意不做「第一个字符就让新空行出现」——那要求同时渲染两个末尾元素并串起两套状态，复杂度与收益不成比例，而 Postman 同样是写完一行/Tab 之后才补出空行。

还有一条只有真浏览器（有布局的引擎）才暴露的约束：**幽灵行必须与内容行等高**，而内容行的行高是由同格控件里最高的那个决定的。原先全局 `button { padding: 5px 10px }` 让单元格里的删除按钮（30px）比输入框（26px）高，于是内容行 37px、幽灵行 33px。修法是让 `td button` 与 `td input` 用同一套内边距——这条如果只跑 happy-dom 永远发现不了（它不做布局）。

备选与否决理由：

- **给每行加 `uid` 以支持任意位置增删**：查证后发现 `params`/`headers` 是整块 JSON 落库（`storage/requests.rs:199-238`），而 `uid` 不在 Rust 结构体里——不会被拒（无 `deny_unknown_fields`），**但会被写进数据库**。脏存储，否决。
- **把幽灵行也算进模型，靠出口过滤**：等价于承认模型里可以有空行。它会让 `dirty` 因为一个从未被填写的空行而变真，并且"点一下加号就未保存"的现状会以另一种形式残留。否决。

位置索引在这里是安全的：只有**末尾追加**与**按钮删除**两种增删（见 D2），不会出现中间插入导致索引位移。

### D2: 空行在出口清洗，不在输入过程中删除

被否掉的方案是「清空即删行」。它虽然能让模型始终保持无空行，但用户正在编辑的行会在清空字段的瞬间消失——比留着更烦人，而且中间行被移除会让位置索引位移、受控输入的值串行。

改成这个不变量：

```
插入侧：幽灵行永不进模型                      <- 新空行不再产生
加载侧：打开请求时剔除历史空行                  <- 旧数据被清掉
出口侧：预览 / 发送 / 保存前统一清洗            <- 后端永远见不到空行
编辑中：清空一行不删行，交给出口清洗            <- 编辑体验不被破坏
```

出口只有三个，且都在 `App.tsx` 里（`variablesPreview`、`sendRequest`、`requestStore.update` 的入参），统一经过同一个纯函数即可，不需要动机器的 `editDraft`。

### D3: 清洗的判定规则按行类型分

- `KeyValue`（params / headers / urlencoded）：`key` 与 `value` **皆为空**才视为空行。
- `FormField`（form-data）：只以 `key` 为空判定——file 类型的行本来就没有 `value`，只看值会把合法的文件字段删掉。

`enabled` 不参与判定：禁用的行只要还有内容就必须保留（否则用户关掉一个 header 再保存，那行内容会凭空消失）。

### D4: 编辑面注册表是纯逻辑 + 订阅 hook

新增 `src/lib/editing.ts`（纯逻辑，导出即可单测）与配套 hook，形态与既有的 `store.ts` / `useStore.ts` 对称：

```
EditingSurface { id, priority, label, isDirty(), save() }
registry.register(surface) -> 注销函数      // 组件挂载时注册，卸载时注销
registry.dirty()  -> EditingSurface[]      // 守卫用
registry.top()    -> EditingSurface | null // Ctrl+S 用
```

`priority`：模态 300、主区面板 200、请求 100。因为主区同一时刻只挂载一个面板、模态最多盖一层，`top()` 天然唯一，不需要"按当前上下文判断"这类脆弱逻辑。

`isDirty` 与 `save` 会随 render 变化，注册时用 ref 持有最新闭包，避免每次 render 都注销重注册。

只有**真正有未保存概念**的面注册：请求编辑器、集合/文件夹脚本面板、设置模态。变量面板（即写即提交）、Cookie 新增表单（不是待保存文档）、集合/文件夹改名（D8 改为失焦提交）都不注册——这正是 spec 里"在即时提交的界面按下快捷键不产生副作用"那条场景的落点。

### D5: Ctrl+S 存 `top()`；守卫的「保存并继续」存全部脏面

两者语义不同，刻意不统一：

- 快捷键是"存我现在正在弄的这个"，用户对焦点有直觉，一次只写一个面可控。
- 守卫的「保存并继续」是"别丢东西"，此时应当把全部脏面都存下来。守卫场景下脏面通常只有一个（主区的请求与脚本面板互斥，模态打开时点不到树），所以不会变成失控的批量写入。

### D6: 守卫 = 意图与执行分离 + 内联三选一

```
guard(intent)     有脏面？ --否--> run(intent)
                        --是--> 提示：保存并继续 / 不保存 / 取消
                                   |            |          |
                        保存全部脏面成功后 run  run(intent)  什么都不做
                              失败：不 run，停在原地报错
```

`intent` 是数据（切到某请求 / 切到某实体 / 关标签 / 删除某请求 / 退出应用），`run` 是纯执行函数——两者分离后，守卫逻辑可以脱离 React 单测。

提示复用 `App` 里已有的 `notice warn` 形态（`src/App.tsx:811-833` 的 `scriptGate` 就是先例），放在 `request-region` 顶部。触发源有六个，只有一处实现才可控；`window.confirm` 也给不了三个选项。

保存失败时**清空待执行意图**、停在原地报错：保留意图会让用户以为"我按了取消怎么还挂着"，清掉则行为可预期——改完再点一次。

### D7: 保存入口按"可往返 + 有无自然提交时机"区分

判据：**可往返、且有自然提交时机的编辑 → 隐式提交；不可撤销、或没有提交时机的 → 显式按钮。**

| 界面 | 处置 | 理由 |
| --- | --- | --- |
| 请求操作行「保存」 | 去掉常驻按钮；「未保存」徽标变为可点入口（仅脏时出现，`title` 带 `Ctrl+S`） | 默认界面真的少一个按钮，但不牺牲可发现性 |
| 集合/文件夹「保存名称」 | 去掉，改回车/失焦提交 | 与 `VariablesPanel`、`EnvironmentsPanel` 已有的就地编辑语义对齐；这三处现在不一致 |
| 变量面板「写入」 | 去掉 | 幽灵行取代，提交语义沿用既有的回车/失焦 |
| 实体脚本「保存」 | 保留 + Ctrl+S | 长文本没有自然提交时机 |
| 设置「保存策略」 | 保留 + Ctrl+S | 安全设置，改到一半自动生效是危险的 |
| Cookie「新增」/「另存为」/「删除」 | 保留 | 不可撤销的动作 |

请求编辑器之所以敢去掉常驻按钮，是因为它现在有了新的提交时机：**切走时**由守卫提供「保存并继续」。

被评估并否决的方案：**请求改为自动保存**。它能让 Ctrl+S 与守卫都退化成几乎无意义的小功能，但（一）会把 `dirty` 翻掉，而 `dirty` 还兼着 `saved_id` vs `inline` 的语义（`src/App.tsx:296-306`、`463-467`）；（二）对 API 调试工具来说"改了但还没想清楚"是真实状态。`storage-foundation:32` 虽已提到"自动保存"，本次不动它。

### D8: 实体改名改为回车/失焦提交

`entityDraft.name` 现在是自由编辑 + 显式「保存名称」按钮。改成失焦/回车提交后：它不再需要脏状态、不再进入编辑面注册表，守卫的触发源也少一个（点击别处时失焦先于切换发生，名称已经落地）。空名称仍按既有语义拒绝并还原。

### D9: 窗口守卫走注入的窗口控制器

新增 `src/lib/window.ts`，与 `client` 同一注入思路：

```
WindowController { onCloseRequested(h): Promise<unlisten>, destroy(): Promise<void> }
```

`App` 通过 props 接收（默认实现包 `@tauri-apps/api/window`）。这样 vitest 里不碰真 Tauri，窗口守卫本身也能被单测覆盖。

- 用 `destroy()` 而不是 `close()`：`close()` 会再触发一次 `CloseRequested`，容易打成环。
- 权限必须增加 `core:window:allow-destroy`（`core:window:default` 不含它；不 `preventDefault` 时 `onCloseRequested` 自调的 `destroy()` 也会被拒，可能导致窗口关不掉）。同时更新 `src-tauri/src/security_audit.rs:69-81` 的白名单并写明理由：该权限只用于退出前的未保存确认。生成清单 `src-tauri/gen/schemas/capabilities.json` 需重新构建同步。
- 页面重载走 `beforeunload` 兜底（`preventDefault()`），它只有环境原生提示、没有「保存」选项，spec 里也只承诺"不静默丢弃"。

### D10: 顺手修掉"点当前请求抹掉未保存标记"

`selectRequest` 对同一 id 也要执行 `setDirty(false)`。改为：目标 id 与当前 `selectedId` 相同时直接返回（既不重载 draft，也不动 dirty），并且不触发守卫。这条在 spec 里有对应场景。

## Risks / Trade-offs

- [幽灵行物化会引起重渲染，可能打断中文输入法的 composition] → 幽灵行是身份稳定的常驻元素（不因物化而卸载重挂），物化只是在它上方插入一行；实现时需在真实输入法下验证一次「输入即新增」不断字。
- [六个守卫触发源可能漏掉一处，导致仍有静默丢弃的路径] → 所有触发源都收敛到同一个 `guard(intent)` 入口；`selectRequest` / `selectEntity` / 关闭标签 / 删除 / 窗口关闭逐个改造，并用「重复选中当前请求」「切侧栏 tab」「切脚本相位」这三条反向场景把误触发钉住。
- [`beforeunload` 在 Tauri WebView2 里是否真被触发未实测] → 已在**本机 Chrome**（与 WebView2 同属 Chromium 家族）里端到端确认：`tests-browser/ghost-row-and-reload.spec.ts` 钉住「有未保存改动时重载弹出 `beforeunload` 确认框并因此被取消」「没有改动时重载照常完成」。浏览器经仓库既有的 `launchBrowser()` 退回链取得，**不下载任何浏览器**（本仓库严禁安装 Playwright 自带的 Chromium）。
  一个与 spec 措辞有关的平台约束：Chromium 只在页面**有过用户操作**（sticky activation）之后才为 `beforeunload` 弹确认框。本应用里用户必然已经操作过，但自动化用例必须先模拟一次点击，否则会得到「没有提示」的假阴性——用例里已按此处理。
  真机 WebView2 复核仍建议在 `npm run tauri dev` 里点一次 F5，但已不再是不确定项。
- [放宽权限会削弱"前端无多余能力"的断言强度] → 只加 `allow-destroy` 一项，且必须同时改 `security_audit.rs` 白名单与注释，让这次放宽在代码里留下痕迹；窗口守卫本身不读文件、不发网络。
- [去掉常驻「保存」按钮会降低新用户的可发现性] → 未保存标记与保存入口同时出现、彼此相邻，入口的 `title` 说明 `Ctrl+S`；spec 把"未改动时不存在保存按钮、改动时两者同时出现"写成了可测场景。
- [既有测试多处用 `getByText('保存')` 定位] → 单独列一条断言迁移任务；需要区分「请求操作行的保存」与「实体脚本/设置的保存」，`npm test` 必须全绿。
- [守卫的「保存并继续」可能写入比用户预期更多的面] → 采纳该语义的原因已记在 D5；实际场景下同时脏的面通常只有一个，若实测出现多面同时脏造成困惑，可在提示文案里列出将被保存的面。
- [出口清洗三处，漏掉一处就会让空行漏到后端] → 清洗收敛成单一纯函数，并在 `App.tsx` 的三个出参处统一调用；用"幽灵行未输入即发送"与"空行不被保存"两条场景覆盖。
