// 原生输入框上的占位符悬停（change: show-variable-values-on-hover，任务 2.1 / 2.2）。
//
// 命中判定（`placeholderAtClientX`）只依赖 `event.currentTarget`，因此**一份 hook 可以服务
// 同一张表里的所有输入框**：指针走到哪个框，就按哪个框算。这也是为什么它必须挂在 input
// 自己的 `mousemove` 上、而不是按行给每个输入框各建一个 hook——键值表的行数是用户可控的，
// 在 `map` 里调 hook 会把 hook 的调用顺序交给数据。

import { useEffect, useState, type MouseEvent } from 'react';
import { placeholderAtClientX, type PlaceholderHit } from './placeholders';

export interface PlaceholderHoverHandlers {
  onMouseMove: (event: MouseEvent<HTMLInputElement>) => void;
  onMouseLeave: () => void;
  onBlur: () => void;
}

export interface PlaceholderHoverView {
  /** 当前指针下的占位符；没有命中时为 null。 */
  hit: PlaceholderHit | null;
  /** 接到原生 input 上（可直接展开）。 */
  handlers: PlaceholderHoverHandlers;
}

/** 同一个占位符的同一个位置：此时不动 state，免得每次 mousemove 都重渲染。 */
function sameHit(current: PlaceholderHit | null, next: PlaceholderHit | null): boolean {
  if (!current || !next) return current === next;
  return (
    current.name === next.name &&
    current.start === next.start &&
    current.rect.left === next.rect.left &&
    current.rect.top === next.rect.top
  );
}

/**
 * 指针停在某个 `{{name}}` 上时给出命中信息（含它在视口里的矩形）。
 *
 * 消失的三条路径都覆盖：指针移到占位符之外（mousemove 给出 null）、指针离开编辑面
 * （mouseleave）、输入框失焦（blur）。
 *
 * 另外在**任何**祖先容器滚动时收起：提示是 `position: fixed` 的覆盖层，容器一滚它的
 * 锚点就失效了，继续显示等于把一个错位的提示当成有效信息（`scroll` 用捕获阶段监听，
 * 覆盖内部滚动容器）。
 */
export function usePlaceholderHover(): PlaceholderHoverView {
  const [hit, setHit] = useState<PlaceholderHit | null>(null);

  useEffect(() => {
    if (!hit) return;

    const dismiss = () => setHit(null);
    window.addEventListener('scroll', dismiss, true);
    return () => window.removeEventListener('scroll', dismiss, true);
  }, [hit]);

  return {
    hit,
    handlers: {
      onMouseMove: (event) => {
        const next = placeholderAtClientX(event.currentTarget, event.clientX);
        setHit((current) => (sameHit(current, next) ? current : next));
      },
      onMouseLeave: () => setHit(null),
      onBlur: () => setHit(null),
    },
  };
}
