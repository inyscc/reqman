// 编辑面注册表。
//
// 把「哪个面有未保存改动、怎么保存它」收敛到一处，供两个消费方使用：
// - `Ctrl+S`：保存 `top()` —— 当前生效的那一个面；
// - 未保存守卫：`dirty()` —— 全部有未保存改动的面。
//
// 这是纯逻辑，不依赖 React（组件侧的绑定见 useEditing.ts），与 store.ts /
// useStore.ts 的分层一致。

export interface EditingSurface {
  /** 稳定标识，重复注册同一 id 视为更新而不是新增。 */
  id: string;
  /** 越大越「当前」：模态 > 主区面板 > 请求。 */
  priority: number;
  /** 界面上的称呼，用于守卫提示「请求「X」有未保存的改动」。 */
  label: string;
  isDirty: () => boolean;
  /**
   * 保存这一面。返回 false 表示保存失败——失败原因由这一面自己呈现，
   * 调用方（守卫的「保存并继续」）据此决定**不**继续执行原操作。
   */
  save: () => Promise<boolean>;
  /**
   * 这一面此刻是否算「当前生效」的编辑面。默认 true。
   *
   * 用途是让 Ctrl+S 的判断与「用户正在看什么」一致：主区让给环境编辑器时，
   * 那个还没保存的请求仍然要参与未保存守卫（关窗时要提示），但它不是当前面，
   * 快捷键不该越过用户去保存它。
   */
  isActive?: () => boolean;
}

/** 三个层级，同层内不会同时挂载两个面。 */
export const SURFACE_PRIORITY = {
  request: 100,
  panel: 200,
  modal: 300,
} as const;

export interface EditingRegistry {
  /** 返回注销函数；同一 id 重复注册会替换既有面（不改变它在同优先级中的次序）。 */
  register(surface: EditingSurface): () => void;
  dirty(): EditingSurface[];
  top(): EditingSurface | null;
  /** 某个面的脏状态翻转时由组件调用，用来唤醒订阅者。 */
  touch(): void;
  subscribe(listener: () => void): () => void;
  /** 每次状态变化自增，供 useSyncExternalStore 判定快照是否变化。 */
  version(): number;
}

export function createEditingRegistry(): EditingRegistry {
  const surfaces = new Map<string, EditingSurface>();
  const listeners = new Set<() => void>();
  let revision = 0;

  const bump = () => {
    revision += 1;
    for (const listener of listeners) listener();
  };

  return {
    register(surface) {
      surfaces.set(surface.id, surface);
      bump();

      return () => {
        // 已被同 id 的新面取代时不要误删
        if (surfaces.get(surface.id) === surface) {
          surfaces.delete(surface.id);
          bump();
        }
      };
    },

    dirty: () => Array.from(surfaces.values()).filter((surface) => surface.isDirty()),

    top() {
      let best: EditingSurface | null = null;
      // Map 保持插入顺序，`>=` 让同优先级的后注册者胜出
      for (const surface of surfaces.values()) {
        if (surface.isActive && !surface.isActive()) continue;
        if (!best || surface.priority >= best.priority) best = surface;
      }
      return best;
    },

    touch: bump,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    version: () => revision,
  };
}
