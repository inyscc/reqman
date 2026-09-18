## Why

请求编辑器里本该隐式发生的事，现在全靠常驻按钮：每张键值表底部一个「+ 添加一行」、操作行一个「保存」、切换请求与关闭标签则**静默丢弃**草稿。

这不只是手感问题。「+ 添加一行」会立刻往模型里写一行 `{key:'', value:'', enabled:true}`，而 Rust 发送路径只按 `enabled` 过滤、不看空值（`src-tauri/src/variables/mod.rs:322-327`），并且 `validate_header` 对空名直接报错（`src-tauri/src/net/headers.rs:35-38`）。于是**在 Headers 标签点一下加号、没填就发送，请求会失败并报「请求头名称不能为空」**——一个用户点出来的错误。`variables_preview` 同样把 enabled 的空行原样带进预览（`src-tauri/src/variables/mod.rs:563-567`）。

丢弃那一侧，`storage-foundation` 已经承诺过：

```42:44:openspec/specs/storage-foundation/spec.md
#### Scenario: 未保存改动的处置
- **WHEN** 用户修改了已保存请求但尚未保存即关闭该请求
- **THEN** 系统保留改动或明确提示未保存，SHALL NOT 静默丢弃
```

而实现是直接清 draft（`src/App.tsx:711-720`）与 `setDirty(false)` 后换 draft（`src/App.tsx:359-369`）。本变更落实这条已承诺的行为，并顺手修掉"点当前已打开的请求会白抹未保存标记"（`src/App.tsx:363`）。

## What Changes

- **键值表改为「幽灵行」**：Params / Headers / urlencoded / form-data / 环境变量表在末尾常驻一个空行，输入即物化为真行并在下方补新的幽灵行。幽灵行**不进模型**，因此不再产生"用户无意留下的空行"，上面那条发送报错随之消失。
- **空行在出口统一清洗**：模型允许在编辑过程中暂时保留空行（清空一行不立刻删除，避免正在编辑的行突然消失），但预览、发送与保存前一律经同一个纯函数剔除空行。加载既有请求时也做一次，清掉历史脏数据。
- **Ctrl+S 保存当前生效的编辑面**：新增一个编辑面注册表，编辑面各自上报 `isDirty` / `save`；快捷键保存注册表中优先级最高的那一个（模态 > 主区面板 > 请求）。不脏或正忙时不发请求。
- **保存按钮按"是否可往返、是否有自然提交时机"区分**：
  - 请求操作行**去掉常驻「保存」按钮**，把「未保存」徽标变成可点入口（仅在脏时出现，`title` 提示 `Ctrl+S`），因此默认界面少一个按钮。
  - 集合/文件夹的**「保存名称」按钮去掉**，改为回车/失焦提交——与 `VariablesPanel`、`EnvironmentsPanel` 已有的就地编辑语义对齐（现在这三处不一致）。
  - 变量面板底部的「写入」按钮**去掉**（幽灵行取代），提交语义沿用既有的回车/失焦。
  - **保留**显式按钮：实体脚本「保存」、设置「保存策略」、Cookie「新增」，以及「另存为」「删除」——它们要么没有自然提交时机（长文本），要么是不可撤销的动作（新增、应用安全策略）。
- **未保存改动在切走前的守卫**：切请求、切集合/文件夹、关闭会话标签、删除当前打开的请求，若存在脏编辑面，先给出「保存并继续 / 不保存 / 取消」三选一；选「保存」时保存全部脏面，保存成功才继续，失败则停在原地报错。明确**不**触发守卫：切侧栏 tab、切 Scripts 相位、切环境、发送、打开模态（这些都按既有规格保留草稿）。
- **退出应用前的未保存处置**：拦截 Tauri 主窗口的关闭请求，脏时走同一个守卫，确认后才真正退出。另加 `beforeunload` 兜底拦截页面重载（浏览器原生文案，无自定义选项）。
- **权限与安全审计**：为窗口退出新增 `core:window:allow-destroy`。`core:window:default` 不含它，而 `onCloseRequested` 在不 `preventDefault` 时会自行调用 `destroy()`——不加权限反而可能导致窗口关不掉。随之更新 `src-tauri/src/security_audit.rs` 的权限白名单并写明理由（**BREAKING**: 权限面从四项变为五项，审计闸门必须被显式打开）。
- **顺手修 bug**：选中当前已打开的请求不再清除未保存标记。
- **顺带修掉一个与本变更无关、但实现期撞上的既有缺陷（本地化相关）**：网络错误分类（`src-tauri/src/error.rs`）原先只看英文错误文案，简体中文 Windows 上 `getaddrinfo` 失败被渲染成「不知道这样的主机。 (os error 11001)」，一条 DNS 子串都匹配不上，于是**域名解析失败被报成笼统的连接失败**——违反 `http-engine` 已有的「失败类别可区分」。改为优先用错误链上最内层 `io::Error` 的原始错误码（不随系统语言变化），英文文案只作兜底；同理「连接被拒」也不再依赖文案。**该能力的需求文本不变**，本项只是让实现真的满足它。

## Capabilities

### New Capabilities

（无。全部行为落在既有 `ui-layout` 能力内。）

### Modified Capabilities

- `ui-layout`: 「面包屑与请求操作行」不再要求常驻的「保存」按钮（改为"未保存时提供保存入口 + 快捷键"）；新增四条需求——「键值表的幽灵行」、「Ctrl+S 保存当前编辑面」、「未保存改动在切走前的守卫」、「退出应用前的未保存处置」。

## Impact

- 组件：`RequestEditor.tsx`（`KeyValueTable`、`FormDataEditor`）、`VariablesPanel.tsx`、`EntityScriptPanel.tsx`、`SettingsPanel.tsx`、`App.tsx`（操作行、会话标签、守卫、快捷键）。
- 新增纯逻辑：编辑面注册表（导出即可单测）、空行清洗函数、待执行意图的执行分离；窗口控制器走注入，测试可替换。
- 后端：`src-tauri/security_audit.rs` 的权限白名单与注释；以及上面那条缺陷修复所在的 `src-tauri/src/error.rs`（分类函数的入参多一个「最内层 `io::Error` 的原始错误码」，并新增 3 条单元测试）。不改任何命令面、存储结构或网络行为。
- 配置：`src-tauri/capabilities/default.json` 增加一项权限；`src-tauri/gen/schemas/capabilities.json` 需重新构建生成以与源文件一致。
- 测试：`tests/app.test.tsx` 新增用例（幽灵行物化、出口清洗、Ctrl+S 路由、守卫三选一与保存失败不前进、窗口关闭），并迁移依赖「保存」按钮文案的既有断言；`npm test`、`npx tsc --noEmit`、`npm run build`、`cargo test` 需全绿。
- 依赖：不新增任何依赖。
