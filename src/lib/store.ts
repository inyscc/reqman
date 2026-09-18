// 乐观更新 + 按实体串行化的状态层（design.md D2）。
//
// 前端立即反映编辑，异步提交后端，以后端返回的规范实体为准；失败时回滚到该
// 实体上一次已确认的快照，并把错误暴露给界面。同一实体的提交按序执行，避免
// 重排请求竞态；不同实体互不阻塞。
//
// 这里是纯逻辑，不依赖 React，因此可以直接被单测覆盖。

import { describeError } from './commands';
import type { AppError } from './types';

interface Overlay<T> {
  value: T;
  ticket: number;
}

export interface EntityStore<T extends { id: string }> {
  /** 当前应展示的值（乐观值优先）。 */
  get(id: string): T | undefined;
  /** 后端已确认的值。 */
  confirmed(id: string): T | undefined;
  list(): T[];
  seed(items: T[]): void;
  isDirty(id: string): boolean;
  markDirty(id: string): void;
  update(id: string, optimistic: T, commit: (value: T) => Promise<T>): Promise<void>;
  errors(): AppError[];
  clearErrors(): void;
  pending(): number;
  /** 是否有实体存在未提交的编辑（用于「未保存改动」提示）。 */
  dirtyIds(): string[];
  subscribe(listener: () => void): () => void;
  /** 每次状态变化自增，供 useSyncExternalStore 判定快照是否变化。 */
  version(): number;
}

export function createEntityStore<T extends { id: string }>(): EntityStore<T> {
  const confirmed = new Map<string, T>();
  const overlays = new Map<string, Overlay<T>>();
  const dirty = new Set<string>();
  const queues = new Map<string, Promise<unknown>>();
  const errors: AppError[] = [];
  const listeners = new Set<() => void>();

  let ticket = 0;
  let revision = 0;
  let inFlight = 0;

  const bump = () => {
    revision += 1;
    for (const listener of listeners) listener();
  };

  const store: EntityStore<T> = {
    get: (id) => overlays.get(id)?.value ?? confirmed.get(id),
    confirmed: (id) => confirmed.get(id),
    list: () => Array.from(confirmed.keys()).map((id) => store.get(id) as T),

    seed(items) {
      for (const item of items) confirmed.set(item.id, item);
      bump();
    },

    isDirty: (id) => dirty.has(id),

    markDirty(id) {
      dirty.add(id);
      bump();
    },

    dirtyIds: () => Array.from(dirty),

    async update(id, optimistic, commit) {
      const myTicket = ++ticket;
      overlays.set(id, { value: optimistic, ticket: myTicket });
      bump();

      const previous = queues.get(id) ?? Promise.resolve();
      const run = previous.then(async () => {
        inFlight += 1;
        try {
          const canonical = await commit(optimistic);
          confirmed.set(id, canonical);
          dirty.delete(id);
          // 只有当没有更新的乐观值覆盖时才清除
          if (overlays.get(id)?.ticket === myTicket) overlays.delete(id);
        } catch (error) {
          // 回滚到该实体上一次已确认的快照
          if (overlays.get(id)?.ticket === myTicket) overlays.delete(id);
          errors.push(describeError(error));
          throw error;
        } finally {
          inFlight -= 1;
          bump();
        }
      });

      // 队列里保留一个「不抛出」的版本，避免一次失败阻断后续提交
      queues.set(
        id,
        run.catch(() => undefined),
      );

      return run;
    },

    errors: () => [...errors],
    clearErrors: () => {
      errors.length = 0;
      bump();
    },

    pending: () => inFlight,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    version: () => revision,
  };

  return store;
}
