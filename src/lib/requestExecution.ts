// 一次请求的执行流水线：解析 → 前置脚本 → 合并改动 → 发送 → 后置脚本。
//
// 这条流水线原先长在 `App.tsx` 的 `performSend` 里，与标签状态、发送态、错误归属
// 缠在一起。集合运行器需要**逐条**跑同一套东西（脚本、门禁、取消、合并语义一条都不能
// 少），而在两处各写一遍必然分叉——因此把它抽成这里的一个函数：
//
// - 这里只做「跑一次请求」，不知道标签、模态、响应面板；产出是一个结果对象。
// - 界面侧的留痕（写响应、报错、门禁提示、收尾）由调用方按需接上。
//
// 与 Postman 的对应关系：这就是它的 "send request" 那一步，运行器只是把它按顺序调 N 次。

import { describeError, type Commands } from './commands';
import { folderSegments, loadRequestFolderChain } from './folderChain';
import { cleanForSend } from './rows';
import { applyScriptBody, diffRequestBody } from './scriptBody';
import {
  applyScriptHeaders,
  diffRequestHeaders,
  withSentBody,
  withSentHeaders,
} from './scriptHeaders';
import {
  SCRIPT_TIMEOUT_MS,
  isScriptExecutionAllowed,
  runScriptPhase,
  toSandboxRequest,
} from './scriptRuntime';
import type {
  ConsoleEntry,
  PhaseCancellation,
  SandboxRequest,
  ScriptSegment,
  TestAssertion,
  VisualizerResult,
} from './scriptRuntime';
import type { ConsoleResult, NetworkStart, RequestTrace } from './consoleLog';
import type { AppError, BodyKind, RequestPreview, ResponsePayload, SavedRequest } from './types';

/** 流水线要的宿主能力：后端命令 + 当前工作区/环境的上下文。 */
export interface RequestExecutionDeps {
  client: Commands;
  workspaceId: string | null;
  environmentId: string | null;
}

export interface RequestExecutionInput {
  /** 待发草稿（未清洗；`cleanForSend` 由本函数做，与发送按钮走同一条路）。 */
  request: SavedRequest;
  /**
   * 草稿是否偏离已存版本。
   *
   * 为真时按内联发出（`saved_id: null`）：否则后端会拿库里的那一份覆盖掉用户的改法
   * （spec: 请求编辑器 / design D3）。
   */
  dirty: boolean;
  /** 跳过全部脚本只发请求——门禁被拒后的「不执行脚本，仍发送」。 */
  skipScripts?: boolean;
  /** 本次执行的取消出口（脚本段与网络段共用）。 */
  attempt: PhaseCancellation;
  /** 响应一到达就通知调用方：后置脚本可能还要跑一会儿，界面不必等它。 */
  onResponse?: (payload: ResponsePayload) => void;
  /**
   * 请求即将发出（目标 URL 已解析）：调用方据此在全局 Console 里占位。
   *
   * 放在这里而不是由调用方自己造，是因为「解析后的 URL」只有本函数拿得到；占位必须在
   * 网络往返**之前**完成，时间线的顺序才等于发起顺序（design D2）。
   */
  onBegin?: (pending: NetworkStart) => void;
}

/**
 * 本次**实际发出**的请求。
 *
 * 与调用方手里的草稿不是一回事：变量已解析、认证已落成、前置脚本的改写已合并。运行器的
 * 「请求」页要看的正是这一份——否则「脚本加了什么头」永远只能靠 console 打出来猜。
 */
export interface SentRequest {
  method: string;
  /** 实际发送的目标（重定向前）；连解析都没走到时退回草稿里的原文。 */
  url: string;
  /** 实际带出去的请求头，顺序即发送顺序。 */
  headers: [string, string][];
  /** 正文形态：`body` 为空时，界面据此说明"为什么没有原文"而不是留一片空白。 */
  bodyKind: BodyKind;
  /**
   * 实际发出的正文文本。
   *
   * 只有 `raw` 形态能回读（后端只回带这一种）；表单 / 二进制为 null，此时以 `bodyKind`
   * 说明形态，SHALL NOT 伪造成一段可以复制走的原文。
   */
  body: string | null;
}

/**
 * 一次执行的结果。
 *
 * 所有出口（正常、失败、取消、门禁拦截）都收敛成这个对象，调用方据此决定怎么呈现：
 * `error` 与 `gated` 互斥，`cancelled` 时两者都为空。
 */
export interface RequestExecutionOutcome {
  /** 成功到达的响应；失败或门禁拦截时为 null。 */
  response: ResponsePayload | null;
  /** 失败原因（已分类，取消不算失败）。 */
  error: AppError | null;
  console: ConsoleEntry[];
  assertions: TestAssertion[];
  /** 脚本的首个未捕获错误（不阻断发送，另行呈现）。 */
  scriptError: string | null;
  visualizer: VisualizerResult | null;
  /** 脚本门禁未获准：本次**没有**发出请求。 */
  gated: { collectionId: string; name: string } | null;
  /** 本次执行被取消（前端脚本段或后端网络段）。 */
  cancelled: boolean;
  /**
   * 本次实际发出的请求（脚本改写、变量解析之后的那一份）。
   *
   * 与 `response` 并存：失败、取消、门禁拦截时没有响应，但「本来要发的是什么」同样要能看见
   * ——那恰恰是排查"为什么没发出去 / 发出去的不是我想要的"的起点。
   */
  sent: SentRequest;
  /**
   * 交给全局 Console 的一份事实。
   *
   * 所有出口都带它——包括失败、取消与未发出：那些恰恰是最需要回看的情形。
   */
  trace: RequestTrace;
}

/** 取消的判定只认这一条：后端以 `cancelled` 收场时前端不把它当失败。 */
const CANCELLED_CODE = 'cancelled';

/**
 * 未解析变量：请求根本没出去，所以时间线上算「未发出」而不是失败。
 *
 * 与 `App.tsx` 里那条提示共用同一个码——分类由后端给出，不是这里自造的。
 */
export const UNRESOLVED_CODE = 'unresolved_variables';

export async function executeRequest(
  deps: RequestExecutionDeps,
  input: RequestExecutionInput,
): Promise<RequestExecutionOutcome> {
  const { client, workspaceId, environmentId } = deps;
  const { request, attempt } = input;
  const skipScripts = Boolean(input.skipScripts);

  // 发起时刻：时间线按它排序，而不是等结果回来再插一条（design D2）
  const startedAt = Date.now();
  const console_: ConsoleEntry[] = [];
  const assertions: TestAssertion[] = [];
  let response: ResponsePayload | null = null;
  let scriptError: string | null = null;
  let visualizer: VisualizerResult | null = null;
  /** 解析后的请求目标；解析都没走到时为 null。 */
  let resolvedUrl: string | null = null;
  let phaseLabels: { prerequest: string[]; test: string[] } = { prerequest: [], test: [] };

  // 待发的那一份草稿只算一次：前置脚本改过请求头/正文时要在这上面合并（design D3）
  const inlineDraft = cleanForSend(request);
  // 待发请求与「请求头或请求体是否被脚本改过」。未改动时完全走原路径（design D3）
  let outgoing: { request: SavedRequest; changed: boolean } = {
    request: inlineDraft,
    changed: false,
  };
  /**
   * 解析快照里的待发请求头。
   *
   * 解析可能根本没走到（变量解析就失败了），而 `finish` 在那条路上照样要交出一份请求头，
   * 所以它是个可变量，而不是后面那个 `const sandboxRequest` 的一部分。
   */
  let snapshotHeaders: [string, string][] = [];

  /**
   * 本次**实际带出去的**请求头。
   *
   * 成功时以后端回带的为准（认证头、正文的 Content-Type、Cookie 只有它知道）；失败时没有
   * 这份东西，退回解析快照——它至少是「脚本改完之后、认证之前」的那一份，比空白有用。
   */
  const sentHeaders = (): [string, string][] => response?.request_headers ?? snapshotHeaders;

  /** 统一出口：把散在函数体里的临时状态收敛成结果对象。 */
  const finish = (
    outcome: Partial<RequestExecutionOutcome> & Pick<RequestExecutionOutcome, 'cancelled'>,
  ): RequestExecutionOutcome => {
    const merged = {
      response,
      error: null,
      console: console_,
      assertions,
      scriptError,
      visualizer,
      gated: null,
      ...outcome,
    } as RequestExecutionOutcome;

    // 优先用后端回带的「实际发送目标」：前置脚本可能改写过去向
    const url = response?.request_url || resolvedUrl || outgoing.request.url;

    return {
      ...merged,
      sent: {
        method: outgoing.request.method,
        url,
        headers: sentHeaders(),
        bodyKind: outgoing.request.body.kind,
        // 后端只回带 raw 正文；其余形态没有原文可给，如实留空由界面按形态说明
        body:
          response?.request_body ??
          (outgoing.request.body.kind === 'raw' ? (outgoing.request.body.raw ?? '') : null),
      },
      trace: {
        sendId: attempt.attemptId,
        requestId: request.id,
        method: request.method,
        url,
        startedAt,
        requestHeaders: sentHeaders(),
        result: traceResult(merged),
        responseHeaders: response?.headers ?? null,
        body: response?.body_text ?? null,
        // 后端已经因为体积上限截断时，条目的展开内容要如实标出来
        bodyTruncated: Boolean(response?.truncated),
        outputs: console_,
        segments: phaseLabels,
      },
    };
  };

  const traceResult = (merged: RequestExecutionOutcome): ConsoleResult => {
    if (merged.cancelled) return { kind: 'cancelled' };
    if (merged.gated) {
      return { kind: 'not-sent', reason: `脚本执行未获准：${merged.gated.name}` };
    }
    if (merged.error) {
      // 未解析变量同样属于「没有出去」，与失败分开记：失败是对方/网络的问题
      return merged.error.code === UNRESOLVED_CODE
        ? { kind: 'not-sent', reason: merged.error.message }
        : { kind: 'failed', message: merged.error.message };
    }
    if (response) {
      return {
        kind: 'response',
        status: response.status,
        statusText: response.status_text,
        elapsedMs: response.elapsed_ms,
      };
    }
    return { kind: 'not-sent', reason: '请求未发出' };
  };

  const sendInput = {
    saved_id: input.dirty ? null : request.id,
    inline: inlineDraft,
    environment_id: environmentId,
  };

  // 解析一次请求：脚本构造 `pm.request` 与前置阶段的 Cookie 目标都要它。
  //
  // 用**揭示模式**：脚本要读到真实取值来组装请求（掩码那一份是给界面浮层看的）。
  // 未解析变量的拦截不在这里——它在后端建连之前完成（spec: 未解析变量提示）。
  let resolved: RequestPreview;
  try {
    resolved = await client.variablesPreview(sendInput, true);
  } catch (caught) {
    return finish({ cancelled: false, error: describeError(caught) });
  }

  // 脚本层级：集合 → 目录链（递归祖先，由外到内）→ 请求（spec: 脚本执行时机与顺序）
  const target = workspaceId
    ? { workspaceId, collectionId: request.collection_id, environmentId }
    : null;
  let phases: { pre: ScriptSegment[]; test: ScriptSegment[] } | null = null;
  let requestUrl: string | null = null;
  // 喂给沙箱的请求形态：一个阶段里的各段脚本共用这份快照，**请求头与请求体例外**——
  // 每段执行完的改动都会接力给下一段（design D2）。
  const sandboxRequest = toSandboxRequest(resolved);
  resolvedUrl = resolved.url || null;
  // 解析失败时这份替身是空的；走到这里就有一份「脚本执行之前」的真实请求头可退
  snapshotHeaders = sandboxRequest.header
    .filter((header) => !header.disabled)
    .map((header): [string, string] => [header.key, header.value]);

  // 目标定了，时间线可以占位了：赶在门禁、前置脚本与网络往返之前，顺序才等于发起顺序
  input.onBegin?.({
    sendId: attempt.attemptId,
    requestId: request.id,
    method: request.method,
    url: resolvedUrl || request.url,
    requestHeaders: snapshotHeaders,
    at: startedAt,
  });
  // 前置脚本结束时的请求形态：后置阶段据此看到脚本改过的头与正文；没有前置脚本时就是快照
  let scriptedRequest: SandboxRequest = sandboxRequest;
  // 前置脚本写入的**本地**作用域（`pm.variables`）：不落库，但要交给本次请求的解析，
  // 否则「脚本里算一个值、请求里引用它」这条最常用的写法就只在别的三个作用域里成立
  let scriptLocal: Record<string, string> = {};
  let scriptLocalSecretNames: string[] = [];

  try {
    if (target && !skipScripts) {
      const collection = await client.collectionGet(request.collection_id);

      // 门禁：脚本可能来自导入的集合，执行前必须确认（spec: 脚本来源的可执行性门禁）
      if (!(await isScriptExecutionAllowed(client, request.collection_id))) {
        return finish({
          cancelled: false,
          gated: { collectionId: request.collection_id, name: collection.name },
        });
      }

      // 目录层取**请求当前的归属**并上溯成整条链，而不是用草稿里那份可能陈旧的
      // `folder_id`：拖拽改变归属后草稿不会跟着变，旧代码因此连直接父级都取不到
      // （design D1）。链在这里算一次，后置阶段复用同一份 `phases`——请求在飞行途中
      // 可能被拖动，重算会让前置与后置跑在不同的链上（design D4）。
      const chain = await loadRequestFolderChain(client, request.id);
      if (chain.error) {
        // 链异常（成环或超深）说明本次编排少了若干层。它进 console 而不是 error：
        // error 那个位置归脚本自己（首个未捕获错误），会被 pre.error 覆盖掉，
        // 而这个异常与某一段脚本无关，埋掉就再也看不见了。
        console_.push({
          level: 'error',
          phase: 'prerequest',
          segment: null,
          values: [{ text: chain.error }],
        });
      }

      phases = {
        pre: [
          { label: '集合层', code: collection.pre_request_script ?? null },
          ...folderSegments(chain.folders, (folder) => folder.pre_request_script),
          { label: '请求层', code: request.pre_request_script ?? null },
        ],
        test: [
          { label: '集合层', code: collection.test_script ?? null },
          ...folderSegments(chain.folders, (folder) => folder.test_script),
          { label: '请求层', code: request.test_script ?? null },
        ],
      };

      // 本次真正配了脚本的层级：时间线据此说明「这次跑了哪些段」，空段不算
      phaseLabels = {
        prerequest: phases.pre.filter((segment) => segment.code?.trim()).map((s) => s.label),
        test: phases.test.filter((segment) => segment.code?.trim()).map((s) => s.label),
      };

      // `pm.cookies` 在前置阶段以**脚本执行前解析出的目标**为准（spec: pm.cookies 的
      // 当前请求目标）。这次解析走揭示模式，因此没有「URL 里引用 secret 会以掩码形态
      // 出现」那条旧限制。
      requestUrl = resolved.url || null;

      const pre = await runScriptPhase(
        client,
        target,
        'prerequest',
        phases.pre,
        null,
        requestUrl,
        SCRIPT_TIMEOUT_MS,
        attempt,
        sandboxRequest,
      );

      scriptError = pre.error;
      console_.push(...pre.console);
      assertions.push(...pre.assertions);

      // 前置脚本对请求头的改动落到**真正发出去的那一份**上（spec: pm.request 的填充）。
      // 按差异合并：脚本没碰的头仍保持 `{{var}}` 原样，交给后端解析（design D3）。
      scriptedRequest = pre.request ?? sandboxRequest;
      const withHeaders = applyScriptHeaders(
        inlineDraft,
        diffRequestHeaders(sandboxRequest.header, scriptedRequest.header),
      );

      // 请求体同理（spec: pm.request 的填充）：只有 raw 形态能被改写；表单 / 二进制的
      // 正文在沙箱里只是文本投影，改了也写不回去，这时明说一句，而不是静默吞掉。
      const withBody = applyScriptBody(
        withHeaders.request,
        diffRequestBody(sandboxRequest.body, scriptedRequest.body),
      );
      outgoing = {
        request: withBody.request,
        changed: withHeaders.changed || withBody.changed,
      };
      if (withBody.ignored) {
        console_.push({
          level: 'warn',
          phase: 'prerequest',
          segment: null,
          values: [{ text: '请求体不是 raw 形态（表单 / 二进制），脚本对请求体的改动未生效。' }],
        });
      }
      scriptLocal = pre.local;
      scriptLocalSecretNames = pre.localSecretNames;

      // 取消发生在脚本段：不再往后走，已经产生的输出照常交回
      if (attempt.isCancelled()) return finish({ cancelled: true });
    }

    const payload = await client.sendRequest({
      // 请求头或请求体被脚本改过时必须走内联路径：后端 `saved_id` 优先于 `inline`，带着
      // `saved_id` 发过去，合并结果会被整份忽略——这正是「改了没用」的老毛病（design D3）
      saved_id: outgoing.changed ? null : sendInput.saved_id,
      inline: outgoing.request,
      environment_id: environmentId,
      // 前置脚本经 `pm.variables.set` 写入的本地作用域：只在本次执行期间有效，
      // 因此不能指望数据库里查得到，必须随这次发送一起交给解析（本地作用域优先级最高）
      local: scriptLocal,
      local_secret_names: scriptLocalSecretNames,
      // 会话标识：主请求与脚本内的请求归同一组，取消时一并撤销
      attempt_id: attempt.attemptId,
    });
    response = payload;
    input.onResponse?.(payload);

    if (target && !skipScripts && phases) {
      const post = await runScriptPhase(
        client,
        target,
        'test',
        phases.test,
        payload,
        // 后置阶段的 `pm.cookies` 以**实际发出的请求目标**为准（spec: pm.cookies 的
        // 当前请求目标）。它取自后端回带的发送目标，而不是重定向之后的 `final_url`：
        // 前置脚本改写过目标变量时，两者并不是一回事。
        payload.request_url || requestUrl,
        SCRIPT_TIMEOUT_MS,
        attempt,
        // 后置脚本读到的是**实际发出的那一份**：认证落成的头、正文的 `Content-Type`
        // 只有后端知道；正文同理，喂进沙箱的快照是脚本执行前的解析结果，前置脚本刚写
        // 入的变量在其中还是旧值（spec: pm.request 的填充 / design D4）
        withSentBody(
          withSentHeaders(scriptedRequest, payload.request_headers),
          payload.request_body,
        ),
        // 本地作用域在一个请求的一次执行里连续：前置 `pm.variables.set` 的值后置读得到
        scriptLocal,
      );

      scriptError = scriptError ?? post.error;
      console_.push(...post.console);
      assertions.push(...post.assertions);
      visualizer = post.visualizer;
    }
  } catch (caught) {
    const described = describeError(caught);

    // 取消不是失败（spec: http-engine「请求取消」）：不报错、不动响应区
    if (described.code === CANCELLED_CODE) return finish({ cancelled: true });

    return finish({ cancelled: false, error: described });
  }

  return finish({ cancelled: false });
}
