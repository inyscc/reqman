import type { RefObject } from 'react';
import { ScriptPane } from './ScriptPane';
import type { Collection, Folder } from '../lib/types';

/** 自动保存的就地状态（spec: 脚本的编辑与保存）：落库成功即不再有"未保存"这一说。 */
export interface EntitySaveStatus {
  status: 'saving' | 'saved' | 'error';
  message: string | null;
}

export interface EntityScriptPanelProps {
  kind: 'collection' | 'folder';
  /** 实体草稿（含就地编辑的脚本与名称）由会话标签持有，本组件只是它的视图。 */
  entity: Collection | Folder;
  /** 面板头里的名称输入框：树菜单的「重命名」把焦点交给它。 */
  nameRef?: RefObject<HTMLInputElement | null>;
  /** 编辑实体草稿（名称、前后置脚本都走这里），写回它所在的标签。 */
  onChange: (next: Collection | Folder) => void;
  /** 失焦/回车提交名称。 */
  onCommitName: () => void;
  /** 脚本自动保存的状态，由 `App` 按标签给出；本组件只负责呈现。 */
  saveStatus?: EntitySaveStatus | null;
}

/**
 * 集合 / 文件夹级的前后置脚本编辑。
 *
 * 三级脚本的执行顺序是 集合 → 文件夹 → 请求（spec: 脚本执行时机与顺序）。
 * 本组件是受控视图：草稿放在标签里，因此切走标签不会把没存下的脚本丢掉。
 *
 * 这里**没有保存按钮**——脚本在用户停止输入后由 `App` 自动落库（spec: 脚本的编辑与
 * 保存），面板只呈现"保存中 / 已保存 / 保存失败"的就地状态。
 */
export function EntityScriptPanel({
  kind,
  entity,
  nameRef,
  onChange,
  onCommitName,
  saveStatus,
}: EntityScriptPanelProps) {
  const label = kind === 'collection' ? '集合' : '文件夹';

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
        <span className="grow" />
      </div>
      <div className="pane-body stack fill" data-testid="entity-script-panel">
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

        {saveStatus?.status === 'saving' && (
          <div className="notice info" role="status" data-testid="entity-script-status">
            保存中…
          </div>
        )}
        {saveStatus?.status === 'saved' && (
          <div className="notice info" role="status" data-testid="entity-script-status">
            已保存
          </div>
        )}
        {saveStatus?.status === 'error' && (
          <div className="notice danger" role="alert" data-testid="entity-script-status">
            {saveStatus.message ?? '自动保存失败'}
          </div>
        )}
      </div>
    </div>
  );
}
