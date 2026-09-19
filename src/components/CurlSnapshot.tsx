import { useEffect, useRef, useState } from 'react';
import { describeError } from '../lib/commands';
import type { CurlCommand } from '../lib/types';

export interface CurlSnapshotState {
  command: string;
  warnings: string[];
  error: string | null;
  busy: boolean;
  copied: boolean;
}

export interface CurlSnapshot {
  open: boolean;
  toggle: () => void;
  /** 交给 CurlPanel 的属性包，便于调用方只做一次展开。 */
  panel: CurlSnapshotState & {
    onChangeCommand: (value: string) => void;
    onRegenerate: () => void;
    onCopy: () => void;
  };
}

/**
 * 请求带上的 cURL 快照（spec: 请求带上的 cURL 快照）。
 *
 * 语义上刻意是**快照**而不是跟随：展开时生成一次，之后请求再变也不覆盖文本块——
 * 「能改」正是这个功能的理由，自动跟随会在用户编辑时把内容冲掉。覆盖只能由用户点
 * 「重新生成」触发；收起即重置，所以再展开是重新生成（不留上一次的编辑）。
 */
export function useCurlSnapshot(onGenerate: () => Promise<CurlCommand>): CurlSnapshot {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<CurlSnapshotState>({
    command: '',
    warnings: [],
    error: null,
    busy: false,
    copied: false,
  });
  const copiedTimer = useRef<number | null>(null);

  const generate = async () => {
    setState((current) => ({ ...current, busy: true, error: null }));
    try {
      const result = await onGenerate();
      setState({
        command: result.command,
        warnings: result.warnings,
        error: null,
        busy: false,
        copied: false,
      });
    } catch (caught) {
      setState((current) => ({ ...current, busy: false, error: describeError(caught).message }));
    }
  };

  // 展开时生成一次；收起即清空（下次展开是重新生成）。
  // 刻意只依赖 open：展开期间请求变化不覆盖文本块，也不重新生成。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) {
      setState({ command: '', warnings: [], error: null, busy: false, copied: false });
      return;
    }
    void generate();
  }, [open]);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(state.command);
      setState((current) => ({ ...current, copied: true, error: null }));
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(
        () => setState((current) => ({ ...current, copied: false })),
        1500,
      );
    } catch (caught) {
      // 复制失败要说出来：静默失败会让人以为已经复制成功
      setState((current) => ({ ...current, error: describeError(caught).message }));
    }
  };

  return {
    open,
    toggle: () => setOpen((value) => !value),
    panel: {
      ...state,
      onChangeCommand: (value: string) => setState((current) => ({ ...current, command: value })),
      onRegenerate: () => void generate(),
      onCopy: () => void copy(),
    },
  };
}

/** 命令文本块：可编辑的多行文本 + 「重新生成」「复制」+ 生成结果给出的提示。 */
export function CurlPanel(props: CurlSnapshot['panel']) {
  const { command, warnings, error, busy, copied, onChangeCommand, onRegenerate, onCopy } = props;

  return (
    <div className="curl-block" data-testid="curl-block">
      {error && (
        <div className="notice danger" role="alert" data-testid="curl-error">
          {error}
        </div>
      )}

      <textarea
        className="curl-command"
        aria-label="curl 命令"
        rows={5}
        value={command}
        disabled={busy}
        onChange={(event) => onChangeCommand(event.target.value)}
      />

      {warnings.length > 0 && (
        <div className="notice warn" role="alert" data-testid="curl-warnings">
          {warnings.join('；')}
        </div>
      )}

      <div className="row">
        <span className="muted">可以就地修改这段命令，改动不会写回请求。</span>
        <span className="grow" />
        <button className="ghost" data-testid="curl-regenerate" onClick={onRegenerate} disabled={busy}>
          重新生成
        </button>
        <button data-testid="curl-copy" onClick={onCopy} disabled={busy || command === ''}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
    </div>
  );
}
