import { useState } from 'react';
import { CodeSurface } from './CodeSurface';

export interface ScriptPaneProps {
  /** 模型 URI（`file://`）：pre/test 共用一个模型（切换只换内容，不重建编辑器）。 */
  uri: string;
  pre: string;
  test: string;
  /** 编辑器可访问名：请求侧与集合/文件夹侧各自的文案。 */
  preLabel: string;
  testLabel: string;
  prePlaceholder?: string;
  testPlaceholder?: string;
  onChangePre: (value: string) => void;
  onChangeTest: (value: string) => void;
}

type Phase = 'pre' | 'test';

/**
 * 前置/后置脚本的两栏编辑：左栏点击切换，右栏编辑（change: rework-collection-tree-and-scripts，design D5）。
 *
 * 两段脚本各是一个独立状态，切换只换右栏的展示源，来回切换不丢内容。左栏的
 * 小圆点标记「另一段也写了东西」——两栏化之后这是唯一的提示信号。
 */
export function ScriptPane(props: ScriptPaneProps) {
  const {
    uri,
    pre,
    test,
    preLabel,
    testLabel,
    prePlaceholder,
    testPlaceholder,
    onChangePre,
    onChangeTest,
  } = props;
  const [phase, setPhase] = useState<Phase>('pre');
  const hasPre = pre.trim().length > 0;
  const hasTest = test.trim().length > 0;
  const isPre = phase === 'pre';

  return (
    <div className="script-pane" data-testid="script-pane">
      <div className="script-pane-list">
        <button
          className={phase === 'pre' ? 'active' : undefined}
          aria-pressed={phase === 'pre'}
          onClick={() => setPhase('pre')}
        >
          <span>Pre-request</span>
          {hasPre && <span className="script-dot" data-testid="script-dot-pre" title="已有内容" />}
        </button>
        <button
          className={phase === 'test' ? 'active' : undefined}
          aria-pressed={phase === 'test'}
          onClick={() => setPhase('test')}
        >
          <span>Post-response</span>
          {hasTest && <span className="script-dot" data-testid="script-dot-test" title="已有内容" />}
        </button>
      </div>

      <div className="script-pane-editor">
        <CodeSurface
          uri={uri}
          ariaLabel={isPre ? preLabel : testLabel}
          language="javascript"
          value={isPre ? pre : test}
          placeholder={isPre ? prePlaceholder : testPlaceholder}
          fill
          enableCompletion
          onChange={isPre ? onChangePre : onChangeTest}
        />
      </div>
    </div>
  );
}
