// 运行器的两件纯逻辑：拍平子树、按顺序带间隔地跑。
//
// 这里刻意不碰 DOM：顺序、间隔与中止在纯函数里先验清楚，界面测试只关心"结果怎么呈现"。

import { describe, expect, it, vi } from 'vitest';
import {
  collectRunRequests,
  runSequence,
  statusOfOutcome,
  type RunStepResult,
} from '../src/lib/requestRunner';
import type { RequestExecutionOutcome } from '../src/lib/requestExecution';
import type { CollectionTree, SavedRequest, TreeNode } from '../src/lib/types';

function makeRequest(overrides: Partial<SavedRequest> = {}): SavedRequest {
  return {
    id: 'r1',
    collection_id: 'c1',
    folder_id: null,
    name: '请求',
    method: 'GET',
    url: 'https://api.test/x',
    params: [],
    headers: [],
    body: { kind: 'none', raw: '', raw_language: null, form: [], binary_path: null },
    auth: { kind: 'none', basic: null, bearer: null, apikey: null, inherit: false },
    settings: {
      follow_redirects: true,
      verify_tls: true,
      timeout_ms: 30000,
      proxy: null,
      http_version: 'auto',
    },
    pre_request_script: null,
    test_script: null,
    sort_order: 0,
    ...overrides,
  };
}

function requestNode(id: string, name: string, method = 'GET', sort = 0): TreeNode {
  return {
    kind: 'request',
    id,
    name,
    sort_order: sort,
    children: [],
    request: makeRequest({ id, name, method }),
  };
}

function folderNode(id: string, name: string, children: TreeNode[], sort = 0): TreeNode {
  return { kind: 'folder', id, name, sort_order: sort, children };
}

function tree(children: TreeNode[]): CollectionTree[] {
  return [
    {
      collection: {
        id: 'c1',
        workspace_id: 'w1',
        name: '我的集合',
        description: null,
        auth: { kind: 'none', basic: null, bearer: null, apikey: null, inherit: false },
        pre_request_script: null,
        test_script: null,
        sort_order: 0,
      },
      children,
    },
  ];
}

describe('拍平一棵子树', () => {
  it('按树上的顺序深度优先，目录就地展开并带上路径', () => {
    const trees = tree([
      requestNode('r1', '登录', 'POST', 0),
      folderNode(
        'f1',
        '用户',
        [
          requestNode('r2', '列表', 'GET', 0),
          folderNode('f2', '详情', [requestNode('r3', '按 id', 'GET', 0)], 1),
        ],
        1,
      ),
      requestNode('r4', '健康检查', 'GET', 2),
    ]);

    const items = collectRunRequests(trees, { kind: 'collection', id: 'c1' });

    // 顺序与树上一致：目录展开在它自己的位置上，不排到最后
    expect(items.map((item) => item.id)).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(items.map((item) => item.folderPath)).toEqual([[], ['用户'], ['用户', '详情'], []]);
    expect(items[1].method).toBe('GET');
  });

  it('目标是目录时只跑它自己的子树', () => {
    const trees = tree([
      requestNode('r1', '外层请求'),
      folderNode('f1', '用户', [
        requestNode('r2', '列表'),
        folderNode('f2', '详情', [requestNode('r3', '按 id')]),
      ]),
    ]);

    const items = collectRunRequests(trees, { kind: 'folder', id: 'f1' });

    expect(items.map((item) => item.id)).toEqual(['r2', 'r3']);
    // 路径从被选中的目录自己起算：界面上"用户 / 详情"已经够定位
    expect(items[1].folderPath).toEqual(['用户', '详情']);
  });

  it('空目录与找不到的目标都给出空名单，而不是抛错', () => {
    const trees = tree([folderNode('f1', '空目录', [])]);

    expect(collectRunRequests(trees, { kind: 'folder', id: 'f1' })).toEqual([]);
    // 目录在打开之后被删掉：这一轮没有可跑的，界面显示空态
    expect(collectRunRequests(trees, { kind: 'folder', id: 'gone' })).toEqual([]);
  });

  it('树上缺请求本体的节点被跳过', () => {
    const trees = tree([
      { kind: 'request', id: 'r9', name: '被裁剪过', sort_order: 0, children: [], request: null },
      requestNode('r1', '正常'),
    ]);

    expect(collectRunRequests(trees, { kind: 'collection', id: 'c1' }).map((item) => item.id)).toEqual(
      ['r1'],
    );
  });
});

function outcome(overrides: Partial<RequestExecutionOutcome> = {}): RequestExecutionOutcome {
  return {
    response: null,
    error: null,
    console: [],
    assertions: [],
    scriptError: null,
    visualizer: null,
    gated: null,
    cancelled: false,
    ...overrides,
  };
}

describe('一条请求的结局', () => {
  it('没有断言也算通过：没断言可挂不等于它挂了', () => {
    expect(statusOfOutcome(outcome()).status).toBe('pass');
  });

  it('断言全通过时是通过，并数出条数', () => {
    const result = statusOfOutcome(
      outcome({
        assertions: [
          { name: 'a', passed: true, skipped: false, error: null },
          { name: 'b', passed: true, skipped: false, error: null },
        ],
      }),
    );

    expect(result).toMatchObject({ status: 'pass', passed: 2, failed: 0 });
  });

  it('有断言失败就是失败（跳过的仍算通过）', () => {
    const result = statusOfOutcome(
      outcome({
        assertions: [
          { name: 'a', passed: false, skipped: false, error: '不成立' },
          { name: 'b', passed: false, skipped: true, error: null },
        ],
      }),
    );

    // 跳过的那条不是失败，因此通过数是 1、失败数是 1
    expect(result).toMatchObject({ status: 'fail', failed: 1, passed: 1 });
  });

  it('脚本抛错按失败算：后面的断言根本没机会注册', () => {
    const result = statusOfOutcome(outcome({ scriptError: '第 2 行：boom' }));

    expect(result.status).toBe('fail');
    expect(result.message).toBe('第 2 行：boom');
  });

  it('请求失败是出错，带上原因与耗时 0', () => {
    const result = statusOfOutcome(
      outcome({ error: { code: 'dns_failure', message: '找不到主机' } }),
    );

    expect(result).toMatchObject({ status: 'error', message: '找不到主机', elapsedMs: 0 });
  });

  it('门禁未获准是出错，不冒充失败', () => {
    const result = statusOfOutcome(outcome({ gated: { collectionId: 'c1', name: '我的集合' } }));

    expect(result.status).toBe('error');
    expect(result.message).toContain('我的集合');
  });

  it('取消优先：即使已经有断言，也不把这一条算成失败', () => {
    const result = statusOfOutcome(
      outcome({
        cancelled: true,
        assertions: [{ name: 'a', passed: false, skipped: false, error: 'x' }],
      }),
    );

    expect(result.status).toBe('stopped');
  });

  it('耗时取响应的 elapsed_ms', () => {
    const result = statusOfOutcome(
      outcome({
        response: {
          id: 'resp-1',
          status: 200,
          status_text: 'OK',
          elapsed_ms: 42,
          size_bytes: 2,
          truncated: false,
          headers: [],
          content_type: 'application/json',
          body_text: '{}',
          body_base64: null,
          pretty_available: true,
          pretty_print_threshold: 1024,
          size_limit_bytes: 1024,
          insecure_warning: false,
          final_url: 'https://api.test/x',
          request_url: 'https://api.test/x',
        },
      }),
    );

    expect(result.elapsedMs).toBe(42);
  });
});

function step(overrides: Partial<RunStepResult> = {}): RunStepResult {
  return { status: 'pass', passed: 0, failed: 0, message: null, elapsedMs: 0, ...overrides };
}

describe('顺序执行与间隔', () => {
  it('按顺序跑完，第一条之前不等待', async () => {
    const order: number[] = [];
    const waits: number[] = [];

    const results = await runSequence(
      3,
      async (index) => {
        order.push(index);
        return step();
      },
      { intervalMs: 500, wait: async (ms) => void waits.push(ms) },
    );

    expect(order).toEqual([0, 1, 2]);
    // 三条之间只有两次间隔：最后一条跑完不必再等
    expect(waits).toEqual([500, 500]);
    expect(results).toHaveLength(3);
  });

  it('间隔为 0 时不等', async () => {
    const wait = vi.fn(async () => {});

    await runSequence(2, async () => step(), { intervalMs: 0, wait });

    expect(wait).not.toHaveBeenCalled();
  });

  it('开跑前就要求停止时一条都不跑', async () => {
    const run = vi.fn(async () => step());

    const results = await runSequence(3, run, { intervalMs: 0, shouldStop: () => true });

    expect(run).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('在间隔里按了停止：下一秒不再开跑', async () => {
    const run = vi.fn(async () => step());
    let stopped = false;

    const results = await runSequence(3, run, {
      intervalMs: 100,
      shouldStop: () => stopped,
      // 间隔期间用户点了停止
      wait: async () => {
        stopped = true;
      },
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
  });

  it('某一条被取消（stopped）时立刻收手，不跑后面的', async () => {
    const run = vi
      .fn<(index: number) => Promise<RunStepResult>>()
      .mockResolvedValueOnce(step())
      .mockResolvedValueOnce(step({ status: 'stopped', message: '已停止' }));

    const results = await runSequence(5, run, { intervalMs: 0 });

    expect(run).toHaveBeenCalledTimes(2);
    expect(results.map((item) => item.status)).toEqual(['pass', 'stopped']);
  });

  it('每跑完一条就回报一次，界面据此逐条上屏', async () => {
    const seen: number[] = [];

    await runSequence(2, async () => step(), {
      intervalMs: 0,
      onStep: (index) => seen.push(index),
    });

    expect(seen).toEqual([0, 1]);
  });
});

describe('失败即停', () => {
  it('开了之后，判为失败就不再往后跑', async () => {
    const run = vi.fn(async () => step({ status: 'fail', failed: 1 }));

    const results = await runSequence(3, run, { intervalMs: 0, stopOnFailure: true });

    expect(run).toHaveBeenCalledTimes(1);
    // 没跑的那些不伪造结果：返回的只是已跑过的前缀
    expect(results).toHaveLength(1);
  });

  it('出错与失败同等对待', async () => {
    const run = vi.fn(async () => step({ status: 'error', message: '找不到主机' }));

    const results = await runSequence(3, run, { intervalMs: 0, stopOnFailure: true });

    expect(run).toHaveBeenCalledTimes(1);
    expect(results[0].status).toBe('error');
  });

  it('前面通过了，到失败那一条才收手', async () => {
    const run = vi
      .fn<(index: number) => Promise<RunStepResult>>()
      .mockResolvedValueOnce(step())
      .mockResolvedValueOnce(step())
      .mockResolvedValueOnce(step({ status: 'fail', failed: 1 }))
      .mockResolvedValue(step());

    const results = await runSequence(5, run, { intervalMs: 0, stopOnFailure: true });

    expect(run).toHaveBeenCalledTimes(3);
    expect(results.map((item) => item.status)).toEqual(['pass', 'pass', 'fail']);
  });

  it('全通过时与没开一样跑完', async () => {
    const run = vi.fn(async () => step());

    const results = await runSequence(3, run, { intervalMs: 0, stopOnFailure: true });

    expect(run).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(3);
  });

  it('没开就照旧跑完：失败只是结果之一，不是中断的理由', async () => {
    const run = vi.fn(async () => step({ status: 'fail', failed: 2 }));

    const results = await runSequence(3, run, { intervalMs: 0 });

    expect(run).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(3);
  });

  it('被取消的那条不因"失败即停"重复处理：仍然只跑一条', async () => {
    const run = vi.fn(async () => step({ status: 'stopped', message: '已停止' }));

    const results = await runSequence(4, run, { intervalMs: 0, stopOnFailure: true });

    expect(run).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
  });
});
