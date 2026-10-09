import { describe, expect, it } from 'vitest';
import { describeError } from '../src/lib/commands';
import type { AppError, ProxyDecisionView } from '../src/lib/types';

/**
 * 失败路径上的代理决定。
 *
 * 后端把决定挂在错误的 `proxy_decision` 上，而 `code` / `message` 的位置与含义不变——
 * 既有的错误处理（`describeError` 与各处按 code 分支的逻辑）一行都不用改。
 */
describe('失败时仍能读出代理决定', () => {
  const view: ProxyDecisionView = {
    layer: 'request',
    mode: 'manual',
    proxy_url: 'http://10.0.0.1:8080',
    reason: 'manual',
    pac_url: null,
  };

  it('describeError 照旧给出 code 与 message，且决定原样可读', () => {
    const fromBackend = {
      code: 'proxy_error',
      message: '代理不可达',
      proxy_decision: view,
    };

    const described: AppError = describeError(fromBackend);

    expect(described.code).toBe('proxy_error');
    expect(described.message).toBe('代理不可达');
    expect(described.proxy_decision).toEqual(view);
  });

  it('不带决定的错误照旧只有 code 与 message', () => {
    const described = describeError({ code: 'not_found', message: '记录不存在' });

    expect(described).toEqual({ code: 'not_found', message: '记录不存在' });
    expect(described.proxy_decision).toBeUndefined();
  });

  it('直连的决定也读得出来——不是"没有可显示的代理"', () => {
    const direct: ProxyDecisionView = {
      layer: null,
      mode: null,
      proxy_url: null,
      reason: 'unconfigured',
      pac_url: null,
    };

    const described = describeError({
      code: 'connection_failed',
      message: '连接失败',
      proxy_decision: direct,
    });

    expect(described.proxy_decision?.reason).toBe('unconfigured');
    expect(described.proxy_decision?.proxy_url).toBeNull();
  });
});
