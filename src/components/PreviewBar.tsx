import type { RequestPreview } from '../lib/types';

export interface PreviewBarProps {
  preview: RequestPreview | null;
  error?: string | null;
  /**
   * 未解析变量警告是否由本组件渲染。默认渲染；PreviewStrip 会在折叠时
   * 把它提到折叠体之外常驻，因此以自己的那份为准（change: rework-app-layout）。
   */
  showUnresolved?: boolean;
}

/**
 * 未解析变量警告：与呈现载体无关，**发送之前必须可见**（spec: 未解析变量提示）。
 * 单独导出是为了让折叠条与预览体共用一个呈现，而不是各写一份文案。
 */
export function UnresolvedWarning({ names }: { names: string[] }) {
  if (names.length === 0) return null;

  return (
    <div className="notice warn" role="alert" data-testid="unresolved-warning">
      以下变量未能解析，请求中会保留 <code>{'{{name}}'}</code> 原文：
      <ul className="warn-list">
        {names.map((name) => (
          <li key={name} className="mono">
            {name}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 解析预览：未解析变量必须在**发送之前**就能被看到（spec: 未解析变量提示），
 * secret 取值在这里只会以掩码出现。
 */
export function PreviewBar({ preview, error, showUnresolved = true }: PreviewBarProps) {
  if (error) {
    return (
      <div className="notice danger" role="alert">
        {error}
      </div>
    );
  }

  if (!preview) {
    return <div className="notice info muted">正在解析请求…</div>;
  }

  return (
    <div className="stack">
      <div className="row">
        <span className="badge">{preview.method}</span>
        <span className="mono grow break-all">
          {preview.url}
        </span>
        {preview.masked && <span className="badge">secret 已掩码</span>}
        {preview.proxy_url && (
          <span className="badge">代理 {preview.proxy_url}</span>
        )}
      </div>

      {showUnresolved && <UnresolvedWarning names={preview.unresolved} />}

      {preview.cookies && preview.cookies.length > 0 && (
        <div className="row" data-testid="preview-cookies">
          <span className="badge">Cookie</span>
          <span className="mono break-all">
            {preview.cookies.map(([name, value]) => `${name}=${value}`).join('; ')}
          </span>
        </div>
      )}

      {preview.insecure_warning && (
        <div className="notice danger" role="alert">
          已关闭证书校验。
        </div>
      )}
    </div>
  );
}
