// 应用窗口的控制口。
//
// 「退出应用前的未保存处置」需要拦截主窗口的关闭请求，并在用户确认后真正关闭
// 窗口。直接 import `@tauri-apps/api/window` 会让测试与浏览器预览都用不到真实现，
// 因此与命令层一样走注入（`App` 的 `windowCloser` prop）。
//
// 页面内的最小化 / 最大化 / 关闭、拖拽移动与自绘边缘缩放也全部经由这里
// （change: add-in-page-window-controls）——同样保持可注入，测试用假实现替换。
//
// 两个必须记住的事实：
// - `core:window:default` 不含 `allow-close` / `allow-destroy`，真正关窗需要
//   `core:window:allow-destroy`（见 capabilities/default.json 与 security_audit.rs）；
// - `onCloseRequested` 在 handler 未 `preventDefault()` 时会自行调用 `destroy()`，
//   这里改为**永远自己 preventDefault**，由 handler 的返回值决定是否关窗，
//   顺序完全由我们掌握。

// 与 @tauri-apps/api/window 内部（未导出）的 ResizeDirection 同构：
// 结构化类型兼容，可直接传给 startResizeDragging。
export type ResizeDirection =
  | 'East'
  | 'North'
  | 'NorthEast'
  | 'NorthWest'
  | 'South'
  | 'SouthEast'
  | 'SouthWest'
  | 'West';

export interface WindowCloser {
  /**
   * 挂上关闭请求的拦截。`handler` 返回 true 表示允许关闭（实现方负责真正关窗），
   * 返回 false 表示窗口保持打开。返回解绑函数。
   */
  onCloseRequested(handler: () => Promise<boolean>): Promise<() => void>;
  /**
   * 守卫放行后真正关窗（destroy）。原生关闭事件的路径在 `onCloseRequested`
   * 的实现里自行 destroy；页面内关闭按钮没有事件可 resolve，走这里。
   */
  close(): Promise<void>;
  /** 最小化窗口。 */
  minimize(): Promise<void>;
  /** 最大化 / 还原切换（一个入口覆盖两个方向）。 */
  toggleMaximize(): Promise<void>;
  /** 从会话标签行开始拖拽移动窗口（手动处理器方案，见 change design D5）。 */
  startDragging(): Promise<void>;
  /** 自绘边缘缩放：从指定方向开始原生缩放拖拽（design D6）。 */
  startResizeDragging(direction: ResizeDirection): Promise<void>;
  /** 窗口当前是否最大化；非 Tauri 环境恒为 false。 */
  isMaximized(): Promise<boolean>;
  /** 订阅窗口尺寸变化（最大化 / 还原图标跟随真实状态），返回解绑函数。 */
  onResized(handler: () => void): Promise<() => void>;
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Tauri Window 的惰性单例；非 Tauri 环境（浏览器预览、测试）恒为 null。 */
let windowPromise: Promise<import('@tauri-apps/api/window').Window | null> | null = null;
function tauriWindow() {
  if (!inTauri()) return Promise.resolve(null);
  // 动态 import：非 Tauri 环境（浏览器预览、测试）根本不加载它
  windowPromise ??= import('@tauri-apps/api/window').then((module) => module.getCurrentWindow());
  return windowPromise;
}

export const tauriWindowCloser: WindowCloser = {
  async onCloseRequested(handler) {
    const current = await tauriWindow();
    if (!current) return () => {};

    return current.onCloseRequested(async (event) => {
      event.preventDefault();
      if (await handler()) await current.destroy();
    });
  },

  async close() {
    const current = await tauriWindow();
    await current?.destroy();
  },

  async minimize() {
    const current = await tauriWindow();
    await current?.minimize();
  },

  async toggleMaximize() {
    const current = await tauriWindow();
    await current?.toggleMaximize();
  },

  async startDragging() {
    const current = await tauriWindow();
    await current?.startDragging();
  },

  async startResizeDragging(direction) {
    const current = await tauriWindow();
    await current?.startResizeDragging(direction);
  },

  async isMaximized() {
    const current = await tauriWindow();
    return current ? current.isMaximized() : false;
  },

  async onResized(handler) {
    const current = await tauriWindow();
    if (!current) return () => {};
    return current.onResized(() => handler());
  },
};

/**
 * 页面重载的兜底拦截。
 *
 * `CloseRequested` 只覆盖窗口关闭，重载（Ctrl+R、开发期整页刷新）不走它。
 * 这里只能借用浏览器的原生确认提示——文案不可控、也没有「保存」选项，因此
 * spec 只承诺「不静默丢弃」。`handler` 返回 true 表示有未保存内容，需要提示。
 */
export function onBeforeUnload(handler: () => boolean): () => void {
  const listener = (event: BeforeUnloadEvent) => {
    if (!handler()) return;
    event.preventDefault();
    // 部分环境仍要求设置 returnValue 才会提示
    event.returnValue = '';
  };

  window.addEventListener('beforeunload', listener);
  return () => window.removeEventListener('beforeunload', listener);
}
