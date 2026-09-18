// ============================================================================
// Windows / WebView2 实机冒烟（任务 10.4）
//
// 自动化的是「实机上到底跑不跑得起来」这件事本身，而不是替代人工看界面：
// 它自己在本地起一个目标服务、拉起**构建产物**、用 CDP 连进 WebView2，
// 然后走真实界面把请求发出去，最后核对证据。
//
// 前置：
//   npm install
//   npm run tauri build            # 产物：src-tauri/target/release/reqman.exe
//   node openspec/changes/add-pm-script-runtime/probes/webview2-smoke.mjs
//   node …webview2-smoke.mjs --escape    # 额外跑 1.4 的逃逸探针（A 轮 + B 轮）
//
// 核对内容，每项都断言证据而不是「看起来正常」：
//   1. 真机的文档起点注入：主文档 `Object.prototype` 的冻结状态（9.8 的落地：应为 false）
//      —— 这一项就是 D17 的实机复验：冻结为 true 时沙箱宿主侧根本加载不了。
//   2. 启动模块图不含沙箱 chunk（9.2 的审计断言在真机上的对照）。
//   3. 1.3 的 CSP 继承：blob Worker 是否继承文档 CSP（`worker-csp-probe.js` 原文）。
//   4. 端到端：建集合 → 建请求 → 填地址与前后置脚本 → 保存 → 发送 →
//      「脚本」标签页里同时出现前置/后置的 console 与断言明细（脚本真的跑了）。
//   5. `--escape`：1.4 的逃逸探针在真实桥上的结果（A 轮未配置策略 / B 轮已配置策略）。
//
// 关于 CDP：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 是 WebView2 运行时的官方开关，
// 只作用于本次进程、不写任何配置或注册表，因此它既能冒烟 release 产物，也不改变产品行为。
//
// 关于应用数据：脚本会在**最后一个集合**里建一条请求（集合名固定为「新集合」，用户数据里
// 可能已有同名集合，按位置比按名字可靠），跑完把这条请求删掉；**空集合留在原地**，
// 需要时在界面上点一下 × 即可。既有集合的**集合级脚本会先于本请求的脚本执行**，
// 因此 console 里可能出现不相干的行——脚本会把它们连同断言一起打印出来，不做过滤。
// ============================================================================

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const CDP_PORT = 9222;
const TARGET_PORT = 8899;
// 默认冒烟构建产物；`REQMAN_APP` 可指向**已安装**的可执行文件（验证安装包时用）
const APP = process.env.REQMAN_APP ?? 'src-tauri/target/release/reqman.exe';
const RUN_ESCAPE = process.argv.includes('--escape');

const CSP_PROBE = readFileSync(new URL('./worker-csp-probe.js', import.meta.url), 'utf8');
const ESCAPE_PROBE = readFileSync(new URL('./escape-probe.js', import.meta.url), 'utf8');

const failures = [];

function check(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `\n    ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

function note(text) {
  console.log(`  · ${text}`);
}

function record(label, value) {
  console.log(`  ${label}：${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// 1. 本地目标服务：让「发送」有确定的结果，不依赖外网
// ---------------------------------------------------------------------------

const target = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, path: req.url }));
});
await new Promise((resolve) => target.listen(TARGET_PORT, '127.0.0.1', resolve));
note(`目标服务已就绪：http://127.0.0.1:${TARGET_PORT}/`);

// ---------------------------------------------------------------------------
// 2. 拉起构建产物并等 CDP 就绪
// ---------------------------------------------------------------------------

const app = spawn(APP, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
  },
  stdio: 'ignore',
});

let version = null;
for (let attempt = 0; attempt < 80 && !version; attempt += 1) {
  try {
    version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
  } catch {
    await delay(500);
  }
}

function shutdown(code) {
  target.close();
  app.kill();
  process.exit(code);
}

if (!version) {
  check('客户端启动并开放调试端口', false, `${APP} 未在 40 秒内就绪`);
  shutdown(1);
}
note(`WebView2 引擎：${version.Browser}`);

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
const context = browser.contexts()[0];
const page = context.pages()[0] ?? (await context.waitForEvent('page'));
await page.waitForLoadState('domcontentloaded');

/** 直接调后端的具名命令——与界面走的是同一套注册表，不新增任何能力。 */
async function invoke(command, args = {}) {
  return page.evaluate(
    ([name, payload]) => window.__TAURI_INTERNALS__.invoke(name, payload),
    [command, args],
  );
}

const activeWorkspace = await invoke('workspace_active');
const workspaceId = activeWorkspace?.id ?? (await invoke('workspace_list'))[0]?.id;
if (!workspaceId) {
  check('找到活动工作区', false, 'workspace_list / workspace_active 都为空');
  shutdown(1);
}
note(`活动工作区：${activeWorkspace?.name ?? '(未命名)'} (${workspaceId})`);

/** 当前工作区里所有集合的 id，用于「创建前后做差」定位本次新建的那个。 */
async function collectionIds() {
  const trees = await invoke('workspace_tree', { workspaceId });
  return (trees ?? []).map((tree) => tree.collection.id);
}

/**
 * 清掉历史冒烟留下的空集合。
 *
 * 只删**同时**满足三条的：名为「新集合」、没有任何子项、且集合级前后置脚本都是空的。
 * 第三条是关键——用户自己的集合也叫「新集合」并且往往带着脚本，不能碰。
 */
async function sweepEmptySmokeCollections(label) {
  const trees = (await invoke('workspace_tree', { workspaceId })) ?? [];
  const removed = [];
  const spared = [];

  for (const tree of trees) {
    const collection = tree.collection;

    if (collection.name !== '新集合') continue;

    const empty = (tree.children ?? []).length === 0;
    const scripted = Boolean(
      (collection.pre_request_script ?? '').trim() || (collection.test_script ?? '').trim(),
    );

    if (empty && !scripted) {
      await invoke('collection_delete', { id: collection.id });
      removed.push(collection.id);
    } else {
      spared.push({ id: collection.id, empty, scripted });
    }
  }

  note(`${label}：删除 ${removed.length} 个空的「新集合」，保留 ${spared.length} 个（有子项或有脚本）`);
  if (spared.length > 0) record('保留的集合（不动）', spared);
  return removed;
}

if (process.argv.includes('--cleanup')) {
  await sweepEmptySmokeCollections('清理');
  await browser.close();
  console.log(
    failures.length === 0 ? '\n清理完成。' : `\n失败项（${failures.length}）：\n  - ${failures.join('\n  - ')}`,
  );
  shutdown(failures.length === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 3. 真机环境：文档起点注入的状态与启动模块图
// ---------------------------------------------------------------------------

const environment = await page.evaluate(() => ({
  frozen: Object.isFrozen(Object.prototype),
  origin: location.origin,
  tauriInternals: typeof window.__TAURI_INTERNALS__ !== 'undefined',
  resources: performance.getEntriesByType('resource').map((entry) => entry.name),
  // 构建产物里的入口 chunk（dev 下是 /src/main.tsx，这里只对构建产物做体积判据）
  entrySize:
    performance
      .getEntriesByType('resource')
      .find((entry) => /\/assets\/index-.*\.js$/.test(entry.name))?.decodedBodySize ?? null,
}));
note(`页面 origin：${environment.origin}`);

// 1.5 记的那条症状就是这一项：注入的初始化脚本没生效时 `__TAURI_INTERNALS__` 不存在，
// 所有 invoke 都会失败、界面等于废掉。它是「静态 import 沙箱」那轮实验的判据。
check(
  'Tauri IPC 引导可用（`__TAURI_INTERNALS__` 存在）',
  environment.tauriInternals === true,
  '缺失意味着初始化脚本没生效：所有 invoke 会失败',
);

check(
  '9.8 落地：真机主文档的 Object.prototype 未被冻结',
  environment.frozen === false,
  environment.frozen
    ? "仍被冻结 —— 沙箱宿主侧会在求值期抛 `Cannot assign to read only property 'toString'`"
    : '',
);

const sandboxRequests = environment.resources.filter((url) => url.includes('postman-sandbox'));
check(
  '启动阶段没有单独去取沙箱 chunk（9.2 的真机对照）',
  sandboxRequests.length === 0,
  sandboxRequests.join('\n    '),
);

// 上面那条**单独不足以**判定「沙箱没进启动图」：沙箱被静态 import 时会被**内联**进入口 chunk，
// 此时根本没有带 postman-sandbox 名字的 URL 可查（本次 1.5 归因复核实测到这一点）。
// 能区分的判据是入口 chunk 的体积：懒加载时约 282 KB，内联时约 3.4 MB。
const entryLimit = 1_000_000;
check(
  `入口 chunk 未被沙箱撑大（< ${entryLimit} 字节）`,
  typeof environment.entrySize === 'number' && environment.entrySize < entryLimit,
  `入口 chunk = ${environment.entrySize ?? '未取到'} 字节（懒加载约 282 KB；内联沙箱约 3.4 MB）`,
);

// ---------------------------------------------------------------------------
// 4. 1.3：blob Worker 是否继承文档 CSP（探针原文）
// ---------------------------------------------------------------------------

const cspProbe = new Promise((resolve) => {
  page.on('console', (message) => {
    const text = message.text();
    if (text.startsWith('CSP-PROBE ')) {
      try {
        resolve(JSON.parse(text.slice('CSP-PROBE '.length)));
      } catch {
        resolve(null);
      }
    }
  });
});
await page.evaluate(CSP_PROBE);
const csp = await Promise.race([cspProbe, delay(20_000).then(() => null)]);

if (!csp) {
  check('1.3 CSP 继承探针在真机上跑出结果', false, '20 秒内没有看到 CSP-PROBE 输出');
} else {
  const results = csp.report?.results ?? {};
  const directives = (csp.report?.violations ?? []).map((item) => item.directive);

  check(
    '正对照：Worker 内同源请求成功（它失败则整轮无效）',
    String(results.sameOriginFetch ?? '').startsWith('ok'),
    `sameOriginFetch=${results.sameOriginFetch}`,
  );
  check(
    'connect-src：Worker 的远程 fetch 被 CSP 拦下',
    results.remoteFetch !== 'reached',
    `remoteFetch=${results.remoteFetch}`,
  );
  check(
    'script-src：Worker 的远程 importScripts 被 CSP 拦下',
    results.remoteImportScripts !== 'loaded',
    `remoteImportScripts=${results.remoteImportScripts}`,
  );
  check(
    'worker-src：嵌套 blob Worker 被允许（应用 CSP 放行 blob:）',
    String(results.nestedBlobWorker ?? '').startsWith('created'),
    `nestedBlobWorker=${results.nestedBlobWorker}`,
  );
  check(
    '违规事件给出了指令名（CSP 继承的可靠信号）',
    directives.length > 0,
    `violations=${JSON.stringify(csp.report?.violations ?? [])}`,
  );
  record('1.3 记录', { results, violations: directives });
}

// ---------------------------------------------------------------------------
// 5. 走真实界面：建集合 → 建请求 → 填脚本 → 保存 → 发送
// ---------------------------------------------------------------------------

const idsBefore = await collectionIds();
await page.getByRole('button', { name: '+ 集合' }).click();

// 用集合 id 的差集定位本次新建的那个：名字固定是「新集合」，会与用户既有集合重名，不能按名字认
let createdCollectionId = null;
for (let attempt = 0; attempt < 30 && !createdCollectionId; attempt += 1) {
  const ids = await collectionIds();
  createdCollectionId = ids.find((id) => !idsBefore.includes(id)) ?? null;
  if (!createdCollectionId) await delay(500);
}
if (!createdCollectionId) note('未能定位本次新建的集合 id（收尾时会提示）');

// 在最后一行（刚建的）集合里建请求
await page.locator('button[title="在集合根新建请求"]').last().click();

const smokePath = `/smoke-${Date.now()}`;
await page.getByLabel('请求地址').fill(`http://127.0.0.1:${TARGET_PORT}${smokePath}`);

/** 把前后置脚本写进去并保存（保存 = 「编辑即授权」，发送时不会撞门禁）。 */
async function writeScripts(pre, post) {
  await page.getByRole('button', { name: 'scripts', exact: true }).click();
  await page.getByLabel('前置脚本').fill(pre);
  await page.getByLabel('后置脚本').fill(post);
  await page.getByRole('button', { name: '保存', exact: true }).click();
}

/** 点发送，等界面给出结果，然后读「脚本」标签页。 */
async function sendAndReadScriptReport() {
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page
    .waitForFunction(
      () =>
        document.querySelector('[data-testid="status"]') ||
        document.querySelector('[data-testid="app-error"]'),
      undefined,
      { timeout: 60_000 },
    )
    .catch(() => undefined);

  const status = await page
    .locator('[data-testid="status"]')
    .textContent()
    .catch(() => null);
  const sendError = await page
    .locator('[data-testid="app-error"]')
    .textContent()
    .catch(() => null);

  const scriptTab = page.getByRole('button', { name: '脚本', exact: true });
  if ((await scriptTab.count()) > 0) await scriptTab.click();

  const report = await page.evaluate(() => ({
    console: [...document.querySelectorAll('[data-testid="script-console"] li')].map((li) => ({
      text: li.textContent ?? '',
      phase: li.getAttribute('data-phase'),
    })),
    passed: [...document.querySelectorAll('[data-testid="assertion-pass"]')].map(
      (row) => row.textContent ?? '',
    ),
    failed: [...document.querySelectorAll('[data-testid="assertion-fail"]')].map(
      (row) => row.textContent ?? '',
    ),
    error: document.querySelector('[data-testid="script-error"]')?.textContent ?? null,
  }));

  return { status, sendError, report };
}

await writeScripts(
  [
    // 对象参数按结构呈现（10.4 顺带修的呈现缺陷：曾经是 [object Object]）
    "console.log('webview2-smoke-pre', { a: 1, nested: { b: [1, 2] } });",
    "pm.variables.set('smoke', 'ok');",
    // 传输失败时脚本侧要拿到可读原因（10.4 抓到的缺陷：曾经是 [object Object]）
    'await new Promise((resolve) => {',
    "  pm.sendRequest('http://probe.invalid/x', (err) => {",
    "    console.log('webview2-smoke-err: ' + (err ? err.message : '（无错误）'));",
    '    resolve();',
    '  });',
    '});',
  ].join('\n'),
  "console.log('webview2-smoke-post ' + pm.response.code);\n" +
    "pm.test('冒烟：状态码为 200', () => pm.expect(pm.response.code).to.eql(200));",
);

const basic = await sendAndReadScriptReport();
check('请求已发送并拿到响应', Boolean(basic.status), basic.sendError ? `界面报错：${basic.sendError}` : '没有状态码');
note(`响应状态：${basic.status ?? '（无）'}`);

const pre = basic.report.console.find((entry) => entry.text.includes('webview2-smoke-pre'));
const post = basic.report.console.find((entry) => entry.text.includes('webview2-smoke-post'));

check('脚本没有报错（沙箱宿主侧在真机上加载成功）', basic.report.error === null, basic.report.error ?? '');
check(
  '前置脚本的 console 输出可见，且来源标为前置',
  Boolean(pre) && pre.phase === 'prerequest',
  JSON.stringify(pre ?? null),
);
check(
  '后置脚本的 console 输出可见，且来源标为后置',
  Boolean(post) && post.phase === 'test',
  JSON.stringify(post ?? null),
);
const transportError = basic.report.console.find((entry) =>
  entry.text.includes('webview2-smoke-err:'),
);
check(
  'console 的对象参数按结构呈现（不是 [object Object]）',
  Boolean(pre?.text.includes('{"a":1,"nested":{"b":[1,2]}}')) && !pre?.text.includes('[object Object]'),
  JSON.stringify(pre ?? null),
);
check(
  'pm.sendRequest 失败时脚本拿到可读原因（不是 [object Object]）',
  Boolean(transportError) && !transportError?.text.includes('[object Object]'),
  JSON.stringify(transportError ?? null),
);
check(
  '断言明细可见且通过',
  basic.report.passed.some((text) => text.includes('冒烟：状态码为 200')) &&
    basic.report.failed.length === 0,
  JSON.stringify({ passed: basic.report.passed, failed: basic.report.failed }),
);
record('10.4 端到端记录', basic.report);

// ---------------------------------------------------------------------------
// 6.（可选）1.4 逃逸探针：A 轮未配置策略 / B 轮已配置策略
// ---------------------------------------------------------------------------

if (RUN_ESCAPE) {
  // 读当前策略状态：这两者必须分开——「未配置」与「已配置但读不懂」行为不同
  await page.getByRole('button', { name: '设置' }).click();
  const state = (await page.locator('[data-testid="policy-state"]').textContent()) ?? '';
  const unreadable = state.includes('无法解析');
  const alreadyConfigured = !state.includes('未配置');
  note(`脚本目标策略当前状态：${state.trim()}`);

  const runProbeRound = async (label) => {
    await writeScripts(ESCAPE_PROBE, '');
    const outcome = await sendAndReadScriptReport();
    const line = outcome.report.console.find((entry) => entry.text.includes('ESCAPE-PROBE '));
    const raw = line ? line.text.slice(line.text.indexOf('ESCAPE-PROBE ') + 'ESCAPE-PROBE '.length) : null;

    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }

    console.log(`  —— 1.4 ${label} ——`);
    check(
      `${label}：逃逸探针跑出报告`,
      parsed !== null,
      parsed === null ? `脚本错误：${outcome.report.error ?? '无'} / 原始输出：${(raw ?? '').slice(0, 200)}` : '',
    );
    if (parsed) {
      const leaked = Object.entries(parsed.primitives ?? {}).filter(
        ([, value]) => !['undefined', 'THROWS'].includes(String(value)),
      );
      const recovery = Object.entries(parsed.recovery ?? {}).filter(([, value]) =>
        String(value).startsWith('LEAKS'),
      );
      const capable = Object.entries(parsed.modules ?? {}).flatMap(([id, modes]) =>
        Object.entries(modes ?? {})
          .filter(([, entry]) => entry?.verdict === 'CAPABLE')
          .map(([mode]) => `${mode}:${id}`),
      );

      check(`${label}：沙箱内没有联网 / 存储 / Worker 原语`, leaked.length === 0, JSON.stringify(leaked));
      check(`${label}：回收全局对象的向量都不成立`, recovery.length === 0, JSON.stringify(recovery));
      check(`${label}：危险模块没有可达能力（stub 不算）`, capable.length === 0, JSON.stringify(capable));
      check(`${label}：读文件尝试失败`, !String(parsed.fsAttempt ?? '').startsWith('READ'), String(parsed.fsAttempt));
      check(
        `${label}：探针自身的四条断言全部通过`,
        outcome.report.failed.length === 0 && outcome.report.passed.length >= 4,
        JSON.stringify({ passed: outcome.report.passed, failed: outcome.report.failed }),
      );
      check(`${label}：脚本没有报错`, outcome.report.error === null, outcome.report.error ?? '');

      record(`${label}：ipc 条目`, parsed.ipc);
      record(`${label}：faker 路径`, parsed.faker);
      record(`${label}：require 别名与 require 同源`, parsed.requireAlias);
      record(`${label}：fsAttempt`, parsed.fsAttempt);
      record(`${label}：五条断言`, outcome.report.assertions ?? {
        passed: outcome.report.passed,
        failed: outcome.report.failed,
      });
    }

    return outcome;
  };

  if (unreadable) {
    note('策略已配置但无法解析 —— 不改变用户配置，只用当前状态跑一轮');
    await runProbeRound('当前配置');
  } else {
    if (alreadyConfigured) {
      note('检测到用户已配置策略：不覆盖，只按当前配置跑一轮（B 轮语义）');
      await runProbeRound('当前配置');
    } else {
      await runProbeRound('A 轮（未配置策略）');

      // B 轮：临时收紧策略，验「拒绝发生在桥的出口」而不是发出去再失败
      await page.getByLabel('策略模式').selectOption('allow');
      await page.getByLabel('主机名单').fill('api.test');
      await page.getByRole('button', { name: '保存策略' }).click();
      await page.locator('[data-testid="settings-status"]').waitFor({ timeout: 10_000 }).catch(() => undefined);
      note('已临时把策略设为 allow：api.test');

      const roundB = await runProbeRound('B 轮（已配置策略 allow api.test）');
      const roundBLine = roundB.report.console.find((entry) => entry.text.includes('ESCAPE-PROBE '));
      const roundBReport = roundBLine
        ? JSON.parse(
            roundBLine.text.slice(
              roundBLine.text.indexOf('ESCAPE-PROBE ') + 'ESCAPE-PROBE '.length,
            ),
          )
        : null;

      const ipcEntry = roundBReport?.ipc?.['http://ipc.localhost/'] ?? {};
      check(
        'B 轮：IPC 入口在**桥的出口**就被拒（而不是发出去再失败）',
        String(ipcEntry.error ?? '').includes('不在允许范围内'),
        JSON.stringify(ipcEntry),
      );

      // 恢复为不限制，别把用户环境留在收紧状态
      await page.getByRole('button', { name: '恢复为不限制' }).click();
      await page.locator('[data-testid="settings-status"]').waitFor({ timeout: 10_000 }).catch(() => undefined);
      note('已恢复为不限制目标（与 Postman 一致）');
    }
  }

  await page.getByRole('button', { name: '设置' }).click();
}

// ---------------------------------------------------------------------------
// 7. 清掉本次冒烟建的请求（空集合留在原地）
// ---------------------------------------------------------------------------

await page.getByRole('button', { name: '删除', exact: true }).click();
note('已删除本次冒烟创建的请求');

if (createdCollectionId) {
  await invoke('collection_delete', { id: createdCollectionId });
  note(`已删除本次冒烟创建的集合（${createdCollectionId}）——跑完不留痕`);
} else {
  note('未能定位本次新建的集合；若界面上多出一个空的「新集合」，点 × 或跑 --cleanup 清理');
}

await browser.close();

console.log(
  failures.length === 0
    ? '\n全部通过：WebView2 实机冒烟无失败项。'
    : `\n失败项（${failures.length}）：\n  - ${failures.join('\n  - ')}`,
);
shutdown(failures.length === 0 ? 0 : 1);
