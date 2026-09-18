import { useRef, useState, type FocusEvent } from 'react';
import { describeError } from '../lib/commands';
import type { Commands } from '../lib/commands';
import type { Variable } from '../lib/types';

export interface VariablesPanelProps {
  client: Commands;
  workspaceId: string;
  environmentId: string | null;
  variables: Variable[];
  onChanged: () => void;
  /** 嵌入 Environments tab 时由外层承担上下文，隐藏自带的标题行。 */
  hideHeader?: boolean;
}

function plaintext(variable: Variable): string {
  return variable.current.state === 'value' ? variable.current.value : '';
}

/**
 * 变量面板：secret 取值默认以掩码呈现，明文只能经「揭示」按钮显式取得
 * （后端把列表与揭示刻意分成两个命令）。
 *
 * 值可以就地编辑（change: add-variable-inline-editing）：
 * - 可读的值（非 secret，或已揭示）直接是输入框，回车或失焦提交，Esc 还原；
 * - 未揭示的 secret 保持掩码，点「修改」才换成**空**输入框（留空 = 不修改）——
 *   既不能把掩码文本当值改掉，也不能替用户把明文填进去。
 * 只有值确实变化时才发写请求，因此点「删除」「揭示」引起的那次失焦不会顺手写一遍。
 */
export function VariablesPanel({
  client,
  workspaceId,
  environmentId,
  variables,
  onChanged,
  hideHeader = false,
}: VariablesPanelProps) {
  /** 幽灵行（新增变量）：纯本地状态，回车或失焦提交后才进后端。 */
  const [ghost, setGhost] = useState({ name: '', value: '', secret: false });
  const ghostNameRef = useRef<HTMLInputElement>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  /** 每行的编辑草稿：只有真正编辑过才存在（design D2）。 */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** 处于编辑态的未揭示 secret；默认仍是掩码（design D1）。 */
  const [editingSecrets, setEditingSecrets] = useState<Record<string, boolean>>({});

  const scope = environmentId ? 'environment' : 'global';
  const ownerId = environmentId ?? workspaceId;

  /** 该行界面上呈现的值（已揭示的用明文，否则用列表里的值）。 */
  const shownValue = (variable: Variable) => revealed[variable.id] ?? plaintext(variable);

  /** 未揭示的 secret：界面呈现掩码、编辑时不预填。 */
  const masked = (variable: Variable) =>
    variable.is_secret && revealed[variable.id] === undefined;

  const clearDraft = (id: string) =>
    setDrafts((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });

  const stopSecretEdit = (id: string) =>
    setEditingSecrets((current) => (current[id] ? { ...current, [id]: false } : current));

  const forgetReveal = (id: string) =>
    setRevealed((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });

  /**
   * 写值：`is_secret` 必须显式传——Rust 侧是 `#[serde(default)] bool`，
   * 漏掉它会把一个 secret 变量顺手降级成明文变量（design D3）。
   */
  const write = async (variable: Variable, next: string) => {
    try {
      await client.variableSet({
        scope,
        owner_id: ownerId,
        name: variable.name,
        is_secret: variable.is_secret,
        initial: next,
        current: next,
      });
      clearDraft(variable.id);
      stopSecretEdit(variable.id);
      // 改完之后重新盖回掩码：明文要看再点「揭示」
      forgetReveal(variable.id);
      onChanged();
    } catch (caught) {
      // 失败即回滚：草稿丢掉，输入框回落到 props 里的原值
      clearDraft(variable.id);
      stopSecretEdit(variable.id);
      setError(describeError(caught).message);
    }
  };

  const submitValue = async (variable: Variable) => {
    const draft = drafts[variable.id];

    if (masked(variable)) {
      // 未揭示的 secret 没有可比对的「原值」，所以用「空即不修改」这条显式规则
      const next = (draft ?? '').trim();
      if (next === '') {
        clearDraft(variable.id);
        stopSecretEdit(variable.id);
        return;
      }
      await write(variable, next);
      return;
    }

    if (draft === undefined || draft === shownValue(variable)) {
      clearDraft(variable.id);
      return;
    }
    await write(variable, draft);
  };

  const cancelEdit = (variable: Variable) => {
    clearDraft(variable.id);
    stopSecretEdit(variable.id);
  };

  const clearGhost = () => setGhost({ name: '', value: '', secret: false });

  /**
   * 幽灵行的提交：名称非空才算「写了东西」。
   *
   * 名称为空时不发任何请求——这既覆盖了「点进空行又原样离开」，也覆盖了
   * 「按了删除/揭示按钮引起的那次失焦」。失败时保留已填内容并报错，
   * 用户可以直接改完再提交。
   */
  const submitGhost = async () => {
    const name = ghost.name.trim();
    if (name === '') {
      if (ghost.value !== '' || ghost.secret) clearGhost();
      return;
    }
    setError(null);
    try {
      await client.variableSet({
        scope,
        owner_id: ownerId,
        name,
        is_secret: ghost.secret,
        initial: ghost.value,
        current: ghost.value,
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

  return (
    <div className="stack">
      {!hideHeader && (
        <div className="row">
          <strong>{scope === 'environment' ? '环境变量' : '全局变量'}</strong>
          <span className="grow" />
          <span className="muted">作用域：{scope}</span>
        </div>
      )}

      {error && (
        <div className="notice danger" role="alert" data-testid="variable-error">
          {error}
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th>名称</th>
            <th>当前值</th>
            <th className="var-actions" />
          </tr>
        </thead>
        <tbody>
          {variables.map((variable) => {
            const unreadable = variable.current.state === 'unreadable';
            const isMasked = masked(variable);
            const editingSecret = editingSecrets[variable.id] === true;

            return (
              <tr key={variable.id}>
                <td className="mono">
                  {variable.name}
                  {variable.is_secret && <span className="badge">secret</span>}
                </td>
                <td className="mono">
                  {unreadable ? (
                    <span
                      className="badge danger"
                      title="密钥不可用，无法读取或修改该值"
                      data-testid={`unreadable-${variable.name}`}
                    >
                      不可读
                    </span>
                  ) : isMasked && !editingSecret ? (
                    <>
                      <span data-testid={`masked-${variable.name}`}>{plaintext(variable)}</span>
                      <button
                        className="ghost var-edit"
                        aria-label={`修改 ${variable.name}`}
                        onClick={() => setEditingSecrets((current) => ({ ...current, [variable.id]: true }))}
                      >
                        修改
                      </button>
                    </>
                  ) : (
                    <input
                      className="var-value-input"
                      aria-label={`变量值 ${variable.name}`}
                      data-testid={
                        isMasked ? `masked-${variable.name}` : `plain-${variable.name}`
                      }
                      placeholder={isMasked ? '输入新值（留空表示不修改）' : undefined}
                      value={drafts[variable.id] ?? (isMasked ? '' : shownValue(variable))}
                      onChange={(event) =>
                        setDrafts((current) => ({
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
                  )}
                </td>
                <td className="var-actions">
                  {variable.is_secret && revealed[variable.id] === undefined && (
                    <button onClick={() => reveal(variable)}>揭示</button>
                  )}
                  <button className="ghost" onClick={() => remove(variable)}>
                    删除
                  </button>
                </td>
              </tr>
            );
          })}
          <tr className="ghost-row">
            <td>
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
            <td className="var-actions">
              <label className="row" style={{ width: 'auto' }}>
                <input
                  className="checkbox"
                  style={{ width: 'auto' }}
                  type="checkbox"
                  aria-label="新增变量标记为 secret"
                  checked={ghost.secret}
                  onChange={(event) => setGhost({ ...ghost, secret: event.target.checked })}
                  onBlur={leaveGhost}
                />
                secret
              </label>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
