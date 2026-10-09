import type { ProxyDecisionView } from './types';

/**
 * 把一个代理决定写成一句可读的话（spec: ui-layout「响应区的代理决定」）。
 *
 * 三件事在这里定死：
 *
 * - **直连要写出来**。什么都不显示会被读成"没有这条信息"，而它其实是一条结论——
 *   用户要知道的恰恰是"这次没走代理"。
 * - **降级要与普通直连区分**。PAC 没取到而直连，和本来就配了直连，是两件不同的事；
 *   前者是故障，只是还没到让请求失败的程度。
 * - **只用地址**。决定里的 `proxy_url` 由后端剔除过 `user:pass@`，这里不碰任何凭据字段。
 */
export function proxyDecisionLabel(view: ProxyDecisionView | null | undefined): string | null {
  if (!view) return null;

  const parts: string[] = [
    view.proxy_url === null ? '直连' : `经代理 ${view.proxy_url}`,
  ];

  if (view.reason === 'whitelisted') {
    parts.push('命中不走代理的白名单');
  }
  if (view.reason === 'pac_unavailable') {
    parts.push('PAC 未能取得，已按直连降级');
  }
  if (view.reason === 'pac' && view.pac_stale) {
    parts.push('PAC 用的是上次成功取回的副本');
  }
  if (view.pac_url) {
    parts.push(`PAC ${view.pac_url}`);
  }

  return parts.join(' · ');
}
