import { useCallback, useEffect, useState } from 'react';
import { describeError } from '../lib/commands';
import { SURFACE_PRIORITY, type EditingRegistry } from '../lib/editing';
import {
  readSendRequestPolicyRaw,
  writeSendRequestPolicy,
  type SendRequestPolicy,
} from '../lib/scriptRuntime';
import { useEditingSurface } from '../lib/useEditing';

export interface SettingsPanelProps {
  client: Parameters<typeof readSendRequestPolicyRaw>[0];
  /** 编辑面注册表：Ctrl+S 与未保存守卫据此找到这一面。 */
  editing?: EditingRegistry;
}

/**
 * 应用设置。目前只有一项：`pm.sendRequest` 的目标策略。
 *
 * 这一项之所以要有界面，是因为它是**安全相关**的设置：默认与 Postman 一致、不限制
 * 目标地址，用户必须能主动收紧，也必须能看出当前是松是紧。
 */
export function SettingsPanel({ client, editing }: SettingsPanelProps) {
  const [mode, setMode] = useState<'allow' | 'deny'>('allow');
  const [hosts, setHosts] = useState('');
  /** null = 未配置（不限制）；字符串 = 已配置的原始值。 */
  const [raw, setRaw] = useState<string | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 读回来的基线：未保存守卫据此判断草稿有没有偏离已配置的值。 */
  const [baseline, setBaseline] = useState({ mode: 'allow' as 'allow' | 'deny', hosts: '' });

  const load = useCallback(async () => {
    try {
      const value = await readSendRequestPolicyRaw(client);

      setRaw(value);
      setUnreadable(false);

      let nextMode: 'allow' | 'deny' = 'allow';
      let nextHosts = '';

      if (value) {
        try {
          const parsed = JSON.parse(value) as SendRequestPolicy;

          nextMode = parsed?.mode === 'deny' ? 'deny' : 'allow';
          nextHosts = (parsed?.hosts ?? []).join('\n');
        } catch {
          // 存进去的东西读不懂：保持输入框为空，并明确告诉用户，而不是假装没配置
          setUnreadable(true);
        }
      }

      setMode(nextMode);
      setHosts(nextHosts);
      setBaseline({ mode: nextMode, hosts: nextHosts });
      setError(null);
    } catch (caught) {
      setError(describeError(caught).message);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<boolean> => {
    const list = hosts
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);

    setError(null);
    try {
      await writeSendRequestPolicy(client, { mode, hosts: list });
      setStatus(
        list.length === 0
          ? '已保存：名单为空，当前拒绝全部目标'
          : `已保存：${mode === 'allow' ? '只允许' : '只拒绝'} ${list.length} 个主机`,
      );
      await load();
      return true;
    } catch (caught) {
      setError(describeError(caught).message);
      return false;
    }
  };

  useEditingSurface(editing, {
    id: 'settings-policy',
    priority: SURFACE_PRIORITY.modal,
    label: '脚本目标策略',
    isDirty: () => mode !== baseline.mode || hosts !== baseline.hosts,
    save,
  });

  const reset = async () => {
    await writeSendRequestPolicy(client, null);
    setHosts('');
    setStatus('已恢复为不限制目标（与 Postman 一致）');
    await load();
  };

  return (
    <div className="stack" data-testid="settings-panel">
      <strong>脚本目标策略</strong>
      <p className="muted">
        <code>pm.sendRequest</code> 默认不限制目标地址（与 Postman 一致）。一旦配置，脚本就只能
        访问名单内的主机（或反过来，被名单挡住）。子域一并匹配。
      </p>

      <div className="row">
        <span data-testid="policy-state">
          {raw ? (unreadable ? '已配置（无法解析，当前拒绝全部）' : '已配置') : '未配置 · 不限制目标'}
        </span>
      </div>

      <div className="row">
        <select
          aria-label="策略模式"
          value={mode}
          onChange={(event) => setMode(event.target.value === 'deny' ? 'deny' : 'allow')}
        >
          <option value="allow">只允许名单内</option>
          <option value="deny">只拒绝名单内</option>
        </select>
      </div>

      <label htmlFor="policy-hosts">主机名单（每行一个，例如 api.test）</label>
      <textarea
        id="policy-hosts"
        aria-label="主机名单"
        rows={4}
        value={hosts}
        onChange={(event) => setHosts(event.target.value)}
      />

      <div className="row">
        <button
          onClick={() => {
            void save();
          }}
        >
          保存策略
        </button>
        <button
          className="ghost"
          onClick={() => {
            void reset();
          }}
        >
          恢复为不限制
        </button>
      </div>

      {status && (
        <div className="notice info" role="status" data-testid="settings-status">
          {status}
        </div>
      )}
      {error && (
        <div className="notice danger" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
