// 全局 Console 面板（change: add-console-panel）。
//
// 只负责呈现：条目从 `consoleLog` 来，筛选是纯函数，展开用的结构在收集时就留好了。
// 抽屉的占位、高度拖动与持久化在 App 侧（spec: ui-layout「底部 Console 抽屉占位」）。

import { useEffect, useRef, useState } from 'react';
import {
  consoleLog,
  filterEntries,
  useConsoleLog,
  type ConsoleFilterKind,
  type ConsoleLogEntry,
  type ConsoleLogStore,
  type ConsoleNetworkEntry,
  type ConsoleOutputEntry,
  type ConsoleResult,
} from '../lib/consoleLog';
import type { ConsoleValue } from '../lib/scriptRuntime';

export interface ConsolePanelProps {
  /** 测试用：注入另一份时间线；不传就用应用那一份。 */
  store?: ConsoleLogStore;
  onClose: () => void;
}

const FILTERS: { kind: ConsoleFilterKind; label: string }[] = [
  { kind: 'all', label: '全部' },
  { kind: 'network', label: '网络' },
  { kind: 'output', label: '输出' },
];

/** 是否算「停在末尾」的容差（像素）：滚动位置很难精确落在最后一行。 */
const FOLLOW_THRESHOLD = 8;

export function ConsolePanel({ store, onClose }: ConsolePanelProps) {
  const entries = useConsoleLog(store);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<ConsoleFilterKind>('all');

  const listRef = useRef<HTMLDivElement | null>(null);
  // 是否跟着新条目走。用 ref 而不是 state：滚动事件很频繁，不该每条都触发重渲染
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const visible = filterEntries(entries, { query, kind });

  const scrollToBottom = () => {
    const element = listRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    atBottomRef.current = true;
    setShowJump(false);
  };

  const handleScroll = () => {
    const element = listRef.current;
    if (!element) return;

    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const atBottom = distance <= FOLLOW_THRESHOLD;
    atBottomRef.current = atBottom;
    setShowJump(!atBottom);
  };

  // 停在末尾时跟随新条目；用户上滚查看旧条目后不再强行拉回来（spec: request-console）
  useEffect(() => {
    if (!atBottomRef.current) return;
    const element = listRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [visible.length]);

  return (
    <div className="console-panel" data-testid="console-panel">
      <div className="console-head">
        <strong className="console-title">Console</strong>

        <input
          className="console-search"
          type="search"
          placeholder="搜索 URL、状态或输出"
          aria-label="搜索 Console"
          data-testid="console-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />

        <span className="segmented" role="group" aria-label="按类型过滤">
          {FILTERS.map((filter) => (
            <button
              key={filter.kind}
              className={`segmented-item ${kind === filter.kind ? 'active' : ''}`}
              aria-pressed={kind === filter.kind}
              data-testid={`console-filter-${filter.kind}`}
              onClick={() => setKind(filter.kind)}
            >
              {filter.label}
            </button>
          ))}
        </span>

        <button
          className="ghost"
          data-testid="console-clear"
          onClick={() => {
            // 不弹确认：条目只活在内存里，重新发一次就有（spec: request-console）
            (store ?? consoleLog).clear();
          }}
        >
          清空
        </button>

        <button className="ghost" data-testid="console-close" onClick={onClose}>
          关闭
        </button>
      </div>

      <div className="console-list" data-testid="console-list" ref={listRef} onScroll={handleScroll}>
        {visible.length === 0 ? (
          entries.length === 0 ? (
            <div className="muted" data-testid="console-empty">
              还没有日志。发送一条请求后，这里会留下它的记录。
            </div>
          ) : (
            <div className="muted" data-testid="console-no-match">
              没有匹配的条目。试试别的关键词或换个类型。
            </div>
          )
        ) : (
          visible.map((entry) => <ConsoleEntryRow key={entry.id} entry={entry} />)
        )}
      </div>

      {showJump && (
        <button className="console-jump" data-testid="console-jump" onClick={scrollToBottom}>
          回到底部
        </button>
      )}
    </div>
  );
}

function ConsoleEntryRow({ entry }: { entry: ConsoleLogEntry }) {
  const [open, setOpen] = useState(false);

  if (entry.kind === 'network') {
    return <NetworkRow entry={entry} open={open} onToggle={() => setOpen((value) => !value)} />;
  }

  return <OutputRow entry={entry} open={open} onToggle={() => setOpen((value) => !value)} />;
}

function NetworkRow({
  entry,
  open,
  onToggle,
}: {
  entry: ConsoleNetworkEntry;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="console-entry" data-kind="network" data-testid="console-entry">
      <button className="console-line" aria-expanded={open} onClick={onToggle}>
        <span className="console-caret">{open ? '▾' : '▸'}</span>
        <span className="method-badge" data-method={entry.method}>
          {entry.method}
        </span>
        <span className="mono console-url">{entry.url}</span>
        <span className="grow" />
        <ResultBadge result={entry.result} />
      </button>

      {open && (
        <div className="console-detail">
          <HeadersTable title="请求头" rows={entry.requestHeaders} />

          {entry.responseHeaders ? (
            <HeadersTable title="响应头" rows={entry.responseHeaders} />
          ) : (
            <div className="muted" data-testid="console-no-response">
              {entry.result === null
                ? '请求还在进行中，响应到达后会补到这里。'
                : '这次没有响应，也就没有响应头与正文。'}
            </div>
          )}

          {entry.body && (
            <div className="console-body-block">
              <div className="console-detail-title">响应正文</div>
              <pre className="console-pre" data-testid="console-body">
                {entry.body.text}
              </pre>
              {entry.body.truncated && (
                <div className="muted">正文只保留了前 8 KiB，其余没有记录。</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function OutputRow({
  entry,
  open,
  onToggle,
}: {
  entry: ConsoleOutputEntry;
  open: boolean;
  onToggle: () => void;
}) {
  // 有一项带结构才值得展开：纯文本展开也只是同一句话
  const expandable = entry.values.some((value) => value.json !== undefined);

  return (
    <div
      className="console-entry"
      data-kind="output"
      data-testid="console-entry"
      data-phase={entry.phase}
      data-level={entry.level}
    >
      <button className="console-line" aria-expanded={open} onClick={onToggle} disabled={!expandable}>
        <span className="console-caret">{expandable ? (open ? '▾' : '▸') : ' '}</span>
        <span className="mono console-output-text" data-testid="console-output-text">
          {entry.values.map((value) => value.text).join(' ')}
        </span>
        {/* 来源（前置 / 后置 · 哪一级脚本 · 级别）排在行尾：先把输出读到，再看它是谁写的 */}
        <span className="mono muted console-tag">
          [{entry.phase === 'prerequest' ? '前置' : '后置'}
          {entry.segment ? ` · ${entry.segment}` : ''} · {entry.level}]
        </span>
      </button>

      {open && expandable && (
        <div className="console-detail" data-testid="console-structure">
          {entry.values.map((value, index) => (
            <JsonValue key={index} value={value} />
          ))}
        </div>
      )}
    </div>
  );
}

function JsonValue({ value }: { value: ConsoleValue }) {
  if (value.json === undefined) {
    return <div className="mono console-json-row">{value.text}</div>;
  }

  return <JsonNode label={null} value={value.json} depth={0} />;
}

function isBranch(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

/** 叶子值的呈现：字符串带引号，`null` 与数字直出——读得出类型差别。 */
function renderLeaf(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function JsonNode({ label, value, depth }: { label: string | null; value: unknown; depth: number }) {
  // 默认只展开一层：整份响应体一进来就全摊开，面板会被一段数据撑满
  const [open, setOpen] = useState(depth < 1);

  if (!isBranch(value)) {
    return (
      <div className="console-json-row" style={{ paddingLeft: depth * 12 }}>
        {label !== null && <span className="console-key">{label}: </span>}
        <span className="mono">{renderLeaf(value)}</span>
      </div>
    );
  }

  const children: [string, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);
  const summary = Array.isArray(value) ? `[${children.length}]` : `{${children.length}}`;

  return (
    <div className="console-json-branch">
      <button
        className="console-json-toggle"
        aria-expanded={open}
        data-testid="console-json-toggle"
        style={{ paddingLeft: depth * 12 }}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="console-caret">{open ? '▾' : '▸'}</span>
        {label !== null && <span className="console-key">{label}: </span>}
        <span className="mono muted">{summary}</span>
      </button>

      {open &&
        children.map(([key, item]) => (
          <JsonNode key={key} label={key} value={item} depth={depth + 1} />
        ))}
    </div>
  );
}

function HeadersTable({ title, rows }: { title: string; rows: [string, string][] }) {
  if (rows.length === 0) {
    return (
      <div className="console-body-block">
        <div className="console-detail-title">{title}</div>
        <div className="muted">（空）</div>
      </div>
    );
  }

  return (
    <div className="console-body-block">
      <div className="console-detail-title">{title}</div>
      <table className="console-headers">
        <tbody>
          {rows.map(([name, value], index) => (
            <tr key={`${name}-${index}`}>
              <td className="console-header-name mono">{name}</td>
              <td className="mono">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResultBadge({ result }: { result: ConsoleResult | null }) {
  if (result === null) {
    return (
      <span className="badge" data-testid="console-status-pending">
        发送中
      </span>
    );
  }

  switch (result.kind) {
    case 'response': {
      const tone = result.status < 400 ? 'ok' : result.status < 500 ? 'warn' : 'danger';
      return (
        <span className="console-result" data-testid="console-status-response">
          <span className={`badge ${tone}`}>
            {result.status} {result.statusText}
          </span>
          <span className="muted mono">{result.elapsedMs} ms</span>
        </span>
      );
    }
    case 'failed':
      return (
        <span className="console-result" data-testid="console-status-failed">
          <span className="badge danger">失败</span>
          <span className="muted mono console-fail-reason">{result.message}</span>
        </span>
      );
    case 'cancelled':
      return (
        <span className="badge" data-testid="console-status-cancelled">
          已取消
        </span>
      );
    case 'not-sent':
      return (
        <span className="console-result" data-testid="console-status-not-sent">
          <span className="badge warn">未发出</span>
          <span className="muted mono console-fail-reason">{result.reason}</span>
        </span>
      );
  }
}
