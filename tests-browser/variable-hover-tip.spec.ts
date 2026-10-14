// 占位符悬浮值提示在真实应用里的行为
// （change: show-variable-values-on-hover，任务 3.1 / 3.2 / 3.3 / 4.1）。
//
// 为什么必须在真浏览器里验：提示的锚点来自**字符到像素**的换算（地址栏按 input 自己的
// 文本排版取命中区间、键值表按输入框的字体量前缀宽度），而 §3.1 要求它是覆盖层——出现与
// 消失都不动布局。这两件事在 happy-dom 里都没有排版可依据。
//
// 应用在没有 Tauri 的环境里起不来，因此这里注入一个最小的假后端：一个集合 + 一个请求
// （地址栏、参数、请求头、raw 正文四处都放了占位符）+ 一组覆盖四条取值分支的变量。
// 假后端同时记下每一次命令调用，用来断言「看一次提示不写入任何东西」。

import type { Browser, Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser';

const FAKE_TAURI = `
window.__invoked = [];
window.__TAURI_INTERNALS__ = {
  transformCallback: function (callback) {
    var id = Math.floor(Math.random() * 1000000);
    window['_' + id] = callback;
    return id;
  },
  unregisterCallback: function (id) { delete window['_' + id]; },
  convertFileSrc: function (path) { return path; },
  invoke: async function (cmd, args) {
    window.__invoked.push(cmd);
    var auth = { kind: 'inherit', basic: null, bearer: null, api_key: null };
    var workspace = { id: 'w1', name: '探针工作区' };
    var collection = {
      id: 'c1', workspace_id: 'w1', name: '探针集合', auth: auth,
      pre_request_script: "console.log('前置跑过了');",
      test_script: null, sort_order: 0
    };
    var environment = { id: 'e1', workspace_id: 'w1', name: '本地', auth: auth, proxy: null, sort_order: 0 };
    window.__settings = window.__settings || {};
    function settingKey(scope, key) { return scope + ':' + key; }
    // 脚本已授权：本文件不验门禁，但 4.1 要跑一次带脚本的发送
    window.__settings['script_gate:c1'] = 'allowed';

    function variable(name, value, extra) {
      var stored = { state: 'value', value: value };
      return {
        id: 'v-' + name, scope: 'environment', owner_id: 'e1', name: name,
        is_secret: Boolean(extra && extra.secret), enabled: true, sort_order: 0,
        initial: stored, current: stored
      };
    }

    // 环境作用域：host 给值、token 是 secret、shadowed 与集合同名（环境应胜出）
    var environmentVariables = [
      variable('host', 'env.test'),
      variable('token', '••••••', { secret: true }),
      variable('shadowed', 'env-wins')
    ];
    // 集合作用域：token / shadowed 与上面同名（必须被环境盖过）、collection-only 独有
    var collectionVariables = [
      variable('token', 'col-token'),
      variable('shadowed', 'col-loses'),
      variable('collection-only', 'col-value')
    ];

    var request = {
      id: 'r-1', collection_id: 'c1', folder_id: null, name: '悬停探针',
      method: 'GET', url: 'https://{{host}}/users',
      params: [{ key: 'token', value: '{{token}}', enabled: true }],
      headers: [
        { key: 'X-Guid', value: '{{$guid}}', enabled: true },
        { key: 'X-Missing', value: '{{nope}}', enabled: true },
        { key: 'X-Scope', value: '{{collection-only}}', enabled: true }
      ],
      body: {
        kind: 'raw', raw: '{\\n  "host": "{{host}}",\\n  "guid": "{{$guid}}"\\n}',
        raw_language: 'json', form: [], urlencoded: [], binary: null
      },
      auth: auth,
      settings: {
        timeout: { mode: 'inherit' }, follow_redirects: true, verify_tls: true,
        http_version: 'auto', encoding: null, proxy: null
      },
      pre_request_script: null, test_script: null, sort_order: 0
    };

    switch (cmd) {
      case 'workspace_list': return [workspace];
      case 'workspace_active': return workspace;
      case 'workspace_tree':
        return [{
          collection: collection,
          children: [{ kind: 'request', id: 'r-1', name: '悬停探针', sort_order: 0, children: [], request: request }]
        }];
      case 'environment_list': return [environment];
      case 'environment_active': return environment;
      case 'globals_list': return [];
      case 'variable_list': return args.scope === 'collection' ? collectionVariables : environmentVariables;
      case 'collection_get': return collection;
      case 'folder_get': return null;
      case 'request_get': return request;
      case 'settings_get': return window.__settings[settingKey(args.scope, args.key)] || null;
      case 'settings_set': window.__settings[settingKey(args.scope, args.key)] = args.value; return null;
      case 'variables_preview':
        return {
          method: 'GET', url: 'https://env.test/users', params: [], headers: [],
          body_text: null, auth_kind: 'inherit', auth_key: null, proxy_url: null,
          unresolved: [], masked: false, insecure_warning: false
        };
      case 'secret_reveal':
        return variable('token', 'real-secret', { secret: true });
      case 'cookie_query': return [];
      case 'send_request':
        return {
          id: 'resp-1', status: 200, status_text: 'OK', elapsed_ms: 1,
          size_bytes: 2, declared_size_bytes: 2, truncated: false,
          headers: [['content-type', 'application/json']],
          content_type: 'application/json', body_text: '{}', body_base64: null,
          pretty_available: true, pretty_print_threshold: 1024,
          size_limit_bytes: 50 * 1024 * 1024, insecure_warning: false,
          final_url: 'https://env.test/users', via_proxy: false, http_version: 'HTTP/1.1',
          request_url: 'https://env.test/users', unresolved: []
        };
      case 'plugin:event|listen': return 1;
      default: return null;
    }
  }
};
`;

let server: ViteDevServer;
let origin = '';
let browser: Browser;

beforeAll(async () => {
  server = await createServer({
    root: process.cwd(),
    logLevel: 'error',
    // 端口避开 1420（tauri dev）与其它 browser 用例已占用的 5188–5200
    server: { port: 5187, strictPort: true },
  });
  await server.listen();
  origin = `http://localhost:${server.config.server.port ?? 5187}`;
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

interface Point {
  x: number;
  y: number;
}

async function openApp(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(15_000);
  await page.addInitScript(FAKE_TAURI);
  await page.goto(origin, { waitUntil: 'load' });
  await page.getByTestId('workspace-tree').getByText('悬停探针').click();
  await page.getByLabel('请求地址').waitFor();
  return page;
}

/** 地址栏里某个占位符的页面坐标：取着色叠层里那一段的实际矩形（与输入框同一份排版）。 */
async function urlPlaceholderPoint(page: Page, name: string): Promise<Point | null> {
  return page.evaluate((target) => {
    const span = Array.from(document.querySelectorAll('.url-overlay .var')).find(
      (node) => node.textContent === `{{${target}}}`,
    ) as HTMLElement | undefined;
    if (!span) return null;
    const rect = span.getBoundingClientRect();
    return { x: rect.left + 2, y: rect.top + rect.height / 2 };
  }, name);
}

/** 某个输入框里「开头数 prefix 个字符之后」的页面坐标（按输入框自己的字体量前缀宽度）。 */
async function inputPoint(
  page: Page,
  ariaLabel: string,
  prefix: string,
): Promise<Point | null> {
  return page.evaluate(
    ({ label, before }) => {
      const input = document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | null;
      if (!input) return null;

      const style = getComputedStyle(input);
      const probe = document.createElement('span');
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      probe.style.whiteSpace = 'pre';
      probe.style.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      probe.textContent = before;
      document.body.appendChild(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();

      const rect = input.getBoundingClientRect();
      const inset =
        (Number.parseFloat(style.borderLeftWidth) || 0) +
        (Number.parseFloat(style.paddingLeft) || 0);
      return {
        x: rect.left + inset - input.scrollLeft + width + 2,
        y: rect.top + rect.height / 2,
      };
    },
    { label: ariaLabel, before: prefix },
  );
}

/** raw 正文里含有某个片段的**那一行**上、该片段起始处的页面坐标。 */
async function bodyPoint(page: Page, needle: string): Promise<Point | null> {
  return page.evaluate((text) => {
    const line = Array.from(document.querySelectorAll('.code-surface .view-line')).find((node) =>
      (node.textContent ?? '').includes(text),
    ) as HTMLElement | undefined;
    if (!line) return null;

    const content = line.textContent ?? '';
    const at = content.indexOf(text);
    const style = getComputedStyle(line);

    const probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.whiteSpace = 'pre';
    probe.style.font = `${style.fontSize} ${style.fontFamily}`;
    probe.textContent = content.slice(0, at);
    document.body.appendChild(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();

    const rect = line.getBoundingClientRect();
    return { x: rect.left + width + 4, y: rect.top + rect.height / 2 };
  }, needle);
}

const OWN_TIP = '[data-testid="variable-tip"]';

/**
 * 读回当前**可见**的提示文字。
 *
 * 两种呈现都要看：地址栏与键值表走自研浮层（`[data-testid="variable-tip"]`），Body raw 走
 * Monaco 自带的悬停浮层（`.monaco-hover`，隐藏的那个 `getClientRects()` 为空）。四个编辑面
 * 说的是同一份内容，因此断言两侧合起来看。
 */
function collectTips(): string {
  const parts: string[] = [];
  const own = document.querySelector('[data-testid="variable-tip"]') as HTMLElement | null;
  if (own) parts.push(own.innerText);
  for (const node of Array.from(document.querySelectorAll('.monaco-hover')) as HTMLElement[]) {
    if (node.getClientRects().length > 0) parts.push(node.innerText);
  }
  return parts.join('\n').replace(/\s+/g, ' ').trim();
}

/** 把指针移到点上，等提示出现（并等到其中含有期望文字），返回提示文字。 */
async function hoverTip(page: Page, point: Point, expected?: string): Promise<string> {
  await page.mouse.move(point.x, point.y);
  await page.waitForFunction(
    (text) => {
      const parts: string[] = [];
      const own = document.querySelector('[data-testid="variable-tip"]') as HTMLElement | null;
      if (own) parts.push(own.innerText);
      for (const node of Array.from(document.querySelectorAll('.monaco-hover')) as HTMLElement[]) {
        if (node.getClientRects().length > 0) parts.push(node.innerText);
      }
      if (parts.length === 0) return false;
      const joined = parts.join('\n');
      return text === null || joined.includes(text);
    },
    expected ?? null,
    { timeout: 10_000 },
  );

  return page.evaluate(collectTips);
}

/** 把指针移开（离开编辑面），等两种提示都消失。 */
async function moveAway(page: Page): Promise<void> {
  await page.mouse.move(2, 2);
  await page.waitForFunction(
    () => {
      if (document.querySelector('[data-testid="variable-tip"]')) return false;
      return !Array.from(document.querySelectorAll('.monaco-hover')).some(
        (node) => (node as HTMLElement).getClientRects().length > 0,
      );
    },
    undefined,
    { timeout: 5_000 },
  );
}

/** 备一份「布局指纹」：编辑面与响应区的宽高、以及各自的滚动位置。 */
async function layoutFingerprint(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const boxOf = (selector: string) => {
      const node = document.querySelector(selector) as HTMLElement | null;
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        scrollLeft: node.scrollLeft,
        scrollTop: node.scrollTop,
      };
    };

    return {
      url: boxOf('[aria-label="请求地址"]'),
      requestPane: boxOf('.request-pane'),
      response: boxOf('.response-region'),
      table: boxOf('.table-scroll'),
      document: { height: document.documentElement.scrollHeight },
    };
  });
}

describe('占位符悬浮值提示（真实应用）', () => {
  it('地址栏：悬停出现、移开消失，且不改变编辑面与响应区的布局（3.1）', async () => {
    const page = await openApp();
    try {
      const before = await layoutFingerprint(page);

      const point = await urlPlaceholderPoint(page, 'host');
      expect(point, '地址栏里应有 {{host}} 的着色片段').not.toBeNull();

      const tip = await hoverTip(page, point!, 'env.test');
      expect(tip, `提示内容：${tip}`).toContain('host');
      expect(tip).toContain('env.test');
      expect(tip).toContain('环境');

      expect(
        await layoutFingerprint(page),
        '提示是覆盖层：出现不该改变任何编辑面或响应区的几何与滚动位置',
      ).toEqual(before);

      await moveAway(page);
    } finally {
      await page.close();
    }
  }, 90_000);

  it('参数表与请求头表：四类取值各呈其形，来源作用域随生效条走（3.2）', async () => {
    const page = await openApp();
    try {
      // 默认页签是 Body（spec: ui-layout「请求编辑器的默认标签页」）：参数表在 Params 下
      await page.locator('button.tab', { hasText: 'Params' }).click();

      // 参数表：token 在环境里是 secret、在集合里也有同名——生效的是环境那一条
      const secretPoint = await inputPoint(page, '参数值（可用 {{var}}） 0', '');
      const secret = await hoverTip(page, secretPoint!, 'real-secret');
      expect(secret, 'secret 应显示明文').toContain('real-secret');
      expect(secret, '来源应标出环境（集合里的同名条目已被盖过）').toContain('环境');

      await page.locator('button.tab', { hasText: 'Headers' }).click();
      await moveAway(page);

      const guidPoint = await inputPoint(page, '头值（可用 {{var}}） 0', '');
      const guid = await hoverTip(page, guidPoint!, '每次独立求值');
      expect(guid, '动态变量应说明它是每次独立求值的，而不是给一个值').toContain('$guid');
      expect(guid, '动态变量不该给出任何具体取值').not.toContain('env.test');

      const missingPoint = await inputPoint(page, '头值（可用 {{var}}） 1', '');
      const missing = await hoverTip(page, missingPoint!, '未解析');
      expect(missing).toContain('nope');

      const scopePoint = await inputPoint(page, '头值（可用 {{var}}） 2', '');
      const scope = await hoverTip(page, scopePoint!, 'col-value');
      expect(scope, '只存在于集合的变量来源应标为集合').toContain('集合');

      await moveAway(page);
    } finally {
      await page.close();
    }
  }, 90_000);

  it('Body raw：与其余编辑面同一份内容（3.2）', async () => {
    const page = await openApp();
    try {
      await page.locator('button.tab', { hasText: 'Body' }).click();
      await page.waitForSelector('.code-surface .view-line');

      const point = await bodyPoint(page, '{{host}}');
      expect(point, 'raw 正文里应有 {{host}}').not.toBeNull();

      const tip = await hoverTip(page, point!, 'env.test');
      expect(tip).toContain('host');
      expect(tip).toContain('env.test');
      expect(tip, '四个编辑面说的是同一件事：都带来源').toContain('环境');

      await moveAway(page);
    } finally {
      await page.close();
    }
  }, 90_000);

  it('提示不截住指针、不写入任何状态，且明文只出现在提示里（3.3 / 4.1）', async () => {
    const page = await openApp();
    try {
      const point = await urlPlaceholderPoint(page, 'host');
      const tip = await hoverTip(page, point!, 'env.test');
      expect(tip).toContain('env.test');

      // 3.3：提示 `pointer-events: none`——指针落在它上面时命中的应是它下面的东西
      const hitThrough = await page.evaluate((selector) => {
        const tipNode = document.querySelector(selector) as HTMLElement | null;
        if (!tipNode) return null;
        const rect = tipNode.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return {
          pointerEvents: getComputedStyle(tipNode).pointerEvents,
          hitIsTip: Boolean(hit) && tipNode.contains(hit),
          position: getComputedStyle(tipNode).position,
        };
      }, OWN_TIP);
      expect(hitThrough?.pointerEvents, '提示不该接住指针').toBe('none');
      expect(hitThrough?.hitIsTip, '提示中心的指针应落到它下面的元素上').toBe(false);
      expect(hitThrough?.position, '提示是覆盖层').toBe('fixed');

      // 4.1(c)：看一次提示不产生任何持久化写入。
      //
      // 取「第二次悬停」的增量而不是整段窗口：变量列表第一次要装载（读），之后就命中缓存；
      // 因此对一个非 secret 的变量再悬停一次，应当**一条命令都不多发**。这比「窗口内没有
      // 写命令」更准——窗口里混着界面自己的标签页持久化，与本能力无关。
      await moveAway(page);
      const beforeSecond = await page.evaluate(
        () => (window as unknown as { __invoked: string[] }).__invoked.length,
      );
      expect(await hoverTip(page, point!, 'env.test')).toContain('env.test');
      const delta = await page.evaluate(
        (from) => (window as unknown as { __invoked: string[] }).__invoked.slice(from),
        beforeSecond,
      );
      expect(delta, `看一次提示不该调用任何命令，实际：${delta.join(', ')}`).toEqual([]);

      // 4.1(a)(b)：secret 的明文出现在提示里，但不进入脚本 console 输出
      await page.locator('button.tab', { hasText: 'Params' }).click();
      const secretPoint = await inputPoint(page, '参数值（可用 {{var}}） 0', '');
      expect(await hoverTip(page, secretPoint!, 'real-secret')).toContain('real-secret');

      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.getByRole('button', { name: '脚本', exact: true }).waitFor();
      await page.getByRole('button', { name: '脚本', exact: true }).click();

      const consoleText = await page.evaluate(
        () =>
          (
            document.querySelector('[data-testid="script-console"]') as HTMLElement | null
          )?.innerText ?? '',
      );
      expect(consoleText, '脚本应真的跑过').toContain('前置跑过了');
      expect(consoleText, 'secret 明文不该进入脚本输出').not.toContain('real-secret');
    } finally {
      await page.close();
    }
  }, 90_000);
});
