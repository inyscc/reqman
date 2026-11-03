// 全局 Console 面板的呈现（change: add-console-panel）。
//
// 每个用例各用一份 `createConsoleLog()`：面板的呈现不该依赖用例之间的先后。

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConsolePanel } from '../src/components/ConsolePanel';
import { createConsoleLog, type ConsoleLogStore, type RequestTrace } from '../src/lib/consoleLog';

function trace(overrides: Partial<RequestTrace> = {}): RequestTrace {
  return {
    sendId: 'send-1',
    requestId: 'req-1',
    method: 'POST',
    url: 'https://api.test/device/stream',
    startedAt: 1,
    requestHeaders: [['accept', 'application/json']],
    result: { kind: 'response', status: 200, statusText: 'OK', elapsedMs: 99 },
    responseHeaders: [['content-type', 'application/json']],
    body: '{"ok":true}',
    bodyTruncated: false,
    outputs: [],
    segments: { prerequest: [], test: [] },
    ...overrides,
  };
}

function setup(seed?: (store: ConsoleLogStore) => void) {
  const store = createConsoleLog();
  seed?.(store);
  render(<ConsolePanel store={store} onClose={() => undefined} />);
  return store;
}

/** 让列表有可视高度：happy-dom 里 scrollHeight/clientHeight 都是 0，滚不动也判定不了。 */
function stubScroll(element: HTMLElement, { scrollHeight = 1000, clientHeight = 100 } = {}) {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: clientHeight });
}

describe('条目的呈现', () => {
  it('还没有日志时给的是「还没有日志」，不是「没有匹配」', () => {
    setup();

    expect(screen.getByTestId('console-empty').textContent).toContain('还没有日志');
    expect(screen.queryByTestId('console-no-match')).toBeNull();
  });

  it('成功条目显示方法、URL、状态与耗时', () => {
    setup((store) => store.recordOutcome(trace()));

    expect(screen.getByText('POST')).toBeTruthy();
    expect(screen.getByText('https://api.test/device/stream')).toBeTruthy();
    expect(screen.getByTestId('console-status-response').textContent).toContain('200 OK');
    expect(screen.getByTestId('console-status-response').textContent).toContain('99 ms');
  });

  it('失败条目给出失败原因', () => {
    setup((store) =>
      store.recordOutcome(
        trace({ result: { kind: 'failed', message: '找不到主机' }, responseHeaders: null, body: null }),
      ),
    );

    expect(screen.getByTestId('console-status-failed').textContent).toContain('失败');
    expect(screen.getByTestId('console-status-failed').textContent).toContain('找不到主机');
  });

  it('取消与未发出各有自己的标记', () => {
    setup((store) => {
      store.recordOutcome(trace({ sendId: 'a', result: { kind: 'cancelled' } }));
      store.recordOutcome(
        trace({ sendId: 'b', result: { kind: 'not-sent', reason: '脚本执行未获准：我的集合' } }),
      );
    });

    expect(screen.getByTestId('console-status-cancelled').textContent).toContain('已取消');
    expect(screen.getByTestId('console-status-not-sent').textContent).toContain('未发出');
    expect(screen.getByTestId('console-status-not-sent').textContent).toContain('我的集合');
  });

  it('输出条目显示阶段、层级与级别', () => {
    setup((store) =>
      store.recordOutcome(
        trace({
          outputs: [
            { level: 'warn', phase: 'prerequest', segment: '集合层', values: [{ text: '注意' }] },
          ],
        }),
      ),
    );

    const tag = screen.getByText(/\[前置 · 集合层 · warn\]/);
    expect(tag).toBeTruthy();
    expect(screen.getByTestId('console-output-text').textContent).toContain('注意');

    // 来源排在行尾：先读到输出本身，再回头看它是谁写的（与网络条目同一种排法）
    const line = tag.closest('.console-line');
    expect(line?.lastElementChild).toBe(tag);
  });

  it('展开网络条目能看到请求头、响应头与正文', () => {
    setup((store) => store.recordOutcome(trace()));

    fireEvent.click(screen.getByText('https://api.test/device/stream'));

    expect(screen.getByText('请求头')).toBeTruthy();
    expect(screen.getByText('响应头')).toBeTruthy();
    expect(screen.getByTestId('console-body').textContent).toContain('{"ok":true}');
  });

  it('没有响应的条目展开后不伪造空响应', () => {
    setup((store) =>
      store.recordOutcome(
        trace({ result: { kind: 'failed', message: '超时' }, responseHeaders: null, body: null }),
      ),
    );

    fireEvent.click(screen.getByText('https://api.test/device/stream'));

    expect(screen.getByTestId('console-no-response')).toBeTruthy();
    expect(screen.queryByText('响应头')).toBeNull();
  });
});

describe('结构化值的展开', () => {
  it('展开对象条目能看到字段，内层再点一次才展开', () => {
    setup((store) =>
      store.recordOutcome(
        trace({
          outputs: [
            {
              level: 'log',
              phase: 'test',
              segment: '请求层',
              values: [{ text: '{"a":1,"nested":{"b":[1,2]}}', json: { a: 1, nested: { b: [1, 2] } } }],
            },
          ],
        }),
      ),
    );

    fireEvent.click(screen.getByTestId('console-output-text'));

    // 默认展开一层：顶层字段已经可见，内层还是收着的
    expect(screen.getByText('a:')).toBeTruthy();
    expect(screen.queryByText('b:')).toBeNull();

    const toggles = screen.getAllByTestId('console-json-toggle');
    // 最后一个可展开节点是 nested
    fireEvent.click(toggles[toggles.length - 1]);

    expect(screen.getByText('b:')).toBeTruthy();
  });

  it('没有结构的输出退化为纯文本，点开也不崩', () => {
    setup((store) =>
      store.recordOutcome(
        trace({
          outputs: [{ level: 'log', phase: 'test', segment: null, values: [{ text: '纯文本' }] }],
        }),
      ),
    );

    const line = screen.getByTestId('console-output-text').closest('button');
    expect(line?.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByTestId('console-structure')).toBeNull();
  });
});

describe('搜索与过滤', () => {
  function seed(store: ConsoleLogStore) {
    store.recordOutcome(trace({ sendId: 'a', url: 'https://open.test/device' }));
    store.recordOutcome(
      trace({
        sendId: 'b',
        url: 'https://api.test/health',
        outputs: [{ level: 'log', phase: 'test', segment: null, values: [{ text: 'ready' }] }],
      }),
    );
  }

  it('按 URL 片段搜索', () => {
    setup(seed);

    fireEvent.change(screen.getByTestId('console-search'), { target: { value: 'open.test' } });

    expect(screen.getAllByTestId('console-entry')).toHaveLength(1);
  });

  it('过滤类型只留该类条目', () => {
    setup(seed);

    fireEvent.click(screen.getByTestId('console-filter-output'));

    const entries = screen.getAllByTestId('console-entry');
    expect(entries).toHaveLength(1);
    expect(entries[0].getAttribute('data-kind')).toBe('output');
  });

  it('切回全部时被过滤掉的条目回来', () => {
    setup(seed);

    fireEvent.click(screen.getByTestId('console-filter-network'));
    expect(screen.getAllByTestId('console-entry')).toHaveLength(2);

    fireEvent.click(screen.getByTestId('console-filter-output'));
    expect(screen.getAllByTestId('console-entry')).toHaveLength(1);

    fireEvent.click(screen.getByTestId('console-filter-all'));
    expect(screen.getAllByTestId('console-entry')).toHaveLength(3);
  });

  it('搜索无命中时是「没有匹配」，与空态区分', () => {
    setup(seed);

    fireEvent.change(screen.getByTestId('console-search'), { target: { value: '查无此项' } });

    expect(screen.getByTestId('console-no-match')).toBeTruthy();
    expect(screen.queryByTestId('console-empty')).toBeNull();
  });
});

describe('跟随与清空', () => {
  it('停在末尾时跟随新条目', () => {
    const store = setup((store) => store.recordOutcome(trace({ sendId: 'a' })));

    const list = screen.getByTestId('console-list');
    stubScroll(list);
    // 停在末尾：scrollHeight - scrollTop - clientHeight = 0
    list.scrollTop = 900;
    fireEvent.scroll(list);

    act(() => store.recordOutcome(trace({ sendId: 'b' })));

    // 新条目到达后仍贴底，且不出现「回到底部」
    expect(list.scrollTop).toBe(1000);
    expect(screen.queryByTestId('console-jump')).toBeNull();
  });

  it('上滚查看旧条目后，新条目到达不把视图拉回去', () => {
    const store = setup((store) => store.recordOutcome(trace({ sendId: 'a' })));

    const list = screen.getByTestId('console-list');
    stubScroll(list);
    list.scrollTop = 0;
    fireEvent.scroll(list);

    expect(screen.getByTestId('console-jump')).toBeTruthy();

    act(() => store.recordOutcome(trace({ sendId: 'b' })));

    // 视图没被抢走：仍然停在用户看的地方
    expect(list.scrollTop).toBe(0);
    expect(screen.getByTestId('console-jump')).toBeTruthy();

    fireEvent.click(screen.getByTestId('console-jump'));
    expect(list.scrollTop).toBe(1000);
    expect(screen.queryByTestId('console-jump')).toBeNull();
  });

  it('清空立即生效，回到空态且不弹确认', () => {
    setup((store) => store.recordOutcome(trace()));

    fireEvent.click(screen.getByTestId('console-clear'));

    expect(screen.queryAllByTestId('console-entry')).toHaveLength(0);
    expect(screen.getByTestId('console-empty')).toBeTruthy();
  });
});
