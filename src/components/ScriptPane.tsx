import { useState, type ReactNode } from 'react';

export interface ScriptPaneProps {
  pre: string;
  test: string;
  /** 编辑器可访问名：请求侧与集合/文件夹侧各自的文案。 */
  preLabel: string;
  testLabel: string;
  preHint?: ReactNode;
  testHint?: ReactNode;
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
    pre,
    test,
    preLabel,
    testLabel,
    preHint,
    testHint,
    prePlaceholder,
    testPlaceholder,
    onChangePre,
    onChangeTest,
  } = props;
  const [phase, setPhase] = useState<Phase>('pre');
  const hasPre = pre.trim().length > 0;
  const hasTest = test.trim().length > 0;

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
        {phase === 'pre' ? (
          <>
            {preHint && <span className="muted">{preHint}</span>}
            <textarea
              aria-label={preLabel}
              className="mono"
              placeholder={prePlaceholder}
              value={pre}
              onChange={(event) => onChangePre(event.target.value)}
            />
          </>
        ) : (
          <>
            {testHint && <span className="muted">{testHint}</span>}
            <textarea
              aria-label={testLabel}
              className="mono"
              placeholder={testPlaceholder}
              value={test}
              onChange={(event) => onChangeTest(event.target.value)}
            />
          </>
        )}
      </div>
    </div>
  );
}
