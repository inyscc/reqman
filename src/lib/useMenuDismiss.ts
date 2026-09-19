import { useEffect, type RefObject } from 'react';

/**
 * 浮层的关闭规则（spec: 通用下拉的观感与菜单行为；design D2）。
 *
 * 三条：**点击菜单与豁免选择器之外的地方**、**Esc**、**容器滚动**（capture 阶段，
 * 祖先滚动也算）。三条都不调用 bridge、不改数据——只退出浮层。
 *
 * 这套规则原本写在 `NodeMenu` 里，现在抽出来由行内菜单与 `Dropdown` 共用：两处
 * 的关闭语义在 spec 里是同一套，复制一份等于承诺它们会一起漂移。
 *
 * 调用方都是条件渲染（菜单挂载 = 打开），但监听在这里始终挂着，收起时调用 close
 * 只是把已经是 false 的状态再设一次，React 会自行跳过。
 */
export function useMenuDismiss(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  exemptSelector?: string,
): void {
  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      // 菜单自身的触发器（行内菜单的「⋯」）由各自的处理器开关，这里只处理「点到别处」
      if (exemptSelector && target?.closest(exemptSelector)) return;
      if (ref.current && target instanceof Node && ref.current.contains(target)) return;
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
  }, [ref, onClose, exemptSelector]);
}
