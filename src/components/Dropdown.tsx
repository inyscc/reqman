import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useMenuDismiss } from '../lib/useMenuDismiss';

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
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
  /** 菜单的可访问名借触发器的那个（aria-labelledby），不另写一份 aria-label——
      两个同名的 aria-label 会让按名称定位一个时不唯一。 */
  const triggerId = useId();

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
    setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
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
      setActiveIndex((index) => Math.min(visible.length - 1, index + 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === 'Enter') {
      // 拦截：不让它冒泡成触发器的 click（那会变成「再开一次」）
      event.preventDefault();
      const option = visible[activeIndex];
      if (option) choose(option.value);
    }
  };

  useMenuDismiss(root, close);

  const classes = ['dropdown', align === 'right' ? 'align-right' : '', open ? 'open' : '', className]
    .filter(Boolean)
    .join(' ');

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

      {open && (
        <div className="dropdown-menu">
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
                {option.value === value && (
                  <span className="dropdown-check" aria-hidden="true">
                    ✓
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
