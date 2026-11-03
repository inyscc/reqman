import { describe, expect, it } from 'vitest';
import type { Commands } from '../src/lib/commands';
import {
  clampConsoleHeight,
  clampSplit,
  CONSOLE_DEFAULT,
  CONSOLE_MAX,
  CONSOLE_MIN,
  CONSOLE_SCOPE,
  readConsoleHeight,
  readSplitRatio,
  SPLIT_DEFAULT,
  SPLIT_MAX,
  SPLIT_MIN,
  SPLIT_SCOPE,
  writeConsoleHeight,
  writeSplitRatio,
} from '../src/lib/layout';

/** 只实现分栏用到的两个命令；settings 表由这个 Map 顶着。 */
function fakeClient(store = new Map<string, string>()) {
  const client = {
    settingsGet: async (scope: string, key: string) => store.get(`${scope}:${key}`) ?? null,
    settingsSet: async (scope: string, key: string, value: string) => {
      store.set(`${scope}:${key}`, value);
    },
  } as unknown as Commands;

  return { client, store };
}

describe('分栏比例（spec: 主区左右分栏与可调比例）', () => {
  it('把越界与读不懂的值收敛到合法区间，任一列都不会被压没（比例存在下限）', () => {
    expect(clampSplit(0.95)).toBe(SPLIT_MAX);
    expect(clampSplit(0)).toBe(SPLIT_MIN);
    expect(clampSplit(-1)).toBe(SPLIT_MIN);
    expect(clampSplit(Number.NaN)).toBe(SPLIT_DEFAULT);
  });

  it('从未调整过时回落默认比例', async () => {
    const { client } = fakeClient();
    expect(await readSplitRatio(client, 'w1')).toBe(SPLIT_DEFAULT);
  });

  it('存量值读不懂时回落默认，而不是把界面拖进怪状态', async () => {
    const { client } = fakeClient(new Map([[`${SPLIT_SCOPE}:w1`, '不是数字']]));
    expect(await readSplitRatio(client, 'w1')).toBe(SPLIT_DEFAULT);
  });

  it('比例按工作区各自记住，不互相沿用（每个工作区各自记住比例）', async () => {
    const { client } = fakeClient();
    await writeSplitRatio(client, 'w1', 0.7);
    await writeSplitRatio(client, 'w2', 0.3);

    expect(await readSplitRatio(client, 'w1')).toBe(0.7);
    expect(await readSplitRatio(client, 'w2')).toBe(0.3);
  });

  it('越界值在写入时就钳制，落库的值永远在区间内', async () => {
    const { client, store } = fakeClient();
    await writeSplitRatio(client, 'w1', 9);
    expect(store.get(`${SPLIT_SCOPE}:w1`)).toBe(String(SPLIT_MAX));
  });

  it('写入失败不抛出：比例只是显示偏好，写不进去不该打断使用', async () => {
    const client = {
      settingsSet: async () => {
        throw new Error('磁盘满了');
      },
    } as unknown as Commands;

    await expect(writeSplitRatio(client, 'w1', 0.6)).resolves.toBeUndefined();
  });
});

describe('Console 抽屉高度（spec: ui-layout「底部 Console 抽屉占位」）', () => {
  it('越界与读不懂的值收敛到区间内，主区与状态条都不会被挤没', () => {
    expect(clampConsoleHeight(0.9)).toBe(CONSOLE_MAX);
    expect(clampConsoleHeight(0)).toBe(CONSOLE_MIN);
    expect(clampConsoleHeight(-1)).toBe(CONSOLE_MIN);
    expect(clampConsoleHeight(Number.NaN)).toBe(CONSOLE_DEFAULT);
  });

  it('从未调整过时用默认高度', async () => {
    const { client } = fakeClient();
    expect(await readConsoleHeight(client, 'w1')).toBe(CONSOLE_DEFAULT);
  });

  it('读写往返，且按工作区各自记住', async () => {
    const { client } = fakeClient();
    await writeConsoleHeight(client, 'w1', 0.45);
    await writeConsoleHeight(client, 'w2', 0.2);

    expect(await readConsoleHeight(client, 'w1')).toBe(0.45);
    expect(await readConsoleHeight(client, 'w2')).toBe(0.2);
  });

  it('与分栏比例各存各的键，调一个不会顺手改掉另一个', async () => {
    const { client, store } = fakeClient();
    await writeSplitRatio(client, 'w1', 0.7);
    await writeConsoleHeight(client, 'w1', 0.4);

    // 同一个工作区里两条偏好互不牵连
    expect(store.get(`${SPLIT_SCOPE}:w1`)).toBe('0.7');
    expect(store.get(`${CONSOLE_SCOPE}:w1`)).toBe('0.4');
  });
});
