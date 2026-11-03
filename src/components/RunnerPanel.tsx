import { useEffect, useMemo, useRef, useState } from 'react';
import { ScriptReport } from './ScriptReport';
import type { RequestExecutionOutcome } from '../lib/requestExecution';
import {
  runSequence,
  statusOfOutcome,
  type RunRequest,
  type RunStatus,
  type RunStepResult,
} from '../lib/requestRunner';
import type { SavedRequest } from '../lib/types';

export interface RunnerPanelProps {
  items: RunRequest[];
  /**
   * 集合的脚本尚未获准执行时为它的名字：这时先让人选「允许」还是「不跑脚本」，
   * 与发送路径上的门禁是同一件事（spec: 脚本来源的可执行性门禁）。
   */
  gate: { name: string } | null;
  /** 记住「允许执行」，之后不再问。 */
  onAllow: () => Promise<void>;
  /** 跑一条；`skipScripts` 来自门禁里的选择。 */
  execute: (
    request: SavedRequest,
    options: { skipScripts: boolean },
  ) => Promise<RequestExecutionOutcome>;
  /** 中止正在跑的那一条（脚本段与网络段一起撤）。 */
  cancelCurrent: () => void;
  onClose: () => void;
}

/** 每条请求的运行状态文案由同一张表给出，避免"红点配了绿灯的字"。 */
const STATUS_TEXT: Record<RunStatus, string> = {
  pass: '通过',
  fail: '有失败',
  error: '出错',
  stopped: '已停止',
};

/**
 * 行末那截摘要：只写这一条**自己**的事（通过/失败几条、耗时），状态由前面那颗圆点说。
 *
 * 顺序固定为「结论 · 计数」，不写成「通过 2 · 失败 1」那种罗列——一行只该有一个结论，
 * 混着念的摘要读起来像两个不同的结果。
 */
function summarize(result: RunStepResult): { text: string; ms: number } {
  const ms = result.elapsedMs;
  if (result.status === 'error') return { text: '出错', ms };
  if (result.status === 'stopped') return { text: '已停止', ms: 0 };
  if (result.status === 'fail') return { text: `失败 ${result.failed}`, ms };
  return { text: result.passed > 0 ? `通过 ${result.passed}` : '通过', ms };
}

/**
 * 设置项行末的说明入口：平时只是一个圈里的 i，悬停才把话说完。
 *
 * 挂在 `title` 上而不是自绘浮层——这条说明只在"想知道"时才需要，原生提示够用，
 * 也省掉一层定位与关闭逻辑。点它不该顺手勾上外层那一项，所以吃掉点击的默认行为。
 */
function Info({ title }: { title: string }) {
  return (
    <span
      className="runner-info"
      role="img"
      aria-label={title}
      title={title}
      onClick={(event) => event.preventDefault()}
    >
      i
    </span>
  );
}

/**
 * 集合 / 目录的运行器（change: collection-runner）。
 *
 * 打开时**默认全选**子树里的所有请求——运行集合最常见的意图就是"全跑一遍"，让人再勾一次
 * 是白费力气；取消部分才需要动手。执行按树上的顺序一条条来，两条之间按设定的间隔等待，
 * 停止按钮会立刻中止当前这条（脚本与网络一起撤），不等它自己跑完。
 *
 * 版面分三列，从左到右正好是一次运行的三个问题：**跑什么**（名单）、**跑成什么样**
 * （明细）、**怎么跑**（设置）。设置单独成一列而不是跟名单挤在同一行——"跑什么"和
 * "怎么跑"是两件事，各自的控件该有自己的位置；主按钮落在右列底部，与设置同在一处。
 *
 * 这里只呈现结果，不做判定：通过/失败由 `statusOfOutcome` 从执行结果里折出来，断言明细
 * 交给 `ScriptReport`——与响应区的「脚本」页签是同一个组件，两处口径不会分叉。
 */
export function RunnerPanel({
  items,
  gate,
  onAllow,
  execute,
  cancelCurrent,
  onClose,
}: RunnerPanelProps) {
  // 默认全选：运行集合就是"全都跑一遍"，取消个别的才需要动手
  const [selected, setSelected] = useState<Set<string>>(() => new Set(items.map((item) => item.id)));
  const [intervalText, setIntervalText] = useState('0');
  /** 间隔要显式打开：不勾即不等，与「失败时自动结束」是同一形状的两项设置。 */
  const [delayEnabled, setDelayEnabled] = useState(false);
  /**
   * 失败即停：一条判为失败 / 出错就不再往后跑。默认关闭——"跑完看全貌"和"断了就收手"
   * 是两种意图，谁也不该替用户先选；而一旦开了，这一轮就该留下说明，不能只是少跑几条。
   */
  const [stopOnFailure, setStopOnFailure] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<string, RunStepResult>>({});
  const [outcomes, setOutcomes] = useState<Record<string, RequestExecutionOutcome>>({});
  /** 因失败提前收手的现场：结果区据此说明"为什么后面没跑"。 */
  const [halt, setHalt] = useState<{
    index: number;
    name: string;
    status: RunStatus;
    remaining: number;
  } | null>(null);
  /** 正在跑的那一条：行的状态点据此显示"进行中"。 */
  const [activeId, setActiveId] = useState<string | null>(null);
  /** 明细面板里展示的那一条。 */
  const [detailId, setDetailId] = useState<string | null>(null);
  /** 门禁的选择：`null` 表示还没选（此时不能开跑）。 */
  const [gateChoice, setGateChoice] = useState<'allow' | 'skip' | null>(null);

  const stopRef = useRef(false);
  /** 间隔等待的提前兑现：停止时不必干等完整个间隔。 */
  const wakeRef = useRef<(() => void) | null>(null);
  /** 最新的取消出口：卸载时要用它收手，而不是用挂载那一刻的闭包。 */
  const cancelRef = useRef(cancelCurrent);
  cancelRef.current = cancelCurrent;

  /**
   * 关闭模态会直接卸载本组件（标题栏的 ×、Esc、点遮罩都走那条路），因此收尾挂在卸载上：
   * 不然关掉之后这一轮还会继续往后跑——界面没了，请求仍在发。
   */
  useEffect(
    () => () => {
      stopRef.current = true;
      wakeRef.current?.();
      cancelRef.current();
    },
    [],
  );

  const queued = useMemo(
    () => items.filter((item) => selected.has(item.id)),
    [items, selected],
  );
  // 没勾「请求之间等待」时，填的数字不生效——勾选框才是这一项的总开关
  const intervalMs = delayEnabled
    ? Math.max(0, Math.min(600_000, Number.parseInt(intervalText, 10) || 0))
    : 0;
  const gatePending = gate !== null && gateChoice === null;
  const done = Object.keys(results).length;

  /** 全场的通过 / 失败计数：右列的进度与结果标题右侧的小字都用它。 */
  const tally = useMemo(() => {
    let passed = 0;
    let failed = 0;
    for (const result of Object.values(results)) {
      if (result.status === 'pass') passed += 1;
      else if (result.status === 'fail' || result.status === 'error') failed += 1;
    }
    return { passed, failed };
  }, [results]);

  const toggle = (id: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wakeRef.current = null;
        resolve();
      }, ms);
      wakeRef.current = () => {
        clearTimeout(timer);
        wakeRef.current = null;
        resolve();
      };
    });

  const run = async () => {
    if (running || queued.length === 0) return;

    stopRef.current = false;
    setRunning(true);
    setResults({});
    setOutcomes({});
    setDetailId(null);
    setHalt(null);

    const skipScripts = gateChoice === 'skip';

    const ran = await runSequence(
      queued.length,
      async (index) => {
        const item = queued[index];
        setActiveId(item.id);
        const outcome = await execute(item.request, { skipScripts });
        setOutcomes((previous) => ({ ...previous, [item.id]: outcome }));
        return statusOfOutcome(outcome);
      },
      {
        intervalMs,
        stopOnFailure,
        shouldStop: () => stopRef.current,
        wait,
        onStep: (index, result) => {
          const item = queued[index];
          setResults((previous) => ({ ...previous, [item.id]: result }));
          // 跑完一条就把明细切到它：用户盯着的通常就是刚过去的那一条
          setDetailId((current) => current ?? item.id);
        },
      },
    );

    setActiveId(null);
    setRunning(false);

    // 停下来的是"失败"，还是用户按了停止？前者要交代剩余多少条没跑，后者界面已有停止按钮的语义
    const last = ran[ran.length - 1];
    if (
      stopOnFailure &&
      !stopRef.current &&
      last !== undefined &&
      ran.length < queued.length &&
      (last.status === 'fail' || last.status === 'error')
    ) {
      setHalt({
        index: ran.length,
        name: queued[ran.length - 1].name,
        status: last.status,
        remaining: queued.length - ran.length,
      });
      // 明细直接翻到断掉的那一条：收手之后要看的就是它，不该还停在第一条上
      setDetailId(queued[ran.length - 1].id);
    }
  };

  const stop = () => {
    stopRef.current = true;
    // 正在等待间隔时立刻醒来，不必干等
    wakeRef.current?.();
    cancelCurrent();
  };

  /** 关闭：还在跑就先停，别让执行在关掉的界面背后继续跑。 */
  const close = () => {
    if (running) stop();
    onClose();
  };

  const detail = detailId ? items.find((item) => item.id === detailId) : undefined;
  const detailOutcome = detailId ? outcomes[detailId] : undefined;
  const detailResult = detailId ? results[detailId] : undefined;

  return (
    <div className="runner">
      {gatePending && gate && (
        <div className="notice warn runner-gate" role="alert" data-testid="runner-gate">
          <p>
            集合「{gate.name}」带有脚本。执行后可以读写变量、经 <code>pm.sendRequest</code>{' '}
            发起网络请求。运行器会逐条执行这些脚本，因此先确认一次。
          </p>
          <div className="row">
            <button
              className="primary"
              onClick={() => {
                void onAllow().then(() => setGateChoice('allow'));
              }}
            >
              允许执行（记住此集合）
            </button>
            <button className="ghost" onClick={() => setGateChoice('skip')}>
              不执行脚本，仅发送请求
            </button>
          </div>
        </div>
      )}

      <div className="runner-body">
        <section className="runner-list-pane">
          <div className="runner-pane-head">
            <span className="runner-pane-title">待运行请求</span>
            <span className="runner-count" data-testid="runner-selection">
              已选 {selected.size} / {items.length}
            </span>
            <span className="runner-divider" aria-hidden="true" />
            <button
              type="button"
              className="runner-link"
              onClick={() => setSelected(new Set(items.map((item) => item.id)))}
              disabled={running}
            >
              全选
            </button>
            <span className="runner-divider" aria-hidden="true" />
            <button
              type="button"
              className="runner-link"
              onClick={() => setSelected(new Set())}
              disabled={running}
            >
              全不选
            </button>
          </div>

          {items.length === 0 ? (
            <p className="runner-placeholder">这个目标下还没有请求。</p>
          ) : (
            <ul
              className={`runner-list ${done > 0 ? 'has-results' : ''}`}
              data-testid="runner-list"
            >
              {items.map((item, index) => {
                const result = results[item.id];
                const status: RunStatus | 'idle' | 'running' =
                  item.id === activeId && running ? 'running' : (result?.status ?? 'idle');
                const summary = result ? summarize(result) : null;
                // 状态点跟着"已有结果或正在跑"出现：两条来源不同，但都该有一盏灯
                const showDot = summary !== null || status === 'running';
                return (
                  <li
                    key={item.id}
                    className={`runner-row ${detailId === item.id ? 'selected' : ''}`}
                    data-testid="runner-row"
                    data-status={status}
                    onClick={() => setDetailId(item.id)}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(item.id)}
                      disabled={running}
                      onChange={() => toggle(item.id)}
                      aria-label={`选择 ${item.name}`}
                    />
                    {/* 序号是执行顺序，不是行号：取消勾选后它跟着重排，一眼看得出谁先谁后 */}
                    <span className="runner-index" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="method-badge" data-method={item.method}>
                      {item.method}
                    </span>
                    <button
                      type="button"
                      className="runner-name"
                      onClick={(event) => {
                        event.stopPropagation();
                        setDetailId(item.id);
                      }}
                      title={[...item.folderPath, item.name].join(' / ')}
                    >
                      {item.name}
                    </button>
                    <span className="grow" />
                    <span
                      className="runner-status"
                      data-testid={summary ? 'runner-row-meta' : undefined}
                    >
                      {showDot && <span className={`runner-dot ${status}`} aria-hidden="true" />}
                      {summary ? (
                        <>
                          <span>{summary.text}</span>
                          {summary.ms > 0 && <span className="runner-ms">{summary.ms} ms</span>}
                        </>
                      ) : status === 'running' ? (
                        <span>运行中</span>
                      ) : (
                        // 提前收手后，没轮到的那些写「未执行」：空白看起来像"还在排队"
                        halt !== null && (
                          <span className="runner-skip" data-testid="runner-row-skip">
                            未执行
                          </span>
                        )
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="runner-result-pane">
          <div className="runner-pane-head">
            <span className="runner-pane-title">运行结果</span>
            {(tally.passed > 0 || tally.failed > 0) && (
              <span className="runner-tally" data-testid="runner-tally">
                {tally.passed > 0 && <span className="runner-tally-pass">通过 {tally.passed}</span>}
                {tally.failed > 0 && <span className="runner-tally-fail">失败 {tally.failed}</span>}
              </span>
            )}
          </div>

          {/* 少跑几条不能没有交代：说明是谁触发的收手、还剩多少条没跑 */}
          {halt && (
            <div className="runner-halt" role="status" data-testid="runner-halt">
              <span>
                第 {halt.index} 条「{halt.name}」{halt.status === 'error' ? '执行出错' : '有断言未通过'}
                ，已按设置结束本轮。
              </span>
              <span className="runner-halt-rest">其余 {halt.remaining} 条未执行。</span>
            </div>
          )}

          <div className="runner-detail" data-testid="runner-detail">
            {!detail && (
              <div className="runner-empty-state">
                <p className="runner-empty-title">还没有运行结果</p>
                <p className="runner-empty-hint">
                  点「开始运行」跑完这一轮，再点左边的任意一行，这里会显示它的响应、脚本输出与断言。
                </p>
              </div>
            )}
            {detail && !detailResult && (
              <p className="runner-placeholder">这一条还没有运行结果。</p>
            )}
            {detail && detailResult && (
              <>
                <div className="runner-detail-head">
                  {detail.folderPath.length > 0 && (
                    <span className="runner-detail-path">
                      {detail.folderPath.join(' / ')} /
                    </span>
                  )}
                  <strong className="runner-detail-name">{detail.name}</strong>
                  <span
                    className={`runner-pill ${detailResult.status}`}
                    data-testid="runner-detail-status"
                  >
                    {STATUS_TEXT[detailResult.status]}
                  </span>
                  {detailOutcome?.response && (
                    <span className="muted runner-detail-meta">
                      HTTP {detailOutcome.response.status} · {detailResult.elapsedMs} ms ·{' '}
                      {detailOutcome.response.size_bytes} B
                    </span>
                  )}
                </div>
                {/* 停止不是失败：它不该长成一条红色错误条（spec: http-engine「请求取消」） */}
                {detailResult.message && detailResult.status === 'stopped' && (
                  <p className="muted" data-testid="runner-detail-stopped">
                    {detailResult.message}
                  </p>
                )}
                {detailResult.message && detailResult.status !== 'stopped' && (
                  <div className="notice danger" role="alert" data-testid="runner-detail-error">
                    {detailResult.message}
                  </div>
                )}
                {detailOutcome && (
                  <ScriptReport
                    console={detailOutcome.console}
                    assertions={detailOutcome.assertions}
                    error={detailOutcome.scriptError}
                  />
                )}
              </>
            )}
          </div>
        </section>

        <aside className="runner-side">
          <div className="runner-rail-block">
            <div className="runner-card-head">执行设置</div>
            {/* 每项都是一样的形状：一个勾选框 + 一句说明它自己的话，左对齐竖排。
                需要额外解释的挂在行末的 ⓘ 上（悬停才出），不在行下压一段灰字 */}
            <div className="runner-settings">
              <label className="runner-setting">
                <input
                  type="checkbox"
                  checked={delayEnabled}
                  disabled={running}
                  onChange={(event) => setDelayEnabled(event.target.checked)}
                  data-testid="runner-delay-toggle"
                />
                <span className="runner-setting-text">
                  请求之间等待
                  <span className="runner-input">
                    <input
                      id="runner-interval"
                      type="number"
                      min={0}
                      max={600000}
                      step={100}
                      value={intervalText}
                      disabled={running || !delayEnabled}
                      onChange={(event) => setIntervalText(event.target.value)}
                    />
                    <span className="runner-unit">毫秒</span>
                  </span>
                </span>
                <Info title="第一条立即发出，之后每条之间等这么久。" />
              </label>

              <label className="runner-setting">
                <input
                  id="runner-stop-on-failure"
                  type="checkbox"
                  checked={stopOnFailure}
                  disabled={running}
                  onChange={(event) => setStopOnFailure(event.target.checked)}
                  data-testid="runner-stop-on-failure"
                />
                <span className="runner-setting-text">失败时自动结束</span>
                <Info title="任一条有断言未通过、脚本报错或请求出错，就停下，不再往后跑。" />
              </label>
            </div>
          </div>

          <div className="runner-rail-block">
            <div className="runner-card-head">运行进度</div>
            <div className="runner-stats">
              <div className="runner-stat">
                <strong>{done}</strong>
                <span>已完成</span>
              </div>
              <div className="runner-stat">
                <strong>{tally.passed}</strong>
                <span>通过</span>
              </div>
              <div className={`runner-stat ${tally.failed > 0 ? 'fail' : ''}`}>
                <strong>{tally.failed}</strong>
                <span>失败</span>
              </div>
            </div>

            <span className="runner-bar">
              <span style={{ width: `${queued.length ? (done / queued.length) * 100 : 0}%` }} />
            </span>
            {running ? (
              <p className="runner-hint" role="status" data-testid="runner-progress">
                正在执行 {done} / {queued.length}
              </p>
            ) : (
              <p className="runner-hint">
                {halt
                  ? `已执行 ${done} / ${queued.length} 条`
                  : done > 0
                    ? `本轮共 ${queued.length} 条`
                    : `共 ${queued.length} 条待运行`}
              </p>
            )}
          </div>

          {running ? (
            <button
              type="button"
              className="runner-action danger"
              onClick={stop}
              data-testid="runner-stop"
            >
              停止运行
            </button>
          ) : (
            <button
              type="button"
              className="primary runner-action"
              onClick={() => void run()}
              disabled={queued.length === 0 || gatePending}
              data-testid="runner-start"
            >
              开始运行
            </button>
          )}
          {!running && queued.length === 0 && (
            <p className="runner-hint runner-hint-center">至少勾选一条请求才能开始。</p>
          )}
        </aside>
      </div>

      <div className="runner-foot">
        <span className="runner-foot-note">运行的是已保存的请求；标签里未保存的改动不参与。</span>
        <span className="grow" />
        <button type="button" className="ghost" onClick={close} data-testid="runner-close">
          关闭
        </button>
      </div>
    </div>
  );
}
