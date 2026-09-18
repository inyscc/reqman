import { useState } from 'react';
import { describeError, type Commands } from '../lib/commands';
import type { CurlCommand, ImportOutcome, SendRequestInput } from '../lib/types';

const KIND_LABELS: Record<string, string> = {
  collection_v21: 'Postman 集合 v2.1',
  collection_v20: 'Postman 集合 v2.0',
  environment: '环境',
  globals: '全局变量',
};

export interface ImportExportPanelProps {
  client: Commands;
  workspaceId: string;
  /** 导出集合的目标；为空表示当前没有可导出的集合。 */
  collectionId: string | null;
  environmentId: string | null;
  /** 导出 curl 的目标请求；为空表示当前没有选中的请求。 */
  sendInput: SendRequestInput | null;
  /** 导入成功后通知外层刷新树与变量。 */
  onImported: () => void;
}

/** 导入报告的一句话摘要：有差异时说清楚差异在哪。 */
export function describeOutcome(outcome: ImportOutcome): { tone: 'ok' | 'warn'; text: string } {
  const report = outcome.report;
  const kind = KIND_LABELS[outcome.kind] ?? outcome.kind;
  const differences =
    report.auth_downgrades.length +
    report.skipped_items.length +
    report.file_field_downgrades.length +
    report.dropped_examples;

  if (differences === 0) {
    return { tone: 'ok', text: `导入完成（${kind}）：没有降级或丢弃` };
  }

  const parts = [`导入完成（${kind}）`];
  if (report.auth_downgrades.length > 0) parts.push(`认证降级 ${report.auth_downgrades.length} 处`);
  if (report.file_field_downgrades.length > 0) {
    parts.push(`待选择文件 ${report.file_field_downgrades.length} 个`);
  }
  if (report.skipped_items.length > 0) parts.push(`已跳过 ${report.skipped_items.length} 项`);
  if (report.dropped_examples > 0) parts.push(`丢弃示例 ${report.dropped_examples} 条`);
  return { tone: 'warn', text: parts.join('，') };
}

export function ImportExportPanel(props: ImportExportPanelProps) {
  const { client, workspaceId, collectionId, environmentId, sendInput, onImported } = props;

  const [text, setText] = useState('');
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [curl, setCurl] = useState<CurlCommand | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(false);
    }
  };

  const runImport = (source: { text?: string; handle?: string }) =>
    run(async () => {
      const result = await client.importPostman(workspaceId, source);
      setOutcome(result);
      setCurl(null);
      onImported();
    });

  const summary = outcome ? describeOutcome(outcome) : null;

  return (
    <div className="stack" data-testid="import-export-panel">
      <div className="row">
        <strong>导入 / 导出</strong>
      </div>

      {error && (
        <div className="notice danger" role="alert" data-testid="io-error">
          {error}
        </div>
      )}

      <textarea
        aria-label="粘贴 Postman 文档"
        rows={4}
        placeholder="粘贴 Postman Collection / Environment / Globals 文档"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />

      <div className="row">
        <button disabled={busy || text.trim().length === 0} onClick={() => void runImport({ text })}>
          导入粘贴内容
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const picked = await client.pickUploadFile();
              if (!picked) return;
              await runImport({ handle: picked.handle });
            })
          }
        >
          从文件导入
        </button>
      </div>

      <div className="row">
        <button disabled={busy || !collectionId} onClick={() => void run(async () => {
          if (!collectionId) return;
          await client.collectionExport(collectionId);
        })}>
          导出集合
        </button>
        <button disabled={busy || !environmentId} onClick={() => void run(async () => {
          if (!environmentId) return;
          await client.environmentExport(environmentId);
        })}>
          导出环境
        </button>
        <button disabled={busy} onClick={() => void run(async () => {
          await client.globalsExport(workspaceId);
        })}>
          导出全局变量
        </button>
      </div>

      <div className="row">
        <button disabled={busy || !sendInput} onClick={() => void run(async () => {
          if (!sendInput) return;
          setCurl(await client.curlExport(sendInput));
        })}>
          导出 curl
        </button>
      </div>

      {summary && outcome && (
        <div data-testid="import-report">
          <div className={summary.tone === 'ok' ? 'notice info' : 'notice warn'} role="status">
            {summary.text}
          </div>

          {outcome.report.auth_downgrades.length > 0 && (
            <div className="notice warn" data-testid="auth-downgrades">
              认证降级：
              {outcome.report.auth_downgrades
                .map((entry) => `${entry.entry_name}（${entry.auth_type}）`)
                .join('、')}
            </div>
          )}

          {outcome.report.file_field_downgrades.length > 0 && (
            <div className="notice warn" data-testid="file-downgrades">
              待选择文件：
              {outcome.report.file_field_downgrades
                .map((entry) => `${entry.entry_name}/${entry.field_name}`)
                .join('、')}
            </div>
          )}

          {outcome.report.skipped_items.length > 0 && (
            <div className="notice warn" data-testid="skipped-items">
              已跳过：
              {outcome.report.skipped_items
                .map((entry) => `${entry.name}（${entry.reason}）`)
                .join('、')}
            </div>
          )}
        </div>
      )}

      {curl && (
        <div data-testid="curl-output">
          {curl.warnings.length > 0 && (
            <div className="notice danger" role="alert" data-testid="curl-warnings">
              {curl.warnings.join('；')}
            </div>
          )}
          <pre className="body mono">{curl.command}</pre>
        </div>
      )}
    </div>
  );
}
