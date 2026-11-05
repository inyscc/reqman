// 变量候选的交互状态机（change: suggest-variables-while-typing，任务 2.1）。
//
// 与 `usePlaceholderHover` 的关系：那个管「指针停在哪」，这个管「光标正在输入什么」。
// 两者都挂在**同一个 input 自己的事件**上，因此一份 hook 可以服务整张键值表——行数是
// 用户可控的，在 `map` 里调 hook 会把调用顺序交给数据。
//
// 三条硬约束：
// 1. **焦点不许丢**：候选项的 `mousedown` 被 `preventDefault` 掉（见 `VariableSuggest.tsx`），
//    所以点击不会让输入框失焦；这里的 `onBlur` 只是兜底。
// 2. **插入后光标要归位**：受控输入的重新渲染会把光标丢到末尾，因此写入走 `flushSync`
//    提交、紧接着同步 `setSelectionRange`（design D3）。
// 3. **打开时才取列表**：变量可能在别处刚被改过，因此每次从关闭转为打开都带 `refresh`
//    重新装载一次（design D5）。

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { flushSync } from 'react-dom';
import { caretRectAt } from './placeholders';
import type { VariableCandidate, VariableCatalog } from './variableHover';
import {
  applySuggestion,
  filterCandidates,
  suggestContext,
  type SuggestContext,
} from './variableSuggest';

/** 浮层锚点：触发它的那个 `{{` 在视口里的位置。 */
export interface SuggestAnchor {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

export interface VariableSuggestHandlers {
  onChange(event: ChangeEvent<HTMLInputElement>): void;
  /**
   * 处理一个按键；返回 `true` 表示候选已接管（调用方 SHALL NOT 再处理它）。
   *
   * 用返回值而不是全局 `defaultPrevented`：参数表幽灵行的回车有自己的含义（提交并跳到
   * 下一行），两段逻辑都挂在同一个 input 上，靠返回值让位比读事件状态更直接。
   */
  onKeyDown(event: KeyboardEvent<HTMLInputElement>): boolean;
  onClick(event: MouseEvent<HTMLInputElement>): void;
  onBlur(): void;
  onCompositionStart(): void;
  onCompositionEnd(event: CompositionEvent<HTMLInputElement>): void;
}

export interface VariableSuggestView {
  /** 当前候选；空数组表示「有触发但没有匹配」，浮层里呈现空态说明。 */
  items: VariableCandidate[];
  activeIndex: number;
  /** 非 null 表示浮层正在显示，值即它的锚点。 */
  anchor: SuggestAnchor | null;
  /** 给某个输入框绑定一套处理器；`apply` 把「整段新文本」写回它自己的模型。 */
  bind(apply: (next: string) => void): VariableSuggestHandlers;
  /** 选中第 index 项（鼠标点选也走它）。 */
  accept(index: number): void;
  /** 把高亮移到第 index 项（鼠标划过时用）。 */
  activate(index: number): void;
  close(): void;
}

interface Session {
  input: HTMLInputElement;
  apply: (next: string) => void;
  context: SuggestContext;
  all: VariableCandidate[];
}

interface Snapshot {
  anchor: SuggestAnchor;
  items: VariableCandidate[];
  activeIndex: number;
}

/** 同一份名字列表：过滤后如果内容没变，高亮项就不该被重置。 */
function sameItems(left: VariableCandidate[], right: VariableCandidate[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item.name === right[index].name)
  );
}

export function useVariableSuggest(source: VariableCatalog | null): VariableSuggestView {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const composingRef = useRef(false);
  const aliveRef = useRef(true);

  // 卸载后不再写 state。**必须在这里把标志置回 true**：StrictMode 会把 effect 走
  // 「挂载 → 清理 → 再挂载」一遍，只在清理里置 false、不在挂载时置回，第二次挂载后
  // 这个组件就永远拿不到候选了（浏览器的真实表现是「敲了 `{{`，什么都不弹」）。
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const close = useCallback(() => {
    sessionRef.current = null;
    setSnapshot(null);
  }, []);

  /** 按输入框当前的光标位置重算候选；光标离开那个 `{{` 时直接收起。 */
  const render = useCallback(
    (session: Session) => {
      const { input } = session;
      const context = suggestContext(input.value, input.selectionStart ?? input.value.length);
      if (!context) {
        close();
        return;
      }

      session.context = context;
      const items = filterCandidates(session.all, context.query);
      const anchor = caretRectAt(input, context.start);

      setSnapshot((current) => ({
        anchor,
        items,
        // 过滤结果变了就回到第一项：否则高亮会停在「上一个列表的第 3 项」这种莫名位置
        activeIndex:
          current && sameItems(current.items, items)
            ? Math.min(current.activeIndex, Math.max(items.length - 1, 0))
            : 0,
      }));
    },
    [close],
  );

  const open = useCallback(
    (input: HTMLInputElement, apply: (next: string) => void) => {
      if (!source) return;
      if (!suggestContext(input.value, input.selectionStart ?? input.value.length)) {
        close();
        return;
      }

      const session = sessionRef.current;
      // 同一个输入框继续键入：列表已经在手上，只重算过滤，不再问后端
      if (session && session.input === input) {
        session.apply = apply;
        render(session);
        return;
      }

      // 换了输入框 / 首次打开：取一次列表。取到之前**不打开**浮层——先闪一下「没有匹配」
      // 是错的，那会让用户以为这个作用域里真的没有变量。
      const next: Session = {
        input,
        apply,
        context: { start: 0, end: 0, query: '' },
        all: [],
      };
      sessionRef.current = next;

      void source
        .candidates({ refresh: true })
        .then((items) => {
          if (!aliveRef.current || sessionRef.current !== next) return;
          next.all = items;
          render(next);
        })
        .catch(() => {
          if (aliveRef.current && sessionRef.current === next) close();
        });
    },
    [source, close, render],
  );

  const activate = useCallback((index: number) => {
    setSnapshot((current) =>
      current && current.activeIndex !== index ? { ...current, activeIndex: index } : current,
    );
  }, []);

  /**
   * 光标可能刚被键盘挪动（←/→/Home/End）：等默认行为把光标放到新位置后重算一次。
   *
   * 为什么不留到下一次输入：把光标移出那个 `{{` 之后，浮层若还挂着，它锚的就是一个用户
   * 已经离开的位置——而回车又会把候选插到别处。因此这几颗键要主动复核一次。
   */
  const recheck = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;

    window.setTimeout(() => {
      if (aliveRef.current && sessionRef.current === session) render(session);
    }, 0);
  }, [render]);

  const accept = useCallback(
    (index: number) => {
      const session = sessionRef.current;
      if (!session) return;

      const { input } = session;
      // 以此刻的光标为准重算一次范围：浮层开着的时候光标可能被挪动过
      const context =
        suggestContext(input.value, input.selectionStart ?? input.value.length) ?? session.context;
      const item = filterCandidates(session.all, context.query)[index];
      if (!item) return;

      const edit = applySuggestion(input.value, context, item.name);

      // 先提交这次写入，再把光标放回插入点之后。反过来的话，受控渲染会把光标顶到末尾，
      // 用户接着敲的第一个字符就落到整段文本的最后面。
      flushSync(() => session.apply(edit.text));
      input.setSelectionRange(edit.caret, edit.caret);
      close();
    },
    [close],
  );

  // 候选要接住指针（点选），因此不能像悬停提示那样永驻——浮层之外按下指针即收起。
  // 用捕获阶段听 `mousedown`：等冒泡到 document 时，别的控件可能已经吃掉了这次事件。
  const isOpen = snapshot !== null;

  useEffect(() => {
    if (!isOpen) return;

    const onPointerDown = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (target instanceof Element && target.closest('[data-variable-suggest]')) return;
      // 点回输入框自己不算「在浮层之外」：那是一次光标位移，交给 onClick 重算
      const session = sessionRef.current;
      if (session && session.input.contains(target)) return;
      close();
    };

    // 浮层是 fixed 的，祖先容器一滚锚点就失效了（与悬停提示同一条理由）
    const onScroll = () => close();

    document.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [isOpen, close]);

  const bind = (apply: (next: string) => void): VariableSuggestHandlers => ({
    onChange: (event) => {
      // 组字期间不重算：选字时列表跟着变会把候选整段换掉
      if (composingRef.current) return;
      open(event.currentTarget, apply);
    },
    onClick: (event) => {
      open(event.currentTarget, apply);
    },
    onBlur: () => close(),
    onCompositionStart: () => {
      composingRef.current = true;
    },
    onCompositionEnd: (event) => {
      composingRef.current = false;
      open(event.currentTarget, apply);
    },
    onKeyDown: (event) => {
      if (!snapshot) return false;
      const count = snapshot.items.length;

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setSnapshot((current) =>
            current
              ? { ...current, activeIndex: count === 0 ? 0 : (current.activeIndex + 1) % count }
              : current,
          );
          return true;
        case 'ArrowUp':
          event.preventDefault();
          setSnapshot((current) =>
            current
              ? {
                  ...current,
                  activeIndex: count === 0 ? 0 : (current.activeIndex - 1 + count) % count,
                }
              : current,
          );
          return true;
        case 'Escape':
          event.preventDefault();
          close();
          return true;
        case 'Enter':
        case 'Tab':
          // 没有候选项时不接管：让它落回输入框原有的行为（例如幽灵行的提交）
          if (count === 0) return false;
          event.preventDefault();
          accept(snapshot.activeIndex);
          return true;
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'Home':
        case 'End':
          // 这些键会移动光标：默认行为先发生，之后按新位置重算（移出该 `{{` 就收起）
          recheck();
          return false;
        default:
          return false;
      }
    },
  });

  return {
    items: snapshot?.items ?? [],
    activeIndex: snapshot?.activeIndex ?? 0,
    anchor: snapshot?.anchor ?? null,
    bind,
    accept,
    activate,
    close,
  };
}
