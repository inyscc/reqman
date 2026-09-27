import { useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useMenuDismiss } from '../lib/useMenuDismiss';
import { useMenuPlacement } from '../lib/useMenuPlacement';

export interface MenuItem {
  label: string;
  danger?: boolean;
  onSelect: () => void;
  /**
   * 该项的键位文案（如 `Ctrl+D`）。
   *
   * 只作呈现：按下快捷键由 App 的 window 监听处理，菜单不参与触发——两条路径走同一个
   * 入口，行为因此不可能分叉（spec: ui-layout「树操作的快捷键」）。
   */
  shortcut?: string;
}

/**
 * 行内操作菜单：点击外部、Esc、容器滚动都会关闭（design D2）。
 *
 * 从集合树里提取出来共享——环境列表项用的是同一套交互（change:
 * add-collection-search-and-env-management，design D5），类名保持不变以免
 * 既有定位器失效。三条关闭规则来自 `useMenuDismiss`，下拉菜单用的是同一个实现。
 *
 * 位置同样与下拉菜单共用 `useMenuPlacement`：菜单是覆盖层，留在行内会被所在滚动容器
 * 裁掉——集合树与环境列表都是滚动容器，最底部的那一行因此「点不出菜单」
 * （spec: ui-polish「浮层在垂直方向的定位」）。
 */
export function NodeMenu({
  items,
  anchor,
  onClose,
}: {
  items: MenuItem[];
  /** 触发它的「⋯」按钮：菜单据它实测的矩形决定朝上还是朝下展开。 */
  anchor: RefObject<Element | null>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // 行内菜单贴在触发按钮的右缘，与「⋯」位于行末的位置一致
  const position = useMenuPlacement({ open: true, anchor, menu: ref, align: 'right' });

  useMenuDismiss(ref, onClose, '.node-more');

  // portal 到 body：它是覆盖层，不能留在可能带 overflow 的祖先里被裁掉
  return createPortal(
    <div
      className="node-menu"
      role="menu"
      ref={ref}
      style={{
        top: position?.top ?? 0,
        left: position?.left,
        right: position?.right,
        // 向上展开时从底边长出：生长方向与它实际所在的一侧一致
        transformOrigin: position?.above ? 'bottom right' : 'top right',
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          className={item.danger ? 'danger' : undefined}
          onClick={(event) => {
            event.stopPropagation();
            item.onSelect();
            onClose();
          }}
        >
          <span className="node-menu-label">{item.label}</span>
          {item.shortcut && <span className="node-menu-shortcut">{item.shortcut}</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
