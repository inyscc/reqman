import { useEffect, useRef } from 'react';

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
 * 既有定位器失效。
 */
export function NodeMenu({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      // 菜单自身与「⋯」按钮内的点击交给各自的处理器，这里只处理「点到别处」
      if (target?.closest('.node-more')) return;
      if (ref.current && event.target instanceof Node && ref.current.contains(event.target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onScroll = () => onClose();

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose]);

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
