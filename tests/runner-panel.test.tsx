// 运行器的界面行为：默认全选、取消部分、逐条跑、结果与明细上屏、门禁与停止。
//
// 执行本身由 `request-runner.test.ts` 覆盖；这里给的是假 execute，只验界面接线。

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RunnerPanel } from '../src/components/RunnerPanel';
import type { RequestExecutionOutcome, SentRequest } from '../src/lib/requestExecution';
import type { RunRequest } from '../src/lib/requestRunner';
import type { ResponsePayload, SavedRequest } from '../src/lib/types';

function makeRequest(id: string, name: string, method = 'GET'): SavedRequest {
  return {
    id,
    collection_id: 'c1',
    folder_id: null,
    name,
    method,
    url: `https://api.test/${id}`,
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
  };
}

function item(id: string, name: string, method = 'GET', folderPath: string[] = []): RunRequest {
  return { id, name, method, folderPath, request: makeRequest(id, name, method) };
}

function sent(overrides: Partial<SentRequest> = {}): SentRequest {
  return {
    method: 'GET',
    url: 'https://api.test/r1',
    headers: [],
    bodyKind: 'none',
    body: null,
    ...overrides,
  };
}

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
    sent: sent(),
    ...overrides,
  };
}

function response(overrides: Partial<ResponsePayload> = {}): ResponsePayload {
  return {
    id: 'resp-1',
    status: 200,
    status_text: 'OK',
    elapsed_ms: 12,
    size_bytes: 21,
    truncated: false,
    headers: [['content-type', 'application/json']],
    content_type: 'application/json',
    body_text: '{"ok":true,"id":7}',
    body_base64: null,
    pretty_available: true,
    pretty_print_threshold: 1_000_000,
    size_limit_bytes: 8 * 1024 * 1024,
    insecure_warning: false,
    final_url: 'https://api.test/r1',
    request_url: 'https://api.test/r1',
    via_proxy: false,
    http_version: 'HTTP/1.1',
    unresolved: [],
    ...overrides,
  };
}

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof RunnerPanel>> = {},
) {
  const execute = vi.fn(async () => outcome());
  const onClose = vi.fn();
  const onAllow = vi.fn(async () => {});

  render(
    <RunnerPanel
      items={[item('r1', '登录', 'POST'), item('r2', '列表')]}
      gate={null}
      onAllow={onAllow}
      execute={execute}
      cancelCurrent={() => {}}
      onClose={onClose}
      {...overrides}
    />,
  );

  return { execute, onClose, onAllow };
}

describe('运行器的名单与选择', () => {
  it('默认全选：运行集合最常见的意图就是全跑一遍', () => {
    renderPanel();

    expect(screen.getByTestId('runner-selection').textContent).toContain('已选 2 / 2');
    // 只数名单里的勾选框：「失败时自动结束」那个不是选择，默认也不该是勾上的
    const boxes = screen.getAllByLabelText(/^选择 /) as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    expect(boxes.every((box) => box.checked)).toBe(true);
  });

  it('取消部分后计数随之变化，跑的时候只跑勾上的', async () => {
    const { execute } = renderPanel();

    fireEvent.click(screen.getByLabelText('选择 列表'));
    expect(screen.getByTestId('runner-selection').textContent).toContain('已选 1 / 2');

    fireEvent.click(screen.getByTestId('runner-start'));

    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute.mock.calls[0][0]).toMatchObject({ id: 'r1' });
  });

  it('全不选时运行按钮不可用', () => {
    renderPanel();

    fireEvent.click(screen.getByText('全不选'));

    expect((screen.getByTestId('runner-start') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('运行中的结果与明细', () => {
  it('每条跑完就在行上标出结果，失败的显示失败条数', async () => {
    const execute = vi.fn(async (request: SavedRequest) =>
      request.id === 'r2'
        ? outcome({
            assertions: [{ name: '正文为 JSON', passed: false, skipped: false, error: '不是 JSON' }],
          })
        : outcome({
            assertions: [{ name: '状态码 200', passed: true, skipped: false, error: null }],
          }),
    );
    renderPanel({ execute });

    fireEvent.click(screen.getByTestId('runner-start'));

    await waitFor(() => expect(screen.getAllByTestId('runner-row-meta')).toHaveLength(2));

    const rows = screen.getAllByTestId('runner-row');
    expect(rows[0].getAttribute('data-status')).toBe('pass');
    expect(rows[1].getAttribute('data-status')).toBe('fail');
    expect(rows[1].textContent).toContain('失败 1');
  });

  it('点开一条能看到它的断言与 console 输出', async () => {
    const execute = vi.fn(async () =>
      outcome({
        assertions: [{ name: '状态码 200', passed: true, skipped: false, error: null }],
        console: [
          { level: 'log', phase: 'test', segment: null, values: [{ text: '第一行\n第二行' }] },
        ],
      }),
    );
    renderPanel({ execute });

    fireEvent.click(screen.getByTestId('runner-start'));
    await waitFor(() => expect(screen.getByTestId('runner-detail-status')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '列表' }));
    // 断言与 console 归在「脚本」页签下，而明细默认就停在那一页

    expect(screen.getByTestId('script-assertions').textContent).toContain('状态码 200');

    // 换行由 CSS（`.script-console` 的 white-space: pre-wrap）保住，happy-dom 不加载样式表，
    // 所以两侧各验一半：文本本身带换行没被拆掉，且容器挂着那个样式钩子
    const list = screen.getByTestId('script-console');
    expect(list.classList.contains('script-console')).toBe(true);
    expect(list.textContent).toContain('第一行\n第二行');
  });

  it('失败时脚本页签上有一盏红灯：断言退到页签后面，不能只剩名单上那个数字', async () => {
    const execute = vi.fn(async () =>
      outcome({
        assertions: [{ name: '状态码 200', passed: false, skipped: false, error: null }],
      }),
    );
    renderPanel({ execute });

    fireEvent.click(screen.getByTestId('runner-start'));
    await waitFor(() => expect(screen.getByTestId('runner-detail-status')).toBeTruthy());

    const tab = screen.getByTestId('runner-tab-script');
    expect(tab.querySelector('.tab-dot.fail')).toBeTruthy();
  });

  it('请求失败时明细给出原因，不冒充"没有断言"', async () => {
    const execute = vi.fn(async () =>
      outcome({ error: { code: 'dns_failure', message: '找不到主机' } }),
    );
    renderPanel({ execute });

    fireEvent.click(screen.getByTestId('runner-start'));

    await waitFor(() => expect(screen.getByTestId('runner-detail-error').textContent).toContain('找不到主机'));
    expect(screen.getAllByTestId('runner-row')[0].getAttribute('data-status')).toBe('error');
  });
});

describe('明细的三页：请求 / 响应 / 脚本', () => {
  /** 一次走完全程的发送：请求侧有脚本加的头与正文，响应侧有正文与响应头。 */
  const withExchange = () =>
    vi.fn(async () =>
      outcome({
        response: response({
          request_headers: [['X-Sign', 'abc123']],
          request_body: '{"name":"x"}',
        }),
        sent: sent({
          method: 'POST',
          url: 'https://api.test/r1?sig=abc',
          headers: [
            ['X-Sign', 'abc123'],
            ['Content-Type', 'application/json'],
          ],
          bodyKind: 'raw',
          body: '{"name":"x"}',
        }),
      }),
    );

  it('默认停在「脚本」：跑完先给断言与输出，响应要点过去才看', async () => {
    renderPanel({ execute: withExchange() });

    fireEvent.click(screen.getByTestId('runner-start'));
    await waitFor(() =>
      expect(screen.getByTestId('runner-tab-script').getAttribute('aria-selected')).toBe('true'),
    );

    // 一页只讲一次往返的一侧：停在脚本页时，请求与响应的东西都不在
    expect(screen.queryByTestId('runner-response-body')).toBeNull();
    expect(screen.queryByTestId('runner-request-line')).toBeNull();

    fireEvent.click(screen.getByTestId('runner-tab-response'));
    expect(screen.getByTestId('runner-response-body').textContent).toContain('"ok"');
    expect(screen.getByTestId('runner-response-headers').textContent).toContain('content-type');
  });

  it('点另一条请求会回到「脚本」页：上一面的语境不跟着换人', async () => {
    renderPanel({ execute: withExchange() });

    fireEvent.click(screen.getByTestId('runner-start'));
    await waitFor(() => expect(screen.getAllByTestId('runner-row-meta')).toHaveLength(2));

    // 先自己切到「响应」，再点名单里的另一条
    fireEvent.click(screen.getByTestId('runner-tab-response'));
    expect(screen.getByTestId('runner-tab-response').getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getAllByTestId('runner-row')[1]);

    expect(screen.getByTestId('runner-tab-script').getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByTestId('runner-response-body')).toBeNull();
  });

  it('「请求」页是实际发出的那一份：目标、脚本加的头、实际正文', async () => {
    renderPanel({ execute: withExchange() });
    fireEvent.click(screen.getByTestId('runner-start'));
    await waitFor(() => expect(screen.getByTestId('runner-tab-request')).toBeTruthy());

    fireEvent.click(screen.getByTestId('runner-tab-request'));

    expect(screen.getByTestId('runner-request-line').textContent).toContain(
      'https://api.test/r1?sig=abc',
    );
    expect(screen.getByTestId('runner-request-body').textContent).toContain('"name"');
    expect(screen.getByTestId('runner-request-headers').textContent).toContain('X-Sign');
  });

  it('请求没发出去时，「响应」页说明没有响应，而不是留白', async () => {
    const execute = vi.fn(async () =>
      outcome({ error: { code: 'dns_failure', message: '找不到主机' } }),
    );
    renderPanel({ execute });

    fireEvent.click(screen.getByTestId('runner-start'));
    await waitFor(() => expect(screen.getByTestId('runner-tab-response')).toBeTruthy());

    fireEvent.click(screen.getByTestId('runner-tab-response'));

    await waitFor(() => expect(screen.getByTestId('runner-no-response')).toBeTruthy());
  });

  it('表单正文没有原文可给时，说明是哪一种形态', async () => {
    const execute = vi.fn(async () =>
      outcome({ sent: sent({ method: 'POST', bodyKind: 'form_data', body: null }) }),
    );
    renderPanel({ execute });
    fireEvent.click(screen.getByTestId('runner-start'));
    await waitFor(() => expect(screen.getByTestId('runner-tab-request')).toBeTruthy());

    fireEvent.click(screen.getByTestId('runner-tab-request'));

    expect(screen.getByTestId('runner-request-body-empty').textContent).toContain('form-data');
  });
});

describe('执行设置', () => {
  it('两项都是勾选框：默认都不勾，间隔的数字框在没勾时不可编辑', () => {
    renderPanel();

    const delay = screen.getByTestId('runner-delay-toggle') as HTMLInputElement;
    const stop = screen.getByTestId('runner-stop-on-failure') as HTMLInputElement;
    const interval = document.getElementById('runner-interval') as HTMLInputElement;

    expect(delay.checked).toBe(false);
    expect(stop.checked).toBe(false);
    // 勾选框是这一项的总开关：没勾时填的数字不生效，所以也不该让人填
    expect(interval.disabled).toBe(true);

    fireEvent.click(delay);
    expect(interval.disabled).toBe(false);
  });

  it('说明挂在行末的 ⓘ 上，不占行下的一段灰字', () => {
    renderPanel();

    expect(
      screen.getByLabelText('第一条立即发出，之后每条之间等这么久。'),
    ).toBeTruthy();
    expect(
      screen.getByLabelText('任一条有断言未通过、脚本报错或请求出错，就停下，不再往后跑。'),
    ).toBeTruthy();
  });
});

describe('失败时自动结束', () => {
  /** 第一条断言失败、其余通过：开了「失败即停」的话，只该跑第一条。 */
  const failingFirst = () =>
    vi.fn(async (request: SavedRequest) =>
      request.id === 'r1'
        ? outcome({
            assertions: [{ name: '状态码 200', passed: false, skipped: false, error: null }],
          })
        : outcome({
            assertions: [{ name: '状态码 200', passed: true, skipped: false, error: null }],
          }),
    );

  it('勾上后第一条失败就收手，并交代剩余几条没跑', async () => {
    const execute = failingFirst();
    renderPanel({ execute });

    fireEvent.click(screen.getByTestId('runner-stop-on-failure'));
    fireEvent.click(screen.getByTestId('runner-start'));

    await waitFor(() => expect(screen.getByTestId('runner-halt')).toBeTruthy());

    expect(execute).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('runner-halt').textContent).toContain('其余 1 条未执行');
    // 没轮到的那一行写明"未执行"，留白看起来像还在排队
    expect(screen.getByTestId('runner-row-skip').textContent).toContain('未执行');
  });

  it('默认不勾：失败也把剩下的跑完，不收手也不出现收手说明', async () => {
    const execute = failingFirst();
    renderPanel({ execute });

    fireEvent.click(screen.getByTestId('runner-start'));

    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('runner-halt')).toBeNull();
    expect(screen.queryByTestId('runner-row-skip')).toBeNull();
  });

  it('出错同样触发收手，说明里写的是"执行出错"', async () => {
    const execute = vi.fn(async () => outcome({ error: { code: 'dns_failure', message: '找不到主机' } }));
    renderPanel({ execute });

    fireEvent.click(screen.getByTestId('runner-stop-on-failure'));
    fireEvent.click(screen.getByTestId('runner-start'));

    await waitFor(() => expect(screen.getByTestId('runner-halt')).toBeTruthy());
    expect(screen.getByTestId('runner-halt').textContent).toContain('执行出错');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('收手后明细直接翻到断掉的那一条，不停在第一条上', async () => {
    const execute = vi.fn(async (request: SavedRequest) =>
      request.id === 'r2'
        ? outcome({
            assertions: [{ name: '状态码 200', passed: false, skipped: false, error: null }],
          })
        : outcome(),
    );
    renderPanel({
      execute,
      items: [item('r1', '登录', 'POST'), item('r2', '列表'), item('r3', '详情')],
    });

    fireEvent.click(screen.getByTestId('runner-stop-on-failure'));
    fireEvent.click(screen.getByTestId('runner-start'));

    await waitFor(() => expect(screen.getByTestId('runner-halt')).toBeTruthy());
    expect(screen.getByTestId('runner-detail').textContent).toContain('列表');
  });

  it('全通过时不出现收手说明，勾选状态保持不变', async () => {
    renderPanel();

    const check = screen.getByTestId('runner-stop-on-failure') as HTMLInputElement;
    fireEvent.click(check);
    fireEvent.click(screen.getByTestId('runner-start'));

    await waitFor(() => expect(screen.getAllByTestId('runner-row-meta')).toHaveLength(2));
    expect(screen.queryByTestId('runner-halt')).toBeNull();
    expect(check.checked).toBe(true);
  });
});

describe('脚本门禁与停止', () => {
  it('脚本未获准执行时先让人选，选之前不能开跑', async () => {
    const { onAllow } = renderPanel({ gate: { name: '我的集合' } });

    expect(screen.getByTestId('runner-gate')).toBeTruthy();
    expect((screen.getByTestId('runner-start') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByText('允许执行（记住此集合）'));

    await waitFor(() => expect(onAllow).toHaveBeenCalled());
    await waitFor(() =>
      expect((screen.getByTestId('runner-start') as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it('选择"不执行脚本"时，每一条都以跳过脚本的方式跑', async () => {
    const { execute } = renderPanel({ gate: { name: '我的集合' } });

    fireEvent.click(screen.getByText('不执行脚本，仅发送请求'));
    fireEvent.click(screen.getByTestId('runner-start'));

    await waitFor(() => expect(execute).toHaveBeenCalled());
    expect(execute.mock.calls[0][1]).toEqual({ skipScripts: true });
  });

  it('停止会中止在飞的那一条，并且不再往后跑', async () => {
    let resolveFirst: (value: RequestExecutionOutcome) => void = () => {};
    const execute = vi.fn(
      () =>
        new Promise<RequestExecutionOutcome>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const cancelCurrent = vi.fn(() => {
      // 真实实现里取消让这一次执行以 cancelled 收场
      resolveFirst(outcome({ cancelled: true }));
    });
    renderPanel({ execute, cancelCurrent });

    fireEvent.click(screen.getByTestId('runner-start'));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('runner-stop'));

    expect(cancelCurrent).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getAllByTestId('runner-row')[0].getAttribute('data-status')).toBe('stopped'),
    );
    // 第二条没开跑
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
