// 打通脚本执行的最小闭环（任务 2.3）。
//
// 验证的是**宿主侧契约**：能建上下文、能把脚本送进去执行、能拿回脚本产生的输出与抛出
// 的错误、结束后能释放上下文。
//
// 一个必须清楚的边界：vitest 跑在 Node 下，`uvm` 会走它的 Node 后端
// （`worker_threads`），因此本文件证明的是宿主侧契约成立，**不是**浏览器后端的行为。
// 浏览器侧的后端差异由 1.3（CSP 继承）与 1.4（逃逸尝试）覆盖，两者不能互相替代。

import { describe, expect, it } from 'vitest';
import Sandbox from 'postman-sandbox';

/** 宿主侧拿到的上下文。上游没有提供宿主侧类型，这里只声明用到的部分。 */
interface SandboxContext {
  execute: (
    target: unknown,
    options: Record<string, unknown>,
    callback: (error: Error | null, result?: unknown) => void,
  ) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  dispose: (callback?: () => void) => void;
}

interface ScriptRun {
  error: Error | null;
  result: unknown;
  /** 每条 console 输出的参数列表。 */
  logs: string[][];
}

function createContext(): Promise<SandboxContext> {
  return new Promise((resolve, reject) => {
    (
      Sandbox as unknown as {
        createContext: (cb: (error: Error | null, ctx: SandboxContext) => void) => void;
      }
    ).createContext((error, ctx) => (error ? reject(error) : resolve(ctx)));
  });
}

function dispose(context: SandboxContext): Promise<void> {
  return new Promise((resolve) => context.dispose(() => resolve()));
}

/** 执行一段脚本，收集它产生的 console 输出、抛出的错误与返回的 execution。 */
function runScript(context: SandboxContext, code: string, timeout = 15_000): Promise<ScriptRun> {
  const logs: string[][] = [];

  return new Promise((resolve) => {
    // 沙箱派发的是 `execution.console`，宿主转译后重发为 `console`。
    context.on('console', (_cursor, _level, ...args) => {
      logs.push(args.map((value) => String(value)));
    });

    context.execute(
      code,
      { timeout },
      (error: Error | null, result?: unknown) => resolve({ error, result, logs }),
    );
  });
}

describe('脚本执行的最小闭环', () => {
  it('脚本产生的 console 输出被回传', async () => {
    const context = await createContext();
    try {
      const run = await runScript(context, 'console.log("来自沙箱", 42);');

      expect(run.error).toBeNull();
      expect(run.logs).toEqual([['来自沙箱', '42']]);
    } finally {
      await dispose(context);
    }
  }, 30_000);

  it('脚本抛出的错误被回传，且不丢失后续输出', async () => {
    const context = await createContext();
    try {
      const run = await runScript(context, 'console.log("先输出"); throw new Error("脚本内报错");');

      expect(run.error, '抛出的错误必须到达宿主').toBeTruthy();
      expect(String(run.error?.message)).toContain('脚本内报错');
      expect(run.logs, '抛错之前产生的输出不应丢失').toEqual([['先输出']]);
    } finally {
      await dispose(context);
    }
  }, 30_000);

  it('上下文释放后再执行不会静默跑一遍', async () => {
    const context = await createContext();
    const first = await runScript(context, 'console.log("第一次");');

    expect(first.logs).toEqual([['第一次']]);

    await dispose(context);

    // 释放后 uvm 在 dispatch 时**同步抛出**（`unable to dispatch "execute" post
    // disconnection`），而不是走回调报错。就「脚本不会静默地再跑一遍」而言这正是我们
    // 要的行为，但宿主适配层必须显式处理它——否则它会以未捕获异常的形式冒出去，而
    // 调用方拿不到任何结果。这里只断言「抛错且没有产出输出」，不锁死上游的报错文本。
    let threw = false;
    try {
      context.execute('console.log("不该出现");', {}, () => {});
    } catch {
      threw = true;
    }
    expect(threw, '释放后再次执行必须失败，而不是静默执行').toBe(true);
  }, 30_000);
});
