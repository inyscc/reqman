import { useCallback, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { clampSplit } from '../lib/layout';

export interface SplitHandleProps {
  /** 当前分栏比例（0–1）。实时值由父级持有，以便与持久化共用同一份状态。 */
  ratio: number;
  /** 拖动过程中持续回调（已按帧节流）。 */
  onRatio: (ratio: number) => void;
  /** 松手时回调一次，父级据此落库。 */
  onCommit: (ratio: number) => void;
}

/**
 * 请求区与响应区之间的分栏命中区（change: rework-visual-system-and-app-chrome，design D7）。
 *
 * 几个刻意的做法：
 *
 * - 容器几何在 pointerdown 时缓存。拖动期间容器的位置与宽度不会变，逐帧读
 *   `getBoundingClientRect` 只会换来无谓的布局读取。
 * - `pointermove` 用 `requestAnimationFrame` 节流。改 `grid-template-columns` 是布局
 *   重排、走不了合成层，所以每帧只写一次比例。
 * - 拖动期间在容器上挂 `data-dragging`，由 CSS 关掉两侧 pane 的 `pointer-events`：
 *   响应区里的沙箱 iframe 会吞掉 `pointermove`，不关掉就没法把分隔线拖过它上方。
 * - 松手才落库。拖动过程中每一帧都写一次存储没有意义，而且会把存储写爆。
 */
export function SplitHandle({ ratio, onRatio, onCommit }: SplitHandleProps) {
  const draggingRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const pendingRef = useRef<number | null>(null);
  /** 已应用过的最后一个值：松手时用它落库，保证落库值与最后一帧一致。 */
  const latestRef = useRef(ratio);
  const boxRef = useRef({ left: 0, width: 0 });

  const flushPending = useCallback(() => {
    frameRef.current = null;
    const value = pendingRef.current;

    if (value === null) return;
    latestRef.current = value;
    onRatio(value);
  }, [onRatio]);

  const stopDragging = (container: HTMLElement | null) => {
    draggingRef.current = false;

    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    if (container) delete container.dataset.dragging;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    const container = event.currentTarget.parentElement;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return;

    boxRef.current = { left: rect.left, width: rect.width };
    pendingRef.current = null;
    latestRef.current = ratio;
    draggingRef.current = true;
    container.dataset.dragging = 'true';

    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 指针捕获失败只是「拖出元素后不再跟手」，不影响功能；jsdom 下也会走到这里
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;

    const { left, width } = boxRef.current;
    if (width <= 0) return;

    pendingRef.current = clampSplit((event.clientX - left) / width);
    if (frameRef.current !== null) return;

    frameRef.current = requestAnimationFrame(flushPending);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;

    // 把还没跑的那一帧补上，否则落库的比例会与用户松手的位置差一帧
    if (frameRef.current !== null) flushPending();

    stopDragging(event.currentTarget.parentElement);

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 同 setPointerCapture：失败不影响结果
    }

    onCommit(latestRef.current);
  };

  const onLostPointerCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    stopDragging(event.currentTarget.parentElement);
  };

  return (
    <div
      className="split-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整请求区与响应区的宽度"
      data-testid="split-handle"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onLostPointerCapture={onLostPointerCapture}
    />
  );
}
