import { useCallback, useEffect, useMemo, useState } from 'react';
import { describeError, type Commands } from '../lib/commands';
import type { CookieView } from '../lib/types';

export interface CookiePanelProps {
  client: Commands;
}

/** 新增表单的有效期选项（Unix 秒在提交时换算）。 */
type ExpiryChoice = 'session' | '30d' | '1y';

const EXPIRY_SECONDS: Record<Exclude<ExpiryChoice, 'session'>, number> = {
  '30d': 30 * 24 * 3600,
  '1y': 365 * 24 * 3600,
};

/**
 * Cookie 手动管理（spec: Cookie 的手动管理 / Cookie 的作用域）。
 *
 * Cookie **按域在应用范围内共享**：它承载的是目标服务的会话状态，与「用哪套集合」
 * 无关。这一点必须在界面上明说（8.7），否则「切换工作区 Cookie 还在」会被当成
 * 数据串了。取值在这里明文呈现——它会随每个请求发送，不是 secret；但落库仍是密文。
 */
export function CookiePanel({ client }: CookiePanelProps) {
  const [entries, setEntries] = useState<CookieView[]>([]);
  const [domain, setDomain] = useState('');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [path, setPath] = useState('/');
  const [expiry, setExpiry] = useState<ExpiryChoice>('30d');
  const [secure, setSecure] = useState(false);
  const [httpOnly, setHttpOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries(await client.cookieList());
      setError(null);
    } catch (caught) {
      setError(describeError(caught).message);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => {
    const byDomain = new Map<string, CookieView[]>();
    for (const entry of entries) {
      const list = byDomain.get(entry.domain) ?? [];
      list.push(entry);
      byDomain.set(entry.domain, list);
    }
    return [...byDomain.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [entries]);

  const add = async () => {
    try {
      await client.cookiePut({
        domain: domain.trim(),
        name: name.trim(),
        value,
        path: path.trim() || '/',
        host_only: false,
        secure,
        http_only: httpOnly,
        expires_at:
          expiry === 'session' ? null : Math.floor(Date.now() / 1000) + EXPIRY_SECONDS[expiry],
      });
      setDomain('');
      setName('');
      setValue('');
      await load();
    } catch (caught) {
      setError(describeError(caught).message);
    }
  };

  const remove = async (id: string) => {
    try {
      await client.cookieDelete(id);
      await load();
    } catch (caught) {
      setError(describeError(caught).message);
    }
  };

  return (
    <div className="stack" data-testid="cookie-panel">
      <strong>Cookie</strong>
      <p className="muted" data-testid="cookie-scope-note">
        Cookie 按域在<b>整个应用</b>范围内共享：同一站点的会话状态在工作区与集合之间保持一致，
        切换工作区<b>不会</b>清空 Cookie。带有效期的 Cookie 加密后保存在本地，重启后仍然有效；
        会话 Cookie 只在本次运行内有效。
      </p>

      {grouped.length === 0 && <p className="muted">当前没有 Cookie。</p>}

      {grouped.map(([entryDomain, list]) => (
        <div key={entryDomain} data-testid="cookie-domain-group">
          <strong className="mono">{entryDomain}</strong>
          <div className="stack">
            {list.map((entry) => (
              <div className="row" key={entry.id} data-testid="cookie-entry">
                <span className="mono">
                  {entry.name}={entry.value}
                </span>
                <span className="muted">
                  {entry.path}
                  {entry.secure && ' · Secure'}
                  {entry.http_only && ' · HttpOnly'}
                  {entry.expires_at === null && ' · 会话'}
                </span>
                <button
                  className="ghost"
                  onClick={() => {
                    void remove(entry.id);
                  }}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}

      <strong>新增 Cookie</strong>
      <div className="row">
        <input
          aria-label="Cookie 域"
          placeholder="api.test"
          value={domain}
          onChange={(event) => setDomain(event.target.value)}
        />
        <input
          aria-label="Cookie 名称"
          placeholder="名称"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <input
          aria-label="Cookie 取值"
          placeholder="取值"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
      <div className="row">
        <input
          aria-label="Cookie 路径"
          placeholder="/"
          value={path}
          onChange={(event) => setPath(event.target.value)}
        />
        <select
          aria-label="Cookie 有效期"
          value={expiry}
          onChange={(event) => setExpiry(event.target.value as ExpiryChoice)}
        >
          <option value="session">会话（本次运行）</option>
          <option value="30d">30 天</option>
          <option value="1y">一年</option>
        </select>
        <label>
          <input
            type="checkbox"
            aria-label="仅安全连接"
            checked={secure}
            onChange={(event) => setSecure(event.target.checked)}
          />{' '}
          仅安全连接
        </label>
        <label>
          <input
            type="checkbox"
            aria-label="仅协议访问"
            checked={httpOnly}
            onChange={(event) => setHttpOnly(event.target.checked)}
          />{' '}
          仅协议访问
        </label>
        <button
          onClick={() => {
            void add();
          }}
        >
          新增
        </button>
      </div>

      {error && (
        <div className="notice danger" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
