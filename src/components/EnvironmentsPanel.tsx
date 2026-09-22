import { useRef, useState, type DragEvent } from 'react';
import { describeError } from '../lib/commands';
import { moveEnvironmentId, type DropPosition } from '../lib/environmentMoves';
import { NodeMenu, type MenuItem } from './NodeMenu';
import { OverlayScrollbar } from './OverlayScrollbar';
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
  /**
   * 拖拽落定：给出**完整**的新顺序（当前工作区的全部环境 id，`Globals` 不在其中）。
   * 未产生实际变化（拖回原处）时不会被调用。
   */
  onReorder: (orderedIds: string[]) => void;
}

/**
 * Environments tab（change: rework-app-layout，design D3；环境管理见 change:
 * add-collection-search-and-env-management，design D5/D6/D8；列表观感与搜索见
 * change: rework-request-band-env-and-tables）。
 *
 * 这一栏只有**列表**：点击环境项即激活（与主区选择器共用同一份状态），Globals 是
 * 固定项，选中它等价于「取消环境激活」。变量的编辑在主区（`App` 的
 * environment-editor 分支）——侧栏只有 280px，变量表格挤在这里既看不清也占掉了
 * 列表的位置。
 *
 * 观感上刻意与集合树分道：环境列表短、行要好点，因此行高比树里的请求行大一档；
 * 激活态用行首勾选标记 + 整行浅底表达，不用文字徽标与强调色竖条。
 *
 * 拖拽排序（change: rework-environments-list）：环境是单层列表，拖到某一行 = 落到该行的
 * 位置，落点指示就是那一行整行高亮——没有插入线，也没有「移入」这第二种意图。`Globals`
 * 既不可拖也不作落点；搜索过滤生效时整列禁拖（可见子集不是完整顺序，落点没有意义）。
 * 顺序本身由 `App` 持有（侧栏与主区选择器是同一份状态），这里只负责手势与落点解算。
 */
export function EnvironmentsPanel({
  client,
  workspaceId,
  environments,
  environmentId,
  onActivate,
  onEnvironmentsChanged,
  onDeleted,
  onReorder,
}: EnvironmentsPanelProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  /** 正在就地改名的环境 id 与草稿值。 */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  /** 按名称过滤（纯视图态）：不写后端、不改变激活环境）。 */
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 防抖：回车提交后紧跟的 blur 不该再提一次。 */
  const submitting = useRef(false);
  /** 真正滚动的那个列表；悬浮滚动条只读它的几何，不参与它的布局。 */
  const listRef = useRef<HTMLDivElement>(null);

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? environments.filter((environment) => environment.name.toLowerCase().includes(normalizedQuery))
    : environments;

  // ---- 拖拽排序 ----

  /** 被拖动的环境 id 与当前解析出的落点（视图态，不写入）。 */
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropMark, setDropMark] = useState<{ id: string; position: DropPosition } | null>(null);
  /** 过滤生效时禁用拖拽：可见条目不是完整顺序，落点没有意义。 */
  const draggable = normalizedQuery === '';
  /** 完整顺序（不受过滤影响）；`Globals` 不在这份数据里，因此永远进不了排序。 */
  const environmentIds = environments.map((environment) => environment.id);

  const endDrag = () => {
    setDragId(null);
    setDropMark(null);
  };

  /**
   * 落点解算：真会改变顺序时返回新顺序，没有变化（拖回原处、禁拖）返回 null。
   *
   * 与集合树同一句约定——无变化的位置既不画插入线，也不接受放下，而不是等松手才报错。
   * `Globals` 行压根不调用它，因此它既不是落点、环境也跑不到它上面。
   */
  const resolveDrop = (targetId: string, position: DropPosition): string[] | null => {
    if (!dragId || !draggable) return null;
    const next = moveEnvironmentId(environmentIds, dragId, targetId, position);
    // 原引用即"没有变化"（`moveEnvironmentId` 用同一个数组表示此事）
    return next === environmentIds ? null : next;
  };

  /** 指针落在某行的哪一半：上半区插到它之前，下半区插到它之后（与集合树同款）。 */
  const positionOf = (event: DragEvent<HTMLElement>): DropPosition => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
    return ratio < 0.5 ? 'before' : 'after';
  };

  const rowClass = (id: string, active: boolean) => {
    const mark = dropMark?.id === id ? `drop-${dropMark.position}` : '';
    return ['env-row', active ? 'active' : '', mark, dragId === id ? 'dragging' : '']
      .filter(Boolean)
      .join(' ');
  };

  /** 单行的手势：HTML5 DnD 只允许在 `dragover` 里 `preventDefault` 过的目标上放下。 */
  const dragHandlers = (id: string) => ({
    draggable,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      if (!draggable) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', id);
      setDragId(id);
    },
    onDragEnd: endDrag,
    onDragOver: (event: DragEvent<HTMLElement>) => {
      const position = positionOf(event);
      const next = resolveDrop(id, position);
      if (next) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }
      // 无论有没有落点都刷新插入线：指针停在被拖行或 Globals 上时它要熄掉
      setDropMark(next ? { id, position } : null);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      const next = resolveDrop(id, positionOf(event));
      if (!next) return;
      event.preventDefault();
      endDrag();
      onReorder(next);
    },
  });

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
        <input
          className="env-search"
          type="search"
          aria-label="搜索环境"
          placeholder="搜索环境"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
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

      <div className="env-list" role="listbox" aria-label="环境列表" ref={listRef}>
        {/* Globals 是固定项：不可拖、也不作落点（在它上面放下不产生任何写入） */}
        <div
          className={rowClass('globals', environmentId === null)}
          // 固定项：显式标成不可拖，DOM 上也说得清（走查 / 用例都靠它）
          draggable={false}
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
            <span className="env-check" aria-hidden="true">
              {environmentId === null ? '✓' : ''}
            </span>
            <strong className="env-name">Globals</strong>
          </button>
        </div>

        {filtered.map((environment) => {
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
              className={rowClass(environment.id, environmentId === environment.id)}
              {...dragHandlers(environment.id)}
              onMouseEnter={() => setActiveId(environment.id)}
              onMouseLeave={() => {
                if (menuId !== environment.id) setActiveId(null);
              }}
              // 与集合树同款：右键与「⋯」是同一份菜单、同一个展开状态，
              // 且打开菜单不改变激活的环境（spec: Environments tab 的环境管理）
              onContextMenu={(event) => {
                event.preventDefault();
                setMenuId(environment.id);
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
                  <span className="env-check" aria-hidden="true">
                    {environmentId === environment.id ? '✓' : ''}
                  </span>
                  <span className="env-name">{environment.name}</span>
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

      {/* 滚动条悬浮在内容之上，不占行宽：原生滚动条一出现一消失，整行与行内元素就会横跳
          （与集合树、键值表同款）。内容不溢出时它自己不渲染。 */}
      <OverlayScrollbar targetRef={listRef} />

      {environments.length === 0 && (
        <div className="muted">还没有环境，可用工具栏的「新建环境」创建；Globals 始终可用。</div>
      )}

      {environments.length > 0 && filtered.length === 0 && (
        <div className="muted" data-testid="env-search-empty">
          没有名称匹配的环境。
        </div>
      )}
    </div>
  );
}
