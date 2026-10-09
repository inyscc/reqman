import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_INDENT_UNIT,
  FORMAT_LABELS,
  HEX_MAX_BYTES,
  bodyBytes,
  detectResponseFormat,
  hexDump,
  humanBytes,
  planPreview,
  renderBody,
  revokeSandboxUrl,
  createSandboxUrl,
  type DetectedFormat,
  type ResponseFormat,
} from '../lib/sandbox';
import {
  DEFAULT_PRESENTATION,
  resolveInitialFormat,
  type RequestResponseFormat,
  type ResponsePresentation,
} from '../lib/responsePresentation';
import { Dropdown, type DropdownOption } from './Dropdown';
import { ScriptReport } from './ScriptReport';
import { CodeSurface } from './CodeSurface';
import { WrapIcon } from './icons';
import { CODE_SURFACE_MAX_BYTES } from '../lib/codeSurface';
import type { ConsoleEntry, TestAssertion } from '../lib/scriptRuntime';
import type { ProxyDecisionView, ResponsePayload } from '../lib/types';
import { proxyDecisionLabel } from '../lib/proxyDecision';

type Tab = 'body' | 'headers' | 'script';

/** 格式下拉的选项顺序：跟随检测在前，Hex 收在末尾（低频、诊断用）。 */
const FORMAT_ORDER: ResponseFormat[] = ['auto', 'raw', 'json', 'xml', 'html', 'hex'];

/**
 * 发送进行中的遮罩 + 进度线（spec: ui-layout「发送中的响应区反馈」）。
 *
 * 两种情形共用这一个浮层：响应区尚无内容时它铺满正文区，已有响应时它压在那份响应之上
 * （旧响应只是被压暗，SHALL NOT 被清空）。
 *
 * **不摆占位行**：占位条压在旧响应的文字上会读成一层删除线——比不遮挡更难看，而且它与
 * "下面那份东西还在"这件事自相矛盾。遮罩本身说明了"这一块在等响应"，顶边那条进度线
 * （跑马灯）提供进度感，零动画时则由响应头的「发送中」标识承担（spec 的 reduced-motion 一条）。
 *
 * 纯呈现——语义由那个标识承担，因此对辅助技术隐藏。
 */
function SendingOverlay() {
  return <div className="response-loading" data-testid="response-loading" aria-hidden="true" />;
}

export interface ResponsePanelProps {
  response: ResponsePayload | null;
  error: string | null;
  /**
   * 本次发送的**代理决定**（spec: ui-layout「响应区的代理决定」）。
   *
   * 与 `response` / `error` 并列传入，而不是从 `response` 里取：失败时没有响应，
   * 而决定在那时同样要出现——失败恰恰是最需要看它的时候。
   */
  proxyDecision?: ProxyDecisionView | null;
  onSaveFull: () => void;
  /** 脚本 console 输出；为空时「脚本」标签页不出现（任务 6.4）。 */
  scriptConsole?: ConsoleEntry[];
  scriptAssertions?: TestAssertion[];
  scriptError?: string | null;
  /** 可视化结果（已渲染的 HTML）；由 sandbox="" 的 iframe 隔离承载（任务 4.6）。 */
  visualizerHtml?: string | null;
  /** 应用级呈现配置（响应格式检测）。 */
  presentation?: ResponsePresentation;
  /**
   * 格式化输出的缩进单元（空格串 / 单个制表符），由编辑器外观的「缩进数 + 缩进类型」
   * 换算后下发（spec: code-editors「等宽面的外观与缩进」）。缺省只作兜底——应用内一律由
   * App 传入；旧的「格式化缩进宽度」键已退场。
   */
  indent?: string;
  /** 请求级的响应格式覆盖（spec: ui-layout「请求级响应格式覆盖」）。 */
  requestFormat?: RequestResponseFormat;
  /**
   * 折行的**生效值**（应用级缺省 + 该请求的覆盖）与把它落为显式值的出口
   * （spec: ui-layout「折行」）。工具条上那枚开关写的是请求级取值，因此与请求侧更同源。
   */
  wrapLines?: boolean;
  onWrapLinesChange?: (next: boolean) => void;
  /**
   * 该请求是否正在发送（spec: ui-layout「发送中的响应区反馈」）。它与 `busy` 分开：
   * `busy` 还被保存请求、脚本与改名共用，而遮罩与「发送中」标识只随发送态出现。
   */
  sending?: boolean;
}

/**
 * 不可信响应的呈现（design.md D15）：HTML / SVG / Markdown 一律放进**不带
 * allow-scripts** 的 sandbox iframe，用 blob: 承载，拿不到应用界面与后端能力。
 */
function SandboxedPreview({ html }: { html: string }) {
  const [url, setUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (typeof URL.createObjectURL !== 'function') {
      setUrl(undefined);
      return;
    }
    const next = createSandboxUrl(html);
    setUrl(next);
    return () => revokeSandboxUrl(next);
  }, [html]);

  return (
    <iframe
      className="preview"
      title="响应预览"
      data-testid="sandboxed-preview"
      // 空 sandbox：不授予 allow-scripts，也不授予 allow-same-origin
      sandbox=""
      // 只传实际用到的那一个承载属性，避免无谓的属性增删
      {...(url ? { src: url } : { srcDoc: html })}
    />
  );
}

/**
 * 依据当前生效的呈现格式生成下拉选项。
 *
 * 检测格式以 `badge` 标记（spec: ui-layout「响应区正文工具条」）：标记跟着**检测**
 * 走，不跟着当前值走，因此强制选了别的格式时它仍留在检测到的那一项上。
 *
 * text / markdown 在下拉里没有同名选项——它们的容器视图就是原文，因此标记落在 Raw。
 *
 * 响应超过格式化阈值时，需要格式化的三项直接不可选：这一事实由选项自身表达，
 * 不由界面另写一句解释（spec: ui-layout「语义落在操作上」）。
 */
function formatOptions(
  detected: DetectedFormat,
  prettyAvailable: boolean,
): DropdownOption<ResponseFormat>[] {
  const detectedOption: ResponseFormat =
    detected === 'text' || detected === 'markdown' ? 'raw' : detected;

  return FORMAT_ORDER.map((format) => ({
    value: format,
    label: FORMAT_LABELS[format],
    ...(format === detectedOption ? { badge: '检测' } : {}),
    ...(prettyAvailable || format === 'raw' || format === 'hex' ? {} : { disabled: true }),
  }));
}

export function ResponsePanel({
  response,
  sending = false,
  error,
  proxyDecision = null,
  onSaveFull,
  scriptConsole,
  scriptAssertions,
  scriptError,
  visualizerHtml,
  presentation = DEFAULT_PRESENTATION,
  indent = DEFAULT_INDENT_UNIT,
  requestFormat,
  wrapLines = true,
  onWrapLinesChange,
}: ResponsePanelProps) {
  const [tab, setTab] = useState<Tab>('body');
  const [preview, setPreview] = useState(true);

  /** 代理决定的可读文案；没有决定时为 `null`（如尚未发送过）。 */
  const decisionLabel = proxyDecisionLabel(proxyDecision);

  /** 本次查看的格式（spec: http-engine「响应内容与格式化」）：临时覆盖，不持久。 */
  const initialFormat = resolveInitialFormat(presentation.formatDetection, requestFormat);
  const [format, setFormat] = useState<ResponseFormat>(initialFormat);

  // 解析结果与配置都要经 ref 读，避免把「新响应才重置」写成「配置一变就重置」——
  // 用户正在看的那份响应不该因为改了全局设置而跳走（spec: ui-layout 配置生效于
  // **之后的**响应呈现）。
  const resolveRef = useRef({ global: presentation.formatDetection, request: requestFormat });
  resolveRef.current = { global: presentation.formatDetection, request: requestFormat };

  const responseId = response?.id ?? null;
  useEffect(() => {
    const resolved = resolveInitialFormat(resolveRef.current.global, resolveRef.current.request);
    setFormat(resolved);
    setPreview(true);
  }, [responseId]);

  // 没有输出也没有断言时不产生噪声：连标签页都不出现
  const hasScript =
    (scriptConsole?.length ?? 0) > 0 ||
    (scriptAssertions?.length ?? 0) > 0 ||
    Boolean(scriptError);

  // 上一次发送有脚本输出、这一次没有时「脚本」标签会消失；把选中态收回 Body，
  // 否则面板会停在一个不存在的标签上，看上去像「什么都没渲染」
  useEffect(() => {
    if (!hasScript && tab === 'script') setTab('body');
  }, [hasScript, tab]);

  const plan = useMemo(() => {
    if (!response) return null;
    return planPreview(
      response.content_type,
      response.body_text ?? null,
      response.body_text === null,
    );
  }, [response]);

  const detected = detectResponseFormat(response?.content_type);

  /**
   * 体积超过格式化阈值时不套格式化器（后端已判定 `pretty_available`），但仍允许
   * Raw 与 Hex —— 字节视图与格式化无关。
   */
  const effectiveFormat: ResponseFormat =
    response && !response.pretty_available && format !== 'hex' ? 'raw' : format;

  const rendered =
    response && tab === 'body'
      ? renderBody(effectiveFormat, detected, response.body_text ?? '', indent)
      : null;

  // 预览是**开关**而不是独裁者（design D5）：可预览响应默认照旧预览，用户关掉开关
  // 或选了任一其它格式时让位给文本视图。
  const showPreview =
    plan?.kind === 'iframe' && preview && format === 'auto' && response?.body_text != null;

  // 正文为空（二进制）时没有可解释的文本：沿用原有的 base64 提示，Hex 除外。
  const binaryFallback = plan?.kind === 'binary' && response?.body_text == null;

  const hexBytes =
    rendered?.view === 'hex' ? bodyBytes(response?.body_text, response?.body_base64) : null;

  /** 纯文本降级面是否退出折行（Hex 例外：它靠空格对齐三列，永远不折）。 */
  const bodyWrapClass = wrapLines ? '' : ' nowrap-body';

  if (error) {
    return (
      <div className="pane">
        <div className="pane-header">
          <strong>响应</strong>
          {/* 失败时没有响应元数据，但**代理决定仍要出现**——失败恰恰是最需要看它的时候
              （spec: ui-layout「响应区的代理决定」「失败时仍呈现决定」）。 */}
          {decisionLabel && (
            <span className="response-meta mono" data-testid="proxy-decision">
              {decisionLabel}
            </span>
          )}
        </div>
        <div className="pane-body">
          <div className="notice danger" role="alert">
            {error}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pane">
      <div className="pane-header">
        <strong>响应</strong>
        {/* 只随**发送态**出现：它还挂着响应区的遮罩，两者必须是同一个触发条件
            （spec: ui-layout「发送中的响应区反馈」）。`busy` 含保存与改名，不能用。 */}
        {sending && (
          <span className="badge" data-testid="response-sending">
            发送中…
          </span>
        )}
        {response && (
          <>
            <span
              className={`badge ${
                response.status < 400 ? 'ok' : response.status < 500 ? 'warn' : 'danger'
              }`}
              data-testid="status"
            >
              {response.status} {response.status_text}
            </span>
            {/* 元信息收成一段紧凑文本：原先 4–5 个并列徽章会把头部挤到折行，
                折行又让头部高度不可预测（design D6）。
                「经代理」不再挤在这里——它由下面那个决定元素说清，还带上是哪个代理。 */}
            <span className="response-meta mono" data-testid="response-meta">
              {[
                `${response.elapsed_ms} ms`,
                humanBytes(response.size_bytes),
                response.http_version,
              ]
                .filter((part): part is string => part !== null)
                .join(' · ')}
            </span>
          </>
        )}
        {/* 代理决定：成功与失败都要出现（spec: ui-layout「响应区的代理决定」）。
            **直连也写出来**——"这次没走代理"是一条结论，不是一个空值。 */}
        {decisionLabel && (
          <span className="response-meta mono" data-testid="proxy-decision">
            {decisionLabel}
          </span>
        )}
        <span className="grow" />
        {(response || hasScript) && (
          <>
            <span className="tabs">
              {response && (
                <>
                  <button
                    className={`tab ${tab === 'body' ? 'active' : ''}`}
                    onClick={() => setTab('body')}
                  >
                    Body
                  </button>
                  <button
                    className={`tab ${tab === 'headers' ? 'active' : ''}`}
                    onClick={() => setTab('headers')}
                  >
                    Headers
                  </button>
                </>
              )}
              {hasScript && (
                <button
                  className={`tab ${tab === 'script' ? 'active' : ''}`}
                  onClick={() => setTab('script')}
                >
                  脚本
                </button>
              )}
            </span>
            {response && <button onClick={onSaveFull}>保存全文</button>}
          </>
        )}
      </div>

      <div className="pane-body stack">
        {/* 首次发送进行中时由遮罩承担这段呈现，空态文案让位 */}
        {!response && !hasScript && !sending && <div className="muted">尚未发送请求。</div>}

        {/* 还没有任何响应、但发送已经在途：正文区照常立起来，好让遮罩铺满它
            （spec: ui-layout「发送中的响应区反馈」的第一种形态）。 */}
        {!response && sending && tab === 'body' && (
          <div className="response-body-area">
            <SendingOverlay />
          </div>
        )}

        {/* 脚本输出不依赖响应：请求失败时前置脚本的输出同样要能看见 */}
        {tab === 'script' && (
          <ScriptReport
            console={scriptConsole ?? []}
            assertions={scriptAssertions ?? []}
            error={scriptError ?? null}
          />
        )}

        {/* 可视化结果：模板已由宿主渲染，内容进 sandbox="" 的 iframe——脚本不执行、
            拿不到应用界面与后端能力（D8 / 9.2） */}
        {visualizerHtml && (
          <div className="stack" data-testid="visualizer">
            <strong>可视化</strong>
            <iframe
              className="preview visualizer-frame"
              title="可视化结果"
              data-testid="visualizer-frame"
              sandbox=""
              srcDoc={visualizerHtml}
            />
          </div>
        )}

        {response && tab === 'headers' && (
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>值</th>
              </tr>
            </thead>
            <tbody>
              {response.headers.map(([name, value], index) => (
                <tr key={`${name}-${index}`}>
                  <td className="mono">{name}</td>
                  <td className="mono break-all">
                    {value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {response && tab === 'body' && (
          <>
            {response.truncated && (
              <div className="notice warn" role="status">
                正文超过体积上限，界面只持有前 {humanBytes(Math.min(response.size_bytes, response.size_limit_bytes))}；
                完整正文可用「保存全文」取回。
              </div>
            )}

            <div className="response-view-bar">
              {/* 呈现方式与头部那组标签分属不同维度（容器视图 vs 呈现格式），因此不
                  合并；下拉替换了原先的「原始 / 格式化」双 tab——Raw 即原「原始」，
                  格式选择即原「格式化」的泛化（design D1）。 */}
              <Dropdown
                label="响应呈现格式"
                testId="response-format"
                value={format}
                options={formatOptions(detected, response.pretty_available)}
                onChange={setFormat}
                disabled={sending}
              />
              <span className="grow" />
              {plan?.kind === 'iframe' && (
                <button
                  className="ghost"
                  aria-pressed={preview}
                  data-testid="preview-toggle"
                  disabled={sending}
                  onClick={() => setPreview((current) => !current)}
                >
                  预览
                </button>
              )}
              <span className="muted mono response-content-type">
                {response.content_type ?? '未知内容类型'}
              </span>

              {/* 响应区的折行开关（spec: ui-layout「折行」）：停在正文工具条的**最右端**，
                  排在内容类型之后——它不压在正文上，因此不遮挡任何一行的阅读，也不与
                  正文的滚动条抢指针。图标呈现，开 / 关读在 pressed 态上；显隐由 CSS
                  悬停驱动（design D6），因此显形前不接收指针事件。 */}
              <button
                type="button"
                className="wrap-toggle"
                aria-pressed={wrapLines}
                aria-label="折行"
                title="折行"
                data-testid="response-wrap"
                disabled={sending}
                onClick={() => onWrapLinesChange?.(!wrapLines)}
              >
                <WrapIcon aria-hidden="true" />
              </button>
            </div>

            {/* 正文区自己是一层定位容器：发送遮罩铺在这一层里。折行开关留在工具条上
                （这一层之外），因此遮罩压下来时它照常可见、只是不可用。 */}
            <div className="response-body-area">
              {sending && <SendingOverlay />}

              {showPreview && <SandboxedPreview html={response.body_text ?? ''} />}

            {!showPreview && rendered?.view === 'hex' && (
              <>
                {hexBytes && hexBytes.length > HEX_MAX_BYTES && (
                  <div className="notice info" role="status" data-testid="hex-size-notice">
                    字节过多，Hex 视图只呈现前 {humanBytes(HEX_MAX_BYTES)}。
                  </div>
                )}
                <pre className="body hex-body" data-testid="response-body">
                  {hexDump(hexBytes ?? new Uint8Array())}
                </pre>
              </>
            )}

            {!showPreview &&
              rendered?.view !== 'hex' &&
              (binaryFallback ? (
                <pre className={`body${bodyWrapClass}`} data-testid="response-body">
                  {response.body_base64
                    ? `（二进制内容，base64）\n${response.body_base64.slice(0, 2000)}`
                    : '（二进制内容）'}
                </pre>
              ) : response.size_bytes > CODE_SURFACE_MAX_BYTES ? (
                // 大正文降级：几 MB 文档交给 Monaco 会冻主线程，回落纯文本原样展示
                <>
                  <div className="notice info" role="status" data-testid="body-size-notice">
                    正文过大，高亮已禁用。
                  </div>
                  <pre className={`body${bodyWrapClass}`} data-testid="response-body">
                    {rendered?.view === 'text' ? rendered.text : ''}
                  </pre>
                </>
              ) : (
                <CodeSurface
                  uri="file:///reqman/response/body"
                  testId="response-body"
                  language={rendered?.view === 'text' ? rendered.language : 'plaintext'}
                  value={rendered?.view === 'text' ? rendered.text : ''}
                  readOnly
                  fill
                  wrap={wrapLines}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
