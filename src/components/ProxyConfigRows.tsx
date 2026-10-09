import { useEffect, useState } from 'react';
import { Dropdown } from './Dropdown';
import type { ProxyConfig, ProxyMode } from '../lib/types';

export interface ProxyConfigRowsProps {
  /** `null` = 未配置（顺位到更低层级）。 */
  proxy: ProxyConfig | null;
  onChange: (next: ProxyConfig | null) => void;
  /**
   * 是否提供「未配置」这一档。全局层是最低层级，没有可顺位的目标，因此不提供。
   */
  allowInherit: boolean;
  /** 同一屏可能出现两处代理设置，控件名与测试 id 需要能区分（如 `request` / `global`）。 */
  idPrefix: string;
  /** 模式行的名称，如「请求级代理」「代理」。 */
  name: string;
}

const MODE_LABELS: Record<ProxyMode, string> = {
  inherit: '跟随上一层',
  none: '不使用代理',
  system: '跟随系统',
  manual: '手工填写',
  pac: 'PAC 文件',
};

/**
 * 「未配置」与「不使用代理」是两件事：前者顺位到更低层级，后者要求直连并**停在该层**
 * （spec: http-engine「三级代理」）。界面上它们必须是可区分的两个选项，否则用户无法让
 * 某个请求绕过全局代理。
 */
const INHERIT_LABEL = '未配置';

/** 凭据状态：不可读取要说出来，不能显示成「未设置」（spec: 设置模态的代理配置）。 */
export function passwordStateOf(proxy: ProxyConfig | null): string {
  if (!proxy?.has_password) return '未设置';
  return proxy.password_readable === false ? '已设置（不可读取）' : '已设置';
}

/**
 * 提示收进控件自身的 placeholder——界面上不写解释后果的句子
 * （spec: ui-layout「语义落在操作上」）。
 */
function passwordPlaceholder(proxy: ProxyConfig | null): string {
  if (!proxy?.has_password) return '留空表示不设置';
  return proxy.password_readable === false
    ? '已设置但当前不可读取 · 留空不改写'
    : '已设置 · 留空不改写';
}

/**
 * 代理设置的行式列表：模式一行；手工填写时再出现地址、凭据与白名单，PAC 文件时只出现
 * 一个 PAC 地址。
 *
 * PAC 档**刻意不出现**凭据与白名单：凭据是"连代理时用什么身份"，而 PAC 档还没决定代理
 * 是谁；白名单是"哪些不走代理"，而 PAC 档该不该走代理由那段脚本自己说了算。摆出来只会
 * 让人以为它们生效（spec: 设置模态的代理配置）。
 *
 * 三个层级共用它——同一个交互在同一应用里只该有一种形态，而它们本来就是同一件事。
 */
export function ProxyConfigRows({
  proxy,
  onChange,
  allowInherit,
  idPrefix,
  name,
}: ProxyConfigRowsProps) {
  /** 密码输入框是本地草稿：它是**提交**语义，不是已保存的值。 */
  const [draft, setDraft] = useState('');

  // 凭据落库之后（父级重新读回，代理对象里不再有 `password`）把草稿清空：
  // 否则输入框会继续显示一个已经保存过的值，看起来像还没提交。
  const passwordDraft = proxy?.password;
  useEffect(() => {
    if (passwordDraft === undefined) setDraft('');
  }, [passwordDraft]);

  const modes: ProxyMode[] = allowInherit
    ? ['inherit', 'none', 'system', 'manual', 'pac']
    : ['none', 'system', 'manual', 'pac'];

  const patch = (next: Partial<ProxyConfig>) => {
    onChange({
      // 兜底是"保持当前档"，不是写死手工填写——否则在 PAC 档编辑地址会把它改回手工
      mode: proxy?.mode ?? 'manual',
      url: null,
      pac_url: null,
      username: null,
      no_proxy: [],
      ...proxy,
      ...next,
    });
  };

  const mode = proxy?.mode ?? (allowInherit ? 'inherit' : 'none');
  const isPac = mode === 'pac';

  const changeMode = (next: ProxyMode) => {
    // 「未配置」在存储里就是 `null`：顺位的含义由缺失表达，不需要一个占位配置
    if (next === 'inherit') {
      onChange(null);
      return;
    }

    setDraft('');
    onChange({
      mode: next,
      url: proxy?.url ?? null,
      pac_url: proxy?.pac_url ?? null,
      username: proxy?.username ?? null,
      has_password: proxy?.has_password,
      password_readable: proxy?.password_readable,
      no_proxy: proxy?.no_proxy ?? [],
    });
  };

  return (
    <>
      <div className="settings-row">
        <span className="settings-name">{name}</span>
        <Dropdown<ProxyMode>
          label={`${name}模式`}
          testId={`${idPrefix}-proxy-mode`}
          value={mode}
          options={modes.map((value) => ({
            value,
            label: value === 'inherit' ? INHERIT_LABEL : MODE_LABELS[value],
          }))}
          onChange={changeMode}
        />
      </div>

      {(mode === 'manual' || isPac) && (
        <div className="settings-row stacked">
          <label className="settings-name" htmlFor={`${idPrefix}-proxy-url`}>
            {isPac ? 'PAC 地址' : '代理地址'}
          </label>
          <input
            id={`${idPrefix}-proxy-url`}
            aria-label={isPac ? `${name}PAC 地址` : `${name}地址`}
            placeholder={
              isPac ? 'http://internal.example/proxy.pac' : 'http://127.0.0.1:8080'
            }
            value={(isPac ? proxy?.pac_url : proxy?.url) ?? ''}
            onChange={(event) =>
              patch(isPac ? { pac_url: event.target.value } : { url: event.target.value })
            }
          />
        </div>
      )}

      {mode === 'manual' && (
        <>
          <div className="settings-row">
            <label className="settings-name" htmlFor={`${idPrefix}-proxy-username`}>
              认证用户名
            </label>
            <input
              id={`${idPrefix}-proxy-username`}
              aria-label={`${name}认证用户名`}
              value={proxy?.username ?? ''}
              onChange={(event) => patch({ username: event.target.value })}
            />
          </div>

          {/* 密码三态（见 `ProxyConfig.password`）：留空不改写、填了就是新值、清除是独立动作 */}
          <div className="settings-row stacked">
            <label className="settings-name" htmlFor={`${idPrefix}-proxy-password`}>
              认证密码
            </label>
            <input
              id={`${idPrefix}-proxy-password`}
              aria-label={`${name}认证密码`}
              type="password"
              placeholder={passwordPlaceholder(proxy)}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                patch({ password: event.target.value === '' ? undefined : event.target.value });
              }}
            />
          </div>

          <div className="settings-row">
            <span className="settings-name">凭据状态</span>
            <div className="settings-control">
              <span className="muted" data-testid={`${idPrefix}-password-state`}>
                {passwordStateOf(proxy)}
              </span>
              {proxy?.has_password && (
                <button
                  type="button"
                  className="ghost"
                  data-testid={`${idPrefix}-password-clear`}
                  onClick={() => {
                    setDraft('');
                    patch({ password: '' });
                  }}
                >
                  清除
                </button>
              )}
            </div>
          </div>

          <div className="settings-row stacked">
            <label className="settings-name" htmlFor={`${idPrefix}-proxy-no-proxy`}>
              不走代理的主机
            </label>
            <input
              id={`${idPrefix}-proxy-no-proxy`}
              aria-label={`${name}不走代理的主机`}
              placeholder="localhost, *.internal"
              value={(proxy?.no_proxy ?? []).join(',')}
              onChange={(event) =>
                patch({
                  no_proxy: event.target.value
                    .split(',')
                    .map((entry) => entry.trim())
                    .filter((entry) => entry.length > 0),
                })
              }
            />
          </div>
        </>
      )}
    </>
  );
}
