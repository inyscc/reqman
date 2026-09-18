import { useState } from 'react';
import { PreviewBar, UnresolvedWarning } from './PreviewBar';
import type { RequestPreview } from '../lib/types';

export interface PreviewStripProps {
  preview: RequestPreview | null;
  error?: string | null;
}

/**
 * 解析预览条（change: rework-app-layout，design D4）：占据地址栏下一行，
 * 可折叠、默认展开。
 *
 * 未解析变量警告**不随折叠隐藏**：spec「未解析变量警告常驻」是安全性的硬要求，
 * 折叠掉的只能是「已解析成什么样」这类信息。
 */
export function PreviewStrip({ preview, error }: PreviewStripProps) {
  const [open, setOpen] = useState(true);
  const unresolved = preview?.unresolved.length ?? 0;

  return (
    <div className="preview-strip">
      <button
        className="preview-toggle ghost"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span>解析预览</span>
        {unresolved > 0 && <span className="badge warn">{unresolved} 个未解析</span>}
      </button>

      {error && (
        <div className="notice danger" role="alert">
          {error}
        </div>
      )}

      {!error && open && (
        <div className="preview-body">
          <PreviewBar preview={preview} error={null} showUnresolved={false} />
        </div>
      )}

      {!error && <UnresolvedWarning names={preview?.unresolved ?? []} />}
    </div>
  );
}
