// `postman-sandbox` 只随包提供沙箱**内部**的类型（`types/index.d.ts`），宿主侧没有声明。
// 这里补一份最小声明：只描述 `src/lib/scriptRuntime.ts` 真正用到的那部分，不试图描述
// 整个模块——后者会随上游版本漂移，反而成为负担。
declare module 'postman-sandbox' {
  /** 宿主侧拿到的沙箱上下文。 */
  export interface SandboxContext {
    execute(
      target: unknown,
      options: Record<string, unknown>,
      callback: (error: Error | null, execution?: unknown) => void,
    ): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
    /** 向沙箱派发事件——`pm.sendRequest` 的响应要靠它送回去。 */
    dispatch(event: string, ...args: unknown[]): void;
    dispose(callback?: () => void): void;
  }

  const Sandbox: {
    createContext(
      callback: (error: Error | null, context: SandboxContext) => void,
    ): void;
  };

  export default Sandbox;
}
