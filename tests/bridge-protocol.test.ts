// 桥的消息校验（任务 3.6）。
//
// 这里用假沙箱（vi.mock）替代真实 postman-sandbox：目的不是验证沙箱行为（那由
// script-phase.test.ts 用真沙箱覆盖），而是验证**宿主侧的协议边界**——
//
//   1. 宿主注册的事件名是有限具名集合（BRIDGE_EVENTS）的成员，没有通配、没有额外分支；
//   2. 伪造的载荷（执行 id 不匹配、事件 id 缺失）被忽略——不触达后端、不回响应；
//   3. 合法载荷照常放行——校验不过度拦截。
//
// 依据不是「没人发协议外事件」：1.2 查明 uvm 宿主侧的 forwardEmits 不过滤事件名，
// `__uvm_emit` 被删除只说明此刻没人能写，协议边界必须由宿主自己守。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_EVENTS, runScriptPhase } from '../src/lib/scriptRuntime';
import type { Commands } from '../src/lib/commands';

type Handler = (...args: unknown[]) => void;

/** 假沙箱的可控状态；vi.mock 的工厂在提升后执行，经 vi.hoisted 保证可达。 */
const state = vi.hoisted(() => ({
  /** 宿主注册的全部事件分支。 */
  handlers: new Map<string, Handler[]>(),
  /** 宿主向沙箱派发的全部事件。 */
  dispatched: [] as unknown[][],
  /** 每次execute 的行为，由用例注入；默认同步完成。 */
  execute: null as unknown as
    | null
    | ((
        target: unknown,
        options: { id?: string },
        callback: (error: Error | null, result?: unknown) => void,
      ) => void),
}));

vi.mock('postman-sandbox', () => ({
  default: {
    createContext: (callback: (error: Error | null, context: unknown) => void) => {
      callback(null, {
        on: (name: string, handler: Handler) => {
          const list = state.handlers.get(name) ?? [];
          list.push(handler);
          state.handlers.set(name, list);
        },
        execute: (
          target: unknown,
          options: { id?: string },
          callback: (error: Error | null, result?: unknown) => void,
        ) => {
          if (state.execute) {
            state.execute(target, options, callback);
            return;
          }
          callback(null, {});
        },
        dispatch: (...args: unknown[]) => {
          state.dispatched.push(args);
        },
        dispose: (callback: () => void) => callback(),
      });
    },
  },
}));

function fakeCommands() {
  const sendRequest = vi.fn(async () => {
    throw new Error('不应触达后端');
  });
  const commands = {
    sendRequest,
    settingsGet: async () => null,
    settingsSet: async () => undefined,
    globalsList: async () => [],
    variableList: async () => [],
    globalsSet: async () => {
      throw new Error('不应写回');
    },
    variableSet: async () => {
      throw new Error('不应写回');
    },
    secretReveal: async () => {
      throw new Error('不应揭示');
    },
  };

  return { commands: commands as unknown as Commands, sendRequest };
}

const target = { workspaceId: 'w1', collectionId: 'c1', environmentId: 'e1' };

beforeEach(() => {
  state.handlers.clear();
  state.dispatched = [];
  state.execute = null;
});

describe('桥的消息校验（3.6）', () => {
  it('宿主注册的事件名是有限具名集合的成员，没有通配分支', async () => {
    const { commands } = fakeCommands();

    await runScriptPhase(commands, target, 'prerequest', ['console.log("x");']);

    const names = [...state.handlers.keys()];
    // console + 断言 + 一段脚本的请求出口 + Cookie 仓库
    expect(names).toHaveLength(4);
    expect(names).toContain(BRIDGE_EVENTS.console);
    expect(names).toContain(BRIDGE_EVENTS.assertion);
    expect(names.filter((name) => name.startsWith('execution.request.'))).toHaveLength(1);
    expect(names.filter((name) => name.startsWith('execution.cookies.'))).toHaveLength(1);
    // 没有通配符或协议外名字
    for (const name of names) {
      expect(name, '事件名必须是协议成员').toMatch(
        /^(console|execution\.assertion|execution\.request\.[A-Za-z0-9-]+|execution\.cookies\.[A-Za-z0-9-]+)$/,
      );
      expect(name).not.toContain('*');
    }
  }, 30_000);

  it('执行 id 不匹配的请求事件被忽略，不触达后端', async () => {
    const { commands, sendRequest } = fakeCommands();

    state.execute = (_target, options, callback) => {
      const id = options.id as string;

      // 伪事件：事件名借本执行 id 之名，载荷却声称来自别的执行
      const handler = state.handlers.get(BRIDGE_EVENTS.sendRequest(id))?.[0];
      handler?.({ execution: id }, 'forged-exec-id', 1, {
        url: 'https://evil.test/x',
        method: 'GET',
      });

      callback(null, {});
    };

    const result = await runScriptPhase(commands, target, 'prerequest', ['1;']);
    // 脚本本身无错；伪造的请求被静默忽略
    expect(result.error).toBeNull();
    expect(sendRequest).not.toHaveBeenCalled();
  }, 30_000);

  it('事件 id 缺失的请求事件被忽略，不触达后端', async () => {
    const { commands, sendRequest } = fakeCommands();

    state.execute = (_target, options, callback) => {
      const id = options.id as string;
      const handler = state.handlers.get(BRIDGE_EVENTS.sendRequest(id))?.[0];
      handler?.({ execution: id }, id, undefined, { url: 'https://x.test/x', method: 'GET' });

      callback(null, {});
    };

    await runScriptPhase(commands, target, 'prerequest', ['1;']);
    expect(sendRequest).not.toHaveBeenCalled();
  }, 30_000);

  it('console 的对象参数按结构呈现，而不是 [object Object]（10.4 顺带）', async () => {
    // 沙箱送来的参数是**结构化的**（实测），因此呈现层不该一律 String()：
    // 那会把对象压成 [object Object]、把数组压成 '1,2'。
    const { commands } = fakeCommands();

    state.execute = (_target, _options, callback) => {
      state.handlers
        .get(BRIDGE_EVENTS.console)?.[0]?.({}, 'log', { a: 1, nested: { b: [1, 2] } }, [1, 2], 42);
      callback(null, {});
    };

    const result = await runScriptPhase(commands, target, 'prerequest', ['1;']);

    expect(result.console[0].args).toEqual(['{"a":1,"nested":{"b":[1,2]}}', '[1,2]', '42']);
  }, 30_000);

  it('后端失败时交给脚本的是可读原因，而不是 [object Object]（10.4 实机发现）', async () => {
    // Tauri 命令失败时拒绝给的是**普通对象** `{ code, message }`，不是 Error 实例。
    // 桥的错误出口若只认 `instanceof Error`，脚本侧 `err.message` 会拿到 `[object Object]`
    // ——真机冒烟里 `pm.sendRequest` 打不通时的表现就是这样（10.4 记录）。
    const sendRequest = vi.fn(async () => {
      throw { code: 'dns_failure', message: '不知道这样的主机。 (os error 11001)' };
    });
    const commands = {
      sendRequest,
      settingsGet: async () => null,
      settingsSet: async () => undefined,
      globalsList: async () => [],
      variableList: async () => [],
    } as unknown as Commands;

    state.execute = (_target, options, callback) => {
      const id = options.id as string;
      state.handlers
        .get(BRIDGE_EVENTS.sendRequest(id))?.[0]?.({ execution: id }, id, 3, {
          url: 'http://probe.invalid/x',
          method: 'GET',
        });

      callback(null, {});
    };

    await runScriptPhase(commands, target, 'prerequest', ['1;']);

    await vi.waitFor(() => expect(state.dispatched.length).toBe(1));
    // 派发形状：(事件名, 事件 id, 错误, 响应, 历史)
    expect(state.dispatched[0][1]).toBe(3);
    expect(state.dispatched[0][2]).toEqual({ message: '不知道这样的主机。 (os error 11001)' });
  }, 30_000);

  it('合法载荷照常放行：到达后端、事件 id 原样回传', async () => {
    const sendRequest = vi.fn(async () => {
      throw new Error('用例只关心出口被触达');
    });
    const commands = {
      sendRequest,
      settingsGet: async () => null,
      settingsSet: async () => undefined,
      globalsList: async () => [],
      variableList: async () => [],
    } as unknown as Commands;

    let dispatchedId: string | null = null;

    state.execute = (_target, options, callback) => {
      const id = options.id as string;
      dispatchedId = id;
      const handler = state.handlers.get(BRIDGE_EVENTS.sendRequest(id))?.[0];
      handler?.({ execution: id }, id, 7, { url: 'https://api.test/x', method: 'GET' });

      callback(null, {});
    };

    await runScriptPhase(commands, target, 'prerequest', ['1;']);

    // 校验没有过度拦截：出口被触达一次
    await vi.waitFor(() => expect(sendRequest).toHaveBeenCalledTimes(1));
    // 响应派发回本执行 id，事件 id 原样带回（沙箱靠它配对回调）
    await vi.waitFor(() => expect(state.dispatched.length).toBe(1));
    expect(state.dispatched[0][0]).toBe(`execution.response.${dispatchedId}`);
    expect(state.dispatched[0][1]).toBe(7);
  }, 30_000);
});
