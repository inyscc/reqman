import {
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type DragEvent,
  type FocusEvent,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from 'react';
import { describeError } from '../lib/commands';
import type { Commands, VariablePatch } from '../lib/commands';
import type { Scope, Variable } from '../lib/types';
import { isShadowed } from '../lib/variables';
import { EyeIcon, LockIcon, PencilIcon, TrashIcon } from './icons';

export interface VariablesPanelProps {
  client: Commands;
  /** 作用域：环境、全局或集合。 */
  scope: Extract<Scope, 'environment' | 'global' | 'collection'>;
  /** 归属：环境 id、工作区 id 或集合 id。 */
  ownerId: string;
  variables: Variable[];
  onChanged: () => void;
  /** 嵌入 Environments tab 时由外层承担上下文，隐藏自带的标题行。 */
  hideHeader?: boolean;
}

function plaintext(variable: Variable): string {
  // 后端返回异常（或行还在半途）时 current 可能缺席：掩码边界上宁可显示为空，
  // 也不能让整个表格崩掉
  return variable?.current?.state === 'value' ? variable.current.value : '';
}

/** 按本地顺序排列，未出现在顺序里的条目按原顺序接在后面。 */
function applyOrder(variables: Variable[], order: string[] | null): Variable[] {
  if (!order) return variables;
  const byId = new Map(variables.map((variable) => [variable.id, variable]));
  const out: Variable[] = [];
  for (const id of order) {
    const variable = byId.get(id);
    if (variable) {
      out.push(variable);
      byId.delete(id);
    }
  }
  for (const variable of variables) {
    if (byId.has(variable.id)) out.push(variable);
  }
  return out;
}

/** 把 `dragged` 移到 `target` 的位置（同一条则不动）。 */
function moveId(ids: string[], dragged: string, target: string): string[] {
  if (dragged === target) return ids;
  const from = ids.indexOf(dragged);
  const to = ids.indexOf(target);
  if (from < 0 || to < 0) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, dragged);
  return next;
}

/**
 * 变量面板：环境变量、全局变量与集合变量共用（spec: 变量表格的就地编辑 /
 * 变量表格的重复键与拖拽排序）。
 *
 * 几条贯穿全文的纪律：
 * - 提交一律**按变量自身的 id** 进行，名称因此可以就地改，且改成已存在的名称会被接受
 *   （同名共存；被遮蔽的那条由底部标记指出）。
 * - secret 取值默认以掩码呈现，明文只能经「揭示」按钮显式取得——不能把掩码文本当值改掉，
 *   也不能替用户把明文填进去。
 * - 表末尾的幽灵行是**新增**入口：填入一个已存在的名称会新增一条同名条目，而不是覆盖
 *   既有条目，因此它走 `variable_create` 而不是按名 upsert。
 * - 行拖拽即时重排（乐观），落库失败则回滚到拖动前的顺序。
 */
export function VariablesPanel({
  client,
  scope,
  ownerId,
  variables,
  onChanged,
  hideHeader = false,
}: VariablesPanelProps) {
  /** 幽灵行（新增变量）：纯本地状态，回车或失焦提交后才进后端。 */
  const [ghost, setGhost] = useState({ name: '', value: '', secret: false });
  const ghostNameRef = useRef<HTMLInputElement>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  /** 每行的编辑草稿：只有真正编辑过才存在。 */
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const [valueDrafts, setValueDrafts] = useState<Record<string, string>>({});
  const [descriptionDrafts, setDescriptionDrafts] = useState<Record<string, string>>({});
  /** 处于编辑态的描述列；默认只显示已有描述。 */
  const [editingDescriptions, setEditingDescriptions] = useState<Record<string, boolean>>({});
  /** 处于编辑态的未揭示 secret；默认仍是掩码。 */
  const [editingSecrets, setEditingSecrets] = useState<Record<string, boolean>>({});
  /** 拖拽后的本地顺序（乐观）：`null` 表示跟随传入的变量列表。 */
  const [order, setOrder] = useState<string[] | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** key 列宽（表头分隔线拖出来）；`null` 表示用默认比例。 */
  const [keyWidth, setKeyWidth] = useState<number | null>(null);

  const rows = applyOrder(variables, order);

  /** 该行界面上呈现的值（已揭示的用明文，否则用列表里的值）。 */
  const shownValue = (variable: Variable) => revealed[variable.id] ?? plaintext(variable);

  /** 未揭示的 secret：界面呈现掩码、编辑时不预填。 */
  const masked = (variable: Variable) =>
    variable.is_secret && revealed[variable.id] === undefined;

  const clearDraft = (
    setter: Dispatch<SetStateAction<Record<string, string>>>,
    id: string,
  ) =>
    setter((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });

  const clearFlag = (setter: Dispatch<SetStateAction<Record<string, boolean>>>, id: string) =>
    setter((current) => (current[id] ? { ...current, [id]: false } : current));

  const forgetReveal = (id: string) =>
    setRevealed((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });

  /** 丢弃一行的全部草稿与编辑态（提交成功、失败回滚、取消都用它）。 */
  const discardDrafts = (id: string) => {
    clearDraft(setNameDrafts, id);
    clearDraft(setValueDrafts, id);
    clearDraft(setDescriptionDrafts, id);
    clearFlag(setEditingDescriptions, id);
    clearFlag(setEditingSecrets, id);
  };

  /**
   * 按 id 写回一个变量；失败即回滚（草稿丢掉，输入框回落到 props 里的原值）。
   */
  const write = async (variable: Variable, patch: VariablePatch) => {
    setError(null);
    try {
      await client.variableUpdate(variable.id, patch);
      discardDrafts(variable.id);
      // 改完之后重新盖回掩码：明文要看再点「揭示」
      if (patch.value !== undefined) forgetReveal(variable.id);
      onChanged();
    } catch (caught) {
      discardDrafts(variable.id);
      setError(describeError(caught).message);
    }
  };

  const submitName = async (variable: Variable) => {
    const draft = nameDrafts[variable.id];
    if (draft === undefined) return;

    const next = draft.trim();
    if (next === '') {
      // 与集合/文件夹改名同一语义：拒绝并把输入框还原成原名称
      clearDraft(setNameDrafts, variable.id);
      setError('变量名不能为空');
      return;
    }
    if (next === variable.name) {
      clearDraft(setNameDrafts, variable.id);
      return;
    }
    await write(variable, { name: next });
  };

  const submitValue = async (variable: Variable) => {
    const draft = valueDrafts[variable.id];

    if (masked(variable)) {
      // 未揭示的 secret 没有可比对的「原值」，所以用「空即不修改」这条显式规则
      const next = (draft ?? '').trim();
      if (next === '') {
        clearDraft(setValueDrafts, variable.id);
        clearFlag(setEditingSecrets, variable.id);
        return;
      }
      await write(variable, { value: next });
      return;
    }

    if (draft === undefined || draft === shownValue(variable)) {
      clearDraft(setValueDrafts, variable.id);
      return;
    }
    await write(variable, { value: draft });
  };

  const submitDescription = async (variable: Variable) => {
    const draft = descriptionDrafts[variable.id];
    if (draft === undefined) {
      // 点了铅笔又一个字没输就失焦：编辑框必须收起（Postman 的规矩：空描述不占位）
      clearFlag(setEditingDescriptions, variable.id);
      return;
    }
    if (draft === (variable.description ?? '')) {
      clearDraft(setDescriptionDrafts, variable.id);
      clearFlag(setEditingDescriptions, variable.id);
      return;
    }
    await write(variable, { description: draft });
  };

  const cancelEdit = (variable: Variable) => discardDrafts(variable.id);

  const clearGhost = () => setGhost({ name: '', value: '', secret: false });

  /**
   * 幽灵行的提交：名称非空才算「写了东西」。
   *
   * 名称为空时不发任何请求——这既覆盖了「点进空行又原样离开」，也覆盖了
   * 「按了删除/揭示按钮引起的那次失焦」。走新增命令，因此重名会新增一条同名条目。
   */
  const submitGhost = async () => {
    const name = ghost.name.trim();
    if (name === '') {
      if (ghost.value !== '' || ghost.secret) clearGhost();
      return;
    }
    setError(null);
    try {
      await client.variableCreate({
        scope,
        owner_id: ownerId,
        name,
        value: ghost.value,
        is_secret: ghost.secret,
      });
      clearGhost();
      onChanged();
    } catch (caught) {
      setError(describeError(caught).message);
    }
  };

  const leaveGhost = (event: FocusEvent<HTMLInputElement>) => {
    // 在幽灵行内部换控件（名称 → 值 → secret）不算离开
    const row = event.currentTarget.closest('tr');
    if (row?.contains(event.relatedTarget as Node | null)) return;
    void submitGhost();
  };

  const submitGhostWithEnter = () => {
    void submitGhost();
    ghostNameRef.current?.focus();
  };

  const reveal = async (variable: Variable) => {
    setError(null);
    try {
      const revealedVariable = await client.secretReveal(variable.id);
      if (!revealedVariable) {
        setError('无法读取明文：后端没有返回该变量的内容');
        return;
      }
      setRevealed((current) => ({
        ...current,
        [variable.id]: plaintext(revealedVariable),
      }));
    } catch (caught) {
      setError(describeError(caught).message);
    }
  };

  const remove = async (variable: Variable) => {
    await client.variableDelete(variable.id);
    onChanged();
  };

  /** 拖拽落点：把拖动的行移到目标行的位置，先乐观重排再落库，失败回滚。 */
  const dropOn = async (target: Variable) => {
    const dragged = draggingId;
    setDraggingId(null);
    if (!dragged || dragged === target.id) return;

    const ids = rows.map((variable) => variable.id);
    const next = moveId(ids, dragged, target.id);
    if (next.join('|') === ids.join('|')) return;

    const previous = order;
    setOrder(next);
    setError(null);
    try {
      await client.variableReorder(scope, ownerId, next);
      onChanged();
    } catch (caught) {
      setOrder(previous);
      setError(describeError(caught).message);
    }
  };

  const dragOver = (event: DragEvent<HTMLTableRowElement>) => {
    // 只有正在拖动本表格里的行时才接受落点
    if (!draggingId) return;
    event.preventDefault();
  };

  // ---- 表头分隔线：按住横向拖，改 key 列宽（Postman 的表格中线可以拖）----
  //
  // 监听挂在 `window` 上而不是靠指针捕获：分隔线只有 9px 宽、还贴在单元格边缘，
  // 拖动一出手就离开它，靠元素自身的 pointermove 会漏掉绝大部分位移。
  const startColumnResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    // 从事件本身找表格，不依赖 ref：分隔线就在这个表头里，没有第二处可能
    const table = event.currentTarget.closest('table');
    const firstHeader = table?.querySelector<HTMLElement>('thead th');
    if (!firstHeader) return;

    event.preventDefault();
    const startX = event.clientX;
    const startWidth = firstHeader.getBoundingClientRect().width;
    const previousUserSelect = document.body.style.userSelect;

    // 拖动期间别选中文本
    document.body.style.userSelect = 'none';

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      setKeyWidth(Math.min(Math.max(startWidth + (moveEvent.clientX - startX), 220), 720));
    };
    const onUp = () => {
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="stack">
      {!hideHeader && (
        <div className="row">
          <strong>
            {scope === 'environment' ? '环境变量' : scope === 'collection' ? '集合变量' : '全局变量'}
          </strong>
          <span className="grow" />
          <span className="muted">作用域：{scope}</span>
        </div>
      )}

      {error && (
        <div className="notice danger" role="alert" data-testid="variable-error">
          {error}
        </div>
      )}

      <table
        className="variable-table"
        style={keyWidth === null ? undefined : ({ '--key-width': `${keyWidth}px` } as CSSProperties)}
      >
        <thead>
          <tr>
            <th>
              名称
              {/* 表格中线：拖动改 key 列宽（Postman 的表头分隔线就是这个） */}
              <span
                className="col-resize"
                role="separator"
                aria-orientation="vertical"
                aria-label="调整列宽"
                onPointerDown={startColumnResize}
              />
            </th>
            <th>当前值</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((variable) => {
            const unreadable = variable.current.state === 'unreadable';
            const isMasked = masked(variable);
            const editingSecret = editingSecrets[variable.id] === true;
            const editingDescription = editingDescriptions[variable.id] === true;
            // 判据必须跟着**界面上**的顺序（`rows`），而不是传入的列表：拖拽后本地
            // 顺序先变、后端重取后到，中间这段时间标记若按旧顺序算就会标错行。
            const shadowed = isShadowed(variable, rows);

            return (
              <tr
                key={variable.id}
                data-testid={`variable-row-${variable.name}`}
                data-disabled={variable.enabled ? undefined : 'true'}
                draggable
                onDragStart={() => setDraggingId(variable.id)}
                onDragEnd={() => setDraggingId(null)}
                onDragOver={dragOver}
                onDrop={() => void dropOn(variable)}
              >
                <td className="mono var-key">
                  {/* key 那一列：启用勾选紧贴名称（Postman 式），然后是名称与描述，
                      行尾横向摆这一条变量自己的开关与操作 */}
                  <div className="var-key-line">
                    <input
                      className="checkbox"
                      type="checkbox"
                      aria-label={`启用变量 ${variable.name}`}
                      checked={variable.enabled}
                      onChange={(event) =>
                        void write(variable, { enabled: event.target.checked })
                      }
                    />
                    <input
                      className="var-name-input"
                      aria-label={`变量名 ${variable.name}`}
                      value={nameDrafts[variable.id] ?? variable.name}
                      onChange={(event) =>
                        setNameDrafts((current) => ({
                          ...current,
                          [variable.id]: event.target.value,
                        }))
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void submitName(variable);
                        if (event.key === 'Escape') cancelEdit(variable);
                      }}
                      onBlur={() => void submitName(variable)}
                    />
                    {/* 常显的只有被覆盖标记：它是警告，不是操作，不该等 hover */}
                    {shadowed && (
                      <span
                        className="badge warn"
                        title="该变量被下方同名变量覆盖"
                        data-testid={`overwritten-${variable.name}`}
                      >
                        ⚠
                      </span>
                    )}
                    {/* 一排图标按钮：同一种形态、同一个尺寸，靠形状区分语义 */}
                    <span className="var-row-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`描述 ${variable.name}`}
                        title="编辑描述"
                        onClick={() =>
                          setEditingDescriptions((current) => ({
                            ...current,
                            [variable.id]: true,
                          }))
                        }
                      >
                        <PencilIcon aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`标记为 secret ${variable.name}`}
                        aria-pressed={variable.is_secret}
                        title={variable.is_secret ? '取消 secret 标记' : '标记为 secret'}
                        onClick={() =>
                          void write(variable, { is_secret: !variable.is_secret })
                        }
                      >
                        <LockIcon locked={variable.is_secret} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`删除 ${variable.name}`}
                        title="删除"
                        onClick={() => remove(variable)}
                      >
                        <TrashIcon aria-hidden="true" />
                      </button>
                    </span>
                  </div>
                  {/* 描述：编辑态是一个输入框；留空提交后这里什么都不渲染——
                      空描述不占位（Postman 的规矩） */}
                  {editingDescription ? (
                    <input
                      className="var-desc-input"
                      aria-label={`变量描述 ${variable.name}`}
                      placeholder="描述（留空表示不写）"
                      value={descriptionDrafts[variable.id] ?? variable.description ?? ''}
                      autoFocus
                      onChange={(event) =>
                        setDescriptionDrafts((current) => ({
                          ...current,
                          [variable.id]: event.target.value,
                        }))
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void submitDescription(variable);
                        if (event.key === 'Escape') cancelEdit(variable);
                      }}
                      onBlur={() => void submitDescription(variable)}
                    />
                  ) : (
                    variable.description != null &&
                    variable.description !== '' && (
                      <div className="var-desc" data-testid={`variable-desc-${variable.name}`}>
                        {variable.description}
                      </div>
                    )
                  )}
                </td>
                <td className="mono var-value">
                  {unreadable ? (
                    <span
                      className="badge danger"
                      title="密钥不可用，无法读取或修改该值"
                      data-testid={`unreadable-${variable.name}`}
                    >
                      不可读
                    </span>
                  ) : (
                    // 值与它的操作**必须在同一行**：input 是 width:100%，不套 flex 就会
                    // 把按钮挤到下一行，揭示一次整页高度跳一次
                    <div className="var-value-line">
                      {isMasked && !editingSecret ? (
                        <>
                          <span className="var-mask" data-testid={`masked-${variable.name}`}>
                            {plaintext(variable)}
                          </span>
                          {/* 先铅笔后眼睛：眼睛永远贴着列的右端，揭示前后同一个位置 */}
                          <button
                            type="button"
                            className="icon-btn"
                            aria-label={`修改 ${variable.name}`}
                            title="不显示明文直接改值"
                            onClick={() =>
                              setEditingSecrets((current) => ({ ...current, [variable.id]: true }))
                            }
                          >
                            <PencilIcon aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="icon-btn"
                            aria-label={`揭示 ${variable.name}`}
                            title="显示明文"
                            onClick={() => void reveal(variable)}
                          >
                            <EyeIcon aria-hidden="true" />
                          </button>
                        </>
                      ) : (
                        <>
                          <input
                            className="var-value-input"
                            aria-label={`变量值 ${variable.name}`}
                            data-testid={
                              isMasked ? `masked-${variable.name}` : `plain-${variable.name}`
                            }
                            placeholder={isMasked ? '输入新值（留空表示不修改）' : undefined}
                            value={valueDrafts[variable.id] ?? (isMasked ? '' : shownValue(variable))}
                            onChange={(event) =>
                              setValueDrafts((current) => ({
                                ...current,
                                [variable.id]: event.target.value,
                              }))
                            }
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void submitValue(variable);
                              if (event.key === 'Escape') cancelEdit(variable);
                            }}
                            onBlur={() => void submitValue(variable)}
                          />
                          {/* 已揭示的 secret：再点一次盖回掩码（明文不能常亮） */}
                          {variable.is_secret &&
                            revealed[variable.id] !== undefined &&
                            !editingSecret && (
                              <button
                                type="button"
                                className="icon-btn"
                                aria-label={`隐藏 ${variable.name}`}
                                title="重新掩码"
                                onClick={() => forgetReveal(variable.id)}
                              >
                                <EyeIcon off aria-hidden="true" />
                              </button>
                            )}
                        </>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
          <tr
            className="ghost-row"
            // 幽灵行不参与落点判定：它不属于变量列表的顺序
            onDragOver={(event) => {
              if (draggingId) event.preventDefault();
            }}
          >
            <td className="var-key">
              {/* 幽灵行同样把 secret 开关摆在 key 那一列的末尾，与上面的行对齐 */}
              <div className="var-key-line">
                <input
                  ref={ghostNameRef}
                  className="var-name-input mono"
                  aria-label="新增变量的名称"
                  placeholder="变量名"
                  value={ghost.name}
                  onChange={(event) => setGhost({ ...ghost, name: event.target.value })}
                  onBlur={leaveGhost}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    submitGhostWithEnter();
                  }}
                />
                <label className="row width-auto">
                  <input
                    className="checkbox"
                    type="checkbox"
                    aria-label="新增变量标记为 secret"
                    checked={ghost.secret}
                    onChange={(event) => setGhost({ ...ghost, secret: event.target.checked })}
                    onBlur={leaveGhost}
                  />
                  secret
                </label>
              </div>
            </td>
            <td>
              <input
                className="var-value-input mono"
                aria-label="新增变量的值"
                placeholder="变量值"
                value={ghost.value}
                onChange={(event) => setGhost({ ...ghost, value: event.target.value })}
                onBlur={leaveGhost}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  submitGhostWithEnter();
                }}
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
