import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError } from '../lib/commands';
import { joinCurlParts, type CurlCommand, type CurlLayout } from '../lib/types';

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
 *
 * 布局是**配置**（应用级缺省 + 请求级三态，见 requestPreferences 的 `resolveCurlLineLayout`），
 * 由宿主解析后经 `layout` 传入：本钩子只负责按它把后端给的**同一份分段**拼出来，命令旁
 * 不再有任何开关（spec: ui-layout「cURL 命令布局」）。
 */
export function useCurlSnapshot(
  onGenerate: () => Promise<CurlCommand>,
  active: boolean,
  requestKey: string,
  /** 命令布局的生效值。改动它只重排既有分段，不重新请求后端。 */
  layout: CurlLayout,
): CurlSnapshot {
  const [state, setState] = useState<CurlSnapshotState>(EMPTY);
  const copiedTimer = useRef<number | null>(null);
  /** 生成回调经 ref 读取：它的身份每次渲染都在变，进依赖会变成死循环。 */
  const generate = useRef(onGenerate);
  generate.current = onGenerate;
  /** 作废在途生成：离开标签或换了请求后，旧结果不许再写回。 */
  const sequence = useRef(0);
  /**
   * 命令的**分段**（后端已 shell-quote）。两种布局都从它拼出来，因此布局改动不会让取值
   * 发生任何漂移（design D3）。
   */
  const parts = useRef<string[]>([]);
  /** 生效布局经 ref 读取：`load` 不因它改身份（否则改布局会触发一次重新生成）。 */
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const load = useCallback(async () => {
    const current = ++sequence.current;
    setState((previous) => ({ ...previous, busy: true, error: null }));
    try {
      const result = await generate.current();
      if (current !== sequence.current) return;
      parts.current = result.parts;
      setState({
        command: joinCurlParts(result.parts, layoutRef.current),
        warnings: result.warnings,
        error: null,
        busy: false,
        copied: false,
      });
    } catch (caught) {
      // 生成失败要说出来：静默失败会让人以为这段命令本来就是空的
      if (current !== sequence.current) return;
      parts.current = [];
      setState({ ...EMPTY, error: describeError(caught).message });
    }
  }, []);

  useEffect(() => {
    if (!active) {
      // 离开标签即清空：下次进来是重新生成，上一次的编辑不保留
      sequence.current += 1;
      parts.current = [];
      setState(EMPTY);
      return;
    }
    void load();
  }, [active, requestKey, load]);

  /**
   * 生效布局改动（用户在 Settings 里改了它）：按同一份分段重排，不重新生成。
   *
   * 这只是呈现方式的切换，因此**不会**把上一次的编辑内容带出去——改动布局的入口不在
   * 命令旁边（没有一次性开关），用户改的是「以后都这样」的配置。
   */
  useEffect(() => {
    if (!active || parts.current.length === 0) return;
    setState((current) => ({ ...current, command: joinCurlParts(parts.current, layout) }));
  }, [active, layout]);

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

      {/* 动作行在正文上方（spec: cURL 快照标签）：只有「重新生成」「复制」两个动作。
          布局与压缩都是**配置**，只有应用级 + 请求级两处入口——配置放成命令旁的一次性
          开关，用户改过一次、下次进来又回到配置值，反而难以察觉。 */}
      <div className="row curl-actions">
        <span className="grow" />
        <button
          type="button"
          className="text-action"
          data-testid="curl-regenerate"
          onClick={onRegenerate}
          disabled={busy}
        >
          重新生成
        </button>
        <button
          type="button"
          className="text-action"
          data-testid="curl-copy"
          onClick={onCopy}
          disabled={busy || command === ''}
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>

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
    </div>
  );
}
