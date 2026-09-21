// 脚本执行编排的行为断言（任务 2.4）。
//
// 这里验的是顺序与合并语义：三级脚本按「集合 → 文件夹 → 请求」执行，前一段的写入对
// 后一段可见，因此同名变量最终取请求层的值；没有任何脚本时不创建沙箱上下文；脚本抛错
// 时其后未执行的脚本不再执行，错误仍被报告。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runScriptPhase } from '../src/lib/scriptRuntime';
import type { Commands } from '../src/lib/commands';
import type { ResponsePayload, SavedRequest, Variable } from '../src/lib/types';

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

/** `pm.sendRequest` 走后端网络层，这里给出它会拿到的响应。 */
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

/** 会记录调用的命令假实现。 */
function fakeCommands(variables: Variable[] = []) {
  const calls: string[] = [];
  /** `variable_set` 的全部入参，供作用域路由断言使用（任务 3.3 / 3.4）。 */
  const variableSetCalls: Record<string, unknown>[] = [];
  /** `globals_set` 的全部入参。 */
  const globalsSetCalls: unknown[][] = [];
  /** 假 Cookie Jar：真的记住，脚本写入后可再读出（任务 3.5）。 */
  const cookieJar: import('../src/lib/types').CookieView[] = [];
  const cookiePutCalls: Record<string, unknown>[] = [];
  const sendRequest = vi.fn(async () => sentResponse());
  // 门禁与目标策略都存 settings，假实现必须真的记住，否则策略测不出来
  const settingsStore = new Map<string, string>();
  const commands = {
    sendRequest,
    settingsGet: async (scope: string, key: string) =>
      settingsStore.get(`${scope}:${key}`) ?? null,
    settingsSet: async (scope: string, key: string, value: string) => {
      settingsStore.set(`${scope}:${key}`, value);
    },
    globalsList: vi.fn(async () => {
      calls.push('globalsList');
      return variables;
    }),
    variableList: vi.fn(async () => {
      calls.push('variableList');
      return variables;
    }),
    globalsSet: vi.fn(async (...args: unknown[]) => {
      calls.push('globalsSet');
      globalsSetCalls.push(args);
      return variable('x', '');
    }),
    variableSet: vi.fn(async (input: Record<string, unknown>) => {
      calls.push('variableSet');
      variableSetCalls.push(input);
      return variable('x', '');
    }),
    secretReveal: vi.fn(async () => variable('x', '')),
    cookieQuery: vi.fn(async () => [...cookieJar]),
    cookieList: vi.fn(async () => [...cookieJar]),
    cookiePut: vi.fn(async (args: Record<string, unknown>) => {
      cookiePutCalls.push(args);
      cookieJar.push({
        id: `ck-${cookieJar.length + 1}`,
        name: String(args.name),
        domain: String(args.domain),
        path: String(args.path ?? '/'),
        host_only: Boolean(args.host_only),
        value: String(args.value),
        secure: Boolean(args.secure),
        http_only: Boolean(args.http_only),
        expires_at: (args.expires_at as number | null) ?? null,
      });
    }),
    cookieDelete: vi.fn(async (id: string) => {
      const index = cookieJar.findIndex((entry) => entry.id === id);
      if (index >= 0) cookieJar.splice(index, 1);
    }),
  };

  return {
    commands: commands as unknown as Commands,
    calls,
    sendRequest,
    variableSetCalls,
    globalsSetCalls,
    cookieJar,
    cookiePutCalls,
  };
}

const target = { workspaceId: 'w1', collectionId: 'c1', environmentId: 'e1' };

describe('脚本执行编排', () => {
  it('三级脚本按序执行，前一段的写入对后一段可见', async () => {
    const { commands } = fakeCommands();

    const result = await runScriptPhase(commands, target, 'prerequest', [
      'pm.environment.set("x", "1");',
      'pm.environment.set("x", "2");',
      'console.log("x=", pm.environment.get("x"));',
    ]);

    expect(result.error).toBeNull();
    // 最后一段读到的是请求层写入的值，而不是集合层或文件夹层的
    expect(result.console.map((entry) => entry.args)).toEqual([['x=', '2']]);
  }, 30_000);

  it('按名写入落在生效的那一条，被禁用的条目读不到（spec: 脚本对变量的读写）', async () => {
    // 同名两条：靠上的是 secret、靠下的是明文——生效的是靠下的那条；
    // 第三条被禁用，因此不该出现在脚本可见的作用域里
    const shadowed: Variable = {
      ...variable('host', 'first'),
      id: 'v-first',
      is_secret: true,
      sort_order: 0,
    };
    const effectiveRow: Variable = { ...variable('host', 'second'), id: 'v-second', sort_order: 1 };
    const hidden: Variable = { ...variable('off', 'never'), id: 'v-off', enabled: false };
    const { commands, variableSetCalls } = fakeCommands([shadowed, effectiveRow, hidden]);

    const result = await runScriptPhase(commands, target, 'prerequest', [
      'console.log("host=", pm.environment.get("host"));',
      'pm.environment.set("seen", String(pm.environment.get("off")));',
      'pm.environment.set("host", "patched");',
    ]);

    expect(result.error).toBeNull();
    // 读到的是生效条的值
    expect(result.console.map((entry) => entry.args)).toEqual([['host=', 'second']]);

    const byName = new Map(variableSetCalls.map((call) => [String(call.name), call]));
    // 禁用条目不进作用域：读出来是 undefined
    expect(byName.get('seen')).toMatchObject({ current: 'undefined' });
    // 回写定位到生效的那一条：is_secret 取自它（false），而不是被遮蔽的 secret 条
    expect(byName.get('host')).toMatchObject({ is_secret: false, current: 'patched' });
    expect(result.written).toContain('host');
  }, 30_000);

  it('三个层级都没有脚本时不载入变量，也不报错', async () => {
    const { commands, calls } = fakeCommands();

    const result = await runScriptPhase(commands, target, 'prerequest', [null, '', '   ']);

    expect(result).toEqual({
      console: [],
      assertions: [],
      error: null,
      written: [],
      visualizer: null,
    });
    // 连变量都没读，说明沙箱上下文也没建——空跑一次建上下文没有意义
    expect(calls).toEqual([]);
  }, 30_000);

  it('脚本抛错时其后未执行的脚本不再执行，错误仍被报告', async () => {
    const { commands } = fakeCommands();

    const result = await runScriptPhase(commands, target, 'test', [
      'console.log("第一段");',
      'throw new Error("中段炸了");',
      'console.log("不该出现");',
    ]);

    expect(result.error).toContain('中段炸了');
    const args = result.console.map((entry) => entry.args);
    expect(args).toContainEqual(['第一段']);
    expect(args).not.toContainEqual(['不该出现']);
  }, 30_000);

  it('脚本写入的变量被回写，未变化的不重复写', async () => {
    const { commands, calls } = fakeCommands([variable('x', '0')]);

    const result = await runScriptPhase(commands, target, 'prerequest', [
      'pm.environment.set("x", "1");',
    ]);

    expect(result.written).toContain('x');
    expect(calls).toContain('variableSet');
  }, 30_000);

  it('pm.globals.set 的写入落回全局作用域（3.3）', async () => {
    const { commands, calls, globalsSetCalls, variableSetCalls } = fakeCommands();

    const result = await runScriptPhase(commands, target, 'prerequest', [
      'pm.globals.set("g1", "v1");',
    ]);

    expect(result.error).toBeNull();
    expect(result.written).toContain('g1');
    expect(calls).toContain('globalsSet');
    // 全局作用域挂在工作区上，且新建变量不是 secret
    expect(globalsSetCalls[0]).toEqual(['w1', 'g1', 'v1', false]);
    expect(calls).not.toContain('variableSet');
    expect(variableSetCalls).toEqual([]);
  }, 30_000);

  it('pm.collectionVariables.set 与 pm.environment.set 各自落回所属作用域（3.3）', async () => {
    const { commands, variableSetCalls, globalsSetCalls } = fakeCommands();

    const result = await runScriptPhase(commands, target, 'prerequest', [
      'pm.collectionVariables.set("cv", "from-collection");',
      'pm.environment.set("ev", "from-environment");',
    ]);

    expect(result.error).toBeNull();
    expect(globalsSetCalls).toEqual([]);

    // 集合变量的归属是集合 id，环境变量的归属是环境 id——写错归属就等于越界。
    // 注意落库顺序是 全局 → 环境 → 集合（persistWrites 的固定顺序），与脚本书写顺序无关，
    // 因此按名字查找而不是按下标。
    expect(variableSetCalls.find((item) => item.name === 'cv')).toMatchObject({
      scope: 'collection',
      owner_id: 'c1',
      is_secret: false,
      current: 'from-collection',
    });
    expect(variableSetCalls.find((item) => item.name === 'ev')).toMatchObject({
      scope: 'environment',
      owner_id: 'e1',
      is_secret: false,
      current: 'from-environment',
    });
  }, 30_000);

  it('pm.variables.set 属于本地作用域：同一段脚本内可见，但不落盘（3.3）', async () => {
    const { commands, calls } = fakeCommands([variable('x', 'persisted')]);

    // 三条语句必须在同一段脚本里：本地作用域的生命周期是**单次执行**，
    // 跨段不保留（跨段可见的只有三个持久化作用域，本地值从不回传）
    const result = await runScriptPhase(commands, target, 'prerequest', [
      [
        'console.log("before=", pm.variables.get("x"));',
        'pm.variables.set("x", "local-value");',
        'console.log("after=", pm.variables.get("x"));',
        'console.log("env=", pm.environment.get("x"));',
      ].join(' '),
    ]);

    expect(result.error).toBeNull();
    // 本地写入在脚本内生效且覆盖持久化值，但没有任何一条写回命令被触发
    const printed = result.console.map((entry) => entry.args.join(' ')).join(' ');
    expect(printed).toContain('before= persisted');
    expect(printed).toContain('after= local-value');
    // 覆盖只发生在本地：pm.environment 看到的仍是持久化值
    expect(printed).toContain('env= persisted');
    expect(result.written).toEqual([]);
    expect(calls).not.toContain('variableSet');
    expect(calls).not.toContain('globalsSet');
  }, 30_000);

  it('改写既有 secret 变量保持其 secret 属性，新建变量不是 secret（3.4）', async () => {
    const secret: Variable = {
      id: 'v-token',
      scope: 'environment',
      owner_id: 'e1',
      name: 'token',
      description: null,
      is_secret: true,
      enabled: true,
      sort_order: 0,
      initial: { state: 'unreadable' },
      current: { state: 'unreadable' },
    };
    const revealed: Variable = { ...secret, current: { state: 'value', value: 'SECRET123456' } };
    const { commands: base, variableSetCalls } = fakeCommands([secret]);
    const commands = { ...base, secretReveal: async () => revealed } as Commands;

    const result = await runScriptPhase(commands, target, 'prerequest', [
      'pm.environment.set("token", "rotated");',
      'pm.environment.set("fresh", "v");',
    ]);

    expect(result.error).toBeNull();
    const tokenCall = variableSetCalls.find((item) => item.name === 'token');
    // 覆写 secret 变量必须以 secret 身份落库——后端据 this 走加密存储，
    // 丢掉这个属性就会把轮换后的明文写成普通变量
    expect(tokenCall).toMatchObject({ is_secret: true, current: 'rotated' });
    const freshCall = variableSetCalls.find((item) => item.name === 'fresh');
    expect(freshCall).toMatchObject({ is_secret: false, current: 'v' });
  }, 30_000);

  it('收集 pm.test 的断言明细，失败不阻断其余断言', async () => {
    const { commands } = fakeCommands();

    const result = await runScriptPhase(commands, target, 'test', [
      `pm.test('应该通过', function () { pm.expect(1).to.eql(1); });
       pm.test('应该失败', function () { pm.expect(1).to.eql(2); });
       pm.test('第三条仍会执行', function () { pm.expect('a').to.eql('a'); });`,
    ]);

    expect(result.error).toBeNull();
    expect(result.assertions.map((item) => item.name)).toEqual([
      '应该通过',
      '应该失败',
      '第三条仍会执行',
    ]);
    expect(result.assertions.map((item) => item.passed)).toEqual([true, false, true]);
    // 失败的断言带原因，通过的没有
    expect(result.assertions[1].error).toBeTruthy();
    expect(result.assertions[0].error).toBeNull();
  }, 30_000);

  it('pm.sendRequest 经后端网络层发出，脚本能拿到响应', async () => {
    const { commands, sendRequest } = fakeCommands();

    const result = await runScriptPhase(commands, target, 'test', [
      `pm.sendRequest({
         url: 'https://api.test/ping',
         method: 'POST',
         header: { 'X-Trace': 'abc' },
         body: { mode: 'raw', raw: '{"a":1}' }
       }, function (err, res) {
         console.log('err=', err);
         console.log('code=', res.code);
         console.log('body=', res.text());
       });`,
    ]);

    expect(result.error).toBeNull();
    expect(sendRequest, '脚本的请求必须经宿主桥到达后端').toHaveBeenCalledTimes(1);

    const input = sendRequest.mock.calls[0][0] as { inline?: SavedRequest };
    expect(input.inline?.method).toBe('POST');
    expect(input.inline?.url).toBe('https://api.test/ping');
    expect(input.inline?.headers).toEqual([{ key: 'X-Trace', value: 'abc', enabled: true }]);
    expect(input.inline?.body.kind).toBe('raw');

    const printed = result.console.map((entry) => entry.args.join(' ')).join(' ');
    expect(printed).toContain('code= 201');
    expect(printed).toContain('{"ok":true}');
  }, 30_000);

  it('未配置策略时 pm.sendRequest 不限制目标（与 Postman 一致）', async () => {
    const { commands, sendRequest } = fakeCommands();

    const result = await runScriptPhase(commands, target, 'test', [
      `pm.sendRequest('https://anywhere.example/x', function (err) {
         console.log('err=', err && err.message);
       });`,
    ]);

    expect(result.error).toBeNull();
    expect(sendRequest, '未配置策略即不限制，这是兼容性的一部分').toHaveBeenCalledTimes(1);
  }, 30_000);

  it('配置 allow 策略后名单外目标被拒绝，且原因可辨识', async () => {
    const { commands, sendRequest } = fakeCommands();

    await commands.settingsSet(
      'script_send_request',
      'policy',
      JSON.stringify({ mode: 'allow', hosts: ['api.test'] }),
    );

    const result = await runScriptPhase(commands, target, 'test', [
      `pm.sendRequest('https://evil.example/x', function (err) {
         console.log('err=', err && err.message);
       });`,
    ]);

    expect(sendRequest, '策略外的目标不应到达后端').not.toHaveBeenCalled();
    const printed = result.console.map((entry) => entry.args.join(' ')).join(' ');
    expect(printed).toContain('不在允许范围内');
    expect(printed).toContain('evil.example');
  }, 30_000);

  it('allow 策略下的名单内目标照常发出，子域一并放行', async () => {
    const { commands, sendRequest } = fakeCommands();

    await commands.settingsSet(
      'script_send_request',
      'policy',
      JSON.stringify({ mode: 'allow', hosts: ['api.test'] }),
    );

    await runScriptPhase(commands, target, 'test', [
      `pm.sendRequest('https://sub.api.test/x', function () {});`,
    ]);

    expect(sendRequest).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('配置 deny 策略后名单内目标被拒绝，名单外照常发出', async () => {
    const { commands, sendRequest } = fakeCommands();

    await commands.settingsSet(
      'script_send_request',
      'policy',
      JSON.stringify({ mode: 'deny', hosts: ['evil.example'] }),
    );

    await runScriptPhase(commands, target, 'test', [
      `pm.sendRequest('https://evil.example/x', function () {});`,
    ]);
    expect(sendRequest, '被拒绝的目标不应到达后端').not.toHaveBeenCalled();

    await runScriptPhase(commands, target, 'test', [
      `pm.sendRequest('https://api.test/x', function () {});`,
    ]);
    expect(sendRequest).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('后置脚本能读到本次响应的状态码与正文（3.1）', async () => {
    const { commands } = fakeCommands();

    const result = await runScriptPhase(
      commands,
      target,
      'test',
      ['console.log("code=", pm.response.code); console.log("body=", pm.response.text());'],
      sentResponse(),
    );

    expect(result.error).toBeNull();
    const printed = result.console.map((entry) => entry.args.join(' ')).join(' ');
    expect(printed).toContain('code= 201');
    expect(printed).toContain('{"ok":true}');
  }, 30_000);

  it('前置脚本拿不到 pm.response（与 Postman 一致）', async () => {
    const { commands } = fakeCommands();

    const result = await runScriptPhase(
      commands,
      target,
      'prerequest',
      ['console.log("response=", typeof pm.response);'],
      sentResponse(),
    );

    const printed = result.console.map((entry) => entry.args.join(' ')).join(' ');
    expect(printed).toContain('response= undefined');
  }, 30_000);

  it('console 输出带来源标记，前置与后置可区分', async () => {
    const { commands } = fakeCommands();

    const pre = await runScriptPhase(commands, target, 'prerequest', ['console.log("来自前置");']);
    const post = await runScriptPhase(commands, target, 'test', ['console.log("来自后置");']);

    expect(pre.console[0]?.phase).toBe('prerequest');
    expect(post.console[0]?.phase).toBe('test');
  }, 30_000);

  it('console 输出里的 secret 明文被掩码', async () => {
    const secret: Variable = {
      id: 'v-token',
      scope: 'environment',
      owner_id: 'e1',
      name: 'token',
      description: null,
      is_secret: true,
      enabled: true,
      sort_order: 0,
      initial: { state: 'unreadable' },
      current: { state: 'unreadable' },
    };
    const revealed: Variable = { ...secret, current: { state: 'value', value: 'SECRET123456' } };
    const { commands: base } = fakeCommands([secret]);
    const commands = { ...base, secretReveal: async () => revealed } as Commands;

    const result = await runScriptPhase(commands, target, 'test', [
      'console.log("token=", pm.environment.get("token"));',
    ]);

    const printed = result.console.map((entry) => entry.args.join(' ')).join('');
    // 脚本拿到的是明文（spec 7.3），呈现时才被掩码
    expect(printed).toContain('******');
    expect(printed).not.toContain('SECRET123456');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 3.5 pm.cookies：当前请求集合与按域读写
// ---------------------------------------------------------------------------

describe('pm.cookies 出口', () => {
  function seededCookie(overrides: Partial<import('../src/lib/types').CookieView> = {}) {
    return {
      id: 'ck-seed',
      name: 'sid',
      domain: 'api.test',
      path: '/',
      host_only: true,
      value: 'abc123',
      secure: false,
      http_only: false,
      expires_at: 4_102_444_800,
      ...overrides,
    };
  }

  it('pm.cookies 读到的是当前请求目标可用的集合（3.5）', async () => {
    const { commands } = fakeCommands();
    (commands as unknown as { cookieQuery: (url: string) => Promise<unknown[]> }).cookieQuery =
      vi.fn(async (url: string) => {
        // 假实现模拟 Rust 端：只有匹配的域才返回
        expect(url).toBe('https://api.test/x');
        return [seededCookie()];
      });

    const result = await runScriptPhase(
      commands,
      target,
      'prerequest',
      ['console.log("c=", pm.cookies.get("sid"));'],
      null,
      'https://api.test/x',
    );

    expect(result.error).toBeNull();
    const printed = result.console.map((entry) => entry.args.join(' ')).join(' ');
    expect(printed).toContain('c= abc123');
  }, 30_000);

  it('请求 URL 缺失时 pm.cookies 没有当前集合但不报错（3.5）', async () => {
    const { commands } = fakeCommands();

    const result = await runScriptPhase(commands, target, 'prerequest', [
      'console.log("cookies=", typeof pm.cookies);',
    ]);

    expect(result.error).toBeNull();
    const printed = result.console.map((entry) => entry.args.join(' ')).join(' ');
    // pm.cookies 存在（沙箱始终提供），只是集合为空
    expect(printed).toContain('cookies= object');
  }, 30_000);

  it('jar().set 立即落库且属性保真（3.5）', async () => {
    const { commands, cookiePutCalls } = fakeCommands();

    const result = await runScriptPhase(
      commands,
      target,
      'prerequest',
      [
        `await new Promise((r) =>
           pm.cookies.jar().set('https://api.test/login', 'sid', 'v1', () => r()));`,
      ],
      null,
      'https://api.test/x',
    );

    expect(result.error).toBeNull();
    expect(cookiePutCalls).toHaveLength(1);
    // jar.set 按 URL 推导：域为 api.test、host-only（URL 不带 Domain 属性）
    expect(cookiePutCalls[0]).toMatchObject({
      domain: 'api.test',
      name: 'sid',
      value: 'v1',
      path: '/',
      host_only: true,
    });
  }, 30_000);

  it('jar().set 带属性时写入不丢失 Secure 与有效期（3.5）', async () => {
    const { commands, cookiePutCalls } = fakeCommands();

    await runScriptPhase(
      commands,
      target,
      'prerequest',
      [
        `await new Promise((r) =>
           pm.cookies.jar().set('https://api.test/login', { name: 'tok', value: 'v2', secure: true, expires: '2100-01-01T00:00:00.000Z' }, () => r()));`,
      ],
      null,
      'https://api.test/x',
    );

    expect(cookiePutCalls[0]).toMatchObject({
      name: 'tok',
      secure: true,
      expires_at: 4_102_444_800,
    });
  }, 30_000);

  it('jar().get 经同一套匹配读回写入的值（3.5）', async () => {
    const { commands } = fakeCommands();

    const result = await runScriptPhase(
      commands,
      target,
      'test',
      [
        // jar.get 的回调直接给**取值字符串**（探针实测），不是 cookie 对象
        `await new Promise((r) =>
           pm.cookies.jar().set('https://api.test/x', 'sid', 'roundtrip', () => r()));
         await new Promise((r) =>
           pm.cookies.jar().get('https://api.test/x', 'sid', function (err, value) {
             console.log('got=', err, value); r();
           }));`,
      ],
      null,
      'https://api.test/x',
    );

    expect(result.error).toBeNull();
    const printed = result.console.map((entry) => entry.args.join(' ')).join(' ');
    expect(printed).toContain('got= null roundtrip');
  }, 30_000);

  it('jar().unset 删除后不再出现（3.5）', async () => {
    const { commands, cookieJar } = fakeCommands();
    cookieJar.push(seededCookie());

    const result = await runScriptPhase(
      commands,
      target,
      'prerequest',
      [
        `await new Promise((r) =>
           pm.cookies.jar().unset('https://api.test/x', 'sid', () => r()));
         await new Promise((r) =>
           pm.cookies.jar().getAll('https://api.test/x', function (err, list) {
             // getAll 返回 CookieList（PropertyList 系），计数走 .all()
             console.log('after=', list.all().length === 0 ? 'EMPTY' : 'HAS:' + list.all().length); r();
           }));`,
      ],
      null,
      'https://api.test/x',
    );

    expect(result.error).toBeNull();
    expect(cookieJar).toHaveLength(0);
    const printed = result.console.map((entry) => entry.args.join(' ')).join(' ');
    expect(printed).toContain('after= EMPTY');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 9.5 脚本超时与错误处置
// ---------------------------------------------------------------------------

describe('脚本超时与错误处置', () => {
  it('无限循环在上限后被中止并报告超时，runScriptPhase 正常返回（9.5）', async () => {
    const { commands } = fakeCommands();

    const result = await runScriptPhase(
      commands,
      target,
      'prerequest',
      ['while (true) {}'],
      null,
      null,
      500,
    );

    // 关键断言：runScriptPhase 正常 resolve（界面不会因此失去响应），且报告超时
    expect(result.error).toBeTruthy();
    expect(result.error).toMatch(/sandbox|timeout/i);
  }, 15_000);

  it('未结算的 Promise 同样受上限约束（9.5）', async () => {
    const { commands } = fakeCommands();

    const result = await runScriptPhase(
      commands,
      target,
      'prerequest',
      ['await new Promise(() => {});'],
      null,
      null,
      500,
    );

    expect(result.error).toBeTruthy();
    expect(result.error).toMatch(/sandbox|timeout/i);
  }, 15_000);

  it('错误报告指明层级与可定位的行号（9.5）', async () => {
    const { commands } = fakeCommands();

    // 三段脚本：第 2 段（文件夹层）的第 4 行抛错
    const result = await runScriptPhase(
      commands,
      target,
      'prerequest',
      ['console.log("ok");', 'const a = 1;\nconst b = 2;\nconst c = 3;\nnull.x;', null],
      null,
      null,
      5_000,
    );

    expect(result.error).toContain('前置脚本');
    expect(result.error).toContain('文件夹层');
    expect(result.error).toContain('第 4 行');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 实机探针自检（1.4）
//
// 1.4 的逃逸尝试只能在真实客户端里做，但那不代表探针本身可以没跑过就交给用户。
// 这条用例把探针原文喂进**真沙箱**跑一遍，证明它能执行完、能发出报告、三条判定都成立。
//
// 注意结论的边界：这里跑的是 `uvm` 的 **Node 后端**（worker_threads），不是 webview 的
// blob Worker 后端。它证明「探针可用」，**不能**替代 WebKitGTK 上的实机结论。
// ---------------------------------------------------------------------------

/**
 * 探针文件的实际位置。
 *
 * 探针跟着它的变更目录走，而变更归档后目录会带日期前缀搬进 `changes/archive/`——
 * 原先写死 `changes/add-pm-script-runtime/probes/escape-probe.js`，该变更一归档
 * 这条用例就变成 ENOENT。两处都找一遍，归档不再弄坏自检。
 *
 * 路径用 cwd 拼：happy-dom 环境下 import.meta.url 不是 file: 协议。
 */
function probeFile(changeName: string): string {
  const changes = resolve(process.cwd(), 'openspec/changes');
  const archive = resolve(changes, 'archive');
  const archived = existsSync(archive)
    ? readdirSync(archive)
        .filter((entry) => entry.endsWith(changeName))
        .map((entry) => resolve(archive, entry, 'probes/escape-probe.js'))
    : [];

  const candidates = [resolve(changes, changeName, 'probes/escape-probe.js'), ...archived];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error(`找不到探针文件：${candidates.join(' | ')}`);
  return found;
}

describe('实机探针自检（1.4）', () => {
  it('逃逸探针能执行完并发出报告，四条判定均通过', async () => {
    const probe = readFileSync(probeFile('add-pm-script-runtime'), 'utf8');
    const { commands } = fakeCommands();

    const result = await runScriptPhase(commands, target, 'prerequest', [probe]);

    // 探针本身不能抛错：否则用户在界面上看到的是一段报错，而不是他的逃逸报告
    expect(result.error).toBeNull();

    const printed = result.console.map((entry) => entry.args.join(' ')).join('\n');
    expect(printed).toContain('ESCAPE-PROBE');
    // 报告是可解析的 JSON（否则用户贴回来的东西没法落档）
    const raw = /ESCAPE-PROBE (\{.*\})/.exec(printed);
    expect(raw).not.toBeNull();
    expect(() => JSON.parse(raw?.[1] ?? '')).not.toThrow();

    // 上游把 Error.prepareStackTrace 锁成 writable=false（Object.defineProperty），
    // 而**各引擎对它的赋值行为不一致**：V8 静默失败、JavaScriptCore 抛
    // "Attempted to assign to readonly property."（WebKit 真机上实测到这条）。
    // 探针因此改为先读描述符、只在可写时才尝试，结果必须稳定落在「不可写，赋值被拒」——
    // 既不抛错（抛了会在真机上冒出红色报错），也不泄漏。
    const parsed = JSON.parse(raw?.[1] ?? '') as { recovery: Record<string, string> };
    expect(parsed.recovery['prepareStackTrace → getThis']).toContain('不可写');

    // 四条判定：无原语泄漏、无可用回收向量、危险模块无可达能力、读文件失败
    expect(result.assertions).toHaveLength(4);
    const failed = result.assertions.filter((item) => !item.passed);
    expect(failed.map((item) => `${item.name}: ${item.error}`)).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// pm.require 的兼容性（spec: pm 兼容面）
// ---------------------------------------------------------------------------

describe('pm.require（spec: pm 兼容面）', () => {
  it('pm.require 可用，与 require 解析同一套内置库、同样拒绝注册表模块', async () => {
    const { commands } = fakeCommands();
    const result = await runScriptPhase(commands, target, 'prerequest', [
      [
        "console.log('same=', pm.require === require);",
        "var viaPm = 'threw'; try { pm.require('ajv'); viaPm = 'ok'; } catch (e) { viaPm = 'threw'; }",
        "console.log('pm.require(ajv)=', viaPm);",
        "var pmHttp = 'ok'; try { pm.require('http'); } catch (e) { pmHttp = 'rejected'; }",
        "var bareHttp = 'ok'; try { require('http'); } catch (e) { bareHttp = 'rejected'; }",
        "console.log('pm.require(http)=', pmHttp, 'require(http)=', bareHttp);",
      ].join('\n'),
    ]);

    expect(result.error).toBeNull();
    const printed = result.console.map((entry) => entry.args.join(' ')).join('\n');
    // 上游在未提供 resolvedPackages 时会摘掉 pm.require（实测 `pm.require is not a function`），
    // 宿主补的别名应让它与 require 完全一致
    expect(printed).toContain('same= true');
    expect(printed).toContain('pm.require(ajv)= ok');
    // 对注册表模块的拒绝行为必须一致
    expect(printed).toContain('pm.require(http)= rejected require(http)= rejected');
  }, 30_000);
});
