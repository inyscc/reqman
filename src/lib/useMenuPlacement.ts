import { useLayoutEffect, useState, type RefObject } from 'react';

/** 浮层与触发器之间的固定间隙（px）。 */
export const MENU_GAP = 4;

export interface MenuPosition {
  top: number;
  left?: number;
  right?: number;
  /** fixed 定位下百分比宽度没有意义；需要时按触发器实测宽度给出下限。 */
  minWidth?: number;
  /** 菜单翻到了触发器上方——调用方可据此调整生长原点。 */
  above: boolean;
}

export interface MenuPlacementOptions {
  /** 菜单是否展开；收起时返回 `null`。 */
  open: boolean;
  /** 触发菜单的那个元素。 */
  anchor: RefObject<Element | null>;
  /** 菜单自身。 */
  menu: RefObject<HTMLElement | null>;
  /** 贴哪一侧：默认与触发器左缘对齐，`right` 优先与右缘对齐。 */
  align?: 'left' | 'right';
  /** 是否把触发器宽度作为菜单的最小宽度（下拉菜单用；行内菜单有自己的下限）。 */
  matchAnchorWidth?: boolean;
}

/**
 * 覆盖层菜单的定位（spec: ui-polish「浮层在垂直方向的定位」）。
 *
 * **垂直**：默认贴在触发器下方；下方放不下、而上方更宽裕时翻到触发器上方。
 * **水平**：默认与触发器左缘对齐，放不下时收回视口内；`align: 'right'` 先试右缘对齐。
 *
 * 为什么定位必须由测量得出、而不是写在一层 CSS 里：菜单是覆盖层，但它的位置要跟着
 * 触发器的实测矩形走。留在祖先里用绝对定位时，祖先的 `overflow` 会把它裁掉——集合树
 * 与环境列表都是滚动容器，最底部的那一行因此「点不出菜单」。
 *
 * 下拉菜单（`Dropdown`）与行内操作菜单（`NodeMenu`）共用这一份实现：两处的语义是同一套，
 * 各写一份等于承诺它们会一起漂移（与 `useMenuDismiss` 抽出来时的理由相同）。
 */
export function useMenuPlacement({
  open,
  anchor,
  menu,
  align = 'left',
  matchAnchorWidth = false,
}: MenuPlacementOptions): MenuPosition | null {
  const [position, setPosition] = useState<MenuPosition | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      // 收起后清掉位置；值相等时 React 不会重渲染，因此不会与 effect 形成循环
      setPosition(null);
      return;
    }

    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      const node = menu.current;
      if (!rect || !node) return;

      const width = node.offsetWidth;
      const height = node.offsetHeight;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      // 垂直：下方放不下、而上方更宽裕时翻到触发器上方
      const below = viewportHeight - rect.bottom - MENU_GAP;
      const above = rect.top - MENU_GAP;
      const flip = height > below && above > below;

      // 水平：默认与触发器左缘对齐，放不下时收回视口内；align='right' 先试右缘对齐
      let left: number | undefined = Math.max(
        MENU_GAP,
        Math.min(rect.left, viewportWidth - MENU_GAP - width),
      );
      let right: number | undefined;

      if (align === 'right') {
        const desired = viewportWidth - rect.right;
        if (desired + width <= viewportWidth - MENU_GAP) {
          left = undefined;
          right = Math.max(MENU_GAP, desired);
        }
      }

      setPosition({
        top: flip ? Math.max(MENU_GAP, above - height) : rect.bottom + MENU_GAP,
        left,
        right,
        ...(matchAnchorWidth ? { minWidth: rect.width } : {}),
        above: flip,
      });
    };

    place();
    // 只跟窗口尺寸走：菜单高度靠选项区的 max-height 收口，内容变化不会把它撑出视口
    window.addEventListener('resize', place);

    return () => window.removeEventListener('resize', place);
  }, [open, align, matchAnchorWidth, anchor, menu]);

  return position;
}
