import { useCallback, useEffect, useState } from 'react';
import { describeError } from '../lib/commands';
import { SURFACE_PRIORITY, type EditingRegistry } from '../lib/editing';
import {
  DEFAULT_PRESENTATION,
  readPresentation,
  writePresentation,
  type FormatDetection,
  type ResponsePresentation,
} from '../lib/responsePresentation';
import { INDENT_WIDTHS, type IndentWidth } from '../lib/sandbox';
import { Dropdown } from './Dropdown';
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
  /** 响应呈现配置的当前值（App 持有，改动后立即作用于之后的响应呈现）。 */
  presentation?: ResponsePresentation;
  onPresentationChange?: (value: ResponsePresentation) => void;
}

/** 改动停止后自动落库的延迟（spec: 脚本的编辑与保存对设置面同样适用）。 */
const SETTINGS_AUTOSAVE_DELAY_MS = 500;

/**
 * 应用设置。目前只有一项：`pm.sendRequest` 的目标策略。
 *
 * 这一项之所以要有界面，是因为它是**安全相关**的设置：默认与 Postman 一致、不限制
 * 目标地址，用户必须能主动收紧，也必须能看出当前是松是紧。
 *
 * 这里**没有保存按钮**：改动停止后自动落库，落库成功后基线前移，脏判据自然为假。
 */
export function SettingsPanel({
  client,
  editing,
  presentation = DEFAULT_PRESENTATION,
  onPresentationChange,
}: SettingsPanelProps) {
  const [mode, setMode] = useState<'allow' | 'deny'>('allow');
  const [hosts, setHosts] = useState('');
  /** null = 未配置（不限制）；字符串 = 已配置的原始值。 */
  const [raw, setRaw] = useState<string | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 响应呈现配置（spec: ui-layout「设置模态的响应呈现配置」）。 */
  const [formatDetection, setFormatDetection] = useState<FormatDetection>(
    presentation.formatDetection,
  );
  const [indentWidth, setIndentWidth] = useState<IndentWidth>(presentation.indentWidth);
  /** 读回来的基线：未保存守卫据此判断草稿有没有偏离已配置的值。 */
  const [baseline, setBaseline] = useState({
    mode: 'allow' as 'allow' | 'deny',
    hosts: '',
    formatDetection: presentation.formatDetection as FormatDetection,
    indentWidth: presentation.indentWidth as IndentWidth,
  });

  const load = useCallback(async () => {
    try {
      const [value, storedPresentation] = await Promise.all([
        readSendRequestPolicyRaw(client),
        readPresentation(client),
      ]);

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
      setFormatDetection(storedPresentation.formatDetection);
      setIndentWidth(storedPresentation.indentWidth);
      setBaseline({
        mode: nextMode,
        hosts: nextHosts,
        formatDetection: storedPresentation.formatDetection,
        indentWidth: storedPresentation.indentWidth,
      });
      // 读回来的值即应用当前生效的值，同步给 App
      onPresentationChange?.(storedPresentation);
      setError(null);
    } catch (caught) {
      setError(describeError(caught).message);
    }
    // onPresentationChange 只在 App 内定义一次；纳入依赖不会造成额外读取
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      const nextPresentation = { formatDetection, indentWidth };
      await writePresentation(client, nextPresentation);
      // 改动立即作用于之后的响应呈现，不需要重启（spec: ui-layout 配置生效）
      onPresentationChange?.(nextPresentation);
      await load();
      return true;
    } catch (caught) {
      setError(describeError(caught).message);
      return false;
    }
  };

  const dirty = () =>
    mode !== baseline.mode ||
    hosts !== baseline.hosts ||
    formatDetection !== baseline.formatDetection ||
    indentWidth !== baseline.indentWidth;

  // 编辑即自动保存（spec: 脚本的编辑与保存）：改动停止后落库。
  // 失败时基线不前移，因此这里会随下一次键入再次排期；退出/关模态时守卫也会拦。
  useEffect(() => {
    if (!dirty()) return;
    const timer = window.setTimeout(() => {
      void save();
    }, SETTINGS_AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
    // save 每次渲染都是新函数，进依赖会让定时器永远重排；脏判据已由上面的 state 表达
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, hosts, formatDetection, indentWidth, baseline]);

  useEditingSurface(editing, {
    id: 'settings-policy',
    priority: SURFACE_PRIORITY.modal,
    label: '脚本目标策略',
    isDirty: dirty,
    save,
  });

  const reset = async () => {
    await writeSendRequestPolicy(client, null);
    setHosts('');
    await load();
  };

  return (
    <div className="stack" data-testid="settings-panel">
      <section className="settings-section">
        <h4>脚本目标策略</h4>

        <div className="settings-row">
          <span className="settings-name">状态</span>
          <span className="muted settings-control" data-testid="policy-state">
            {raw ? (unreadable ? '已配置（无法解析）' : '已配置') : '未配置'}
          </span>
        </div>

        <div className="settings-row">
          <span className="settings-name">策略模式</span>
          <Dropdown
            label="策略模式"
            testId="policy-mode"
            value={mode}
            options={[
              { value: 'allow', label: '只允许名单内' },
              { value: 'deny', label: '只拒绝名单内' },
            ]}
            onChange={(value) => setMode(value === 'deny' ? 'deny' : 'allow')}
          />
        </div>

        <div className="settings-row stacked">
          <label className="settings-name" htmlFor="policy-hosts">
            主机名单
          </label>
          <textarea
            id="policy-hosts"
            aria-label="主机名单"
            placeholder="api.test"
            rows={4}
            value={hosts}
            onChange={(event) => setHosts(event.target.value)}
          />
        </div>

        <div className="settings-row actions">
          <button
            className="ghost"
            onClick={() => {
              void reset();
            }}
          >
            恢复为不限制
          </button>
        </div>
      </section>

      {/* 响应呈现配置（spec: ui-layout「设置模态的响应呈现配置」）：应用级偏好，
          改动后立即作用于之后的响应呈现。 */}
      <section className="settings-section">
        <h4>响应呈现</h4>

        <div className="settings-row">
          <span className="settings-name">响应格式检测</span>
          <Dropdown
            label="响应格式检测"
            testId="format-detection"
            value={formatDetection}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'json', label: 'JSON' },
            ]}
            onChange={(value) => setFormatDetection(value === 'json' ? 'json' : 'auto')}
          />
        </div>

        <div className="settings-row">
          <span className="settings-name">格式化缩进宽度</span>
          <Dropdown
            label="格式化缩进宽度"
            testId="indent-width"
            value={String(indentWidth)}
            options={INDENT_WIDTHS.map((width) => ({
              value: String(width),
              label: `${width} 空格`,
            }))}
            onChange={(value) => {
              const width = INDENT_WIDTHS.find((candidate) => String(candidate) === value);
              if (width) setIndentWidth(width);
            }}
          />
        </div>
      </section>

      {error && (
        <div className="notice danger" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
