import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';

export interface OverlayScrollbarProps {
  /** 真正滚动的那个元素；组件只读它的几何，不改它的布局。 */
  targetRef: RefObject<HTMLElement | null>;
}

/**
 * 悬浮滚动条（change: rework-collection-tree-and-variable-model 的收尾）。
 *
 * 为什么需要它：原生滚动条在 Windows / WebView2 上是**占位型**——出现时吃掉
 * 内容宽度，消失时又还回来。集合树里行内容铺满容器宽度、右对齐的「⋯」因此
 * 每出现一次滚动条就左移一段，看起来像「刷新了位置」。这里把原生滚动条收成
 * 0 宽，自绘一条悬浮在内容之上的指示条，宽度问题就不存在了。
 *
 * 几条纪律：
 * - 只读滚动容器的几何，不参与它的布局（绝对定位在定位上下文里）。
 * - 内容与容器尺寸都可能变（展开、搜索过滤、新建条目），因此同时观察尺寸与子树。
 * - 可用鼠标拖动；拖动时持续可见，静止时跟随容器悬停显隐。
 */
export function OverlayScrollbar({ targetRef }: OverlayScrollbarProps) {
  const [thumb, setThumb] = useState<{ top: number; height: number } | null>(null);
  const [hovering, setHovering] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** 拖动中的换算系数：thumb 走 1px，滚动条要走多少 px。 */
  const dragRef = useRef<{ startY: number; startScroll: number; scale: number } | null>(null);

  useEffect(() => {
    const element = targetRef.current;
    if (!element) return undefined;

    const sync = () => {
      const { clientHeight, scrollHeight, scrollTop } = element;
      if (clientHeight === 0 || scrollHeight <= clientHeight + 1) {
        setThumb(null);
        return;
      }

      const height = Math.max(24, Math.round((clientHeight / scrollHeight) * clientHeight));
      const maxTop = clientHeight - height;
      const top = Math.round((scrollTop / (scrollHeight - clientHeight)) * maxTop);
      setThumb({ top, height });
    };

    const onEnter = () => setHovering(true);
    const onLeave = () => setHovering(false);

    sync();
    element.addEventListener('scroll', sync, { passive: true });
    element.addEventListener('pointerenter', onEnter);
    element.addEventListener('pointerleave', onLeave);

    // jsdom 没有 ResizeObserver：单测里退化成「只在挂载时量一次」，不影响断言
    const ResizeObserverCtor = globalThis.ResizeObserver;
    const sizes = ResizeObserverCtor ? new ResizeObserverCtor(sync) : null;
    const content = ResizeObserverCtor ? new ResizeObserverCtor(sync) : null;

    const watchContent = () => {
      if (!content) return;
      content.disconnect();
      for (const child of Array.from(element.children)) content.observe(child);
    };

    sizes?.observe(element);
    watchContent();

    const mutations = new MutationObserver(() => {
      watchContent();
      sync();
    });
    mutations.observe(element, { childList: true, subtree: true });

    return () => {
      element.removeEventListener('scroll', sync);
      element.removeEventListener('pointerenter', onEnter);
      element.removeEventListener('pointerleave', onLeave);
      sizes?.disconnect();
      content?.disconnect();
      mutations.disconnect();
    };
  }, [targetRef]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = targetRef.current;
    if (!element || !thumb) return;

    event.preventDefault();
    event.stopPropagation();

    const maxTop = element.clientHeight - thumb.height;
    const scale = maxTop <= 0 ? 1 : (element.scrollHeight - element.clientHeight) / maxTop;
    dragRef.current = { startY: event.clientY, startScroll: element.scrollTop, scale };
    setDragging(true);

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const state = dragRef.current;
      if (!state) return;
      element.scrollTop = state.startScroll + (moveEvent.clientY - state.startY) * state.scale;
    };
    const onUp = () => {
      dragRef.current = null;
      setDragging(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  if (!thumb) return null;

  const offsetTop = targetRef.current?.offsetTop ?? 0;

  return (
    <div
      className="overlay-scrollbar"
      data-testid="overlay-scrollbar"
      data-active={hovering || dragging ? 'true' : undefined}
      style={{ top: offsetTop + thumb.top, height: thumb.height }}
      onPointerDown={onPointerDown}
    />
  );
}
