// 占位符的悬浮值提示浮层（change: show-variable-values-on-hover，任务 3.1 / 3.2）。
//
// 三条硬约束决定了它的形态：
//
// 1. **覆盖层**：不占布局、不改变编辑面的宽高与滚动位置。因此它 `position: fixed` 挂在
//    `document.body` 上（不是就地插入——键值表的单元格会裁切，`overflow` 一挡锚点就错位）。
// 2. **`pointer-events: none`**（见 App.css）：提示不能成为指针的落点，否则移向它的路上
//    会命中它自己、`mouseleave` 立刻触发、提示闪没；它内部的文字也因此不能被选中、复制。
// 3. **按需只在显示期间持有一个**：命中变化即重新取值，组件卸载即丢弃——secret 的明文
//    正是靠这一点只活在这次显示里（design D5）。

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PlaceholderHit } from '../lib/placeholders';
import {
  describeHover,
  type VariableHoverInfo,
  type VariableHoverSource,
} from '../lib/variableHover';

/** 提示与占位符之间、提示与视口边缘之间的间距。 */
const GAP = 6;

export interface VariableHoverTipProps {
  source: VariableHoverSource;
  /** 命中的占位符（含它在视口里的矩形）。 */
  hit: PlaceholderHit;
}

interface Placement {
  top: number;
  left: number;
  above: boolean;
}

/** 把提示摆到占位符下方；下方放不下就翻到上方，左右不越出视口。 */
function placeTip(anchor: PlaceholderHit['rect'], box: { width: number; height: number }): Placement {
  const roomBelow = window.innerHeight - anchor.bottom;
  // 上方也放不下时（占位符在很长的表格里靠上）仍选下方：宁可贴着底边，也不要盖住正在看的那一行
  const above = roomBelow < box.height + GAP && anchor.top > box.height + GAP;

  return {
    top: above ? anchor.top - box.height - GAP : anchor.bottom + GAP,
    left: Math.min(Math.max(GAP, anchor.left), Math.max(GAP, window.innerWidth - box.width - GAP)),
    above,
  };
}

export function VariableHoverTip({ source, hit }: VariableHoverTipProps) {
  const [info, setInfo] = useState<VariableHoverInfo | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  // 命中换了名字才重新取值：在同一个占位符内部移动指针不该再问一次后端
  useEffect(() => {
    let alive = true;
    setInfo(null);

    void source.resolve(hit.name).then((next) => {
      if (alive) setInfo(next);
    });

    return () => {
      alive = false;
    };
  }, [source, hit.name]);

  // 先量、再摆：用 layout effect 把这一帧的「未定位」状态收掉，避免看到一次跳到 (0,0) 的闪动
  useLayoutEffect(() => {
    const node = tipRef.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    setPlacement(placeTip(hit.rect, box));
  }, [hit]);

  const presented = info ? describeHover(info) : null;

  return createPortal(
    <div
      className="variable-tip"
      data-testid="variable-tip"
      data-status={presented?.status ?? 'loading'}
      data-scope={presented?.scope ?? ''}
      data-placement={placement?.above ? 'above' : 'below'}
      ref={tipRef}
      style={{
        top: placement?.top ?? 0,
        left: placement?.left ?? 0,
        // 定位算完之前先藏着：这一帧它还在 (0,0)，露出来就是一次闪动
        visibility: placement ? 'visible' : 'hidden',
      }}
    >
      <span className="variable-tip-name mono">{hit.name}</span>

      {presented === null ? (
        <span className="variable-tip-note muted">读取中…</span>
      ) : presented.status === 'value' ? (
        <>
          <span className="variable-tip-value mono">{presented.value}</span>
          <span className="variable-tip-scope">{presented.scopeLabel}</span>
        </>
      ) : (
        <span className="variable-tip-note muted">{presented.note}</span>
      )}
    </div>,
    document.body,
  );
}
