import { useRef } from 'react';
import { useMenuDismiss } from '../lib/useMenuDismiss';

export interface MenuItem {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

/**
 * 行内操作菜单：点击外部、Esc、容器滚动都会关闭（design D2）。
 *
 * 从集合树里提取出来共享——环境列表项用的是同一套交互（change:
 * add-collection-search-and-env-management，design D5），类名保持不变以免
 * 既有定位器失效。三条关闭规则来自 `useMenuDismiss`，下拉菜单用的是同一个实现。
 */
export function NodeMenu({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useMenuDismiss(ref, onClose, '.node-more');

  return (
    <div className="node-menu" role="menu" ref={ref}>
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
          {item.label}
        </button>
      ))}
    </div>
  );
}
