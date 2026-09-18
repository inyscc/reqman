// React 与编辑面注册表的绑定。
//
// 注册表以 prop 往下传（与 `client` 同一套注入思路），不做 Context：
// 需要的组件只有主区面板与模态里的面板两处，显式传参比再造一层 Provider 更好读。

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { EditingRegistry, EditingSurface } from './editing';

/**
 * 把一个编辑面注册进注册表。
 *
 * `isDirty` / `save` / `label` 会随每次 render 变化，因此注册时用 ref 代理读取，
 * 只在 id 变化时重新注册——否则每次按键都会注销重注册，还会打乱同优先级的次序。
 *
 * `registry` 传 undefined 时什么都不做（组件可以脱离 `App` 单独渲染）。
 */
export function useEditingSurface(
  registry: EditingRegistry | undefined,
  surface: EditingSurface,
): void {
  const latest = useRef(surface);
  latest.current = surface;
  const { id } = surface;

  useEffect(() => {
    if (!registry) return;

    const handle: EditingSurface = {
      id,
      get priority() {
        return latest.current.priority;
      },
      get label() {
        return latest.current.label;
      },
      get isActive() {
        return latest.current.isActive;
      },
      isDirty: () => latest.current.isDirty(),
      save: () => latest.current.save(),
    };

    return registry.register(handle);
  }, [registry, id]);

  // 脏状态翻转时唤醒订阅者：守卫与 Ctrl+S 据此重新判断
  const dirty = surface.isDirty();
  useEffect(() => {
    registry?.touch();
  }, [registry, dirty]);
}

/** 订阅注册表版本；返回值变化即意味着某个面的注册或脏状态变了。 */
export function useEditingRegistryVersion(registry: EditingRegistry): number {
  return useSyncExternalStore(
    useCallback((listener) => registry.subscribe(listener), [registry]),
    useCallback(() => registry.version(), [registry]),
    useCallback(() => registry.version(), [registry]),
  );
}
