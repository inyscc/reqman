import { useRef, useState } from 'react';
import { describeError } from '../lib/commands';
import { NodeMenu, type MenuItem } from './NodeMenu';
import type { Commands } from '../lib/commands';
import type { Environment } from '../lib/types';

export interface EnvironmentsPanelProps {
  client: Commands;
  workspaceId: string;
  environments: Environment[];
  /** 当前激活环境；null 表示 Globals。 */
  environmentId: string | null;
  onActivate: (id: string | null) => void;
  /** 环境列表变化后的刷新（新建 / 重命名）。 */
  onEnvironmentsChanged: () => void;
  /** 删除成功后的收尾：`App` 负责刷新列表，并在删的是激活环境时回落 Globals。 */
  onDeleted: (id: string) => void;
}

/**
 * Environments tab（change: rework-app-layout，design D3；环境管理见 change:
 * add-collection-search-and-env-management，design D5/D6/D8）。
 *
 * 这一栏只有**列表**：点击环境项即激活（与主区选择器共用同一份状态），Globals 是
 * 固定项，选中它等价于「取消环境激活」。变量的编辑在主区（`App` 的
 * environment-editor 分支）——侧栏只有 280px，变量表格挤在这里既看不清也占掉了
 * 列表的位置。
 *
 * 工具栏与 Collections tab 同款式：图标按钮，文字只留在 `aria-label` / `title`，
 * 顶部不再重复 tab 名（tab 已经叫 Environments）。
 */
export function EnvironmentsPanel({
  client,
  workspaceId,
  environments,
  environmentId,
  onActivate,
  onEnvironmentsChanged,
  onDeleted,
}: EnvironmentsPanelProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  /** 正在就地改名的环境 id 与草稿值。 */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 防抖：回车提交后紧跟的 blur 不该再提一次。 */
  const submitting = useRef(false);

  const create = async () => {
    setError(null);
    setBusy(true);
    try {
      const created = await client.environmentCreate(workspaceId, '新环境');
      // 新环境立刻进入可编辑状态，用户不必再点一次「重命名」
      setRenamingId(created.id);
      setNameDraft(created.name);
      onEnvironmentsChanged();
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(false);
    }
  };

  const submitRename = async (environment: Environment) => {
    if (submitting.current) return;
    const name = nameDraft.trim();

    if (name === '') {
      // 与集合/文件夹改名同一语义：拒绝并把输入框还原成原名称
      setError('环境名称不能为空');
      setNameDraft(environment.name);
      return;
    }

    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await client.environmentRename(environment.id, name);
      setRenamingId(null);
      onEnvironmentsChanged();
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const remove = async (environment: Environment) => {
    setBusy(true);
    setError(null);
    try {
      await client.environmentDelete(environment.id);
      setConfirmId(null);
      onDeleted(environment.id);
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="env-panel" data-testid="environments-panel">
      <div className="env-toolbar">
        <span className="grow" />
        <button
          className="icon-button"
          aria-label="新建环境"
          title="新建环境"
          disabled={busy}
          onClick={() => void create()}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M7 2h2v5h5v2H9v5H7V9H2V7h5z" fill="currentColor" />
          </svg>
        </button>
      </div>

      {error && (
        <div className="notice danger" role="alert" data-testid="env-error">
          {error}
        </div>
      )}

      <div className="env-list" role="listbox" aria-label="环境列表">
        <div
          className="env-row"
          onMouseEnter={() => setActiveId('globals')}
          onMouseLeave={() => {
            if (menuId !== 'globals') setActiveId(null);
          }}
        >
          <button
            className={`env-item ${environmentId === null ? 'active' : ''}`}
            role="option"
            aria-selected={environmentId === null}
            onClick={() => onActivate(null)}
          >
            <strong className="env-name">Globals</strong>
            <span className="muted">全局变量</span>
          </button>
        </div>

        {environments.map((environment) => {
          const revealed = activeId === environment.id || menuId === environment.id;
          const menu: MenuItem[] = [
            {
              label: '重命名',
              onSelect: () => {
                setRenamingId(environment.id);
                setNameDraft(environment.name);
              },
            },
            {
              label: '删除',
              danger: true,
              onSelect: () => setConfirmId(environment.id),
            },
          ];

          return (
            <div
              key={environment.id}
              className="env-row"
              onMouseEnter={() => setActiveId(environment.id)}
              onMouseLeave={() => {
                if (menuId !== environment.id) setActiveId(null);
              }}
            >
              {renamingId === environment.id ? (
                <div className="env-item editing">
                  <input
                    className="env-name-input"
                    aria-label="环境名称"
                    value={nameDraft}
                    autoFocus
                    disabled={busy}
                    onChange={(event) => setNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void submitRename(environment);
                    }}
                    onBlur={() => void submitRename(environment)}
                  />
                </div>
              ) : (
                <button
                  className={`env-item ${environmentId === environment.id ? 'active' : ''}`}
                  role="option"
                  aria-selected={environmentId === environment.id}
                  onFocus={() => setActiveId(environment.id)}
                  onBlur={() => {
                    if (menuId !== environment.id) setActiveId(null);
                  }}
                  onClick={() => onActivate(environment.id)}
                >
                  <span className="env-name">{environment.name}</span>
                  {environmentId === environment.id && <span className="badge ok">使用中</span>}
                </button>
              )}

              {revealed && renamingId !== environment.id && (
                <button
                  className="node-more"
                  aria-label="更多操作"
                  title="更多操作"
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenuId(menuId === environment.id ? null : environment.id);
                  }}
                >
                  ⋯
                </button>
              )}

              {menuId === environment.id && (
                <NodeMenu items={menu} onClose={() => setMenuId(null)} />
              )}

              {confirmId === environment.id && (
                <div className="node-confirm" role="alert" data-testid="environment-delete-confirm">
                  <span>删除环境「{environment.name}」会把它的变量一并删除。</span>
                  <div className="row">
                    <button onClick={() => void remove(environment)} disabled={busy}>
                      删除
                    </button>
                    <button className="ghost" onClick={() => setConfirmId(null)}>
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {environments.length === 0 && (
        <div className="muted">还没有环境，可用工具栏的「新建环境」创建；Globals 始终可用。</div>
      )}
    </div>
  );
}
