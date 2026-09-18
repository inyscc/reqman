import { useEffect, useMemo, useState } from 'react';
import { humanBytes, planPreview, prettyBody, revokeSandboxUrl, createSandboxUrl } from '../lib/sandbox';
import { ScriptReport } from './ScriptReport';
import type { ConsoleEntry, TestAssertion } from '../lib/scriptRuntime';
import type { ResponsePayload } from '../lib/types';

type Tab = 'body' | 'headers' | 'script';

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

export function ResponsePanel({
  response,
  busy,
  error,
  onSaveFull,
  scriptConsole,
  scriptAssertions,
  scriptError,
  visualizerHtml,
}: ResponsePanelProps) {
  const [tab, setTab] = useState<Tab>('body');
  const [pretty, setPretty] = useState(false);

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
            <span className="badge">{response.elapsed_ms} ms</span>
            <span className="badge">{humanBytes(response.size_bytes)}</span>
            <span className="badge">{response.http_version}</span>
            {response.via_proxy && <span className="badge">经代理</span>}
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
              title="可视化结果"
              data-testid="visualizer-frame"
              sandbox=""
              srcDoc={visualizerHtml}
              style={{ minHeight: 120, border: '1px solid #ddd', width: '100%' }}
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
                  <td className="mono" style={{ wordBreak: 'break-all' }}>
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
                正文超过体积上限，界面只持有前 {humanBytes(response.pretty_print_threshold > 0 ? Math.min(response.size_bytes, 50 * 1024 * 1024) : response.size_bytes)}；
                完整正文可用「保存全文」取回。
              </div>
            )}

            {!response.pretty_available && (
              <div className="notice info">
                响应体积超过格式化阈值（{humanBytes(response.pretty_print_threshold)}），
                结构化视图已关闭，只提供原始内容。
              </div>
            )}

            {response.insecure_warning && (
              <div className="notice danger" role="alert">
                该请求关闭了证书校验。
              </div>
            )}

            {response.unresolved.length > 0 && (
              <div className="notice warn">
                请求中存在未解析变量：{response.unresolved.join('、')}
              </div>
            )}

            <div className="row">
              <button
                className={`tab ${!pretty ? 'active' : ''}`}
                onClick={() => setPretty(false)}
              >
                原始
              </button>
              <button
                className={`tab ${pretty ? 'active' : ''}`}
                onClick={() => setPretty(true)}
                disabled={!response.pretty_available}
              >
                格式化
              </button>
              <span className="grow" />
              <span className="muted mono">{response.content_type ?? '未知内容类型'}</span>
            </div>

            {plan?.kind === 'iframe' && response.body_text != null && (
              <SandboxedPreview html={response.body_text} />
            )}

            {plan?.kind === 'text' && (
              <pre className="body" data-testid="response-body">
                {pretty && response.pretty_available
                  ? prettyBody(response.content_type, response.body_text ?? '')
                  : response.body_text}
              </pre>
            )}

            {plan?.kind === 'binary' && (
              <pre className="body" data-testid="response-body">
                {response.body_base64
                  ? `（二进制内容，base64）\n${response.body_base64.slice(0, 2000)}`
                  : '（二进制内容）'}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}
