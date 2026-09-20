// 响应呈现的应用级配置与三层解析（change: response-format-selector）。

import { describe, expect, it, vi } from 'vitest';
import { createCommands } from '../src/lib/commands';
import {
  DEFAULT_PRESENTATION,
  FORMAT_DETECTION_KEY,
  INDENT_WIDTH_KEY,
  PRESENTATION_SCOPE,
  parseFormatDetection,
  parseIndentWidth,
  readPresentation,
  resolveInitialFormat,
  writePresentation,
} from '../src/lib/responsePresentation';

/** 一个真的记住写入的假存储：读回能反映写过的东西。 */
function fakeCommands() {
  const store = new Map<string, string>();
  const call = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'settings_get') {
      return store.get(`${String(args?.scope)}:${String(args?.key)}`) ?? null;
    }
    if (command === 'settings_set') {
      store.set(`${String(args?.scope)}:${String(args?.key)}`, String(args?.value));
      return null;
    }
    throw new Error(`未使用的命令：${command}`);
  });

  return { commands: createCommands(call as never), store };
}

describe('响应呈现配置的读写', () => {
  it('未配置时是跟随检测 + 缩进 2（与改动前行为一致）', async () => {
    const { commands } = fakeCommands();
    expect(await readPresentation(commands)).toEqual(DEFAULT_PRESENTATION);
  });

  it('写入后能读回同一份配置', async () => {
    const { commands, store } = fakeCommands();
    await writePresentation(commands, { formatDetection: 'json', indentWidth: 4 });

    expect(store.get(`${PRESENTATION_SCOPE}:${FORMAT_DETECTION_KEY}`)).toBe('json');
    expect(store.get(`${PRESENTATION_SCOPE}:${INDENT_WIDTH_KEY}`)).toBe('4');
    expect(await readPresentation(commands)).toEqual({ formatDetection: 'json', indentWidth: 4 });
  });

  it('读不懂的值回落默认，不抛错', () => {
    expect(parseFormatDetection('weird')).toBe('auto');
    expect(parseFormatDetection(null)).toBe('auto');
    expect(parseFormatDetection('json')).toBe('json');
    expect(parseIndentWidth('3')).toBe(2);
    expect(parseIndentWidth('')).toBe(2);
    expect(parseIndentWidth(undefined)).toBe(2);
    expect(parseIndentWidth('8')).toBe(8);
  });

  it('写入失败不抛出（显示偏好不该打断使用）', async () => {
    const call = vi.fn(async () => {
      throw new Error('存储不可用');
    });
    const commands = createCommands(call as never);
    await expect(writePresentation(commands, DEFAULT_PRESENTATION)).resolves.toBeUndefined();
  });
});

describe('三层解析的初始格式', () => {
  it('请求级覆盖优先于全局', () => {
    expect(resolveInitialFormat('auto', 'json')).toBe('json');
    expect(resolveInitialFormat('json', 'auto')).toBe('auto');
  });

  it('inherit 与缺失都跟随全局', () => {
    expect(resolveInitialFormat('json', 'inherit')).toBe('json');
    expect(resolveInitialFormat('json', undefined)).toBe('json');
    expect(resolveInitialFormat('auto', undefined)).toBe('auto');
  });

  it('全局缺省是跟随检测', () => {
    expect(resolveInitialFormat(DEFAULT_PRESENTATION.formatDetection, undefined)).toBe('auto');
  });
});
