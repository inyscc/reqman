// 编辑器外观（字体族 / 字号 / 缩进数 / 缩进类型）的读写、归一与注入
// （change: add-editor-appearance-settings；spec: code-editors「编辑器外观可配置」）。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommands } from '../src/lib/commands';
import {
  DEFAULT_EDITOR_APPEARANCE,
  DEFAULT_FONT_FAMILY,
  applyEditorAppearance,
  currentEditorAppearance,
  indentUnit,
  parseFontFamily,
  parseFontSize,
  parseIndentCount,
  parseIndentType,
  parseWrap,
  readEditorAppearance,
  resolveWrapLines,
  subscribeEditorAppearance,
  writeEditorAppearance,
} from '../src/lib/editorAppearance';

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

afterEach(() => {
  // 模块级的当前值是全局的：用例之间复位，避免互相串味
  applyEditorAppearance(DEFAULT_EDITOR_APPEARANCE);
});

describe('编辑器外观的读写', () => {
  it('未配置时是系统等宽栈 + 12px + 缩进 4 + 空格', async () => {
    const { commands } = fakeCommands();
    expect(await readEditorAppearance(commands)).toEqual(DEFAULT_EDITOR_APPEARANCE);
    expect(DEFAULT_EDITOR_APPEARANCE.fontSize).toBe(12);
    expect(DEFAULT_EDITOR_APPEARANCE.indentCount).toBe(4);
    expect(DEFAULT_EDITOR_APPEARANCE.indentType).toBe('space');
  });

  it('写入后能读回同一份外观', async () => {
    const { commands, store } = fakeCommands();
    const appearance = {
      fontFamily: 'IBM Plex Mono, monospace',
      fontSize: 14,
      indentCount: 8,
      indentType: 'tab' as const,
      wrap: false,
    };
    await writeEditorAppearance(commands, appearance);

    expect(store.get('editor_appearance:font_family')).toBe('IBM Plex Mono, monospace');
    expect(store.get('editor_appearance:font_size')).toBe('14');
    expect(store.get('editor_appearance:indent_count')).toBe('8');
    expect(store.get('editor_appearance:indent_type')).toBe('tab');
    expect(store.get('editor_appearance:wrap')).toBe('false');
    expect(await readEditorAppearance(commands)).toEqual(appearance);
  });

  it('折行缺省开启，只有明确的 false 才关', async () => {
    const { commands, store } = fakeCommands();
    expect(DEFAULT_EDITOR_APPEARANCE.wrap).toBe(true);
    expect((await readEditorAppearance(commands)).wrap).toBe(true);

    // 读不懂、缺失、空一律回缺省；布尔值与 'false' 才表示关
    expect(parseWrap('true')).toBe(true);
    expect(parseWrap('false')).toBe(false);
    expect(parseWrap(false)).toBe(false);
    expect(parseWrap('weird')).toBe(true);
    expect(parseWrap('')).toBe(true);
    expect(parseWrap(null)).toBe(true);

    await writeEditorAppearance(commands, { ...DEFAULT_EDITOR_APPEARANCE, wrap: false });
    expect(store.get('editor_appearance:wrap')).toBe('false');
    expect((await readEditorAppearance(commands)).wrap).toBe(false);
  });

  it('折行的生效值：请求级覆盖应用级缺省', () => {
    expect(resolveWrapLines(true, 'inherit')).toBe(true);
    expect(resolveWrapLines(true, undefined)).toBe(true);
    expect(resolveWrapLines(true, 'off')).toBe(false);
    expect(resolveWrapLines(false, 'on')).toBe(true);
    expect(resolveWrapLines(false, 'inherit')).toBe(false);
    expect(resolveWrapLines(false, undefined)).toBe(false);
  });

  it('读不懂的值、越界值与空字体栈各自回落缺省，不抛错', () => {
    // 字体族：空白视为「未设置」
    expect(parseFontFamily('')).toBe(DEFAULT_FONT_FAMILY);
    expect(parseFontFamily('   ')).toBe(DEFAULT_FONT_FAMILY);
    expect(parseFontFamily(undefined)).toBe(DEFAULT_FONT_FAMILY);
    expect(parseFontFamily('  Menlo  ')).toBe('Menlo');

    // 字号：区间 8–32
    expect(parseFontSize('7')).toBe(12);
    expect(parseFontSize('33')).toBe(12);
    expect(parseFontSize('wide')).toBe(12);
    expect(parseFontSize('')).toBe(12);
    expect(parseFontSize('14')).toBe(14);

    // 缩进数：区间 1–8
    expect(parseIndentCount('0')).toBe(4);
    expect(parseIndentCount('9')).toBe(4);
    expect(parseIndentCount('2')).toBe(2);

    // 缩进类型：只有 space / tab 两个值
    expect(parseIndentType('tab')).toBe('tab');
    expect(parseIndentType('SPACE')).toBe('space');
    expect(parseIndentType('weird')).toBe('space');
    expect(parseIndentType(null)).toBe('space');
  });

  it('写入失败不抛出（外观偏好不该打断使用）', async () => {
    const call = vi.fn(async () => {
      throw new Error('存储不可用');
    });
    const commands = createCommands(call as never);
    await expect(
      writeEditorAppearance(commands, DEFAULT_EDITOR_APPEARANCE),
    ).resolves.toBeUndefined();
  });
});

describe('缩进单元：缩进数 + 缩进类型 → 格式化输出的缩进', () => {
  it('空格档给出对应数量的空格', () => {
    expect(indentUnit({ indentCount: 2, indentType: 'space' })).toBe('  ');
    expect(indentUnit({ indentCount: 4, indentType: 'space' })).toBe('    ');
  });

  it('Tab 档只给一个制表符，显示宽度交给编辑面的 tabSize', () => {
    expect(indentUnit({ indentCount: 4, indentType: 'tab' })).toBe('\t');
    expect(indentUnit({ indentCount: 1, indentType: 'tab' })).toBe('\t');
  });

  it('缩进数区间的两端（1 与 8）都成立', () => {
    expect(indentUnit({ indentCount: 1, indentType: 'space' })).toBe(' ');
    expect(indentUnit({ indentCount: 8, indentType: 'space' })).toBe('        ');
  });

  it('缺省外观对应 4 个空格——响应格式化的缺省缩进由此而来', () => {
    expect(indentUnit(DEFAULT_EDITOR_APPEARANCE)).toBe('    ');
  });
});

describe('外观的注入与订阅', () => {
  it('apply 把等宽变量写到文档根上', () => {
    applyEditorAppearance({
      fontFamily: 'Menlo, monospace',
      fontSize: 16,
      indentCount: 2,
      indentType: 'tab',
    });

    const style = document.documentElement.style;
    expect(style.getPropertyValue('--font-mono')).toBe('Menlo, monospace');
    expect(style.getPropertyValue('--text-mono')).toBe('16px');
  });

  it('apply 会通知订阅者，并返回归一后的值', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeEditorAppearance((value) => seen.push(value.fontFamily));

    // 空字体栈与越界数值在这里就被收敛，订阅者拿到的一定是可用的值
    const effective = applyEditorAppearance({
      fontFamily: '   ',
      fontSize: 99,
      indentCount: 0,
      indentType: 'space',
    });

    expect(effective).toEqual(DEFAULT_EDITOR_APPEARANCE);
    expect(seen).toEqual([DEFAULT_FONT_FAMILY]);
    expect(currentEditorAppearance()).toEqual(DEFAULT_EDITOR_APPEARANCE);

    // 退订之后不再收到
    unsubscribe();
    applyEditorAppearance({ ...DEFAULT_EDITOR_APPEARANCE, fontSize: 15 });
    expect(seen).toHaveLength(1);
  });
});
