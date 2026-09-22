// 脚本沙箱在**真实浏览器**里的加载与执行（浏览器后端 = 生产用的那条路径）。
//
// 为什么必须有这一层：`npm test` 跑在 Node 下，`uvm` 走的是 worker_threads 后端，
// 与 webview 里的 blob Worker 后端是两套实现。already 吃过两次亏——一次是沙箱进入
// 启动模块图导致 Tauri 初始化失效（白屏），一次是「只在某个引擎暴露」的只读属性差异
// （V8 静默失败、JavaScriptCore 抛错）。design 的构建验证要求写明：涉及脚本运行时的
// 改动，不能只有 `npm run build`，还得有一次真实浏览器的加载冒烟。
//
// 这里用 Vite dev server + Playwright Chromium：dev server 让我们能直接 import
// `/src/lib/scriptRuntime.ts`（构建产物里它是内联的，取不到模块级入口）。
// 端口刻意避开 1420，以免与正在运行的 `npm run tauri dev` 冲突。

import type { Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from './browser';

let server: ViteDevServer;
let origin = '';
let probe = '';

/**
 * 按文件名在 `openspec/` 下找探针（含 `archive/`）。
 *
 * 探针随所属变更一起归档（`openspec/changes/` → `openspec/changes/archive/<日期>-<变更名>/`），
 * 写死路径会在归档那一刻失效——用例要能跟着搬家。
 */
function findProbe(name: string): string {
  const stack = ['openspec'];

  while (stack.length > 0) {
    const dir = stack.pop() as string;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;

      if (entry.isDirectory()) stack.push(path);
      else if (entry.name === name) return readFileSync(path, 'utf8');
    }
  }

  throw new Error(`找不到探针 ${name}：它应位于 openspec/ 下（可能已随变更归档）`);
}

beforeAll(async () => {
  probe = findProbe('escape-probe.js');
  server = await createServer({
    root: process.cwd(),
    logLevel: 'error',
    server: { port: 5199, strictPort: true },
  });
  await server.listen();
  origin = `http://localhost:${server.config.server.port ?? 5199}`;
}, 60_000);

afterAll(async () => {
  await server?.close();
});

interface SandboxOutcome {
  ok: boolean;
  error?: string | null;
  thrown?: string;
  stack?: string;
  console?: string[];
  report?: Record<string, unknown>;
  assertions?: { name: string; passed: boolean }[];
}

/** 在真浏览器里跑一段脚本，回传 runScriptPhase 的结果。 */
async function runInBrowser(browser: Browser, code: string): Promise<SandboxOutcome> {
  const page = await browser.newPage();
  const logs: string[] = [];
  page.on('pageerror', (error) => logs.push(`[pageerror] ${error.message}`));

  await page.goto(origin, { waitUntil: 'domcontentloaded' });

  const outcome = await page.evaluate(async (script: string) => {
    // 用 new Function 包一层：字面量 import() 会被 vitest 改写成 SSR 辅助函数，
    // 而这段代码是在浏览器里求值的
    const dynamicImport = new Function('p', 'return import(p)') as (
      p: string,
    ) => Promise<typeof import('../src/lib/scriptRuntime')>;
    const mod = await dynamicImport('/src/lib/scriptRuntime.ts');

    const response = {
      id: 'resp-1',
      status: 200,
      status_text: 'OK',
      elapsed_ms: 1,
      size_bytes: 2,
      declared_size_bytes: 2,
      truncated: false,
      headers: [['content-type', 'application/json']],
      content_type: 'application/json',
      body_text: '{}',
      body_base64: null,
      pretty_available: true,
      pretty_print_threshold: 1024,
      size_limit_bytes: 50 * 1024 * 1024,
      insecure_warning: false,
      final_url: 'https://api.test/',
      via_proxy: false,
      http_version: 'HTTP/1.1',
      unresolved: [],
    };

    const commands = {
      settingsGet: async () => null,
      settingsSet: async () => undefined,
      globalsList: async () => [],
      variableList: async () => [],
      globalsSet: async () => ({}),
      variableSet: async () => ({}),
      secretReveal: async () => ({}),
      cookieQuery: async () => [],
      sendRequest: async () => response,
    };

    try {
      const result = await mod.runScriptPhase(
        commands,
        { workspaceId: 'w1', collectionId: 'c1', environmentId: null },
        'prerequest',
        [script],
      );
      const printed = result.console.map((entry) => entry.args.join(' ')).join('\n');
      const raw = /ESCAPE-PROBE (\{.*\})/.exec(printed);

      return {
        ok: true,
        error: result.error,
        console: result.console.map((entry) => entry.args.join(' ')),
        report: raw ? (JSON.parse(raw[1]) as Record<string, unknown>) : undefined,
        assertions: result.assertions.map((item) => ({
          name: item.name,
          passed: item.passed,
        })),
      };
    } catch (error) {
      return {
        ok: false,
        thrown: String(error && (error as Error).message),
        stack: String(error && (error as Error).stack).slice(0, 600),
      };
    }
  }, code);

  if (logs.length > 0) console.log('浏览器日志：\n' + logs.join('\n'));
  await page.close();

  return outcome as SandboxOutcome;
}

describe('脚本沙箱在真实浏览器里', () => {
  it('能加载沙箱、执行脚本并拿到 console 输出', async () => {
    const browser = await launchBrowser();
    try {
      const outcome = await runInBrowser(browser, 'console.log("browser-sandbox-ok")');

      expect(outcome.thrown).toBeUndefined();
      expect(outcome.error).toBeNull();
      expect(outcome.console?.join(' ')).toContain('browser-sandbox-ok');
    } finally {
      await browser.close();
    }
  }, 120_000);

  it('逃逸探针在浏览器后端跑通：四条判定全过，无原语泄漏、无可用回收向量', async () => {
    const browser = await launchBrowser();
    try {
      const outcome = await runInBrowser(browser, probe);

      expect(outcome.thrown).toBeUndefined();
      expect(outcome.error).toBeNull();

      // 四条判定：无原语泄漏、无可用回收向量、危险模块无可达能力、读文件失败
      const failed = (outcome.assertions ?? []).filter((item) => !item.passed);
      expect(failed.map((item) => item.name)).toEqual([]);
      expect(outcome.assertions).toHaveLength(4);

      const report = outcome.report as
        | { primitives: Record<string, string>; recovery: Record<string, string> }
        | undefined;
      expect(report).toBeDefined();

      // 生产路径上的硬断言：浏览器后端同样没有联网 / 存储 / Worker 原语
      const leaked = Object.entries(report?.primitives ?? {})
        .filter(([, value]) => !['undefined', 'THROWS'].includes(value))
        .map(([name]) => name);
      expect(leaked).toEqual([]);

      // 以及没有任何回收向量能拿回带 fetch 的全局对象
      const working = Object.entries(report?.recovery ?? {})
        .filter(([, value]) => String(value).startsWith('LEAKS'))
        .map(([name]) => name);
      expect(working).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 120_000);
});
