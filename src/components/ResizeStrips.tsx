import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { ResizeDirection, WindowCloser } from '../lib/window';

/** 八个方向的缩放边条：类名即方位缩写。 */
const STRIPS: ReadonlyArray<{ direction: ResizeDirection; className: string }> = [
  { direction: 'North', className: 'n' },
  { direction: 'South', className: 's' },
  { direction: 'East', className: 'e' },
  { direction: 'West', className: 'w' },
  { direction: 'NorthWest', className: 'nw' },
  { direction: 'NorthEast', className: 'ne' },
  { direction: 'SouthWest', className: 'sw' },
  { direction: 'SouthEast', className: 'se' },
];

/**
 * 自绘边缘缩放（change: add-in-page-window-controls，design D6）。
 *
 * decorations(false) 会连带丢掉 Windows 的原生边缘缩放手柄，用贴窗口内沿的
 * 透明窄条补回：pointerdown 交给原生的 startResizeDragging，自己不做逐帧移动。
 * 纯视图组件，窗口控制口可注入（与 App 的 windowCloser 同一份）。
 */
export function ResizeStrips({ windowApi }: { windowApi: WindowCloser }) {
  const onPointerDown = (direction: ResizeDirection) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // 阻止默认行为，避免边条获得焦点或触发文本选择
    event.preventDefault();
    void windowApi.startResizeDragging(direction);
  };

  return (
    <>
      {STRIPS.map((strip) => (
        <div
          key={strip.direction}
          className={`resize-strip ${strip.className}`}
          aria-hidden="true"
          onPointerDown={onPointerDown(strip.direction)}
        />
      ))}
    </>
  );
}

/**
 * 判定一个 pointer/mouse 事件是否落在会话标签行的交互控件上（拖拽与双击最大化都要排除）。
 *
 * `input` / `textarea` 用通配而不是枚举具体的名称框类名：合并面包屑行之后
 * （change: rework-visual-system-and-app-chrome，design D4），请求名与实体名两个
 * 输入框都落进了这一行，而且将来再加输入控件也不会漏。
 *
 * 点名制的判据只有一条：**这个浮层会不会离开会话标签行的 DOM 子树**。凡脱离的都要在这里
 * 点名——排除判定走 DOM 祖先，而 React 的事件冒泡走 React 树，所以浮层里的按下照样会冒到
 * `onSessionBarMouseDown`；`.dropdown-menu` 里非 button / input 的区域（选项之间的间隙、
 * 菜单空白处、选项区自己的滚动条）若不点名，按下时就会把整个窗口拖走
 * （change: rework-environments-list）。行内菜单（`NodeMenu`）与变量浮层都在本行的子树里，
 * 由祖先判定自然覆盖。
 */
export function isInteractiveSessionBarTarget(event: ReactMouseEvent<HTMLElement>): boolean {
  const target = event.target as HTMLElement | null;
  return Boolean(
    target?.closest(
      'button, select, input, textarea, .env-select, .dropdown-menu, .window-controls',
    ),
  );
}
