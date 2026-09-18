import { useEffect, type ReactNode } from 'react';

export interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * 单例模态壳（change: rework-app-layout，design D5）。
 *
 * 低频面板（Cookie / 设置 / 导入导出）从常驻侧栏搬到这里：同一时间只由 App
 * 持有一个 `modal` 状态，因此「开一个再开另一个」天然是替换而非叠加。
 */
export function Modal({ title, onClose, children }: ModalProps) {
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
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <strong>{title}</strong>
          <span className="grow" />
          <button className="ghost" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
