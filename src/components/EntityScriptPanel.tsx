import { useState } from 'react';
import type { RefObject } from 'react';
import { ScriptPane } from './ScriptPane';
import type { Collection, Folder } from '../lib/types';

export interface EntityScriptPanelProps {
  kind: 'collection' | 'folder';
  /** 实体草稿（含就地编辑的脚本与名称）由会话标签持有，本组件只是它的视图。 */
  entity: Collection | Folder;
  dirty: boolean;
  busy: boolean;
  /** 面板头里的名称输入框：树菜单的「重命名」把焦点交给它。 */
  nameRef?: RefObject<HTMLInputElement | null>;
  /** 编辑实体草稿（名称、前后置脚本都走这里），写回它所在的标签。 */
  onChange: (next: Collection | Folder) => void;
  /** 失焦/回车提交名称。 */
  onCommitName: () => void;
  /** 保存脚本；返回是否成功，用于呈现「已保存」。 */
  onSave: () => Promise<boolean>;
}

/**
 * 集合 / 文件夹级的前后置脚本编辑（任务 5.2）。
 *
 * 三级脚本的执行顺序是 集合 → 文件夹 → 请求（spec: 脚本执行时机与顺序）。
 * 保存与「编辑即授权」由 App 按标签执行（design D4）；本组件是受控视图，
 * 草稿放在标签里，因此切走标签不会把没存下的脚本丢掉。
 */
export function EntityScriptPanel({
  kind,
  entity,
  dirty,
  busy,
  nameRef,
  onChange,
  onCommitName,
  onSave,
}: EntityScriptPanelProps) {
  const label = kind === 'collection' ? '集合' : '文件夹';
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    const saved = await onSave();
    setSaving(false);
    if (saved) setStatus('已保存');
  };

  return (
    <div className="pane">
      <div className="pane-header">
        <input
          ref={nameRef}
          className="crumb-name"
          aria-label={kind === 'collection' ? '集合名称' : '文件夹名称'}
          value={entity.name}
          onChange={(event) => onChange({ ...entity, name: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onCommitName();
          }}
          onBlur={onCommitName}
        />
        {dirty && <span className="badge warn">未保存</span>}
        <span className="grow" />
        <button onClick={() => void save()} disabled={busy || saving}>
          保存
        </button>
      </div>
      <div className="pane-body stack" data-testid="entity-script-panel">
        <ScriptPane
          pre={entity.pre_request_script ?? ''}
          test={entity.test_script ?? ''}
          preLabel={`${label}前置脚本`}
          testLabel={`${label}后置脚本`}
          preHint="前置脚本 — 最先执行（三级顺序的第一层或第二层）"
          testHint="后置脚本 — 收到响应后执行"
          onChangePre={(value) => onChange({ ...entity, pre_request_script: value || null })}
          onChangeTest={(value) => onChange({ ...entity, test_script: value || null })}
        />

        <p className="muted">在本应用中编写并保存的脚本视为已授权，发送时不再弹出脚本确认。</p>

        {status && (
          <div className="notice info" role="status" data-testid="entity-script-status">
            {status}
          </div>
        )}
      </div>
    </div>
  );
}
