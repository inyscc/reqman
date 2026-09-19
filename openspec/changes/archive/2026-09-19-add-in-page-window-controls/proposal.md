# 提案：把窗口控制做进页面（add-in-page-window-controls）

## Why

窗口的最小化 / 最大化 / 关闭三个按钮目前由操作系统原生标题栏提供，悬浮在应用内容之上，与应用自身的浅色紧凑风格脱节，也占据了顶部一整层空间。把窗口 chrome 收进页面后，界面更统一（对齐 Postman 一类自绘标题栏的桌面应用），且关闭入口可以与既有的未保存守卫自然汇合。

## What Changes

- **去掉原生窗口装饰**：主窗口改为 `decorations: false`，原生标题栏（含顶部边框）不再渲染，会话标签行成为事实上的标题栏。
- **页面内窗口控制按钮**：会话标签行最右、环境选择器的右侧新增三个按钮——最小化、最大化 / 还原、关闭。最大化按钮按窗口实际状态切换图标。
- **关闭汇入既有守卫**：页面内的关闭按钮复用「退出应用前的未保存处置」三选一守卫，语义与 Alt+F4 完全一致；无未保存改动时直接关闭。守卫语义本身不变。
- **拖拽区**：会话标签行整行作为窗口拖拽区；其中的交互控件（环境选择器、窗口控制按钮、标签关闭按钮）标记为不可拖拽。
- **自绘边缘缩放**：原生装饰移除会连带丢掉 Windows 的边缘缩放手柄，用窗口四周的透明窄条 + `startResizeDragging` 重新提供，不引入第三方插件。
- **能力与审计同步**：`capabilities/default.json` 新增一组具名的 `core:window:allow-*` 权限，`security_audit.rs` 的权限白名单同步扩展并注明理由（本项目把能力扩张当作受审计行为）。

## Capabilities

### New Capabilities

- `window-chrome`: 窗口外观与控制——页面内窗口控制按钮、原生装饰移除、会话标签行拖拽区、自绘边缘缩放，以及页面内关闭按钮与未保存守卫的汇合。

### Modified Capabilities

- `ui-layout`: 「会话标签视觉壳」需求修订——该行最右端保留给窗口控制按钮（行为由 `window-chrome` 定义）；「退出应用前的未保存处置」补充场景——页面内的关闭按钮触发同一守卫。

## Impact

- **Rust**：`src-tauri/src/lib.rs`（窗口 builder 加 `decorations(false)`）；`src-tauri/capabilities/default.json`（新增窗口权限）；`src-tauri/src/security_audit.rs`（权限白名单扩展）。
- **前端**：`src/lib/window.ts`（`WindowCloser` 扩展 `close` / `minimize` / `toggleMaximize` / 边缘缩放与最大化状态查询，保持可注入）；`src/App.tsx`（会话标签行新增按钮、`exit-app` 收尾统一）；`src/App.css`（拖拽区、按钮样式、缩放边条）。
- **测试**：vitest 侧沿用 `windowCloser` 注入架构补假实现与新用例；浏览器 / 真机侧需人工验证拖拽与缩放手势。
- **依赖**：不引入任何新第三方依赖。
