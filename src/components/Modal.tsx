import { useEffect, type ReactNode } from 'react';

export interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 追加到 `.modal` 上的类名，用于按用途微调（如确认弹框收窄宽度）。 */
  className?: string;
}

/**
 * 单例模态壳（change: rework-app-layout，design D5）。
 *
 * 低频面板（Cookie / 设置 / 导入导出）从常驻侧栏搬到这里：同一时间只由 App
 * 持有一个 `modal` 状态，因此「开一个再开另一个」天然是替换而非叠加。
 */
export function Modal({ title, onClose, children, className }: ModalProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={className ? `modal ${className}` : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <strong>{title}</strong>
          <span className="grow" />
          {/* 与页面内窗口控制按钮的「关闭」区分开：同屏两个同名按钮对读屏是歧义 */}
          <button className="ghost" aria-label="关闭对话框" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
