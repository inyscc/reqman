/**
 * 应用内的单例模态（design D5）。
 *
 * 除底栏的三个入口之外，还包含「复制被未保存改动挡下」这一提示——它同样走这一个状态，
 * 因此界面上任意时刻至多一个遮罩（design D9）。
 */
export type ModalKind = 'cookies' | 'settings' | 'import-export' | 'copy-blocked';

export interface BottomBarProps {
  /**
   * 是否存在**在飞发送**（spec: ui-layout「底部状态条」）。
   *
   * 刻意不是 `busy`：保存请求、保存脚本与改名也在「忙」，但它们与「发送中」这条文案无关——
   * 用 `busy` 会让保存时底栏误报发送中。
   */
  sending: boolean;
  error: string | null;
  /** 乐观提交失败的条数；大于 0 时给出查看入口。 */
  optimisticErrors: number;
  onShowOptimisticErrors: () => void;
  onOpenModal: (kind: ModalKind) => void;
  /** 工作区就绪前导入导出不可用（与改造前一致）。 */
  importExportDisabled: boolean;
  /** Console 抽屉是否开着：入口要能看出这一点。 */
  consoleOpen: boolean;
  onToggleConsole: () => void;
}

/** 底部状态条（design D7）：左侧状态，右侧低频面板入口。 */
export function BottomBar({
  sending,
  error,
  optimisticErrors,
  onShowOptimisticErrors,
  onOpenModal,
  importExportDisabled,
  consoleOpen,
  onToggleConsole,
}: BottomBarProps) {
  const status = sending ? '发送中…' : error ? '有错误，详见请求区' : '就绪';

  return (
    <footer className="status-bar">
      <span className="status-text" data-testid="status-bar">
        {status}
      </span>
      {optimisticErrors > 0 && (
        <button className="ghost status-action" onClick={onShowOptimisticErrors}>
          查看 {optimisticErrors} 个提交失败
        </button>
      )}
      <span className="grow" />
      {/* Console 与右边三个不同：它是抽屉，不是模态。开合状态直接反映在入口上，
          否则用户看不出「我上次到底把它关掉了没有」 */}
      <button
        className={`ghost ${consoleOpen ? 'active' : ''}`}
        aria-pressed={consoleOpen}
        data-testid={consoleOpen ? 'console-toggle-open' : 'console-toggle-closed'}
        onClick={onToggleConsole}
      >
        Console
      </button>
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
