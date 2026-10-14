// 悬浮值提示的取值判定（change: show-variable-values-on-hover，任务 1.1）。
//
// 验的是「哪一条生效、来源标成哪一层」：提示必须与发送用同一套判定（复用
// `effectiveByName`），否则它就是一个会骗人的界面。这里直接对着真实的
// `variableHover` 取值源断言，不走组件。
import { describe, expect, it, vi } from 'vitest';
import {
  createVariableHoverSource,
  isDynamicVariable,
  type VariableHoverCommands,
  type VariableHoverContext,
} from '../src/lib/variableHover';
import type { Variable } from '../src/lib/types';

function variable(
  name: string,
  value: string,
  options: {
    id?: string;
    scope?: Variable['scope'];
    enabled?: boolean;
    secret?: boolean;
    state?: Variable['current']['state'];
  } = {},
): Variable {
  const stored =
    options.state === 'unreadable'
      ? ({ state: 'unreadable' } as const)
      : ({ state: 'value', value } as const);

  return {
    id: options.id ?? `v-${name}`,
    scope: options.scope ?? 'environment',
    owner_id: 'owner',
    name,
    is_secret: options.secret ?? false,
    enabled: options.enabled ?? true,
    sort_order: 0,
    initial: stored,
    current: stored,
  };
}

const CONTEXT: VariableHoverContext = {
  workspaceId: 'w1',
  environmentId: 'env1',
  collectionId: 'c1',
};

/**
 * 只暴露提示需要的读出口，并记下每次调用，供「按需装载」的断言使用。
 *
 * `writes` 是**回归护栏**：提示的类型上根本没有写入命令可调（`VariableHoverCommands`
 * 只拾取读出口），这里仍把写入口挂上去并断言它们一次都没被碰过——将来若有人把接口放宽，
 * 这条会先响。
 */
function fakeClient(
  scopeVariables: Variable[],
  collectionVariables: Variable[] = [],
  options: { fail?: boolean; reveal?: Record<string, string> } = {},
) {
  const variableList = vi.fn(async (scope: string, ownerId: string) => {
    if (options.fail) throw new Error('读不到变量');
    return scope === 'environment' ? scopeVariables : collectionVariables;
  });
  const globalsList = vi.fn(async () => {
    if (options.fail) throw new Error('读不到变量');
    return scopeVariables;
  });
  // 揭示出口：只认预先登记的 id → 明文，其余一律失败（掩盖错误会让用例失去分辨力）
  const secretReveal = vi.fn(async (id: string) => {
    const plaintext = options.reveal?.[id];
    if (plaintext === undefined) throw new Error('无法揭示');
    return variable(id, plaintext, { id, secret: true });
  });

  const writes = { variableSet: vi.fn(), variableDelete: vi.fn(), globalsSet: vi.fn() };
  const reads = { variableList, globalsList, secretReveal };
  const client = { ...reads, ...writes } as unknown as VariableHoverCommands;

  return { client, variableList, globalsList, secretReveal, writes };
}

describe('悬浮提示的取值判定', () => {
  it('同名同时存在于集合与环境时取环境，并标明来源是 environment', async () => {
    const { client } = fakeClient(
      [variable('host', 'env.test', { id: 'env-host' })],
      [variable('host', 'collection.test', { id: 'col-host', scope: 'collection' })],
    );
    const source = createVariableHoverSource(client, CONTEXT);

    expect(await source.resolve('host')).toEqual({
      kind: 'value',
      name: 'host',
      value: 'env.test',
      scope: 'environment',
      secret: false,
    });
  });

  it('只存在于集合时取集合，并标明来源是 collection', async () => {
    const { client } = fakeClient([], [variable('token', 'col-value', { scope: 'collection' })]);
    const source = createVariableHoverSource(client, CONTEXT);

    expect(await source.resolve('token')).toMatchObject({
      value: 'col-value',
      scope: 'collection',
    });
  });

  it('环境未激活时读全局变量，并标明来源是 global', async () => {
    const { client, variableList, globalsList } = fakeClient([
      variable('host', 'global.test', { scope: 'global' }),
    ]);
    const source = createVariableHoverSource(client, { ...CONTEXT, environmentId: null });

    expect(await source.resolve('host')).toMatchObject({
      value: 'global.test',
      scope: 'global',
    });
    expect(globalsList).toHaveBeenCalledWith('w1');
    // 没有激活环境时不去问环境作用域（集合级那次调用是另一回事）
    expect(variableList).not.toHaveBeenCalledWith('environment', expect.anything());
  });

  it('禁用条目不被当作生效条：退回同名组里此前最靠后的启用条目', async () => {
    const { client } = fakeClient([
      variable('host', 'first.test', { id: 'a' }),
      variable('host', 'disabled.test', { id: 'b', enabled: false }),
    ]);
    const source = createVariableHoverSource(client, CONTEXT);

    expect(await source.resolve('host')).toMatchObject({ value: 'first.test' });
  });

  it('同名组全部被禁用时该名字视为未解析', async () => {
    const { client } = fakeClient([variable('host', 'x', { enabled: false })]);
    const source = createVariableHoverSource(client, CONTEXT);

    expect(await source.resolve('host')).toEqual({ kind: 'unresolved', name: 'host' });
  });

  it('后端给不出值时呈现「不可读」，不伪装成空值', async () => {
    const { client } = fakeClient([variable('token', '', { state: 'unreadable' })]);
    const source = createVariableHoverSource(client, CONTEXT);

    expect(await source.resolve('token')).toMatchObject({ value: '不可读' });
  });

  it('查不到的普通名字标为未解析，不给任何看似有效的取值', async () => {
    const { client } = fakeClient([]);
    const source = createVariableHoverSource(client, CONTEXT);

    const info = await source.resolve('missing');
    expect(info).toEqual({ kind: 'unresolved', name: 'missing' });
    expect(info).not.toHaveProperty('value');
  });

  it('动态变量只说明自己是动态变量，不给具体取值', async () => {
    const { client } = fakeClient([]);
    const source = createVariableHoverSource(client, CONTEXT);

    const info = await source.resolve('$guid');
    expect(info).toEqual({ kind: 'dynamic', name: '$guid' });
    expect(info).not.toHaveProperty('value');
  });

  it('用户定义的 $guid 不遮蔽动态变量命名空间；名单外的 $ 名字仍算未解析', async () => {
    const { client } = fakeClient([variable('$guid', 'user-value')]);
    const source = createVariableHoverSource(client, CONTEXT);

    expect(await source.resolve('$guid')).toEqual({ kind: 'dynamic', name: '$guid' });
    expect(await source.resolve('$notAThing')).toEqual({
      kind: 'unresolved',
      name: '$notAThing',
    });
    expect(isDynamicVariable('$randomUUID')).toBe(true);
    expect(isDynamicVariable('$notAThing')).toBe(false);
    expect(isDynamicVariable('guid')).toBe(false);
  });

  it('惰性装载：连续几次悬停只取一次变量列表', async () => {
    const { client, variableList } = fakeClient([variable('host', 'env.test')]);
    const source = createVariableHoverSource(client, CONTEXT);

    await Promise.all([source.resolve('host'), source.resolve('host'), source.resolve('nope')]);
    await source.resolve('host');

    expect(variableList).toHaveBeenCalledTimes(2); // 环境 + 集合各一次
  });

  it('装载失败时退化为未解析，不把一次悬停变成错误态', async () => {
    const { client } = fakeClient([], [], { fail: true });
    const source = createVariableHoverSource(client, CONTEXT);

    await expect(source.resolve('host')).resolves.toEqual({
      kind: 'unresolved',
      name: 'host',
    });
  });
});

describe('悬浮提示的 secret 明文边界', () => {
  it('明文经既有的揭示出口取得：不看列表里那份掩码', async () => {
    const { client, secretReveal } = fakeClient(
      [variable('token', '••••••', { id: 'v-token', secret: true })],
      [],
      { reveal: { 'v-token': 'real-secret' } },
    );
    const source = createVariableHoverSource(client, CONTEXT);

    expect(await source.resolve('token')).toEqual({
      kind: 'value',
      name: 'token',
      value: 'real-secret',
      scope: 'environment',
      secret: true,
    });
    expect(secretReveal).toHaveBeenCalledWith('v-token');
  });

  it('明文不被缓存：两次悬停取两次，指针移开即丢弃', async () => {
    const { client, secretReveal } = fakeClient(
      [variable('token', '••••••', { id: 'v-token', secret: true })],
      [],
      { reveal: { 'v-token': 'real-secret' } },
    );
    const source = createVariableHoverSource(client, CONTEXT);

    await source.resolve('token');
    await source.resolve('token');

    expect(secretReveal).toHaveBeenCalledTimes(2);
  });

  it('非 secret 条目不去调揭示出口', async () => {
    const { client, secretReveal } = fakeClient([variable('host', 'env.test')]);
    const source = createVariableHoverSource(client, CONTEXT);

    await source.resolve('host');

    expect(secretReveal).not.toHaveBeenCalled();
  });

  it('揭示失败时呈现「不可读」，不把一次悬停变成抛错', async () => {
    const { client } = fakeClient([variable('token', '••••••', { secret: true })]);
    const source = createVariableHoverSource(client, CONTEXT);

    expect(await source.resolve('token')).toMatchObject({ value: '不可读', secret: true });
  });

  it('取值路径不产生任何写入', async () => {
    const { client, writes } = fakeClient(
      [variable('host', 'env.test'), variable('token', '••••••', { id: 'v-token', secret: true })],
      [],
      { reveal: { 'v-token': 'real-secret' } },
    );
    const source = createVariableHoverSource(client, CONTEXT);

    await source.resolve('host');
    await source.resolve('token');
    await source.resolve('$guid');
    await source.resolve('missing');

    expect(writes.variableSet).not.toHaveBeenCalled();
    expect(writes.variableDelete).not.toHaveBeenCalled();
    expect(writes.globalsSet).not.toHaveBeenCalled();
  });
});
