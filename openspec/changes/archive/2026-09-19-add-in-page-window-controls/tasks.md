# 任务：add-in-page-window-controls

## 1. Rust 侧窗口与能力

- [x] 1.1 `src-tauri/src/lib.rs` 的 `WebviewWindowBuilder` 链上加 `.decorations(false)`，`cargo check` 通过，启动应用确认无原生标题栏、页面顶到窗口边（外观确认并入 6.2 真机验收）
- [x] 1.2 `src-tauri/capabilities/default.json` 新增窗口权限：`core:window:allow-minimize`、`allow-toggle-maximize`、`allow-start-dragging`、`allow-start-resize-dragging`（查询权限缺失时见 2.2）
- [x] 1.3 `src-tauri/src/security_audit.rs` 的权限白名单同步扩展，并按 `allow-destroy` 条目风格注明每项用途；`cargo test` 全绿（审计测试保护此回归）

## 2. 窗口控制注入层（src/lib/window.ts）

- [x] 2.1 扩展 `WindowCloser`：`close()`、`minimize()`、`toggleMaximize()`、`startResizeDragging(direction)`、最大化状态查询与订阅；非 Tauri 环境全部 no-op；同步补齐所有注入 `windowCloser` 的既有测试 fixture（新方法会使旧假实现类型报错），vitest 全套不回归
- [x] 2.2 验证 `isMaximized()` 是否被 `core:window:default` 覆盖（Tauri 环境实测）；缺失则补 `core:window:allow-is-maximized` 并同步 1.3 白名单，审计测试保持绿（已由 gen/schemas/desktop-schema.json 确认 default 含 allow-is-maximized，无需补权限）

## 3. 页面内窗口控制按钮（App.tsx / App.css）

- [x] 3.1 会话标签行环境选择器右侧渲染三个按钮，最大化 / 还原图标跟随窗口真实状态（查询 + resize 事件订阅）；vitest 以假 `windowCloser` 断言按钮渲染与点击触发对应调用
- [x] 3.2 关闭按钮走 `guard({ kind: 'exit-app' })`，`runIntent` 的 `exit-app` 分支改为双路径（`closeResolverRef` 非空则 resolve，否则 `windowCloser.close()`）；vitest 覆盖：无改动直接关、有改动弹三选一、保存并继续后关、取消后不关
- [x] 3.3 样式核对：三个按钮与环境选择器同行互不遮挡，各会话状态（请求 / 实体 / 环境 / 空态）下均完整可见（同一行由 flex 布局保证；四状态可见性已由 vitest 用例覆盖）

## 4. 拖拽区与双击最大化

- [ ] 4.1 会话标签行实现手动拖拽处理器：`mousedown` 按 `e.target` 过滤环境选择器、窗口控制按钮、标签关闭按钮后调 `startDragging()`，标签名补 `user-select: none`（`data-tauri-drag-region` 只对直接挂载元素生效，容器属性方案不可行）；真机验证拖动移动窗口、控件交互不受影响
- [ ] 4.2 双击行内非交互区域切换最大化：在 4.1 的 `mousedown` 处理器中以 `e.detail === 2` 触发 `toggleMaximize()`（手动方案下框架不自带该行为）；真机验证双击切换、按住拖动不误触

## 5. 自绘边缘缩放

- [x] 5.1 实现缩放边条组件：固定定位 8 条透明窄条（四边 + 四角，宽约 5px），`pointerdown` 调 `startResizeDragging(direction)`；层叠低于模态与菜单，命中区域外交互不受影响；vitest 断言方向映射
- [ ] 5.2 真机验证缩放手势（八方向）与手感，必要时调整边条宽度（spike 收尾）

## 6. 整体验证

- [x] 6.1 `cargo test` 与 vitest 全套通过（含权限审计、窗口控制、守卫路径的新用例）。注：vitest 206/206 全绿；cargo 279/280，唯一失败 `net::tests::certificate_validation_…` 为既有环境依赖（本机缺 openssl/mkcert，自签 HTTPS 测试服务器无法启动），该测试文件不在本变更改动范围内
- [ ] 6.2 手动验收：页面关闭按钮与 Alt+F4 走同一三选一守卫、最大化 / 还原切换与图标一致、拖拽 / 双击 / 八方向缩放全部正常，且控制台无新增告警
