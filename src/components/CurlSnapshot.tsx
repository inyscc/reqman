import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError } from '../lib/commands';
import type { CurlCommand } from '../lib/types';

export interface CurlSnapshotState {
  command: string;
  warnings: string[];
  error: string | null;
  busy: boolean;
  copied: boolean;
}

export interface CurlSnapshot extends CurlSnapshotState {
  onChangeCommand: (value: string) => void;
  onRegenerate: () => void;
  onCopy: () => void;
}

const EMPTY: CurlSnapshotState = {
  command: '',
  warnings: [],
  error: null,
  busy: false,
  copied: false,
};

/**
 * cURL 快照（spec: cURL 快照标签）。
 *
 * 语义是**每次进入即重新生成**：`active` 为真时按当前请求生成一次，离开标签即清空，
 * 编辑不跨标签留存——要留用改动后的命令，用户在离开前点「复制」。
 *
 * `requestKey` 也要参与触发：内层标签不会因为换了请求而复位（从树里打开另一条请求时
 * `innerTab` 仍停在 cURL），只盯"标签切换"会把上一条请求的命令留在屏幕上。因此生成
 * 的触发条件是「是否停在该标签」**且**「当前请求的身份」。
 */
export function useCurlSnapshot(
  onGenerate: () => Promise<CurlCommand>,
  active: boolean,
  requestKey: string,
): CurlSnapshot {
  const [state, setState] = useState<CurlSnapshotState>(EMPTY);
  const copiedTimer = useRef<number | null>(null);
  /** 生成回调经 ref 读取：它的身份每次渲染都在变，进依赖会变成死循环。 */
  const generate = useRef(onGenerate);
  generate.current = onGenerate;
  /** 作废在途生成：离开标签或换了请求后，旧结果不许再写回。 */
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const current = ++sequence.current;
    setState((previous) => ({ ...previous, busy: true, error: null }));
    try {
      const result = await generate.current();
      if (current !== sequence.current) return;
      setState({
        command: result.command,
        warnings: result.warnings,
        error: null,
        busy: false,
        copied: false,
      });
    } catch (caught) {
      // 生成失败要说出来：静默失败会让人以为这段命令本来就是空的
      if (current !== sequence.current) return;
      setState({ ...EMPTY, error: describeError(caught).message });
    }
  }, []);

  useEffect(() => {
    if (!active) {
      // 离开标签即清空：下次进来是重新生成，上一次的编辑不保留
      sequence.current += 1;
      setState(EMPTY);
      return;
    }
    void load();
  }, [active, requestKey, load]);

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
    ...state,
    onChangeCommand: (value: string) => setState((current) => ({ ...current, command: value })),
    onRegenerate: () => void load(),
    onCopy: () => void copy(),
  };
}

/** 命令文本块：可编辑的多行文本 + 「重新生成」「复制」+ 生成结果给出的提示。 */
export function CurlPanel(props: CurlSnapshot) {
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
