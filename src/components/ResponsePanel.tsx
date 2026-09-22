import { useEffect, useMemo, useRef, useState } from 'react';
import {
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
import { CODE_SURFACE_MAX_BYTES } from '../lib/codeSurface';
import type { ConsoleEntry, TestAssertion } from '../lib/scriptRuntime';
import type { ResponsePayload } from '../lib/types';

type Tab = 'body' | 'headers' | 'script';

/** 格式下拉的选项顺序：跟随检测在前，Hex 收在末尾（低频、诊断用）。 */
const FORMAT_ORDER: ResponseFormat[] = ['auto', 'raw', 'json', 'xml', 'html', 'hex'];

export interface ResponsePanelProps {
  response: ResponsePayload | null;
  busy: boolean;
  error: string | null;
  onSaveFull: () => void;
  /** 脚本 console 输出；为空时「脚本」标签页不出现（任务 6.4）。 */
  scriptConsole?: ConsoleEntry[];
  scriptAssertions?: TestAssertion[];
  scriptError?: string | null;
  /** 可视化结果（已渲染的 HTML）；由 sandbox="" 的 iframe 隔离承载（任务 4.6）。 */
  visualizerHtml?: string | null;
  /** 应用级呈现配置；缺省与改动前行为一致（跟随检测、缩进 2）。 */
  presentation?: ResponsePresentation;
  /** 请求级的响应格式覆盖（spec: ui-layout「请求级响应格式覆盖」）。 */
  requestFormat?: RequestResponseFormat;
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
  busy,
  error,
  onSaveFull,
  scriptConsole,
  scriptAssertions,
  scriptError,
  visualizerHtml,
  presentation = DEFAULT_PRESENTATION,
  requestFormat,
}: ResponsePanelProps) {
  const [tab, setTab] = useState<Tab>('body');
  const [preview, setPreview] = useState(true);

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
      ? renderBody(effectiveFormat, detected, response.body_text ?? '', presentation.indentWidth)
      : null;

  // 预览是**开关**而不是独裁者（design D5）：可预览响应默认照旧预览，用户关掉开关
  // 或选了任一其它格式时让位给文本视图。
  const showPreview =
    plan?.kind === 'iframe' && preview && format === 'auto' && response?.body_text != null;

  // 正文为空（二进制）时没有可解释的文本：沿用原有的 base64 提示，Hex 除外。
  const binaryFallback = plan?.kind === 'binary' && response?.body_text == null;

  const hexBytes =
    rendered?.view === 'hex' ? bodyBytes(response?.body_text, response?.body_base64) : null;

  if (error) {
    return (
      <div className="pane">
        <div className="pane-header">
          <strong>响应</strong>
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
        {busy && <span className="badge">发送中…</span>}
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
                折行又让头部高度不可预测（design D6）。 */}
            <span className="response-meta mono" data-testid="response-meta">
              {[
                `${response.elapsed_ms} ms`,
                humanBytes(response.size_bytes),
                response.http_version,
                response.via_proxy ? '经代理' : null,
              ]
                .filter((part): part is string => part !== null)
                .join(' · ')}
            </span>
          </>
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
        {!response && !hasScript && <div className="muted">尚未发送请求。</div>}

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
              />
              <span className="grow" />
              {plan?.kind === 'iframe' && (
                <button
                  className="ghost"
                  aria-pressed={preview}
                  data-testid="preview-toggle"
                  onClick={() => setPreview((current) => !current)}
                >
                  预览
                </button>
              )}
              <span className="muted mono response-content-type">
                {response.content_type ?? '未知内容类型'}
              </span>
            </div>

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
                <pre className="body" data-testid="response-body">
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
                  <pre className="body" data-testid="response-body">
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
                />
              ))}
          </>
        )}
      </div>
    </div>
  );
}
