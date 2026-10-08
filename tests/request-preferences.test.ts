import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CURL_BODY_COMPRESS,
  DEFAULT_CURL_LINE_LAYOUT,
  parseCurlBodyCompress,
  parseCurlLineLayout,
  resolveCurlBodyCompress,
  resolveCurlLineLayout,
} from '../src/lib/requestPreferences';

describe('cURL 正文压缩的应用级缺省（spec: ui-layout「cURL 正文压缩」）', () => {
  it('缺省为开，只有明确的 false 才关，读不懂的值回落缺省', () => {
    expect(DEFAULT_CURL_BODY_COMPRESS).toBe(true);

    expect(parseCurlBodyCompress(null)).toBe(true);
    expect(parseCurlBodyCompress(undefined)).toBe(true);
    expect(parseCurlBodyCompress('')).toBe(true);
    expect(parseCurlBodyCompress('true')).toBe(true);
    expect(parseCurlBodyCompress('  true ')).toBe(true);
    expect(parseCurlBodyCompress('坏值')).toBe(true);

    // 只有明确关掉才是关
    expect(parseCurlBodyCompress('false')).toBe(false);
    expect(parseCurlBodyCompress(' false ')).toBe(false);
  });
});

describe('cURL 正文压缩的生效值', () => {
  it('请求级三态覆盖应用级缺省', () => {
    expect(resolveCurlBodyCompress(false, 'compress')).toBe(true);
    expect(resolveCurlBodyCompress(true, 'raw')).toBe(false);
    expect(resolveCurlBodyCompress(true, 'inherit')).toBe(true);
    expect(resolveCurlBodyCompress(false, 'inherit')).toBe(false);
    // 缺失与 inherit 同义（旧数据没有这个字段）
    expect(resolveCurlBodyCompress(true, undefined)).toBe(true);
    expect(resolveCurlBodyCompress(false, undefined)).toBe(false);
  });
});

describe('cURL 命令布局的应用级缺省（spec: ui-layout「cURL 命令布局」）', () => {
  it('缺省多行，只有明确的 single 才是单行，读不懂的值回落缺省', () => {
    expect(DEFAULT_CURL_LINE_LAYOUT).toBe('multi');

    expect(parseCurlLineLayout(null)).toBe('multi');
    expect(parseCurlLineLayout(undefined)).toBe('multi');
    expect(parseCurlLineLayout('')).toBe('multi');
    expect(parseCurlLineLayout('坏值')).toBe('multi');
    expect(parseCurlLineLayout('multi')).toBe('multi');

    expect(parseCurlLineLayout('single')).toBe('single');
    expect(parseCurlLineLayout(' single ')).toBe('single');
  });
});

describe('cURL 命令布局的生效值', () => {
  it('请求级三态覆盖应用级缺省', () => {
    expect(resolveCurlLineLayout('multi', 'single')).toBe('single');
    expect(resolveCurlLineLayout('single', 'multi')).toBe('multi');
    expect(resolveCurlLineLayout('single', 'inherit')).toBe('single');
    expect(resolveCurlLineLayout('multi', 'inherit')).toBe('multi');
    // 缺失与 inherit 同义（旧数据没有这个字段）
    expect(resolveCurlLineLayout('single', undefined)).toBe('single');
  });
});
