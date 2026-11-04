import { useEffect, useMemo, useRef, useState } from 'react';
import { ScriptReport } from './ScriptReport';
import { detectResponseFormat, humanBytes, renderBody } from '../lib/sandbox';
import type { RequestExecutionOutcome, SentRequest } from '../lib/requestExecution';
import {
  runSequence,
  statusOfOutcome,
  type RunRequest,
  type RunStatus,
  type RunStepResult,
} from '../lib/requestRunner';
import type { BodyKind, ResponsePayload, SavedRequest } from '../lib/types';

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
 * 明细里正在看的那一面。
 *
 * 按「一次往返的哪一侧」切分，而不是按「头 / 体」切分：排查时的问句是"发出去的到底是
 * 什么""回来的到底是什么"，头与体是同一次发送的两部分，不该分成四个页签。
 */
type DetailTab = 'request' | 'response' | 'script';

const DETAIL_TABS: { key: DetailTab; label: string }[] = [
  { key: 'request', label: '请求' },
  { key: 'response', label: '响应' },
  { key: 'script', label: '脚本' },
];

/**
 * 没有正文原文时的说法。
 *
 * 后端只回带 `raw` 形态的正文，表单与二进制因此没有原文可给。这里说的是"为什么没有"，
 * 而不是留一片空白——空白读起来像"这条请求没带正文"，与事实相反。
 */
function emptyBodyNote(kind: BodyKind): string {
  switch (kind) {
    case 'none':
      return '这条请求没有正文。';
    case 'raw':
      return '正文为空。';
    case 'form_data':
      return '正文是 form-data 表单，运行器只呈现 raw 形态的原文。';
    case 'url_encoded':
      return '正文是 x-www-form-urlencoded 表单，运行器只呈现 raw 形态的原文。';
    case 'binary':
      return '正文是二进制文件，没有可呈现的原文。';
  }
}

/** 一组请求头 / 响应头：名称与值两列，值一律等宽并允许断行（签名、Cookie 都很长）。 */
function HeaderRows({
  title,
  rows,
  testId,
}: {
  title: string;
  rows: [string, string][];
  testId: string;
}) {
  return (
    <div className="runner-block">
      <div className="runner-block-title">{title}</div>
      {rows.length === 0 ? (
        <p className="runner-block-empty">没有{title}。</p>
      ) : (
        <table className="runner-headers" data-testid={testId}>
          <tbody>
            {rows.map(([name, value], index) => (
              <tr key={`${name}-${index}`}>
                <td className="mono">{name}</td>
                <td className="mono break-all">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * 「请求」页：本次**实际发出**的那一份。
 *
 * 与请求编辑器里显示的不是同一份东西——变量已解析、认证已落成、前置脚本的改写已合并。
 * 签名、`AccessKey` 这类只在运行时才有的头，只有在这里才看得到。
 */
function RequestDetail({ sent }: { sent: SentRequest | null }) {
  if (!sent) return <p className="runner-placeholder">这一次没有可呈现的请求。</p>;

  return (
    <div className="stack">
      <div className="runner-request-line" data-testid="runner-request-line">
        <span className="method-badge" data-method={sent.method}>
          {sent.method}
        </span>
        <span className="mono break-all">{sent.url}</span>
      </div>

      <HeaderRows title="请求头" rows={sent.headers} testId="runner-request-headers" />

      <div className="runner-block">
        <div className="runner-block-title">请求体</div>
        {sent.body ? (
          <pre className="runner-pre" data-testid="runner-request-body">
            {sent.body}
          </pre>
        ) : (
          <p className="runner-block-empty" data-testid="runner-request-body-empty">
            {emptyBodyNote(sent.bodyKind)}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * 「响应」页：与「请求」页同一个顺序——响应头在上、响应体在下。
 *
 * 头是"这一次到底带了什么"的清单，短、要逐行核；体本就长，放在最后，长就让它长，
 * 不会把别的东西推到折叠线以下。两页同序，来回切的时候不必重新找位置。
 */
function ResponseDetail({ response }: { response: ResponsePayload | null }) {
  if (!response) {
    return (
      <p className="runner-placeholder" data-testid="runner-no-response">
        这一次没有响应，也就没有响应头与正文。
      </p>
    );
  }

  // auto：按 Content-Type 检测结果格式化。大正文不套格式化器——那会把主线程占住，
  // 而这里只是"看一眼回来的东西"
  const rendered = response.pretty_available
    ? renderBody('auto', detectResponseFormat(response.content_type), response.body_text ?? '')
    : { view: 'text' as const, text: response.body_text ?? '' };

  return (
    <div className="stack">
      <HeaderRows title="响应头" rows={response.headers} testId="runner-response-headers" />

      <div className="runner-block">
        <div className="runner-block-title">响应体</div>
        {response.truncated && (
          <div className="notice warn" role="status" data-testid="runner-truncated">
            正文超过体积上限，界面只持有前{' '}
            {humanBytes(Math.min(response.size_bytes, response.size_limit_bytes))}。
          </div>
        )}
        {response.body_text === null ? (
          <p className="runner-block-empty">正文是二进制内容，没有可呈现的文本。</p>
        ) : (
          <pre className="runner-pre" data-testid="runner-response-body">
            {rendered.view === 'text' ? rendered.text : ''}
          </pre>
        )}
      </div>
    </div>
  );
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
 *
 * 明细按**一次往返的两侧**分「请求 / 响应 / 脚本」三个页签：跑挂之后要先能回答的问题依次是
 * "发出去的到底是什么""回来的是什么""脚本看见了什么"。请求页看的是**实际发出**的那一份
 * （变量已解析、认证已落成、前置脚本改过的头与正文已合并），不是编辑器里的草稿。
 * console 输出跟着断言留在「脚本」页：按请求归拢的这一份与混排的全局时间线不是同一件事。
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
  /**
   * 明细正在看哪一面。
   *
   * 默认落在「脚本」：跑集合的人点开某一条，多半是问"它为什么是这样"——断言与 console
   * 输出直接回答这个问题；请求与响应是进一步核对时才去的两页。
   *
   * 点一条就回到默认页（见 `openDetail`），而不是沿用上一面：上一面是上一条的语境，
   * 带着它跳到新的一条，等于替用户预设了这一条也要看响应。
   */
  const [detailTab, setDetailTab] = useState<DetailTab>('script');
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

  /** 在明细里打开某一条：除了换人，还要把页签交回默认那一面（「脚本」）。 */
  const openDetail = (id: string) => {
    setDetailId(id);
    setDetailTab('script');
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
    setDetailTab('script');
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

  /**
   * 「脚本」页签上的状态点：有断言才点，全通过是绿点、任一失败或脚本报错是红点。
   *
   * 与响应区的「脚本」页签同一套口径——断言现在退到了一个页签后面，没有这盏灯，
   * 失败就只剩名单行上那一个数字。
   */
  const scriptDot: 'pass' | 'fail' | null = detailOutcome
    ? detailOutcome.scriptError
      ? 'fail'
      : detailOutcome.assertions.length > 0
        ? detailOutcome.assertions.some((assertion) => !assertion.passed && !assertion.skipped)
          ? 'fail'
          : 'pass'
        : null
    : null;

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
                    onClick={() => openDetail(item.id)}
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
                        openDetail(item.id);
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
            <span className="grow" />
            {/* 页签只在这一条真有结果时出现：没有可看的东西时摆一排空页签只是噪声 */}
            {detail && detailResult && (
              <span className="tabs runner-tabs" role="tablist">
                {DETAIL_TABS.map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    role="tab"
                    aria-selected={detailTab === entry.key}
                    className={`tab ${detailTab === entry.key ? 'active' : ''}`}
                    onClick={() => setDetailTab(entry.key)}
                    data-testid={`runner-tab-${entry.key}`}
                  >
                    {entry.label}
                    {entry.key === 'script' && scriptDot && (
                      <span
                        className={`tab-dot ${scriptDot === 'fail' ? 'fail' : ''}`}
                        role="img"
                        aria-label={scriptDot === 'fail' ? '存在失败的断言' : '断言全部通过'}
                        title={scriptDot === 'fail' ? '存在失败的断言' : '断言全部通过'}
                      />
                    )}
                  </button>
                ))}
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
                  点「开始运行」跑完这一轮，再点左边的任意一行，这里会先给它的脚本输出与断言，请求与响应在另两个页签里。
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
                {/* 三个页签是这只请求的三面：发出去的是什么、回来的是什么、脚本看见了什么 */}
                {detailTab === 'request' && <RequestDetail sent={detailOutcome?.sent ?? null} />}
                {detailTab === 'response' && (
                  <ResponseDetail response={detailOutcome?.response ?? null} />
                )}
                {detailTab === 'script' && detailOutcome && (
                  <ScriptReport
                    console={detailOutcome.console}
                    assertions={detailOutcome.assertions}
                    error={detailOutcome.scriptError}
                  />
                )}
                {detailTab === 'script' && !detailOutcome && (
                  <p className="runner-placeholder">这一次没有脚本输出的记录。</p>
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
