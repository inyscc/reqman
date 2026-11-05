// 变量候选浮层（change: suggest-variables-while-typing，任务 2.2）。
//
// 形态与 `VariableHoverTip` 同构——`position: fixed` 挂在 `document.body` 上、不占布局、
// 放不下就上翻。差别只有一条：候选项要能被点，所以它接住指针（`pointer-events: auto`），
// 也因此需要自己的一套收起规则（见 `useVariableSuggest`）。
//
// `mousedown` 上的 `preventDefault` 是这里最容易被删掉的一行：不阻止的话，按下候选项的
// 那一瞬间输入框先失焦、浮层随之收起，`click` 根本不会落到这一项上——点击永远落空。

import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { scopeLabel, type VariableCandidate } from '../lib/variableHover';
import type { SuggestAnchor } from '../lib/useVariableSuggest';

/** 浮层与锚点、与视口边缘之间的间距。 */
const GAP = 4;

export interface VariableSuggestProps {
  anchor: SuggestAnchor;
  items: VariableCandidate[];
  activeIndex: number;
  /** 鼠标点选某一项。 */
  onPick: (index: number) => void;
  /** 鼠标划过某一项：高亮跟着走，避免「看着这一项、回车补的却是另一项」。 */
  onActivate: (index: number) => void;
}

interface Placement {
  top: number;
  left: number;
  above: boolean;
}

/** 摆在光标下方；下方放不下就翻到上方，左右不越出视口。 */
function place(anchor: SuggestAnchor, box: { width: number; height: number }): Placement {
  const roomBelow = window.innerHeight - anchor.bottom;
  const above = roomBelow < box.height + GAP && anchor.top > box.height + GAP;

  return {
    top: above ? anchor.top - box.height - GAP : anchor.bottom + GAP,
    left: Math.min(Math.max(GAP, anchor.left), Math.max(GAP, window.innerWidth - box.width - GAP)),
    above,
  };
}

export function VariableSuggest({
  anchor,
  items,
  activeIndex,
  onPick,
  onActivate,
}: VariableSuggestProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  // 先量、再摆：这一帧里它还在 (0,0)，露出来就是一次闪动（与悬停提示同款处理）
  useLayoutEffect(() => {
    const node = listRef.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    setPlacement(place(anchor, box));
  }, [anchor, items.length]);

  return createPortal(
    <div
      ref={listRef}
      className="variable-suggest"
      data-testid="variable-suggest"
      data-variable-suggest=""
      data-placement={placement?.above ? 'above' : 'below'}
      role="listbox"
      aria-label="变量候选"
      style={{
        top: placement?.top ?? 0,
        left: placement?.left ?? 0,
        visibility: placement ? 'visible' : 'hidden',
      }}
    >
      {items.length === 0 ? (
        <div className="variable-suggest-empty" data-testid="variable-suggest-empty">
          没有匹配的变量
        </div>
      ) : (
        items.map((item, index) => (
          <div
            key={item.name}
            className="variable-suggest-item"
            data-testid="variable-suggest-item"
            data-name={item.name}
            data-scope={item.scope}
            role="option"
            aria-selected={index === activeIndex}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onActivate(index)}
            onClick={() => onPick(index)}
          >
            <span className="variable-suggest-name mono">{item.name}</span>
            <span className="variable-suggest-value mono">{item.value}</span>
            <span className="variable-suggest-scope">{scopeLabel(item.scope)}</span>
          </div>
        ))
      )}
    </div>,
    document.body,
  );
}
