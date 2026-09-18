// 应用窗口的控制口。
//
// 「退出应用前的未保存处置」需要拦截主窗口的关闭请求，并在用户确认后真正关闭
// 窗口。直接 import `@tauri-apps/api/window` 会让测试与浏览器预览都用不到真实现，
// 因此与命令层一样走注入（`App` 的 `windowCloser` prop）。
//
// 两个必须记住的事实：
// - `core:window:default` 不含 `allow-close` / `allow-destroy`，真正关窗需要
//   `core:window:allow-destroy`（见 capabilities/default.json 与 security_audit.rs）；
// - `onCloseRequested` 在 handler 未 `preventDefault()` 时会自行调用 `destroy()`，
//   这里改为**永远自己 preventDefault**，由 handler 的返回值决定是否关窗，
//   顺序完全由我们掌握。

export interface WindowCloser {
  /**
   * 挂上关闭请求的拦截。`handler` 返回 true 表示允许关闭（实现方负责真正关窗），
   * 返回 false 表示窗口保持打开。返回解绑函数。
   */
  onCloseRequested(handler: () => Promise<boolean>): Promise<() => void>;
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export const tauriWindowCloser: WindowCloser = {
  async onCloseRequested(handler) {
    if (!inTauri()) return () => {};

    // 动态 import：非 Tauri 环境（浏览器预览、测试）根本不加载它
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const current = getCurrentWindow();

    return current.onCloseRequested(async (event) => {
      event.preventDefault();
      if (await handler()) await current.destroy();
    });
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
