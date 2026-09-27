/**
 * 应用内的单例模态（design D5）。
 *
 * 除底栏的三个入口之外，还包含「复制被未保存改动挡下」这一提示——它同样走这一个状态，
 * 因此界面上任意时刻至多一个遮罩（design D9）。
 */
export type ModalKind = 'cookies' | 'settings' | 'import-export' | 'copy-blocked';

export interface BottomBarProps {
  busy: boolean;
  error: string | null;
  /** 乐观提交失败的条数；大于 0 时给出查看入口。 */
  optimisticErrors: number;
  onShowOptimisticErrors: () => void;
  onOpenModal: (kind: ModalKind) => void;
  /** 工作区就绪前导入导出不可用（与改造前一致）。 */
  importExportDisabled: boolean;
}

/** 底部状态条（design D7）：左侧状态，右侧低频面板入口。 */
export function BottomBar({
  busy,
  error,
  optimisticErrors,
  onShowOptimisticErrors,
  onOpenModal,
  importExportDisabled,
}: BottomBarProps) {
  const status = busy ? '发送中…' : error ? '有错误，详见请求区' : '就绪';

  return (
    <footer className="status-bar">
      <span className="status-text" data-testid="status-bar">
        {status}
      </span>
      {optimisticErrors > 0 && (
        <button className="ghost" onClick={onShowOptimisticErrors}>
          查看 {optimisticErrors} 个提交失败
        </button>
      )}
      <span className="grow" />
      <button className="ghost" onClick={() => onOpenModal('cookies')}>
        Cookie
      </button>
      <button className="ghost" onClick={() => onOpenModal('settings')}>
        设置
      </button>
      <button
        className="ghost"
        disabled={importExportDisabled}
        onClick={() => onOpenModal('import-export')}
      >
        导入/导出
      </button>
    </footer>
  );
}
