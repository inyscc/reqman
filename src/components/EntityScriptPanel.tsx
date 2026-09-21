import type { ReactNode, RefObject } from 'react';
import { ScriptPane } from './ScriptPane';
import type { Collection, Folder } from '../lib/types';

/** 自动保存的就地状态（spec: 脚本的编辑与保存）：落库成功即不再有"未保存"这一说。 */
export interface EntitySaveStatus {
  status: 'saving' | 'saved' | 'error';
  message: string | null;
}

/** 集合面板的内层页签；文件夹面板不使用（它只有脚本）。 */
export type EntityInnerTab = 'variables' | 'scripts';

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
  /** 当前页签（仅集合面板有页签栏）。 */
  tab?: EntityInnerTab;
  onTab?: (next: EntityInnerTab) => void;
  /** 变量页的内容（仅集合面板传入）。 */
  variablesPane?: ReactNode;
  /** 该集合已定义的变量条数；大于 0 时变量页签带绿点（Postman 的「有内容」提示）。 */
  variablesCount?: number;
}

/**
 * 集合 / 文件夹级的面板：集合以「变量 / 脚本」两个页签呈现，文件夹只有脚本。
 *
 * 三级脚本的执行顺序是 集合 → 文件夹 → 请求（spec: 脚本执行时机与顺序）。
 * 本组件是受控视图：草稿放在标签里，因此切走标签不会把没存下的脚本丢掉。
 *
 * 这里**没有保存按钮**——脚本在用户停止输入后由 `App` 自动落库（spec: 脚本的编辑与
 * 保存），面板只在「保存中 / 保存失败」时就地提示，落库成功不打扰。
 */
export function EntityScriptPanel({
  kind,
  entity,
  nameRef,
  onChange,
  onCommitName,
  saveStatus,
  tab = 'variables',
  onTab,
  variablesPane,
  variablesCount = 0,
}: EntityScriptPanelProps) {
  const label = kind === 'collection' ? '集合' : '文件夹';
  // 文件夹没有变量作用域，给出一个空页签只会制造无内容的界面（spec: 集合面板的变量与脚本站签）
  const hasTabs = kind === 'collection';
  const activeTab = hasTabs ? tab : 'scripts';
  // 页签上的绿点是 Postman 的「这一页有东西」提示：有变量 / 有脚本才点
  const hasVariables = variablesCount > 0;
  const hasScripts =
    (entity.pre_request_script ?? '').trim() !== '' ||
    (entity.test_script ?? '').trim() !== '';

  return (
    <div className="pane entity-pane">
      <div className="pane-header">
        <input
          ref={nameRef}
          className="crumb-name entity-name"
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
      {hasTabs && (
        // Postman 式的页签行：独立于名称行、左对齐的纯文字页签，激活项是浅灰圆角块
        <div className="panel-tabs" role="tablist" aria-label="集合面板">
          <button
            role="tab"
            type="button"
            aria-selected={activeTab === 'variables'}
            className={`panel-tab ${activeTab === 'variables' ? 'active' : ''}`}
            data-testid="entity-tab-variables"
            onClick={() => onTab?.('variables')}
          >
            变量
            {hasVariables && (
              <span className="tab-dot" role="img" aria-label="已定义变量" title="该集合已定义变量" />
            )}
          </button>
          <button
            role="tab"
            type="button"
            aria-selected={activeTab === 'scripts'}
            className={`panel-tab ${activeTab === 'scripts' ? 'active' : ''}`}
            data-testid="entity-tab-scripts"
            onClick={() => onTab?.('scripts')}
          >
            脚本
            {hasScripts && (
              <span className="tab-dot" role="img" aria-label="已定义脚本" title="该集合已定义脚本" />
            )}
          </button>
        </div>
      )}
      <div className="pane-body stack fill" data-testid="entity-script-panel">
        {activeTab === 'variables' ? (
          variablesPane
        ) : (
          <ScriptPane
            uri={`file:///reqman/${kind}/${entity.id}/script.js`}
            pre={entity.pre_request_script ?? ''}
            test={entity.test_script ?? ''}
            preLabel={`${label}前置脚本`}
            testLabel={`${label}后置脚本`}
            onChangePre={(value) => onChange({ ...entity, pre_request_script: value || null })}
            onChangeTest={(value) => onChange({ ...entity, test_script: value || null })}
          />
        )}

        {saveStatus?.status === 'saving' && (
          <div className="notice info" role="status" data-testid="entity-script-status">
            保存中…
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
