import { describe, expect, it } from 'vitest';
import {
  humanBytes,
  planPreview,
  prettyBody,
  prettyJson,
  prettyXml,
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

  it('按内容类型选择格式化方式', () => {
    expect(prettyBody('application/json', '{"a":1}')).toContain('\n');
    expect(prettyBody('text/plain', 'plain')).toBe('plain');
  });

  it('字节数可读化', () => {
    expect(humanBytes(512)).toBe('512 B');
    expect(humanBytes(2048)).toBe('2.0 KB');
    expect(humanBytes(3 * 1024 * 1024)).toBe('3.00 MB');
  });
});
