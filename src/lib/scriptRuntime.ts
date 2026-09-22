// pm 脚本运行时的宿主适配层。
//
// 这里是脚本对外的**唯一出口**（design.md D3）：沙箱内的代码只能经本模块触达变量与后端
// 命令。桥的每个出口都在下面显式列出，不做通用转发——任何新增出口都要在此处显式加，
// 并由安全审计断言出口集合（任务 3.6 / 9.2）。
//
// 三条调用形状是实测得来的，改动前先看 design.md 的「宿主侧调用形状」：
//   1. `execute` 的 target 必须是 `{ listen, script: '<代码字符串>' }`
//   2. 变量以 `[{ key, value, type }]` 喂进 `options.context`
//   3. 脚本的写入从 `execution.<scope>.values` 取回
// 第 1 条写错会**静默不执行**：没有输出、没有错误、`err` 为 `null`。

// 沙箱模块**刻意保持动态 import**。
//
// 原因一（站得住）：它连同一批浏览器 polyfill（events / buffer / string_decoder）会被拉进
// 启动模块图，入口 chunk 从约 282 KB 涨到约 3.43 MB，而这份代码只有真正执行脚本时才需要。
//
// 原因二（已更正）：原先记的是「静态 import 会让 Tauri 初始化脚本失效、`__TAURI_INTERNALS__`
// 缺失、应用黑屏」。复核（1.5 的归因，2026-09-17 实机）表明那条症状与静态 import 无关：
// 真正的原因是主文档的原型被 `freezePrototype` 冻结，导致这个 chunk 在**求值期**抛错、
// 应用根本没挂载（详见 design D17）。关掉冻结原型后，改回静态 import 重建的产物在 WebView2 上
// 启动、IPC 与脚本执行全部正常。所以动态 import 现在是**体积与纵深**的选择，不是「否则黑屏」。
//
// 注意：类型仍然从 'postman-sandbox' 引入——`import type` 会被编译器擦除，不产生
// 运行时依赖，所以不会重新引入上面的问题。
import type { SandboxContext } from 'postman-sandbox';
// describeError 不只是类型的提供者：桥的错误出口要用它做**同一套**归一化。
// Tauri 命令失败时拒绝给的是普通对象 `{ code, message }`（不是 Error 实例），只用
// `instanceof Error` 判断会把可读原因退化成 `[object Object]`——实机冒烟（10.4）抓到的就是这个。
import { describeError, type Commands } from './commands';
import { emptyBody } from './types';
import { effectiveByName } from './variables';
import type { CookieView, ResponsePayload, SavedRequest, StoredValue, Variable } from './types';

export type ScriptListen = 'prerequest' | 'test';

/**
 * 一次发送的取消出口（spec: http-engine「请求取消」）。
 *
 * 一次发送可能被取消在三处：脚本段、网络段、脚本内 `pm.sendRequest` 发出的请求。网络段
 * 由后端的发送会话注册表撤销；脚本段靠这里的 `signal` **立刻**兑现——不能改成「先销毁
 * 沙箱再等回调」，`disposeContext` 的注释记着同一个事实：uvm 终止 Worker 之后回调可能
 * 永不触发，那样 `executeOne` 的 promise 永不兑现、发送态就卡在「发送中」了。
 */
export interface PhaseCancellation {
  /** 本次发送的会话标识：脚本内发出的请求带上它，取消按会话撤销。 */
  attemptId: string;
  /** 取消信号；未取消时永不兑现。 */
  signal: Promise<void>;
  /** 该会话是否已被取消。 */
  isCancelled: () => boolean;
}

/**
 * 宿主桥的事件协议（任务 3.6）。
 *
 * 宿主监听的事件名必须是这个**有限具名集合**的成员，任何新出口都必须在这里登记，
 * 并由安全审计断言（9.2）。依据不是「没人发协议外事件」——1.2 已查明 uvm 宿主侧的
 * `forwardEmits` 只校验沙箱 id 与载荷类型、**不过滤事件名**，`__uvm_emit` 被删除只说明
 * 此刻没人能写；依据必须是：宿主只为这里列出的名字注册处理分支，且每个分支自己校验载荷。
 */
export const BRIDGE_EVENTS = Object.freeze({
  /** 沙箱转译后的 console 输出（宿主监听 `console`，不是 `execution.console`）。 */
  console: 'console',
  /** `pm.test` 断言的逐条回传。 */
  assertion: 'execution.assertion',
  /**
   * `pm.sendRequest` 的请求出口。执行 id 由宿主生成并经 `options.id` 下发，
   * 事件名按执行 id 参数化——不指定 id，宿主就无从监听。
   */
  sendRequest: (executionId: string) => `execution.request.${executionId}`,
  /**
   * `pm.cookies` 的读写出口（3.5）。沙箱把 tough-cookie 的 Store 操作逐个派发过来，
   * 宿主在真实的 Cookie Jar 上执行后按事件 id 回传结果。同样按执行 id 参数化。
   */
  cookies: (executionId: string) => `execution.cookies.${executionId}`,
} as const);

export interface ConsoleEntry {
  level: string;
  args: string[];
  /** 输出来自哪一段脚本，界面据此区分来源（spec: 脚本 console 输出的收集与呈现）。 */
  phase: ScriptListen;
}

/** console 单个参数的呈现上限；超长的仍要能看见，但不能把面板撑爆。 */
const CONSOLE_ARG_LIMIT = 4000;

/**
 * 把 console 的一个参数文本化（6.2 的呈现 / 10.4 的实机观察）。
 *
 * 沙箱把参数**结构化**地送过来——实测（Node 后端）：`console.log({a:1})` 到达宿主时是真正的
 * 对象 `{a:1}`，不是字符串。因此不能一律 `String(value)`：那会把对象变成 `[object Object]`、
 * 把数组的结构丢掉（`[1,2]` → `1,2`），用户看到的与 Postman 差得远。这里字符串按原样、
 * 其它值取 JSON 形态；序列化不了（循环引用）或过长时退回 String / 截断，保证这一条输出不丢。
 */
function formatConsoleArg(value: unknown): string {
  if (typeof value === 'string') return value;

  if (typeof value === 'object' && value !== null) {
    try {
      const json = JSON.stringify(value);

      if (typeof json === 'string') {
        return json.length > CONSOLE_ARG_LIMIT
          ? `${json.slice(0, CONSOLE_ARG_LIMIT)}…（已截断）`
          : json;
      }
    } catch {
      // 循环引用等：退回字符串化，至少不丢这一条输出
    }
  }

  return String(value);
}

export interface TestAssertion {
  name: string;
  passed: boolean;
  skipped: boolean;
  /** 失败原因；通过时为空。 */
  error: string | null;
}

export interface ScriptPhaseResult {
  /** 本次阶段所有脚本产生的 console 输出，按发生顺序。 */
  console: ConsoleEntry[];
  /** `pm.test` 注册的断言结果，按发生顺序。 */
  assertions: TestAssertion[];
  /** 首个未捕获错误；非空时其后未执行的脚本不再执行。 */
  error: string | null;
  /** 被写回后端的变量名，供界面提示与断言使用。 */
  written: string[];
  /** `pm.visualizer.set` 的结果（原始模板与数据，渲染由宿主做，任务 4.6）。 */
  visualizer: VisualizerResult | null;
}

export interface VisualizerResult {
  template: string;
  data: unknown;
}

/**
 * 把可视化模板渲染成 HTML（任务 4.6）。
 *
 * 只做 `{{path}}` 变量替换（扁平点路径），值经 **HTML 转义** 后插入——渲染结果
 * 将进入 `sandbox=""` 的隔离 iframe（D8），模板里的脚本不会执行；转义进一步
 * 防止数据里的 HTML 结构破坏文档。不支持循环与条件指令：spec 的要求是「模板与
 * 数据可见」，完整模板语言兼容超出本场景（已知限制，见 4.6 任务记录）。
 */
export function renderVisualizer(visualizer: VisualizerResult): string {
  const escapeHtml = (value: string): string =>
    value.replace(/[&<>"']/g, (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string,
    );

  const lookup = (path: string): string => {
    let current: unknown = visualizer.data;
    for (const part of path.split('.')) {
      if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
        current = (current as Record<string, unknown>)[part];
      } else {
        return '';
      }
    }
    if (current === null || current === undefined) return '';
    if (typeof current === 'object') return escapeHtml(JSON.stringify(current));

    return escapeHtml(String(current));
  };

  return visualizer.template.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (_, path) => lookup(path));
}

export interface ScriptRuntimeTarget {
  workspaceId: string;
  collectionId: string;
  environmentId: string | null;
}

/** 沙箱 `options.context` 里的作用域名。 */
type ContextScope = 'globals' | 'environment' | 'collectionVariables';

type ScopeValues = Record<string, string>;

interface LoadedScopes {
  globals: Variable[];
  environment: Variable[];
  collection: Variable[];
}

function valueOf(stored: StoredValue): string {
  return stored.state === 'value' ? stored.value : '';
}

/** 懒加载的沙箱模块；首次执行脚本时才进入模块图。 */
let sandboxModule: {
  createContext: (callback: (error: Error | null, ctx: SandboxContext) => void) => void;
} | null = null;

async function loadSandboxModule() {
  if (!sandboxModule) {
    sandboxModule = (await import('postman-sandbox')).default;
  }
  return sandboxModule;
}

function createContext(): Promise<SandboxContext> {
  return (async () => {
    const sandbox = await loadSandboxModule();

    return new Promise<SandboxContext>((resolve, reject) => {
      sandbox.createContext((error, context) => (error ? reject(error) : resolve(context)));
    });
  })();
}

// ---------------------------------------------------------------------------
// 超时与错误定位（任务 9.5）
// ---------------------------------------------------------------------------

/** 单段脚本的执行上限（毫秒）。超时由沙箱内部的定时器抛错完成，不由宿主强杀。 */
export const SCRIPT_TIMEOUT_MS = 10_000;

/**
 * 给用户代码包一层 catch，把**沙箱内部栈帧里的行号**以标记带回宿主。
 *
 * 背景：脚本报错经 uvm 桥回传时只剩 message（teleport 序列化会丢掉非枚举的
 * stack），宿主拿不到行号。但沙箱内部的 Error 是有栈的——在代码自己的 catch
 * 里读取 `stack`（形如 `<anonymous>:8:11` 的帧），把行号作为标记放进 message
 * 再抛出，宿主就能拿到。包装的行数固定，eval 行号 → 用户行号的偏移由运行时
 * 校准得出（见 `calibrateLineOffset`），不依赖对上游包装形状的假设。
 */
function wrapUserScript(code: string): string {
  return [
    'try {',
    // Postman 文档与 spec 都用 `pm.require(...)`，但上游在宿主未提供 `resolvedPackages`
    // 时会**主动把 `pm.require` 从 pm 对象上摘掉**（`lib/sandbox/execute.js`：
    // `if (!options.resolvedPackages) { disabledAPIs.push('require'); }`，实测表现为
    // `pm.require is not a function`），而沙箱自带的 `require` 全局本来就能解析全部内置库。
    // 在 Postman 里两者是同一件事，故在此补别名——不新增任何能力，`require` 本就在脚本作用域内。
    // 单独包一层 try：用户脚本若声明了同名 `pm`，这里不能把整个脚本带崩。
    'try {',
    "  if (typeof pm === 'object' && pm && typeof pm.require !== 'function' && typeof require === 'function') {",
    '    try { pm.require = require; }',
    "    catch (__e) { console.warn('[兼容] pm.require 无法挂载（' + ((__e && __e.message) || __e) + '）；脚本仍可用全局 require'); }",
    '  }',
    '} catch (__ignore) {}',
    code,
    "} catch (__e) {",
    "  var __m = /<anonymous>:(\\d+):\\d+/.exec((__e && __e.stack) || '');",
    "  throw new Error('__reqman_line__:' + (__m ? __m[1] : '?') + '\\n' + ((__e && __e.message) || String(__e)));",
    '}',
  ].join('\n');
}

/** 校准脚本：第 4 行抛 TypeError（前三行是无关声明，撑出多行以验证行号换算）。 */
const CALIBRATION_THROW_LINE = 4;
const CALIBRATION_CODE = 'var __c1 = 1;\nvar __c2 = 2;\nvar __c3 = 3;\nnull.x;';

/**
 * 校准「eval 行号 → 用户行号」的偏移：执行一个在已知行抛错的探针脚本，读回
 * 标记行号，差值即偏移。每个上下文校准一次；失败返回 null（错误报告退化为
 * 无行号，仅层级与消息）。
 */
function calibrateLineOffset(context: SandboxContext, executionId: string): Promise<number | null> {
  return new Promise((resolve) => {
    context.execute(
      { listen: 'prerequest', script: wrapUserScript(CALIBRATION_CODE) },
      { id: `${executionId}-calibrate`, timeout: SCRIPT_TIMEOUT_MS },
      (error) => {
        const marker = /__reqman_line__:(\d+)/.exec(error?.message ?? '');
        resolve(marker ? Number(marker[1]) - CALIBRATION_THROW_LINE : null);
      },
    );
  });
}

/** 三级脚本的层级标签，与 phases 的顺序（集合 → 文件夹 → 请求）一一对应。 */
const SCRIPT_LEVEL_LABELS = ['集合', '文件夹', '请求'] as const;

function labelScript(listen: ScriptListen, index: number): string {
  const phase = listen === 'prerequest' ? '前置' : '后置';
  const level = SCRIPT_LEVEL_LABELS[index] ?? `第 ${index + 1} 段`;

  return `${phase}脚本 · ${level}层`;
}

/** 把带行号标记的原始错误整理成可读、可定位的报告。 */
function formatScriptError(
  listen: ScriptListen,
  index: number,
  rawMessage: string | null,
  lineOffset: number | null,
): string {
  let message = rawMessage ?? '脚本执行失败';
  let line = '';

  const marker = /__reqman_line__:(\d+)\n?/.exec(message);
  if (marker) {
    message = message.replace(marker[0], '');
    if (lineOffset !== null) {
      const userLine = Number(marker[1]) - lineOffset;
      if (userLine > 0) line = `第 ${userLine} 行`;
    }
  }

  return `${labelScript(listen, index)}${line ? `（${line}）` : ''}：${message.trim()}`;
}

function disposeContext(context: SandboxContext): Promise<void> {
  // 被超时终止的上下文，dispose 的回调可能永不触发（uvm 已终止该 Worker）；
  // 加一个短超时兜底，让清理不至于挂起后续流程。
  return Promise.race([
    new Promise<void>((resolve) => context.dispose(() => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 250)),
  ]);
}

function toScopeInput(values: ScopeValues) {
  return Object.keys(values).map((key) => ({ key, value: values[key], type: 'string' }));
}

/** 从 `execution.<scope>.values` 读出 [key, value] 映射。 */
function readScopeValues(raw: unknown): ScopeValues {
  const out: ScopeValues = {};
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    const entry = item as { key?: unknown; value?: unknown };
    if (typeof entry.key === 'string') out[entry.key] = String(entry.value ?? '');
  }
  return out;
}

function scopesOf(variables: Variable[]): ScopeValues {
  const out: ScopeValues = {};
  // 同名组里最靠下的启用条目生效，禁用条目整个不进入沙箱可见的作用域——
  // 与 Rust 侧的解析规则同源（见 lib/variables.ts 的说明）
  for (const [name, variable] of effectiveByName(variables)) {
    out[name] = valueOf(variable.current);
  }
  return out;
}

/**
 * 载入三个作用域的当前取值。
 *
 * secret 变量在列表命令里是掩码的，而脚本需要明文才能正确组装请求（design.md D15），
 * 因此逐个经 `secretReveal` 揭示——这是拿到明文的唯一入口，也便于审计谁读了明文。
 */
async function loadScopes(
  commands: Commands,
  target: ScriptRuntimeTarget,
  /** 收集被揭示出的明文，供 console 输出脱敏使用。 */
  secretValues: string[],
): Promise<LoadedScopes> {
  const globals = await commands.globalsList(target.workspaceId);
  const environment = target.environmentId
    ? await commands.variableList('environment', target.environmentId)
    : [];
  const collection = await commands.variableList('collection', target.collectionId);

  const reveal = async (variables: Variable[]): Promise<Variable[]> => {
    const out: Variable[] = [];
    for (const variable of variables) {
      if (!variable.is_secret) {
        out.push(variable);
        continue;
      }
      const revealed = await commands.secretReveal(variable.id);
      const plaintext = valueOf(revealed.current);

      if (plaintext) secretValues.push(plaintext);
      out.push(revealed);
    }
    return out;
  };

  return {
    globals: await reveal(globals),
    environment: await reveal(environment),
    collection: await reveal(collection),
  };
}

/**
 * 把 console 输出里出现的 secret 明文替换为掩码。
 *
 * 这是**取值匹配**，不是能力约束：脚本做一次编码变换（`btoa`）就能绕过，因此它只能
 * 挡住「原样打印」这一种情形。真实防线是门禁与 `pm.sendRequest` 的目标策略
 * （design D15）。这里的取舍与后端日志脱敏一致：能挡住无意泄漏，不承诺挡住有意外发。
 */
function maskSecrets(text: string, secretValues: string[]): string {
  let out = text;
  for (const value of secretValues) {
    if (value.length < 4) continue; // 过短的取值做替换会误伤过多无关文本
    out = out.split(value).join('******');
  }
  return out;
}

/**
 * 把沙箱给出的 url 还原成字符串。
 *
 * 它可能是字符串、也可能是 sdk.Url 的序列化结果。后者实测形如
 * `{ protocol, host: ['api','test'], path: ['ping'], query: [], variable: [] }`——
 * **没有 `raw`，且 host 与 path 都是数组**。只处理 `raw` 会得到空字符串，请求随即发不出去。
 */
function textOfUrl(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';

  const url = value as {
    raw?: unknown;
    protocol?: unknown;
    host?: unknown;
    path?: unknown;
    query?: unknown;
  };

  if (typeof url.raw === 'string') return url.raw;

  const host = Array.isArray(url.host)
    ? (url.host as unknown[]).filter(Boolean).join('.')
    : typeof url.host === 'string'
      ? url.host
      : '';
  if (!host) return '';

  const path = Array.isArray(url.path)
    ? (url.path as unknown[]).filter(Boolean).join('/')
    : typeof url.path === 'string'
      ? url.path.replace(/^\//, '')
      : '';

  const query = Array.isArray(url.query)
    ? (url.query as unknown[])
        .map((item) => {
          const entry = (item ?? {}) as { key?: unknown; value?: unknown; disabled?: unknown };
          return entry.disabled
            ? null
            : `${String(entry.key ?? '')}=${String(entry.value ?? '')}`;
        })
        .filter(Boolean)
        .join('&')
    : '';

  const base = `${String(url.protocol ?? 'http')}://${host}${path ? `/${path}` : ''}`;

  return query ? `${base}?${query}` : base;
}

/**
 * 把沙箱给出的请求描述转成后端能接受的内联请求。
 *
 * 只映射脚本真正能表达的部分：方法、URL、请求头、raw 正文。文件类正文与多段表单
 * 在脚本里没有可靠来源（路径从不来自前端），因此不映射。
 */
function toInlineRequest(raw: unknown): SavedRequest {
  const request = (raw ?? {}) as {
    method?: unknown;
    url?: unknown;
    header?: unknown;
    body?: { raw?: unknown } | null;
  };

  const headers = Array.isArray(request.header)
    ? request.header.map((item) => {
        const entry = (item ?? {}) as { key?: unknown; value?: unknown };
        return { key: String(entry.key ?? ''), value: String(entry.value ?? ''), enabled: true };
      })
    : [];

  const rawBody =
    request.body && typeof request.body.raw === 'string' ? request.body.raw : null;

  return {
    id: '',
    collection_id: '',
    folder_id: null,
    name: 'pm.sendRequest',
    method: String(request.method ?? 'GET'),
    url: textOfUrl(request.url),
    params: [],
    headers,
    body: rawBody ? { ...emptyBody(), kind: 'raw', raw: rawBody } : emptyBody(),
    auth: { kind: 'none' },
    // 脚本内发起的请求不继承父请求的配置：与 http-engine 的默认一致——跟随重定向、
    // 校验证书、协议版本自动，超时跟随全局。这几条都不该由脚本悄悄改写。
    settings: {
      timeout: { mode: 'inherit' },
      follow_redirects: true,
      verify_tls: true,
      http_version: 'auto',
    },
    pre_request_script: null,
    test_script: null,
    sort_order: 0,
  };
}

/** 把后端响应转成沙箱能构造 sdk.Response 的形状。 */
function toSandboxResponse(payload: ResponsePayload) {
  return {
    code: payload.status,
    status: payload.status_text,
    header: payload.headers.map(([key, value]) => ({ key, value })),
    stream: payload.body_text ?? '',
    responseTime: payload.elapsed_ms,
  };
}

// ---------------------------------------------------------------------------
// Cookie 仓库出口（任务 3.5）
//
// 沙箱内的 `pm.cookies` 是一个 **tough-cookie Store 的远程代理**：jar 的每次
// get/set/unset 都会派发 `execution.cookies.<执行 id>` 事件（载荷
// `(事件 id, 'store', 方法名, 参数)`），宿主在自己的 Cookie Jar 上执行后按
// 事件 id 回传（`(事件 id, 错误, 结果)`）。协议形状为探针实测。
// ---------------------------------------------------------------------------

/** 宿主愿意执行的 Store 操作——有限具名集合，协议外方法一律拒绝执行。 */
const COOKIE_STORE_METHODS = Object.freeze([
  'findCookie',
  'findCookies',
  'putCookie',
  'updateCookie',
  'removeCookie',
  'removeCookies',
  'getAllCookies',
  'removeAllCookies',
] as const);

type CookieStoreMethod = (typeof COOKIE_STORE_METHODS)[number];

/** 沙箱传来的 Cookie 载荷（tough-cookie 的 JSON 形态，字段不可信）。 */
interface ScriptCookie {
  key?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  hostOnly?: unknown;
  secure?: unknown;
  httpOnly?: unknown;
  expires?: unknown;
  maxAge?: unknown;
}

/** 行视图 → tough-cookie JSON。`expires` 用 ISO 串或 'Infinity'（会话）。 */
function toScriptCookie(view: CookieView): Record<string, unknown> {
  return {
    key: view.name,
    value: view.value,
    domain: view.domain,
    path: view.path,
    hostOnly: view.host_only,
    secure: view.secure,
    httpOnly: view.http_only,
    expires:
      view.expires_at === null ? 'Infinity' : new Date(view.expires_at * 1000).toISOString(),
  };
}

/** 沙箱 Cookie 的有效期 → Unix 秒；会话（'Infinity'/缺失）为 null。 */
function expiresOf(cookie: ScriptCookie): number | null {
  if (typeof cookie.maxAge === 'number' && Number.isFinite(cookie.maxAge)) {
    return cookie.maxAge <= 0 ? 0 : Math.floor(Date.now() / 1000) + cookie.maxAge;
  }
  if (typeof cookie.expires === 'number' && Number.isFinite(cookie.expires)) {
    return Math.floor(cookie.expires / 1000);
  }
  if (typeof cookie.expires === 'string' && cookie.expires !== 'Infinity') {
    const parsed = Date.parse(cookie.expires);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

function domainOf(cookie: ScriptCookie): string {
  return typeof cookie.domain === 'string' ? cookie.domain.replace(/^\./, '').trim() : '';
}

/** 按键（域 + 路径 + 名）删除已落库的 Cookie；域按 RFC 后缀匹配收窄。 */
async function deleteCookieByKey(
  commands: Commands,
  domain: string,
  path: string,
  name: string,
): Promise<void> {
  const entries = await commands.cookieList();
  const matches = entries.filter(
    (entry) =>
      entry.name === name &&
      (entry.domain === domain || domain.endsWith(`.${entry.domain}`)) &&
      (entry.path === path || entry.path === '/' || path.startsWith(`${entry.path}/`)),
  );
  for (const entry of matches) {
    await commands.cookieDelete(entry.id);
  }
}

/**
 * 在真实的 Cookie Jar 上执行一次 Store 操作。
 *
 * 匹配语义（域、路径、Secure）不在这里实现——读取走 `cookie_query`，它与请求
 * 自动附带共用同一套 Rust 端匹配；写入经 `cookie_put` 落库，后续请求自然遵守
 * 同样的规则（spec: 脚本写入遵守同样规则）。
 */
async function handleCookieStoreOp(
  commands: Commands,
  method: CookieStoreMethod,
  args: unknown,
): Promise<unknown> {
  const list = Array.isArray(args) ? args : [];

  switch (method) {
    case 'findCookie':
    case 'findCookies': {
      const [domain, path] = list as [unknown, unknown];
      if (typeof domain !== 'string' || !domain) return method === 'findCookie' ? null : [];
      const url = `https://${domain}${typeof path === 'string' && path ? path : '/'}`;
      const matches = await commands.cookieQuery(url);
      const json = matches.map(toScriptCookie);

      return method === 'findCookie' ? (json[0] ?? null) : json;
    }
    case 'putCookie':
    case 'updateCookie': {
      const cookie = list[0] as ScriptCookie | undefined;
      if (!cookie || typeof cookie !== 'object') return null;
      const name = typeof cookie.key === 'string' ? cookie.key : '';
      const domain = domainOf(cookie);
      if (!name || !domain) return null;

      const value = typeof cookie.value === 'string' ? cookie.value : '';
      const expiresAt = expiresOf(cookie);

      // 已过期的写入等价于删除：jar 里不该留下它，已存在的同键项也一并清掉
      if (expiresAt !== null && expiresAt <= Date.now() / 1000) {
        await deleteCookieByKey(commands, domain, String(cookie.path ?? '/'), name);

        return null;
      }

      await commands.cookiePut({
        domain,
        name,
        value,
        path: typeof cookie.path === 'string' && cookie.path ? cookie.path : '/',
        host_only: Boolean(cookie.hostOnly),
        secure: Boolean(cookie.secure),
        http_only: Boolean(cookie.httpOnly),
        expires_at: expiresAt,
      });

      return null;
    }
    case 'removeCookie': {
      const [domain, path, name] = list as [unknown, unknown, unknown];
      if (typeof domain === 'string' && typeof path === 'string' && typeof name === 'string') {
        await deleteCookieByKey(commands, domain.replace(/^\./, ''), path, name);
      }

      return null;
    }
    case 'removeCookies': {
      const [domain, path] = list as [unknown, unknown];
      if (typeof domain !== 'string' || typeof path !== 'string') return null;
      const target = domain.replace(/^\./, '');
      const entries = await commands.cookieList();
      const matches = entries.filter(
        (entry) =>
          (entry.domain === target || domain.endsWith(`.${entry.domain}`)) &&
          (entry.path === path || entry.path === '/' || path.startsWith(`${entry.path}/`)),
      );
      for (const entry of matches) {
        await commands.cookieDelete(entry.id);
      }

      return null;
    }
    case 'getAllCookies': {
      return (await commands.cookieList()).map(toScriptCookie);
    }
    case 'removeAllCookies': {
      for (const entry of await commands.cookieList()) {
        await commands.cookieDelete(entry.id);
      }

      return null;
    }
  }
}

/**
 * 执行一段脚本，并把执行后的作用域取值一并返回。
 *
 * `pm.sendRequest` 与 `pm.cookies` 的出口在这里挂：
 *
 * - Cookie 仓库：沙箱派发 `execution.cookies.<id>`（载荷为事件 id、动作、Store
 *   方法名、参数），宿主在真实 Jar 上执行后按事件 id 回传。
 * - 请求出口：沙箱派发 `execution.request.<id>`（载荷为 cursor、执行 id、事件 id、
 *   请求），宿主必须回 `execution.response.<id>`（事件 id、错误、响应、历史）。
 *   这个出口**默认不限制目标地址**（design D5），目标策略由 9.4 加。
 */
function executeOne(
  context: SandboxContext,
  commands: Commands,
  target: ScriptRuntimeTarget,
  executionId: string,
  policy: SendRequestPolicy | null,
  response: ResponsePayload | null,
  listen: ScriptListen,
  code: string,
  scopes: Record<ContextScope, ScopeValues>,
  /** 当前请求目标的匹配 Cookie，喂给 `pm.cookies`；无 URL（无法解析）时为空。 */
  requestCookies: CookieView[],
  /** 单段脚本的执行上限（毫秒）。 */
  timeoutMs: number,
  /** 本次发送的取消出口；`null` 表示这次执行不参与取消。 */
  cancellation: PhaseCancellation | null,
): Promise<{
  error: string | null;
  next: Record<ContextScope, ScopeValues>;
  visualizer: VisualizerResult | null;
}> {
  return new Promise((resolve) => {
    context.on(
      BRIDGE_EVENTS.cookies(executionId),
      (eventId: unknown, action: unknown, method: unknown, args: unknown) => {
        // 载荷校验（3.6 同款）：事件 id 非空、动作必须是 'store'、方法名必须
        // 在白名单内。协议外的操作不执行、不回执——能力不因伪造而扩大。
        const eventIdValid =
          (typeof eventId === 'string' && eventId !== '') || typeof eventId === 'number';

        if (
          !eventIdValid ||
          action !== 'store' ||
          typeof method !== 'string' ||
          !COOKIE_STORE_METHODS.includes(method as CookieStoreMethod)
        ) {
          return;
        }

        void (async () => {
          try {
            const result = await handleCookieStoreOp(commands, method as CookieStoreMethod, args);

            context.dispatch(BRIDGE_EVENTS.cookies(executionId), eventId, null, result ?? null);
          } catch (error) {
            context.dispatch(
              BRIDGE_EVENTS.cookies(executionId),
              eventId,
              { message: error instanceof Error ? error.message : String(error) },
              null,
            );
          }
        })();
      },
    );

    context.on(
      BRIDGE_EVENTS.sendRequest(executionId),
      (_cursor: unknown, fromExecutionId: unknown, eventId: unknown, request: unknown) => {
        // 载荷校验（3.6）：执行 id 必须与本分支注册的一致；事件 id 是非空字符串或数字
        // （实测为自增数字），它会被原样回传给沙箱用于配对。
        // 不合格载荷一律忽略——不回错误、不触达后端，脚本能力不因此扩大。这一校验
        // 不依赖「沙箱不会发伪事件」的假设：协议的边界由宿主自己守。
        const eventIdValid =
          (typeof eventId === 'string' && eventId !== '') || typeof eventId === 'number';

        if (fromExecutionId !== executionId || !eventIdValid) {
          return;
        }

        const respond = (error: unknown, response: unknown) =>
          context.dispatch(
            `execution.response.${executionId}`,
            eventId,
            error ?? null,
            response ?? null,
            null,
          );

        void (async () => {
          const inline = toInlineRequest(request);

          // 目标策略：未配置时不限制（Postman 行为），一旦配置就以配置为准。
          if (!isSendTargetAllowed(policy, inline.url)) {
            respond(
              {
                message: `pm.sendRequest 的目标不在允许范围内：${inline.url}（策略模式：${policy?.mode ?? '未配置'}）`,
              },
              null,
            );
            return;
          }

          try {
            const payload = await commands.sendRequest({
              inline,
              environment_id: target.environmentId,
              // 会话标识与主请求共用：取消时它会被后端一并撤销，脚本这边则以
              // `cancelled` 错误走既有的回执出口——不新增桥事件
              attempt_id: cancellation?.attemptId ?? null,
            });

            respond(null, toSandboxResponse(payload));
          } catch (error) {
            // 交给脚本的必须是可读原因：后端失败给的是 `{ code, message }` 普通对象，
            // 用 describeError（与界面同一条归一化路径）取出 message，而不是 String(obj)。
            respond({ message: describeError(error).message }, null);
          }
        })();
      },
    );

    context.execute(
      // target 必须是这个形状：listen 决定沙箱是否提供 pm.request / pm.response。
      // 代码经 wrapUserScript 包装以带回行号（9.5）；timeout 由沙箱内部定时器
      // 执行——到点抛错并终止本段脚本，不由宿主强杀。
      { listen, script: wrapUserScript(code) },
      {
        id: executionId,
        timeout: timeoutMs,
        // pm.info.iteration / iterationCount 取自 cursor（上游实现）；
        // 单次发送固定第 0 轮、共 1 轮
        cursor: { iteration: 0, cycles: 1 },
        context: {
          globals: toScopeInput(scopes.globals),
          environment: toScopeInput(scopes.environment),
          collectionVariables: toScopeInput(scopes.collectionVariables),
          // `pm.cookies`（当前请求的集合）：与自动附带同一来源（Rust 匹配），
          // 因此脚本读到的就是实际会携带的（spec: 读取当前请求可用的 Cookie）。
          ...(requestCookies.length > 0
            ? {
                cookies: requestCookies.map((cookie) => ({
                  name: cookie.name,
                  value: cookie.value,
                  domain: cookie.domain,
                  path: cookie.path,
                  secure: cookie.secure,
                  httpOnly: cookie.http_only,
                  hostOnly: cookie.host_only,
                })),
              }
            : {}),
          // 只有后置脚本拿得到 pm.response。
          //
          // 沙箱的判定是 `TARGETS_WITH_RESPONSE[target] || _.has(context, 'response')`
          // ——只要上下文里带了 response，前置脚本也能拿到它。因此在**这里**挡住，
          // 而不是指望调用方不传：否则调用方一时疏忽就会破坏「仅后置可用」。
          ...(response && listen === 'test' ? { response: toSandboxResponse(response) } : {}),
        },
      },
      (error, execution) => {
        const result = (execution ?? {}) as Partial<
          Record<ContextScope, { values?: unknown }> & { return?: { visualizer?: unknown } }
        >;

        // pm.visualizer.set 写入 execution.return.visualizer（原始模板 + 数据，
        // 上游不做渲染）；无 set 调用时为 undefined
        const rawVisualizer = (
          result.return as { visualizer?: { template?: unknown; data?: unknown } } | undefined
        )?.visualizer;

        resolve({
          error: error ? error.message : null,
          next: {
            globals: readScopeValues(result.globals?.values),
            environment: readScopeValues(result.environment?.values),
            collectionVariables: readScopeValues(result.collectionVariables?.values),
          },
          visualizer:
            rawVisualizer && typeof rawVisualizer.template === 'string'
              ? { template: rawVisualizer.template, data: rawVisualizer.data ?? null }
              : null,
        });
      },
    );
  });
}

/** 把脚本写入的差异落回后端；未变化的不写，新增的按非 secret 建立。 */
async function persistWrites(
  commands: Commands,
  target: ScriptRuntimeTarget,
  before: LoadedScopes,
  after: Record<ContextScope, ScopeValues>,
): Promise<string[]> {
  const written: string[] = [];

  const apply = async (
    scope: 'global' | 'environment' | 'collection',
    ownerId: string,
    existing: Variable[],
    values: ScopeValues,
  ) => {
    // 按名定位的是**生效的那一条**（最靠下的启用条目），与脚本读到的值同源；
    // 用「第一条同名」会在重复键下更新被遮蔽的行，甚至因两行值相同而静默跳过写入
    const effective = effectiveByName(existing);
    for (const name of Object.keys(values)) {
      const current = effective.get(name);
      if (current && valueOf(current.current) === values[name]) continue;

      if (scope === 'global') {
        await commands.globalsSet(target.workspaceId, name, values[name], current?.is_secret ?? false);
      } else {
        await commands.variableSet({
          scope,
          owner_id: ownerId,
          name,
          is_secret: current?.is_secret ?? false,
          current: values[name],
        });
      }
      written.push(name);
    }
  };

  await apply('global', target.workspaceId, before.globals, after.globals);
  if (target.environmentId) {
    await apply('environment', target.environmentId, before.environment, after.environment);
  }
  await apply('collection', target.collectionId, before.collection, after.collectionVariables);

  return written;
}

/** 门禁状态存在 settings 表里的作用域键。 */
const SCRIPT_GATE_SCOPE = 'script_gate';

/** `pm.sendRequest` 目标策略存在 settings 表里的作用域键。 */
const SEND_REQUEST_POLICY_SCOPE = 'script_send_request';

export interface SendRequestPolicy {
  /** `allow` 只允许名单内的目标，`deny` 只拒绝名单内的目标。 */
  mode: 'allow' | 'deny';
  hosts: string[];
}

/**
 * 读取 `pm.sendRequest` 的目标策略。
 *
 * **未配置时返回 null，表示不限制目标**——这是 Postman 的行为，也是「完整兼容」的
 * 一部分（design D5）。一旦配置了策略，就以配置为准。
 *
 * 已配置但内容无法解析时**按最严处理（拒绝全部）**：这时静默放行等于把一道安全设置
 * 悄悄失效，比把用户挡住糟糕得多。
 */
export async function loadSendRequestPolicy(
  commands: Commands,
): Promise<SendRequestPolicy | null> {
  const raw = await commands.settingsGet(SEND_REQUEST_POLICY_SCOPE, 'policy');

  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as SendRequestPolicy;

    if (parsed?.mode !== 'allow' && parsed?.mode !== 'deny') return DENY_ALL;
    return {
      mode: parsed.mode,
      hosts: Array.isArray(parsed.hosts) ? parsed.hosts.map(String) : [],
    };
  } catch {
    return DENY_ALL;
  }
}

/** 无法解析的配置：拒绝全部目标。 */
const DENY_ALL: SendRequestPolicy = { mode: 'allow', hosts: [] };

const SEND_REQUEST_POLICY_KEY = 'policy';

/**
 * 读取策略的原始值，供设置界面判断「未配置」与「已配置但无法解析」。
 *
 * 这两者必须能分开：`loadSendRequestPolicy` 把后者也折叠成了拒绝全部，界面若只看它，
 * 就无法告诉用户「你存的东西读不懂」。
 */
export async function readSendRequestPolicyRaw(commands: Commands): Promise<string | null> {
  return commands.settingsGet(SEND_REQUEST_POLICY_SCOPE, SEND_REQUEST_POLICY_KEY);
}

/** 写入策略；传 `null` 表示恢复为「不限制目标」。 */
export async function writeSendRequestPolicy(
  commands: Commands,
  policy: SendRequestPolicy | null,
): Promise<void> {
  await commands.settingsSet(
    SEND_REQUEST_POLICY_SCOPE,
    SEND_REQUEST_POLICY_KEY,
    policy ? JSON.stringify(policy) : '',
  );
}

function hostMatches(host: string, entry: string): boolean {
  const target = host.toLowerCase();
  const rule = entry.toLowerCase().replace(/^\./, '');

  return Boolean(rule) && (target === rule || target.endsWith(`.${rule}`));
}

/** 目标是否被策略放行。 */
export function isSendTargetAllowed(policy: SendRequestPolicy | null, url: string): boolean {
  if (!policy) return true; // 未配置 = 与 Postman 一致，不限制

  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return false; // 无法解析的目标一律拒绝，而不是放行
  }

  const matched = policy.hosts.some((entry) => hostMatches(host, entry));

  return policy.mode === 'allow' ? matched : !matched;
}

/**
 * 该集合的脚本是否已获准执行。
 *
 * 脚本可以来自导入的集合（spec: 脚本来源的可执行性门禁 / design D6）。执行它等于运行
 * 一段来源不在本应用内的代码，而它能读写变量、并经 `pm.sendRequest` 发起网络请求——
 * 后者默认不限制目标地址（design D5）。因此首次执行前必须确认，确认按集合生效。
 */
export async function isScriptExecutionAllowed(
  commands: Commands,
  collectionId: string,
): Promise<boolean> {
  return (await commands.settingsGet(SCRIPT_GATE_SCOPE, collectionId)) === 'allowed';
}

/** 记下该集合的脚本已获准执行，之后不再重复询问。 */
export async function allowScriptExecution(
  commands: Commands,
  collectionId: string,
): Promise<void> {
  await commands.settingsSet(SCRIPT_GATE_SCOPE, collectionId, 'allowed');
}

/**
 * 让一段脚本的执行与取消赛跑。
 *
 * 取消时返回 `null` 而不是抛错——取消不是失败，调用方据此收手即可。若直接 await
 * `executeOne`，取消之后要等沙箱回调兑现，而那条路可能永不兑现。
 */
async function raceWithCancellation<T>(
  work: Promise<T>,
  cancellation: PhaseCancellation | null,
): Promise<T | null> {
  if (!cancellation) return work;
  if (cancellation.isCancelled()) return null;

  return Promise.race([work, cancellation.signal.then(() => null)]);
}

/**
 * 执行一个脚本阶段的全部脚本。
 *
 * `scripts` 必须已按「集合 → 文件夹 → 请求」排好序：本函数按数组顺序执行，且让前一段
 * 的写入对后一段可见，因此同名变量最终取请求层的值（spec: 脚本执行时机与顺序）。
 *
 * 三个层级都没有脚本时不创建上下文，也不报错——空跑一次建沙箱的开销没有意义。
 */
export async function runScriptPhase(
  commands: Commands,
  target: ScriptRuntimeTarget,
  listen: ScriptListen,
  scripts: (string | null | undefined)[],
  /** 本次响应；后置脚本据此得到 `pm.response`。 */
  response: ResponsePayload | null = null,
  /** 解析后的请求 URL；提供时 `pm.cookies` 才有当前请求的集合可读。 */
  requestUrl: string | null = null,
  /** 单段脚本的执行上限（毫秒）；测试用小值以快速验证超时路径。 */
  timeoutMs: number = SCRIPT_TIMEOUT_MS,
  /** 本次发送的取消出口；`null` 表示这个阶段不参与取消。 */
  cancellation: PhaseCancellation | null = null,
): Promise<ScriptPhaseResult> {
  const entries: ConsoleEntry[] = [];
  const assertions: TestAssertion[] = [];
  const secretValues: string[] = [];
  // 保留原始索引：层级标签按 phases 的位置（集合 → 文件夹 → 请求）对号，
  // 过滤后用错索引会把「请求层」标成「文件夹层」
  const codes = scripts
    .map((code, index) => ({ code, index }))
    .filter((item): item is { code: string; index: number } =>
      Boolean(item.code && item.code.trim()),
    );

  if (codes.length === 0) {
    return { console: entries, assertions, error: null, written: [], visualizer: null };
  }

  // 弃用提示（任务 4.3）：上游沙箱对已弃用库不做任何提示（实测），由宿主静态
  // 扫描脚本源码补齐。这是启发式——字符串里出现同样字样会误报，作为提示可接受。
  const DEPRECATED_LIBRARIES: Record<string, string> = {
    'crypto-js': '改用 Web Crypto（crypto.subtle）',
    tv4: '改用 ajv',
    atob: '直接使用全局 atob',
    btoa: '直接使用全局 btoa',
  };

  // `pm.cookies` 的当前集合与 jar 的读写出口都走真实 Jar（与自动附带同一匹配）。
  const requestCookies = requestUrl ? await commands.cookieQuery(requestUrl) : [];

  const before = await loadScopes(commands, target, secretValues);
  const policy = await loadSendRequestPolicy(commands);
  const scopes: Record<ContextScope, ScopeValues> = {
    globals: scopesOf(before.globals),
    environment: scopesOf(before.environment),
    collectionVariables: scopesOf(before.collection),
  };

  const context = await createContext();
  // 行号偏移校准（9.5）：eval 帧行号 = 用户行号 + 偏移；失败则报告退化为无行号
  const lineOffset = await calibrateLineOffset(context, `calibrate-${Date.now()}`);
  let error: string | null = null;
  // 可视化模板取最后一段设置的值（后置脚本通常在最后设置）
  let visualizer: VisualizerResult | null = null;

  try {
    // 沙箱派发 execution.console，宿主转译后重发为 'console'
    context.on(BRIDGE_EVENTS.console, (_cursor, level, ...args: unknown[]) => {
      entries.push({
        level: String(level),
        phase: listen,
        args: args.map((value) => maskSecrets(formatConsoleArg(value), secretValues)),
      });
    });

    // 断言不在执行结果里，而是以事件逐条回传；宿主不会转译这个事件，只能自己监听。
    // payload 形如 (cursor, assertions[])，每项含 name / passed / skipped / error。
    context.on(BRIDGE_EVENTS.assertion, (_cursor, incoming: unknown) => {
      const list = Array.isArray(incoming) ? incoming : [incoming];

      for (const item of list) {
        const raw = (item ?? {}) as {
          name?: unknown;
          passed?: unknown;
          skipped?: unknown;
          error?: { message?: unknown } | null;
        };
        const failure = raw.error;

        assertions.push({
          name: String(raw.name ?? ''),
          passed: Boolean(raw.passed),
          skipped: Boolean(raw.skipped),
          error: failure
            ? maskSecrets(
                String(typeof failure === 'object' ? failure.message ?? '' : failure),
                secretValues,
              )
            : null,
        });
      }
    });

    // 弃用提示（4.3）：对每段脚本扫描已弃用库的 require，生成可辨识的 warn 输出
    for (const { code } of codes) {
      for (const [library, alternative] of Object.entries(DEPRECATED_LIBRARIES)) {
        const pattern = new RegExp(`require\\(\\s*['"]${library.replace('/', '/')}['"]\\s*\\)`);
        if (pattern.test(code)) {
          entries.push({
            level: 'warn',
            phase: listen,
            args: [maskSecrets(`[弃用提示] ${library} 已弃用：${alternative}`, secretValues)],
          });
        }
      }
    }

    for (const { code, index } of codes) {
      const executionId = `exec-${index}-${Math.random().toString(36).slice(2, 10)}`;
      const outcome = await raceWithCancellation(
        executeOne(
          context,
          commands,
          target,
          executionId,
          policy,
          response,
          listen,
          code,
          scopes,
          requestCookies,
          timeoutMs,
          cancellation,
        ),
        cancellation,
      );

      // 取消：这一段的结果已不可信（沙箱即将被销毁），立刻收手，把已经产生的输出交回去
      if (!outcome) break;

      // 无论成败，本段看到的取值都要并入下一段的输入
      scopes.globals = outcome.next.globals;
      scopes.environment = outcome.next.environment;
      scopes.collectionVariables = outcome.next.collectionVariables;

      // 可视化模板取最后一段设置的值（后置脚本通常在最后设置）
      if (outcome.visualizer) visualizer = outcome.visualizer;

      if (outcome.error) {
        error = formatScriptError(listen, index, outcome.error, lineOffset);
        break;
      }
    }
  } finally {
    await disposeContext(context);
  }

  const written = await persistWrites(commands, target, before, scopes);

  return { console: entries, assertions, error, written, visualizer };
}
