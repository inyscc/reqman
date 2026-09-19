# 设计：add-in-page-window-controls

## Context

- 主窗口在 `src-tauri/src/lib.rs` 的 `setup` 中用 `WebviewWindowBuilder` 代码创建（这是导航守卫的既有约束，`security_audit.rs::window_is_created_in_code_so_the_navigation_guard_applies` 钉住），未设置 `decorations`，因此三个窗口控制按钮来自原生标题栏。
- 前端已有窗口控制注入点 `src/lib/window.ts`（`WindowCloser`，`App` 的 `windowCloser` prop），vitest 用假实现替换真实 Tauri IPC；`App.tsx` 已有 `exit-app` 的 `PendingIntent` 与 `closeResolverRef`，未保存守卫对 Alt+F4 已生效。
- `src-tauri/src/security_audit.rs` 用硬白名单断言权限清单，能力扩张必须同步修改白名单并注明理由。
- 项目姿态：不引入第三方 Tauri 插件；能力最小化。

## Goals / Non-Goals

**Goals:**

- 页面内三个窗口控制按钮（最小化 / 最大化还原 / 关闭），位于会话标签行最右端。
- 会话标签行承载拖拽与双击最大化；窗口四边四角提供自绘缩放手势。
- 页面内关闭与 Alt+F4 汇入同一条未保存守卫路径。
- 新增权限全部具名、受审计、不引入通用能力。

**Non-Goals:**

- 不改未保存守卫的语义（沿用现状：仅在有未保存改动时提示）。
- 不做侧栏区域的拖拽扩展（用户已接受局部无拖拽区）。
- 不做窗口位置 / 尺寸的持久化、多窗口、深色标题栏或主题化 chrome。
- 不引入第三方窗口装饰插件。

## Decisions

### D1：`decorations(false)` 设在 Rust builder 上

窗口必须在代码中创建（导航守卫约束），`decorations: false` 自然落在 `WebviewWindowBuilder` 链上。备选：`tauri.conf.json` 静态配置——但 `windows: []` 是被审计钉住的现状，不改。

### D2：权限集与审计同步

新增（预期）：`core:window:allow-minimize`、`core:window:allow-toggle-maximize`（一个按钮做最大化 / 还原切换，对应 `toggleMaximize()`；不需要 `allow-maximize` + `allow-unmaximize` 的拆分组合）、`core:window:allow-start-dragging`、`core:window:allow-start-resize-dragging`。`isMaximized()` 这类只读查询预期已被 `core:window:default` 覆盖，实现时验证，若缺则补 `core:window:allow-is-maximized` 并同步白名单。`security_audit.rs` 白名单逐项扩展，注释沿用 `allow-destroy` 条目的风格写明用途与边界（不读文件、不发网络、不执行命令）。

### D3：扩展 `WindowCloser` 而不是新建注入点

`windowCloser` 已是测试注入的既有通道，直接扩展：`close()`（真正销毁窗口）、`minimize()`、`toggleMaximize()`、`startResizeDragging(direction)`、最大化状态查询与订阅（初始化查询 + resize 事件监听维护状态，供按钮图标切换）。非 Tauri 环境全部返回 no-op，与现有实现一致。备选：新建 `WindowControls` 注入点——会让测试的假实现翻倍，无收益。

### D4：关闭路径统一

```
Alt+F4 ───────> onCloseRequested ─┐
                                  ├─> guard(exit-app) ─> 有脏面? 三选一 : 直接关
页面关闭按钮 ─> guard(exit-app) ───┘         │ 允许关：
                                             │   closeResolverRef 非空 → resolve(true)
                                             │     （原生事件处理器自行 destroy，现状不变）
                                             │   否则 → windowCloser.close()
```

`runIntent` 的 `exit-app` 分支从「只 resolve 回调」改为上述双路径。两条入口共享同一守卫与同一收尾，不新增守卫语义。

### D5：拖拽与双击最大化

`data-tauri-drag-region` 只对直接挂载它的元素生效、子元素不继承（官方文档明示），而会话标签行最大的空白区恰是子元素 `.grow` span，"容器挂属性 + 子元素 no-drag" 的假设不成立。采用官方文档的「手动实现」路径：在行上监听 `mousedown`，按 `e.target` 过滤交互控件（环境选择器、窗口控制按钮、标签关闭按钮及其容器）后调 `startDragging()`；`e.detail === 2`（双击）时调 `toggleMaximize()`。备选的逐元素挂属性方案零散易漏，弃。会话标签行内没有文本输入框，不存在拖拽与文本选择冲突；标签名补 `user-select: none`。

### D6：缩放边条为一个纯视图组件

固定定位的 8 条透明窄条（四边 + 四角，宽约 5px）贴窗口内沿，`pointerdown` → `startResizeDragging(direction)`。层叠顺序低于模态（`.modal-backdrop` z-index 20）与菜单，避免拦截弹层；命中区域外的控件交互不受影响。备选 `tauri-plugin-decorum`——引入第三方依赖，与审计姿态冲突，弃。

### D7：布局适配

去装饰后页面顶到窗口边：`.session-bar` 作为标题栏适当加高内边距即可，不改 `.app` 网格结构；最大化时 Tauri 自行处理工作区边界，无需前端 padding 补偿。

## Risks / Trade-offs

- [WebView2 下 `startResizeDragging` 的手感与命中宽度] → 实现后真机验证（列为 spike 任务），必要时调整边条宽度。
- [`isMaximized` 查询是否被 `core:window:default` 覆盖] → 实现期验证（任务 2.2）；缺则补 `allow-is-maximized` 并同步白名单。
- [缩放边条与窗口边缘滚动条重叠] → 全局滚动条 6px 贴容器右缘，与边条重叠，滚动条最外侧几像素会成为缩放手势；边条收窄到约 5px，接受小面积冲突并真机确认手感。
- [Win11 Snap Layouts 丢失] → 自绘最大化按钮拿不到悬停布局弹窗，属可接受取舍。
- [`WindowCloser` 扩展使现有测试假实现类型报错] → 任务 2.1 同步补齐所有注入 `windowCloser` 的 fixture。
- [审计测试在权限同步前会红] → 权限与白名单在同一 change 内成对修改，审计测试本身即是回归保护。
- [失圆角与阴影] → Windows 无装饰窗口为直角无阴影，属预期取舍；如需观感可后续用 CSS 处理，不在本变更内。
- [页面内关闭绕过 `onCloseRequested` 可能产生双销毁] → D4 的双路径互斥（resolve 或 `close()` 二选一），测试覆盖两条入口。

## Migration Plan

单次落地，无数据迁移；回滚即还原 builder 参数、权限清单与前端按钮，无持久化残留。

## Open Questions

无。剩余不确定项（查询权限覆盖、双击行为、缩放手感）均为实现期验证项，不改变 spec、方案或任务拆分。
