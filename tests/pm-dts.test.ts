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

  it('快照语义：不声明 pm.request 的写方法', () => {
    // 声明了就会让人以为改得动，而宿主喂进去的是一份快照（design D6）：
    // 脚本对它的改动既不跨段可见，也不影响实际发出的请求
    expect(PM_DTS).not.toContain('add(');
    expect(PM_DTS).not.toContain('remove(');
    expect(PM_DTS).not.toContain('upsert(');
  });
});
