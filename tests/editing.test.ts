import { describe, expect, it, vi } from 'vitest';
import { createEditingRegistry, SURFACE_PRIORITY } from '../src/lib/editing';

function surface(
  id: string,
  priority: number,
  dirty: boolean,
): { id: string; priority: number; label: string; isDirty: () => boolean; save: () => Promise<void> } {
  return {
    id,
    priority,
    label: id,
    isDirty: () => dirty,
    save: async () => {},
  };
}

describe('编辑面注册表', () => {
  it('注册后 top 指向该面，注销后回落为 null', () => {
    const registry = createEditingRegistry();
    expect(registry.top()).toBeNull();

    const unregister = registry.register(surface('request', SURFACE_PRIORITY.request, false));
    expect(registry.top()?.id).toBe('request');

    unregister();
    expect(registry.top()).toBeNull();
  });

  it('多个面时 top 取优先级最高的一个', () => {
    const registry = createEditingRegistry();
    registry.register(surface('request', SURFACE_PRIORITY.request, true));
    registry.register(surface('panel', SURFACE_PRIORITY.panel, true));
    registry.register(surface('modal', SURFACE_PRIORITY.modal, false));

    // top 看的是「当前生效」，不是「谁脏」——模态盖住主区时它就是当前面
    expect(registry.top()?.id).toBe('modal');
  });

  it('同优先级取后注册者', () => {
    const registry = createEditingRegistry();
    registry.register(surface('first', SURFACE_PRIORITY.panel, false));
    registry.register(surface('second', SURFACE_PRIORITY.panel, false));

    expect(registry.top()?.id).toBe('second');
  });

  it('dirty 只返回标记为脏的面', () => {
    const registry = createEditingRegistry();
    registry.register(surface('clean', SURFACE_PRIORITY.request, false));
    registry.register(surface('dirty', SURFACE_PRIORITY.panel, true));

    expect(registry.dirty().map((item) => item.id)).toEqual(['dirty']);
  });

  it('isActive 为假的面不参与 top，但仍然算脏面', () => {
    const registry = createEditingRegistry();
    const hidden = { ...surface('request', SURFACE_PRIORITY.request, true), isActive: () => false };
    registry.register(hidden);

    // 快捷键不该越过用户去保存它（它此刻不是「当前面」）
    expect(registry.top()).toBeNull();
    // 但关窗时仍要提示，所以它还是脏面
    expect(registry.dirty().map((item) => item.id)).toEqual(['request']);
  });

  it('重复注册同一 id 视为更新，闭包读到的总是最新值', () => {
    const registry = createEditingRegistry();
    let dirty = false;
    const unregister = registry.register({
      id: 'request',
      priority: SURFACE_PRIORITY.request,
      label: '请求',
      isDirty: () => dirty,
      save: async () => {},
    });

    expect(registry.dirty()).toEqual([]);
    dirty = true;
    // 组件用 ref 代理时注册的稳定对象会读到最新闭包；这里用同一对象模拟
    expect(registry.dirty().map((item) => item.id)).toEqual(['request']);

    unregister();
    // 注销后不再出现，且不会误删同 id 的后来者
    const later = registry.register(surface('request', SURFACE_PRIORITY.request, true));
    expect(registry.dirty().map((item) => item.id)).toEqual(['request']);
    later();
    expect(registry.top()).toBeNull();
  });

  it('注册、注销与 touch 都会推进版本并通知订阅者', () => {
    const registry = createEditingRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);

    const before = registry.version();
    const unregister = registry.register(surface('request', SURFACE_PRIORITY.request, false));
    expect(registry.version()).toBeGreaterThan(before);
    expect(listener).toHaveBeenCalledTimes(1);

    registry.touch();
    expect(listener).toHaveBeenCalledTimes(2);

    unregister();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(registry.top()).toBeNull();
  });
});
