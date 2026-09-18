import { useState } from 'react';
import { describeError, type Commands } from '../lib/commands';
import { SURFACE_PRIORITY, type EditingRegistry } from '../lib/editing';
import { allowScriptExecution } from '../lib/scriptRuntime';
import type { Collection, Folder } from '../lib/types';
import { useEditingSurface } from '../lib/useEditing';
import { ScriptPane } from './ScriptPane';

export interface EntityScriptPanelProps {
  client: Commands;
  kind: 'collection' | 'folder';
  entity: Collection | Folder;
  /** 保存脚本后据此登记「编辑即授权」（design D6）。 */
  collectionId: string;
  onSaved: () => void;
  /** 编辑面注册表：Ctrl+S 与未保存守卫据此找到这一面。 */
  editing?: EditingRegistry;
}

/**
 * 集合 / 文件夹级的前后置脚本编辑（任务 5.2）。
 *
 * 三级脚本的执行顺序是 集合 → 文件夹 → 请求（spec: 脚本执行时机与顺序）。
 * 在本应用中编写并保存的脚本视为已授权（design D6「编辑即授权」）——保存时
 * 登记该集合的门禁确认，发送不再重复询问。
 */
export function EntityScriptPanel({
  client,
  kind,
  entity,
  collectionId,
  onSaved,
  editing,
}: EntityScriptPanelProps) {
  const initialPre = entity.pre_request_script ?? '';
  const initialTest = entity.test_script ?? '';
  const [pre, setPre] = useState(initialPre);
  const [test, setTest] = useState(initialTest);
  /** 已保存的基线：保存成功后前移，未保存守卫据此判断还有没有改动。 */
  const [baseline, setBaseline] = useState({ pre: initialPre, test: initialTest });
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const label = kind === 'collection' ? '集合' : '文件夹';

  const save = async (): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const preScript = pre.trim() ? pre : null;
      const testScript = test.trim() ? test : null;

      if (kind === 'collection') {
        await client.collectionSetScript(entity.id, preScript, testScript);
      } else {
        await client.folderSetScript(entity.id, preScript, testScript);
      }

      if (preScript || testScript) {
        await allowScriptExecution(client, collectionId);
      }

      setBaseline({ pre, test });
      setStatus('已保存');
      onSaved();
      return true;
    } catch (caught) {
      setError(describeError(caught).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  useEditingSurface(editing, {
    id: `entity-script-${entity.id}`,
    priority: SURFACE_PRIORITY.panel,
    label: `${label}「${entity.name}」的脚本`,
    isDirty: () => pre !== baseline.pre || test !== baseline.test,
    save,
  });

  return (
    <div className="pane">
      <div className="pane-header">
        <strong>
          {label} · {entity.name}
        </strong>
        <span className="grow" />
        <button onClick={() => void save()} disabled={busy}>
          保存
        </button>
      </div>
      <div className="pane-body stack" data-testid="entity-script-panel">
        <ScriptPane
          pre={pre}
          test={test}
          preLabel={`${label}前置脚本`}
          testLabel={`${label}后置脚本`}
          preHint="前置脚本 — 最先执行（三级顺序的第一层或第二层）"
          testHint="后置脚本 — 收到响应后执行"
          onChangePre={setPre}
          onChangeTest={setTest}
        />

        <p className="muted">在本应用中编写并保存的脚本视为已授权，发送时不再弹出脚本确认。</p>

        {status && (
          <div className="notice info" role="status" data-testid="entity-script-status">
            {status}
          </div>
        )}
        {error && (
          <div className="notice danger" role="alert">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
