// 集合 / 目录的运行器：把一棵子树拍平成「按顺序执行」的请求列表，并按间隔一条条跑。
//
// 这里不碰界面、不碰网络：拍平只读树，执行循环只认「跑第 index 条」这个回调。因此
// 顺序、间隔与中止都能在没有 DOM、没有假时钟的环境里验清楚；界面只负责呈现每一步的结果。

import type { RequestExecutionOutcome } from './requestExecution';
import type { CollectionTree, SavedRequest, TreeNode } from './types';

/** 运行器里的一个待执行请求。 */
export interface RunRequest {
  /** 请求 id（也是勾选与结果的归属键）。 */
  id: string;
  name: string;
  method: string;
  /** 从集合根到它所在目录的路径（不含集合名），界面上用来区分同名请求。 */
  folderPath: string[];
  /** 树里带回来的请求本体：运行的是**已保存**的那一份，与打开的标签无关。 */
  request: SavedRequest;
}

/**
 * 拍平一棵子树：按树上的顺序深度优先，目录就地展开。
 *
 * 顺序取树上现有的排序（`children` 已按 `sort_order` 排好），因此运行顺序与用户看到的
 * 顺序一致；目录先展开再继续，与 Postman 的 run collection 一样。
 */
export function collectRunRequests(
  trees: CollectionTree[],
  target: { kind: 'collection' | 'folder'; id: string },
): RunRequest[] {
  const out: RunRequest[] = [];
  const walk = (nodes: TreeNode[], path: string[]) => {
    for (const node of nodes) {
      if (node.kind === 'folder') {
        walk(node.children, [...path, node.name]);
        continue;
      }
      // 请求节点缺 `request` 只可能来自后端裁剪过的树；这种条目跑不了，跳过而不是凭空造一条
      if (!node.request) continue;
      out.push({
        id: node.id,
        name: node.name,
        method: node.request.method,
        folderPath: path,
        request: node.request,
      });
    }
  };

  for (const tree of trees) {
    if (target.kind === 'collection') {
      if (tree.collection.id === target.id) walk(tree.children, []);
      continue;
    }
    const folder = findNode(tree.children, target.id);
    // 目录被删/被移走时找不到：返回空列表，界面显示「没有可运行的请求」
    if (folder && folder.kind === 'folder') walk(folder.children, [folder.name]);
  }

  return out;
}

function findNode(nodes: TreeNode[], id: string): TreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.kind === 'folder') {
      const below = findNode(node.children, id);
      if (below) return below;
    }
  }
  return null;
}

/** 一条请求在运行器里的结局。 */
export type RunStatus = 'pass' | 'fail' | 'error' | 'stopped';

export interface RunStepResult {
  status: RunStatus;
  /** 通过的断言数（跳过的算通过——它不是失败，明细里另有标注）。 */
  passed: number;
  /** 失败的断言数；`fail` 时大于 0。 */
  failed: number;
  /** `error` / `stopped` 的原因，或脚本抛错时的说明。 */
  message: string | null;
  /** 响应耗时（毫秒）；没有响应时为 0。 */
  elapsedMs: number;
}

/**
 * 把一次执行的结果折成运行器要的一行。
 *
 * 判定次序：取消 → 门禁 → 请求失败 → 断言失败 / 脚本报错 → 通过。取消排在最前，是因为
 * 它不该被算成失败（spec: http-engine「请求取消」）。没有写断言的一条算通过——它没断言
 * 可挂，不等于它挂了。
 */
export function statusOfOutcome(outcome: RequestExecutionOutcome): RunStepResult {
  const passed = outcome.assertions.filter((item) => item.passed || item.skipped).length;
  const failed = outcome.assertions.filter((item) => !item.passed && !item.skipped).length;
  const elapsedMs = outcome.response?.elapsed_ms ?? 0;

  if (outcome.cancelled) {
    return { status: 'stopped', passed, failed, message: '已停止', elapsedMs };
  }
  if (outcome.gated) {
    return {
      status: 'error',
      passed,
      failed,
      message: `集合「${outcome.gated.name}」的脚本未获准执行`,
      elapsedMs,
    };
  }
  if (outcome.error) {
    return { status: 'error', passed, failed, message: outcome.error.message, elapsedMs };
  }
  if (failed > 0 || outcome.scriptError) {
    return { status: 'fail', passed, failed, message: outcome.scriptError, elapsedMs };
  }
  return { status: 'pass', passed, failed, message: null, elapsedMs };
}

export interface RunSequenceOptions {
  /** 两条请求之间的等待（毫秒）；0 表示不等待。第一条之前不等待。 */
  intervalMs: number;
  /** 用户按下停止（或界面已关闭）：每一条开始前与间隔结束后各问一次。 */
  shouldStop?: () => boolean;
  /** 可注入的等待：测试用假时钟，生产用 setTimeout。 */
  wait?: (ms: number) => Promise<void>;
  /** 每跑完一条的回调，界面据此逐条上屏。 */
  onStep?: (index: number, result: RunStepResult) => void;
}

const defaultWait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * 按顺序跑 `count` 条，返回已经跑完的那些结果（被中止时是前缀）。
 *
 * 间隔放在两条之间而不是每条之前：最后一条跑完不必再等一次，否则「跑完了」与「还在转圈」
 * 之间会多出一段没有意义的空白。
 */
export async function runSequence(
  count: number,
  run: (index: number) => Promise<RunStepResult>,
  options: RunSequenceOptions,
): Promise<RunStepResult[]> {
  const shouldStop = options.shouldStop ?? (() => false);
  const wait = options.wait ?? defaultWait;
  const results: RunStepResult[] = [];

  for (let index = 0; index < count; index += 1) {
    if (shouldStop()) break;

    if (index > 0 && options.intervalMs > 0) {
      await wait(options.intervalMs);
      if (shouldStop()) break;
    }

    const result = await run(index);
    results.push(result);
    options.onStep?.(index, result);

    // 被取消的那一条自己会回报 `stopped`：不必等下一轮的 shouldStop 才收手
    if (result.status === 'stopped' || shouldStop()) break;
  }

  return results;
}
