import { useEffect, useRef, useState } from 'react';
import { describeError } from '../lib/commands';
import type { Commands } from '../lib/commands';
import type { Variable } from '../lib/types';
import { effectiveByName, isShadowed } from '../lib/variables';

export interface VariablesPeekProps {
  client: Commands;
  workspaceId: string;
  /** 当前激活环境；null 表示 Globals。 */
  environmentId: string | null;
  /** 打开中的请求所属集合，用于取集合级变量；没有打开请求时为 null。 */
  collectionId: string | null;
  /** 本请求实际用到的变量名（与发送同源）；没有打开请求时为 null。 */
  used: string[] | null;
  /** 其中未解析的名字。 */
  unresolved: string[];
  /** 进入主区环境编辑器的入口（改动量仍然落在那里）。 */
  onOpenEditor: () => void;
}

/** 界面呈现值：secret 的值本身就是后端给的掩码，这里不做任何揭示。 */
function shownValue(variable: Variable): string {
  return variable.current.state === 'value' ? variable.current.value : '不可读';
}

/**
 * 环境变量的只读浮层（spec: 环境变量的只读浮层）：
 * 锚在环境选择器下方、覆盖在内容之上，不新增列、不挤占请求区或响应区。
 *
 * 只读是刻意的：这里不提供就地编辑、新增、删除，也**不提供揭示明文**——拿明文仍然
 * 只能经变量面板的揭示操作，否则浮层就成了绕过掩码的第二扇门。改动量回主区的环境
 * 编辑器（浮层底部的入口）。
 *
 * 入口按钮与浮层在同一个根节点里，因此「点击外部关闭」不会和入口按钮自己的开关打架。
 */
export function VariablesPeek({
  client,
  workspaceId,
  environmentId,
  collectionId,
  used,
  unresolved,
  onOpenEditor,
}: VariablesPeekProps) {
  const [open, setOpen] = useState(false);
  const [scopeVariables, setScopeVariables] = useState<Variable[]>([]);
  const [collectionVariables, setCollectionVariables] = useState<Variable[]>([]);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);

  // 打开时才去取变量：当前作用域（环境或 Globals）与集合级
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    void (async () => {
      try {
        const scope = environmentId
          ? await client.variableList('environment', environmentId)
          : await client.globalsList(workspaceId);
        const collection = collectionId
          ? await client.variableList('collection', collectionId)
          : [];
        if (cancelled) return;
        setScopeVariables(scope);
        setCollectionVariables(collection);
        setError(null);
      } catch (caught) {
        if (!cancelled) setError(describeError(caught).message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, client, workspaceId, environmentId, collectionId]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  /**
   * 名称 → **生效**条目：集合级先放、当前作用域后放，因此同名时作用域内的那份胜出。
   *
   * 取的是各组里最靠下的启用条目（与解析同源），被禁用的条目根本不会进来——否则浮层
   * 会把一条不参与解析的值呈现成「当前值」（spec: 环境变量的只读浮层）。
   */
  const byName = new Map<string, Variable>();
  for (const [name, variable] of effectiveByName(collectionVariables)) byName.set(name, variable);
  for (const [name, variable] of effectiveByName(scopeVariables)) byName.set(name, variable);
  const unresolvedSet = new Set(unresolved);

  return (
    <span className="env-peek" ref={rootRef}>
      <button
        className="icon-button"
        type="button"
        aria-label="查看变量"
        title="查看变量"
        aria-expanded={open}
        data-testid="env-peek-button"
        onClick={() => setOpen((value) => !value)}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path
            d="M8 3C4.6 3 1.7 5.4 1 8c.7 2.6 3.6 5 7 5s6.3-2.4 7-5c-.7-2.6-3.6-5-7-5zm0 8.4A3.4 3.4 0 1 1 8 4.6a3.4 3.4 0 0 1 0 6.8zm0-1.4a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"
            fill="currentColor"
          />
        </svg>
      </button>

      {open && (
        <div className="peek-panel" role="dialog" aria-label="变量" data-testid="env-peek">
          {error && (
            <div className="notice danger" role="alert">
              {error}
            </div>
          )}

          <div className="peek-section">
            <h4>本请求用到的变量</h4>
            {used === null ? (
              <p className="muted">当前没有打开的请求。</p>
            ) : used.length === 0 ? (
              <p className="muted">这个请求还没有用到变量。</p>
            ) : (
              <ul className="peek-list">
                {used.map((name) => {
                  const variable = byName.get(name);
                  const missing = unresolvedSet.has(name);
                  return (
                    <li key={name} data-testid={`peek-used-${name}`}>
                      <code className="peek-name">{name}</code>
                      {missing ? (
                        <span className="badge warn">未解析</span>
                      ) : (
                        <span className="peek-value mono">
                          {variable ? shownValue(variable) : '—'}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="peek-section">
            <h4>{environmentId ? '当前环境的变量' : '全局变量'}</h4>
            {scopeVariables.length === 0 ? (
              <p className="muted">这个作用域里还没有变量。</p>
            ) : (
              <ul className="peek-list" data-testid="peek-scope-list">
                {/* 逐条列出（含同名与禁用），但不把不参与解析的条目的值呈现为当前值 */}
                {scopeVariables.map((variable) => {
                  const shadowed = isShadowed(variable, scopeVariables);
                  return (
                    <li key={variable.id} data-testid={`peek-scope-${variable.name}`}>
                      <code className="peek-name">{variable.name}</code>
                      {!variable.enabled ? (
                        <span
                          className="badge"
                          title="该变量已禁用，不参与解析"
                          data-testid={`peek-disabled-${variable.name}`}
                        >
                          已禁用
                        </span>
                      ) : shadowed ? (
                        <span
                          className="badge warn"
                          title="该变量被下方同名变量覆盖"
                          data-testid={`peek-shadowed-${variable.name}`}
                        >
                          被覆盖
                        </span>
                      ) : (
                        <span className="peek-value mono">{shownValue(variable)}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="peek-footer">
            <button
              className="ghost"
              data-testid="peek-open-editor"
              onClick={() => {
                // 交给主区编辑器之后就把浮层收起来，避免两块内容同时占着视线
                setOpen(false);
                onOpenEditor();
              }}
            >
              去环境编辑器
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
