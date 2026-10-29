// 编辑器补全声明（`src/lib/pmDts.ts`）与实现的防漂移守卫。
//
// 背景：把 `pm.request` / `pm.response` / `pm.cookies` 收成 `unknown` 时，这些成员之后的
// 补全整体消失——`unknown` 上不允许访问任何属性，脚本里 `pm.request.body` 之类就再也提示
// 不出来。`pmDts.ts` 顶部写着「勿让编辑器补全与真实运行时能力漂移」，这份用例就是那句话
// 的可执行版本：本次变更实现了 `pm.request` 的填充与 `pm.response` 的新字段，声明必须跟着走。

import { describe, expect, it } from 'vitest';
import { PM_DTS } from '../src/lib/pmDts';

describe('pm 补全声明与实现不漂移', () => {
  it('request / response / cookies 不再被收成 unknown', () => {
    expect(PM_DTS).not.toContain('const request: unknown');
    expect(PM_DTS).not.toContain('const response: unknown');
    expect(PM_DTS).not.toContain('const cookies: unknown');
  });

  it('声明了本次实现的 pm.request 字段面', () => {
    for (const member of [
      'interface Request',
      'url: RequestUrl',
      'method: string',
      'headers: HeaderList',
      'body?: RequestBody',
      'auth?: { type: string }',
    ]) {
      expect(PM_DTS, `补全声明缺少 ${member}`).toContain(member);
    }
  });

  it('声明了本次填充的 pm.response 字段面', () => {
    for (const member of [
      'downloadedBytes?: number',
      'cookies: CookieList',
      'originalRequest?: Request',
      'size(): { body: number; header: number; total: number }',
    ]) {
      expect(PM_DTS, `补全声明缺少 ${member}`).toContain(member);
    }
  });

  it('请求头可改写：声明了写方法', () => {
    // 请求头的改动会落到实际发出的请求上（spec: pm.request 的填充），因此这里必须
    // 声明得出来——声明面与运行时不漂移
    for (const member of ['add(header', 'upsert(header', 'remove(name', 'members:']) {
      expect(PM_DTS, `补全声明缺少 ${member}`).toContain(member);
    }
  });

  it('其余字段仍是快照：只声明读取面', () => {
    // 只取 `interface Request` 这一段：别处的 `url: string`（sendRequest 的载荷）不相关
    const requestBlock = PM_DTS.slice(
      PM_DTS.indexOf('interface Request {'),
      PM_DTS.indexOf('interface Response {'),
    );

    // URL 以 `RequestUrl` 声明（可 toString()），不是可赋值的裸字符串
    expect(requestBlock).toContain('url: RequestUrl');
    expect(requestBlock).toContain('method: string');
    // 不声明改写面的方法（例如 setUrl / setMethod）
    expect(requestBlock).not.toMatch(/set(Url|Method|Body)\s*\(/);
  });
});
