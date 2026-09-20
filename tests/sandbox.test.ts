import { describe, expect, it } from 'vitest';
import {
  bodyBytes,
  detectResponseFormat,
  hexDump,
  humanBytes,
  planPreview,
  prettyJson,
  prettyXml,
  renderBody,
} from '../src/lib/sandbox';

describe('响应呈现方式的选择', () => {
  it('HTML 与 SVG 走隔离承载', () => {
    expect(planPreview('text/html; charset=utf-8', '<p>hi</p>', false).kind).toBe('iframe');
    expect(planPreview('image/svg+xml', '<svg/>', false).kind).toBe('iframe');
    expect(planPreview('text/markdown', '# 标题', false).kind).toBe('iframe');
  });

  it('图片走图片视图', () => {
    expect(planPreview('image/png', null, true).kind).toBe('binary');
  });

  it('普通文本直接展示原文', () => {
    const plan = planPreview('application/json', '{"a":1}', false);
    expect(plan.kind).toBe('text');
    expect(plan.text).toBe('{"a":1}');
  });

  it('二进制正文不当作文本处理', () => {
    expect(planPreview('application/octet-stream', null, true).kind).toBe('binary');
  });
});

describe('格式检测（内容类型嗅探的唯一入口）', () => {
  it('按内容类型判定 JSON / XML / HTML / Markdown / 文本', () => {
    expect(detectResponseFormat('application/json; charset=utf-8')).toBe('json');
    expect(detectResponseFormat('application/xml')).toBe('xml');
    expect(detectResponseFormat('text/html')).toBe('html');
    expect(detectResponseFormat('text/markdown')).toBe('markdown');
    expect(detectResponseFormat('text/plain')).toBe('text');
    expect(detectResponseFormat(null)).toBe('text');
  });
});

describe('格式化', () => {
  it('JSON 被缩进，原始内容保持可解析', () => {
    const pretty = prettyJson('{"a":[1,2]}');
    expect(pretty).toContain('\n');
    expect(JSON.parse(pretty)).toEqual({ a: [1, 2] });
  });

  it('非法 JSON 原样返回', () => {
    expect(prettyJson('not json')).toBe('not json');
  });

  it('XML 被缩进', () => {
    const pretty = prettyXml('<a><b>1</b></a>');
    expect(pretty.split('\n').length).toBeGreaterThan(1);
    expect(pretty).toContain('<b>1</b>');
  });

  it('缩进宽度可配（2 / 4 / 8），固定空格', () => {
    expect(prettyJson('{"a":1}', 2).split('\n')[1]).toBe('  "a": 1');
    expect(prettyJson('{"a":1}', 4).split('\n')[1]).toBe('    "a": 1');
    expect(prettyJson('{"a":1}', 8).split('\n')[1]).toBe('        "a": 1');
    // XML 走同一档宽度
    expect(prettyXml('<a><b>1</b></a>', 4).split('\n')[1]).toBe('    <b>1</b>');
  });

  it('字节数可读化', () => {
    expect(humanBytes(512)).toBe('512 B');
    expect(humanBytes(2048)).toBe('2.0 KB');
    expect(humanBytes(3 * 1024 * 1024)).toBe('3.00 MB');
  });
});

describe('响应正文的解释（spec: 响应内容与格式化）', () => {
  it('跟随检测按检测结果格式化', () => {
    const json = renderBody('auto', 'json', '{"a":1}');
    expect(json).toEqual({ view: 'text', text: '{\n  "a": 1\n}', language: 'json' });

    const html = renderBody('auto', 'html', '<p>hi</p>');
    expect(html).toEqual({ view: 'text', text: '<p>hi</p>', language: 'html' });

    const text = renderBody('auto', 'text', 'plain');
    expect(text).toEqual({ view: 'text', text: 'plain', language: 'plaintext' });
  });

  it('强制解释成功时按所选格式呈现，高亮语言跟随所选格式', () => {
    expect(renderBody('json', 'html', '{"a":1}')).toEqual({
      view: 'text',
      text: '{\n  "a": 1\n}',
      language: 'json',
    });
    expect(renderBody('xml', 'text', '<a><b>1</b></a>').language).toBe('xml');
    expect(renderBody('html', 'json', '<p>hi</p>')).toEqual({
      view: 'text',
      text: '<p>hi</p>',
      language: 'html',
    });
    expect(renderBody('raw', 'json', '{"a":1}')).toEqual({
      view: 'text',
      text: '{"a":1}',
      language: 'plaintext',
    });
  });

  it('强制解释失败时静默回退为原样文本', () => {
    expect(renderBody('json', 'text', 'not json')).toEqual({
      view: 'text',
      text: 'not json',
      language: 'json',
    });
    expect(renderBody('xml', 'text', '不是 XML')).toEqual({
      view: 'text',
      text: '不是 XML',
      language: 'xml',
    });
  });

  it('缩进宽度作用于强制与自动两条路径', () => {
    expect(renderBody('json', 'text', '{"a":1}', 4).text).toContain('\n    "a"');
    expect(renderBody('auto', 'json', '{"a":1}', 8).text).toContain('\n        "a"');
  });

  it('Hex 是字节视图，不产出文本', () => {
    expect(renderBody('hex', 'json', '{"a":1}')).toEqual({ view: 'hex' });
  });
});

describe('Hex 视图（spec: Hex 视图场景）', () => {
  it('文本响应经 UTF-8 再编码取回真实字节', () => {
    const bytes = bodyBytes('abc', null);
    expect(Array.from(bytes)).toEqual([0x61, 0x62, 0x63]);

    const dump = hexDump(bytes);
    expect(dump.startsWith('00000000  61 62 63')).toBe(true);
    // 后三列是 ASCII 列：不足 16 字节的那一行只补齐，不生成额外字符
    expect(dump.endsWith('abc')).toBe(true);
  });

  it('非 UTF-8 响应（后端只给 base64）走 base64 通道', () => {
    // 0xD6 0xD0 0xCE 0xC4 是 GBK 的「中文」，不是合法 UTF-8——正是 Hex 要看见的东西
    const base64 = btoa('\u00d6\u00d0\u00ce\u00c4');
    const bytes = bodyBytes(null, base64);
    expect(Array.from(bytes)).toEqual([0xd6, 0xd0, 0xce, 0xc4]);
    const dump = hexDump(bytes);
    expect(dump).toContain('d6 d0 ce c4');
    // 不可打印字节在 ASCII 列显示为 `.`
    expect(dump.endsWith('....')).toBe(true);
  });

  it('base64 优先于文本（两者都在时以原始字节为准）', () => {
    expect(Array.from(bodyBytes('ignored', btoa('\u0000\u0001')))).toEqual([0, 1]);
  });

  it('每行 16 字节，偏移递增，不可见字符显示为点', () => {
    const bytes = new Uint8Array(20);
    bytes.fill(0x41);
    bytes[0] = 0x00;
    bytes[16] = 0x0a;
    const lines = hexDump(bytes).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith('00000000  00')).toBe(true);
    expect(lines[1].startsWith('00000010  0a')).toBe(true);
    expect(lines[0].endsWith('.AAAAAAAAAAAAAAA')).toBe(true);
  });

  it('无正文时是空字节', () => {
    expect(bodyBytes(null, null).length).toBe(0);
    expect(bodyBytes(undefined, undefined).length).toBe(0);
  });
});
