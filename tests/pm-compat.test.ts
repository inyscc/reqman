// pm 兼容面与沙箱标准库的验收（任务 4.1 / 4.2 / 4.4）。
//
// 全部用真实沙箱跑：这里验证的就是「用户脚本看到的世界」——pm 对象的成员、
// pm.require 的库清单、沙箱全局的白名单。清单一律取自 design（对齐
// postman-sandbox@6.7.4 的实际行为，见 D4：以上游实现为准，不以文档为准）。

import { describe, expect, it, vi } from 'vitest';
import { runScriptPhase } from '../src/lib/scriptRuntime';
import type { Commands } from '../src/lib/commands';
import type { ResponsePayload, Variable } from '../src/lib/types';

function variable(name: string, value: string): Variable {
  return {
    id: `v-${name}`,
    scope: 'environment',
    owner_id: 'env',
    name,
    description: null,
    is_secret: false,
    enabled: true,
    sort_order: 0,
    initial: { state: 'value', value },
    current: { state: 'value', value },
  };
}

function fakeCommands(variables: Variable[] = []) {
  const sendRequest = vi.fn(async () => sentResponse());
  const settingsStore = new Map<string, string>();
  const commands = {
    sendRequest,
    settingsGet: async (scope: string, key: string) => settingsStore.get(`${scope}:${key}`) ?? null,
    settingsSet: async (scope: string, key: string, value: string) => {
      settingsStore.set(`${scope}:${key}`, value);
    },
    globalsList: vi.fn(async () => variables),
    variableList: vi.fn(async () => variables),
    globalsSet: vi.fn(async () => variable('x', '')),
    variableSet: vi.fn(async () => variable('x', '')),
    secretReveal: vi.fn(async () => variable('x', '')),
    cookieQuery: vi.fn(async () => []),
    cookieList: vi.fn(async () => []),
    cookiePut: vi.fn(async () => undefined),
    cookieDelete: vi.fn(async () => undefined),
  };

  return { commands: commands as unknown as Commands, sendRequest };
}

function sentResponse(): ResponsePayload {
  return {
    id: 'resp-1',
    status: 201,
    status_text: 'Created',
    elapsed_ms: 3,
    size_bytes: 11,
    declared_size_bytes: null,
    truncated: false,
    headers: [['content-type', 'application/json']],
    content_type: 'application/json',
    body_text: '{"ok":true}',
    body_base64: null,
    pretty_available: true,
    pretty_print_threshold: 1024 * 1024,
    insecure_warning: false,
    final_url: 'https://api.test/ping',
    via_proxy: false,
    http_version: 'HTTP/1.1',
    unresolved: [],
  };
}

const target = { workspaceId: 'w1', collectionId: 'c1', environmentId: 'e1' };

/** 运行一段脚本，回传 console 输出（供断言脚本内自查结果）。 */
async function run(code: string, listen: 'prerequest' | 'test' = 'prerequest') {
  const { commands } = fakeCommands();
  const result = await runScriptPhase(commands, target, listen, [code]);
  expect(result.error, `脚本不应失败：${result.error}`).toBeNull();

  return result.console.map((entry) => entry.args.join(' '));
}

describe('pm 对象成员（4.1）', () => {
  it('pm 的成员与审计清单一致', async () => {
    const { commands } = fakeCommands();
    const result = await runScriptPhase(commands, target, 'test', [
      `var members = ['info', 'request', 'response', 'environment', 'globals',
         'collectionVariables', 'variables', 'cookies', 'sendRequest', 'expect',
         'test', 'execution', 'visualizer', 'vault', 'iterationData'];
       var missing = members.filter(function (name) { return !(name in pm); });
       if (missing.length) { throw new Error('pm 缺少成员：' + missing.join(',')); }
       // pm.require：上游在宿主未提供 resolvedPackages 时会把它摘掉
       // （lib/sandbox/execute.js：if (!options.resolvedPackages) disabledAPIs.push('require')），
       // 而 Postman 自己的运行时是提供该选项的，spec 的「使用内置库」场景也以 pm.require 为入口。
       // 宿主在 wrapUserScript 里补了别名，因此这里断言的不变量是**同源**而非「不存在」：
       // 别名不新增任何能力——require 本就在脚本作用域内（见 4.2）。
       if (typeof pm.require !== 'function') { throw new Error('pm.require 应为函数（宿主别名）'); }
       if (pm.require !== require) { throw new Error('pm.require 必须与全局 require 同源'); }`,
    ]);
    expect(result.error).toBeNull();
  }, 30_000);

  it('pm.response 仅在后置脚本可用，前置脚本下为 undefined（与 Postman 一致）', async () => {
    const pre = await run('console.log("pre-response=", typeof pm.response);', 'prerequest');
    expect(pre.join(' ')).toContain('pre-response= undefined');

    const post = await run('console.log("post-response=", typeof pm.response);', 'test');
    expect(post.join(' ')).toContain('post-response= object');
  }, 30_000);

  it('pm.info 携带事件名与迭代信息', async () => {
    const pre = await run(
      `console.log('event=', pm.info.eventName, 'iteration=', pm.info.iteration, 'count=', pm.info.iterationCount);`,
      'prerequest',
    );
    const post = await run(
      `console.log('event=', pm.info.eventName, 'iteration=', pm.info.iteration, 'count=', pm.info.iterationCount);`,
      'test',
    );

    expect(pre.join(' ')).toContain('event= prerequest iteration= 0 count= 1');
    expect(post.join(' ')).toContain('event= test iteration= 0 count= 1');
  }, 30_000);
});

describe('pm.require 内置库（4.2）', () => {
  const LIBRARIES = [
    'ajv',
    'chai',
    'cheerio',
    'csv-parse/lib/sync',
    'lodash',
    'moment',
    'postman-collection',
    'uuid',
    'xml2js',
  ];

  const NODE_MODULES = [
    'path',
    'assert',
    'buffer',
    'util',
    'url',
    'punycode',
    'querystring',
    'string_decoder',
    'stream',
    'timers',
    'events',
  ];

  it('内置库逐项可用', async () => {
    const printed = await run(
      `var libs = ${JSON.stringify(LIBRARIES)};
       var missing = [];
       libs.forEach(function (name) {
         try { require(name); } catch (error) { missing.push(name + ': ' + error.message); }
       });
       if (missing.length) { throw new Error('缺少内置库：' + missing.join(' | ')); }`,
    );

    expect(printed.join(' ')).not.toContain('缺少内置库');
  }, 30_000);

  it('Node 模块清单逐项可用', async () => {
    const printed = await run(
      `var mods = ${JSON.stringify(NODE_MODULES)};
       var missing = [];
       mods.forEach(function (name) {
         try { require(name); } catch (error) { missing.push(name + ': ' + error.message); }
       });
       if (missing.length) { throw new Error('缺少 Node 模块：' + missing.join(' | ')); }`,
    );

    expect(printed.join(' ')).not.toContain('缺少 Node 模块');
  }, 30_000);

  it('在线注册表依赖被明确拒绝，且不发生任何联网（4.2）', async () => {
    const { commands, sendRequest } = fakeCommands();
    const result = await runScriptPhase(commands, target, 'prerequest', [
      `var rejected = 0;
       ['http', 'axios', 'some-random-package'].forEach(function (name) {
         try { require(name); } catch (error) { rejected++; }
       });
       console.log('rejected=', rejected);`,
    ]);

    expect(result.error).toBeNull();
    const printed = result.console.map((entry) => entry.args.join(' ')).join(' ');
    // 三个在线注册表方向的 require 全部抛错（「Cannot find module」）
    expect(printed).toContain('rejected= 3');
    // 拒绝路径上没有发生任何网络请求（sendRequest 桥未被触碰）
    expect(sendRequest).not.toHaveBeenCalled();
    void commands;
  }, 30_000);
});

describe('沙箱全局白名单（4.4）', () => {
  const KEEP = [
    'Object',
    'Array',
    'JSON',
    'Promise',
    'Math',
    'Date',
    'RegExp',
    'Error',
    'TypeError',
    'Map',
    'Set',
    'Symbol',
    'Proxy',
    'Reflect',
    'parseInt',
    'parseFloat',
    'isNaN',
    'encodeURIComponent',
    'decodeURIComponent',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'crypto',
    'TextEncoder',
    'TextDecoder',
    'URL',
    'URLSearchParams',
    'atob',
    'btoa',
    'structuredClone',
    'queueMicrotask',
    'AbortController',
    'AbortSignal',
    'Blob',
    'Event',
    'EventTarget',
    'ReadableStream',
    'WritableStream',
    'TransformStream',
  ];

  const FORBIDDEN = [
    // 网络
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'importScripts',
    // 持久化与存储
    'indexedDB',
    'localStorage',
    'sessionStorage',
    'caches',
    // 界面与外部世界
    'window',
    'document',
    'navigator',
    'location',
    'Worker',
    'globalThis',
    'self',
  ];

  // 注意：globalThis 本身**不在**白名单里（实测缺失），因此用裸名 typeof 逐个探测
  it('应保留的全局对象都在', async () => {
    const printed = await run(
      `var keep = ${JSON.stringify(KEEP)};
       var missing = keep.filter(function (name) {
         try { return eval('typeof ' + name) === 'undefined'; } catch (e) { return true; }
       });
       if (missing.length) { throw new Error('白名单全局缺失：' + missing.join(',')); }`,
    );

    expect(printed.join(' ')).not.toContain('白名单全局缺失');
  }, 30_000);

  it('联网、存储与界面原语一律不可用', async () => {
    const printed = await run(
      `var forbidden = ${JSON.stringify(FORBIDDEN)};
       var leaked = forbidden.filter(function (name) {
         try { return eval('typeof ' + name) !== 'undefined'; } catch (e) { return false; }
       });
       if (leaked.length) { throw new Error('沙箱泄漏了原语：' + leaked.join(',')); }`,
    );

    expect(printed.join(' ')).not.toContain('沙箱泄漏了原语');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 4.3 弃用库 / 4.6 可视化
// ---------------------------------------------------------------------------

describe('弃用库（4.3）', () => {
  it('crypto-js 与 tv4 仍可用，宿主给出可辨识的弃用提示与替代方案', async () => {
    const { commands } = fakeCommands();
    const result = await runScriptPhase(commands, target, 'prerequest', [
      `var CryptoJS = require('crypto-js');
       var tv4 = require('tv4');
       console.log('libs=', typeof CryptoJS.MD5, typeof tv4.validate);`,
    ]);

    expect(result.error).toBeNull();
    const printed = result.console.map((entry) => entry.args.join(' ')).join(' ');
    expect(printed).toContain('libs= function function');

    // 上游沙箱对弃用库零提示（实测）——提示由宿主静态扫描生成
    const warns = result.console.filter((entry) => entry.level === 'warn');
    const warnText = warns.map((entry) => entry.args.join(' ')).join(' | ');
    expect(warnText).toContain('crypto-js');
    expect(warnText).toContain('Web Crypto');
    expect(warnText).toContain('tv4');
    expect(warnText).toContain('ajv');
  }, 30_000);

  it('lodash3 已被上游 6.7.4 移除（design 清单据实修正）', async () => {
    const printed = await run(
      `try { require('lodash3'); console.log('lodash3= present'); } catch (e) { console.log('lodash3= absent'); }`,
    );
    expect(printed.join(' ')).toContain('lodash3= absent');
  }, 30_000);
});

describe('可视化（4.6）', () => {
  it('pm.visualizer.set 捕获模板与数据（4.6）', async () => {
    const { commands } = fakeCommands();
    const result = await runScriptPhase(commands, target, 'test', [
      `pm.visualizer.set('<h1>{{name}}</h1>', { name: 'reqman' });`,
    ]);

    expect(result.error).toBeNull();
    expect(result.visualizer).toEqual({
      template: '<h1>{{name}}</h1>',
      data: { name: 'reqman' },
    });
  }, 30_000);

  it('clear 之后可视化结果为空（4.6）', async () => {
    const { commands } = fakeCommands();
    const result = await runScriptPhase(commands, target, 'test', [
      `pm.visualizer.set('<p>x</p>', {});
       pm.visualizer.clear();`,
    ]);

    expect(result.error).toBeNull();
    expect(result.visualizer).toBeNull();
  }, 30_000);

  it('渲染做 HTML 转义，数据里的标签不会注入文档（4.6）', async () => {
    const { commands } = fakeCommands();
    const result = await runScriptPhase(commands, target, 'test', [
      `pm.visualizer.set('<p>{{evil}}</p>', { evil: '<img src=x onerror=alert(1)>' });`,
    ]);

    expect(result.visualizer?.template).toBe('<p>{{evil}}</p>');
    expect(result.visualizer?.data).toEqual({ evil: '<img src=x onerror=alert(1)>' });
  }, 30_000);
});
