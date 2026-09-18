import { describe, expect, it } from 'vitest';
import { createEntityStore } from '../src/lib/store';
import { defaultSettings, emptyAuth, emptyBody, type SavedRequest } from '../src/lib/types';

function request(id: string, url: string): SavedRequest {
  return {
    id,
    collection_id: 'c1',
    folder_id: null,
    name: id,
    method: 'GET',
    url,
    params: [],
    headers: [],
    body: emptyBody(),
    auth: emptyAuth(),
    settings: defaultSettings(),
    pre_request_script: null,
    test_script: null,
    sort_order: 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('乐观更新状态层', () => {
  it('乐观值在提交完成前即可见', async () => {
    const store = createEntityStore<SavedRequest>();
    store.seed([request('r1', 'https://a.test')]);

    const gate = deferred<SavedRequest>();
    const pending = store.update('r1', request('r1', 'https://edited.test'), () => gate.promise);

    expect(store.get('r1')?.url).toBe('https://edited.test');
    expect(store.confirmed('r1')?.url).toBe('https://a.test');

    gate.resolve(request('r1', 'https://edited.test'));
    await pending;

    expect(store.confirmed('r1')?.url).toBe('https://edited.test');
    expect(store.get('r1')?.url).toBe('https://edited.test');
  });

  it('提交成功后以后端返回的规范实体为准', async () => {
    const store = createEntityStore<SavedRequest>();
    store.seed([request('r1', 'https://a.test')]);

    // 后端把方法规范化成大写
    const canonical = { ...request('r1', 'https://a.test'), method: 'POST' };
    await store.update('r1', request('r1', 'https://b.test'), async () => canonical);

    expect(store.confirmed('r1')?.method).toBe('POST');
    expect(store.get('r1')?.url).toBe('https://a.test');
  });

  it('提交失败时回滚到上一次已确认的快照并报错', async () => {
    const store = createEntityStore<SavedRequest>();
    store.seed([request('r1', 'https://a.test')]);
    store.markDirty('r1');

    const failing = store.update('r1', request('r1', 'https://bad.test'), async () => {
      throw { code: 'storage_error', message: '写入失败' };
    });

    expect(store.get('r1')?.url).toBe('https://bad.test');

    await expect(failing).rejects.toBeTruthy();

    expect(store.get('r1')?.url).toBe('https://a.test');
    expect(store.errors()).toHaveLength(1);
    expect(store.errors()[0].code).toBe('storage_error');
    expect(store.isDirty('r1')).toBe(true);
  });

  it('同一实体的提交按调用顺序串行执行', async () => {
    const store = createEntityStore<SavedRequest>();
    store.seed([request('r1', 'https://a.test')]);

    const order: string[] = [];
    const firstGate = deferred<void>();

    const first = store.update('r1', request('r1', 'https://1.test'), async (value) => {
      order.push('first-start');
      await firstGate.promise;
      order.push('first-end');
      return value;
    });
    const second = store.update('r1', request('r1', 'https://2.test'), async (value) => {
      order.push('second-start');
      return value;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['first-start']);

    firstGate.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
    expect(store.confirmed('r1')?.url).toBe('https://2.test');
  });

  it('前一个提交失败不会阻断后续提交', async () => {
    const store = createEntityStore<SavedRequest>();
    store.seed([request('r1', 'https://a.test')]);

    const first = store.update('r1', request('r1', 'https://bad.test'), async () => {
      throw { code: 'storage_error', message: '失败' };
    });
    const second = store.update('r1', request('r1', 'https://good.test'), async (value) => value);

    await expect(first).rejects.toBeTruthy();
    await second;

    expect(store.confirmed('r1')?.url).toBe('https://good.test');
    expect(store.get('r1')?.url).toBe('https://good.test');
  });

  it('不同实体的提交互不阻塞', async () => {
    const store = createEntityStore<SavedRequest>();
    store.seed([request('r1', 'https://a.test'), request('r2', 'https://b.test')]);

    const gate = deferred<SavedRequest>();
    const slow = store.update('r1', request('r1', 'https://slow.test'), () => gate.promise);
    const fast = store.update('r2', request('r2', 'https://fast.test'), async (v) => v);

    await fast;
    expect(store.confirmed('r2')?.url).toBe('https://fast.test');
    expect(store.confirmed('r1')?.url).toBe('https://a.test');

    gate.resolve(request('r1', 'https://slow.test'));
    await slow;
    expect(store.confirmed('r1')?.url).toBe('https://slow.test');
  });

  it('未保存改动可被观测，保存成功后清除', async () => {
    const store = createEntityStore<SavedRequest>();
    store.seed([request('r1', 'https://a.test')]);

    expect(store.dirtyIds()).toEqual([]);
    store.markDirty('r1');
    expect(store.dirtyIds()).toEqual(['r1']);

    await store.update('r1', request('r1', 'https://saved.test'), async (v) => v);
    expect(store.dirtyIds()).toEqual([]);
  });

  it('状态变化会通知订阅者', async () => {
    const store = createEntityStore<SavedRequest>();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    store.seed([request('r1', 'https://a.test')]);
    expect(notifications).toBe(1);
    expect(store.version()).toBeGreaterThan(0);

    await store.update('r1', request('r1', 'https://b.test'), async (v) => v);
    expect(notifications).toBeGreaterThan(1);

    unsubscribe();
    store.seed([request('r2', 'https://c.test')]);
    expect(notifications).toBeGreaterThan(1);
  });
});
