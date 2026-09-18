// React 与状态层的绑定。选择器返回的值按引用比较，因此选择器应返回稳定引用
// （例如实体本身或数组的浅拷贝由调用方缓存）。

import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { EntityStore } from './store';

export function useStoreValue<T extends { id: string }, R>(
  store: EntityStore<T>,
  selector: (store: EntityStore<T>) => R,
  isEqual: (a: R, b: R) => boolean = Object.is,
): R {
  const cache = useRef<{ value: R; version: number } | null>(null);

  const getSnapshot = useCallback(() => {
    const version = store.version();
    if (cache.current && cache.current.version === version) {
      return cache.current.value;
    }
    const value = selector(store);
    if (cache.current && isEqual(cache.current.value, value)) {
      cache.current = { value: cache.current.value, version };
      return cache.current.value;
    }
    cache.current = { value, version };
    return value;
  }, [store, selector, isEqual]);

  return useSyncExternalStore(
    useCallback((listener) => store.subscribe(listener), [store]),
    getSnapshot,
    getSnapshot,
  );
}
