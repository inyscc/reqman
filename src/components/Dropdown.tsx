import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useMenuDismiss } from '../lib/useMenuDismiss';
import { useMenuPlacement } from '../lib/useMenuPlacement';

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
  /**
   * 可选的选项装饰（如响应格式下拉里的「检测」标记）。
   *
   * 它与「当前选中项」是两件事：标记可以不落在当前值上（用户强制选了别的格式，
   * 检测标记仍留在真正检测到的那一项），因此两者用不同的视觉与语义表达。
   */
  badge?: string;
  /**
   * 该项当前不可选。
   *
   * 「某一项用不了」这件事由选项自身的状态表达，不由界面另写一句解释——见
   * ui-layout「语义落在操作上」。
   */
  disabled?: boolean;
}

export interface DropdownProps<T extends string> {
  /** 无障碍名称，替代原生 select 的 aria-label。 */
  label: string;
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  /** 菜单顶部是否带搜索框（环境数量多时才需要）。 */
  searchable?: boolean;
  /** 菜单贴哪一侧展开；靠容器右边缘时用 'right'。 */
  align?: 'left' | 'right';
  /** 追加在根节点上的钩子类名（样式与测试定位）。 */
  className?: string;
  testId?: string;
  disabled?: boolean;
}

/**
 * 菜单自身的选择器。
 *
 * 菜单被 portal 到 `document.body`，不再是触发器所在根节点的后代，因此「点菜单不算点到外面」
 * 这条只能靠选择器豁免（见 `useMenuDismiss` 的第三个参数）。
 */
const MENU_SELECTOR = '.dropdown-menu';

/**
 * 通用下拉（spec: 通用下拉的观感与菜单行为；design D1 / D3）。
 *
 * 形态是**文本触发器 + 自绘菜单**，替换运行环境自带的原生 select：原生控件的弹出
 * 列表由系统绘制，字号、行高、hover 与选中态都无法统一到这套设计 token 上。
 *
 * 受控组件，语义与原先的 `<select value onChange>` 一致，接入点是局部替换而不是
 * 重构调用方。关闭规则复用 `useMenuDismiss`，与行内菜单（`NodeMenu`）同源。
 */
export function Dropdown<T extends string>({
  label,
  value,
  options,
  onChange,
  searchable = false,
  align = 'left',
  className,
  testId,
  disabled = false,
}: DropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  /** 菜单的可访问名借触发器的那个（aria-labelledby），不另写一份 aria-label——
      两个同名的 aria-label 会让按名称定位一个时不唯一。 */
  const triggerId = useId();
  // 定位与行内菜单同源（spec: ui-polish「浮层在垂直方向的定位」）：垂直方向按可用空间
  // 决定向上还是向下，水平方向收在视口内
  const position = useMenuPlacement({
    open,
    anchor: trigger,
    menu,
    align,
    matchAnchorWidth: true,
  });

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? options.filter((option) => option.label.toLowerCase().includes(needle)) : options;
  }, [options, query]);

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  const choose = (next: T) => {
    onChange(next);
    close();
    // 焦点回到触发器：键盘走完一次选择后，下一步操作还在原地
    trigger.current?.focus();
  };

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    setQuery('');
    const current = options.findIndex((option) => option.value === value);
    setActiveIndex(current >= 0 && !options[current].disabled ? current : step(-1, 1));
    setOpen(true);
  };

  /** 焦点在菜单里移动时跳过不可选项；没有可选项时停在原地。 */
  const step = (from: number, delta: number) => {
    for (let index = from + delta; index >= 0 && index < visible.length; index += delta) {
      if (!visible[index]?.disabled) return index;
    }
    return from;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => step(index, 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => step(index, -1));
      return;
    }
    if (event.key === 'Enter') {
      // 拦截：不让它冒泡成触发器的 click（那会变成「再开一次」）
      event.preventDefault();
      const option = visible[activeIndex];
      if (option && !option.disabled) choose(option.value);
    }
  };

  useMenuDismiss(root, close, MENU_SELECTOR);

  const classes = ['dropdown', open ? 'open' : '', className].filter(Boolean).join(' ');

  return (
    <div className={classes} ref={root} onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        id={triggerId}
        type="button"
        className="dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        data-value={value}
        data-testid={testId}
        disabled={disabled}
        onClick={toggle}
      >
        <span className="dropdown-value">
          {options.find((option) => option.value === value)?.label ?? value}
        </span>
        <span className="dropdown-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {/* 菜单 portal 到 body：它是覆盖层，不能留在可能带 overflow 的祖先里被裁掉 */}
      {open &&
        createPortal(
          <div
            className="dropdown-menu"
            ref={menu}
            style={{
              top: position?.top ?? 0,
              left: position?.left,
              right: position?.right,
              minWidth: position?.minWidth,
            }}
          >
            {searchable && (
              <input
                className="dropdown-search"
                type="text"
                aria-label={`搜索${label}`}
                placeholder="搜索"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
              />
            )}

            <div className="dropdown-options" role="listbox" aria-labelledby={triggerId}>
              {visible.length === 0 && <p className="dropdown-empty muted">没有匹配的选项</p>}
              {visible.map((option, index) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  aria-disabled={option.disabled || undefined}
                  disabled={option.disabled}
                  className={[
                    'dropdown-option',
                    option.value === value ? 'current' : '',
                    index === activeIndex ? 'active' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => choose(option.value)}
                >
                  <span>{option.label}</span>
                  <span className="dropdown-markers">
                    {option.badge && (
                      <span
                        className="dropdown-badge"
                        data-testid={testId ? `${testId}-badge-${option.value}` : undefined}
                      >
                        {option.badge}
                      </span>
                    )}
                    {option.value === value && (
                      <span className="dropdown-check" aria-hidden="true">
                        ✓
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
