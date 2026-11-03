import { useCallback, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { clampConsoleHeight } from '../lib/layout';

export interface ConsoleHandleProps {
  /** 当前高度比例（0–1）；实时值由父级持有，与持久化共用同一份状态。 */
  ratio: number;
  /** 拖动过程中持续回调（按帧节流）。 */
  onRatio: (ratio: number) => void;
  /** 松手时回调一次，父级据此落库。 */
  onCommit: (ratio: number) => void;
}

/**
 * Console 抽屉上沿的拖拽命中区（spec: ui-layout「底部 Console 抽屉占位」）。
 *
 * 与 `SplitHandle` 同样的取舍：几何在 pointerdown 时缓存一次、`pointermove` 按帧节流、
 * 松手才落库。区别只有一处——它拖的是**高度**，而比例的分母是应用高度（桌面窗口铺满
 * 视口，`vh` 与 `.app` 的高度在这套界面里是一回事）。
 */
export function ConsoleHandle({ ratio, onRatio, onCommit }: ConsoleHandleProps) {
  const draggingRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const pendingRef = useRef<number | null>(null);
  const latestRef = useRef(ratio);
  const startRef = useRef({ y: 0, height: 0, base: 1 });

  const flushPending = useCallback(() => {
    frameRef.current = null;
    const value = pendingRef.current;

    if (value === null) return;
    latestRef.current = value;
    onRatio(value);
  }, [onRatio]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    // 抽屉本体是 handle 的父元素：它的高度就是「拖到哪儿算哪儿」的起点
    const drawer = event.currentTarget.parentElement;
    if (!drawer) return;

    const rect = drawer.getBoundingClientRect();
    const base = window.innerHeight || rect.height || 1;

    startRef.current = { y: event.clientY, height: rect.height, base };
    pendingRef.current = null;
    latestRef.current = ratio;
    draggingRef.current = true;

    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 捕获失败只是「拖出元素后不再跟手」，不影响功能；jsdom 下也会走到这里
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;

    const { y, height, base } = startRef.current;
    // 往上拖变高：高度 = 起始高度 + 指针上移的距离
    pendingRef.current = clampConsoleHeight((height + (y - event.clientY)) / base);
    if (frameRef.current !== null) return;

    frameRef.current = requestAnimationFrame(flushPending);
  };

  const stopDragging = () => {
    draggingRef.current = false;

    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;

    // 把还没跑的那一帧补上，否则落库值会与松手位置差一帧
    if (frameRef.current !== null) flushPending();

    stopDragging();

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 同 setPointerCapture
    }

    onCommit(latestRef.current);
  };

  return (
    <div
      className="console-handle"
      role="separator"
      aria-orientation="horizontal"
      aria-label="调整 Console 面板高度"
      data-testid="console-handle"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onLostPointerCapture={() => {
        if (draggingRef.current) stopDragging();
      }}
    />
  );
}
