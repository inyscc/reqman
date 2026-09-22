import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState, type ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Dropdown } from '../src/components/Dropdown';

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
];

type Props = ComponentProps<typeof Dropdown<string>>;

function renderDropdown(overrides: Partial<Props> = {}) {
  const onChange = vi.fn<(value: string) => void>();
  const view = render(
    <Dropdown<string>
      label="示例"
      value="a"
      options={OPTIONS}
      onChange={onChange}
      {...overrides}
    />,
  );
  return { onChange, view };
}

const trigger = () => screen.getByLabelText('示例');
const options = () => screen.getByRole('listbox', { name: '示例' });

describe('通用下拉（spec: 通用下拉的观感与菜单行为）', () => {
  it('触发器显示当前值，展开后当前项带着标记', () => {
    renderDropdown();

    // 触发器是 button 而不是原生 select：取值靠 data-value 暴露
    expect(trigger().tagName).toBe('BUTTON');
    expect(trigger().textContent).toContain('Alpha');
    expect(trigger().getAttribute('data-value')).toBe('a');
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.click(trigger());

    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    const alpha = within(options()).getByRole('option', { name: 'Alpha' });
    expect(alpha.getAttribute('aria-selected')).toBe('true');
    expect(alpha.textContent).toContain('✓');
    expect(within(options()).getByRole('option', { name: 'Beta' }).getAttribute('aria-selected')).toBe(
      'false',
    );
  });

  it('选项按钮全部可见：菜单展开期间不靠 hover 才显现', () => {
    renderDropdown();
    fireEvent.click(trigger());

    expect(within(options()).getAllByRole('option')).toHaveLength(OPTIONS.length);
  });

  it('选中一项即提交并关闭菜单', () => {
    const { onChange } = renderDropdown();
    fireEvent.click(trigger());
    fireEvent.click(within(options()).getByRole('option', { name: 'Gamma' }));

    expect(onChange).toHaveBeenCalledWith('c');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('受控用法下，选中后触发器显示新值', () => {
    function Controlled() {
      const [value, setValue] = useState('a');
      return <Dropdown<string> label="示例" value={value} options={OPTIONS} onChange={setValue} />;
    }

    render(<Controlled />);
    fireEvent.click(trigger());
    fireEvent.click(within(options()).getByRole('option', { name: 'Gamma' }));

    expect(trigger().textContent).toContain('Gamma');
    expect(trigger().getAttribute('data-value')).toBe('c');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('点击菜单外部关闭且不写入新值', () => {
    const { onChange } = renderDropdown();
    fireEvent.click(trigger());
    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger().getAttribute('data-value')).toBe('a');
  });

  it('Esc 关闭且不写入新值', () => {
    const { onChange } = renderDropdown();
    fireEvent.click(trigger());
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger().getAttribute('data-value')).toBe('a');
  });

  it('容器滚动关闭且不写入新值', () => {
    const { onChange } = renderDropdown();
    fireEvent.click(trigger());
    fireEvent.scroll(document);

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('菜单自身滚动不关闭菜单（否则超出一屏的选项永远不可达）', () => {
    renderDropdown();
    fireEvent.click(trigger());

    // 选项区本身就是滚动容器：它自己滚不能算作「容器滚动」
    fireEvent.scroll(options());

    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('键盘可以走完一次选择：方向键移动、Enter 提交', () => {
    const { onChange } = renderDropdown();
    fireEvent.click(trigger());

    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    fireEvent.keyDown(trigger(), { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('c');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('方向键到顶不会再往上溢出去', () => {
    renderDropdown();
    fireEvent.click(trigger());

    fireEvent.keyDown(trigger(), { key: 'ArrowUp' });
    fireEvent.keyDown(trigger(), { key: 'Enter' });

    expect(trigger().getAttribute('data-value')).toBe('a');
  });

  it('Esc 之后仍可以从键盘继续操作（焦点没有跑掉）', () => {
    renderDropdown();
    fireEvent.click(trigger());
    fireEvent.keyDown(trigger(), { key: 'Escape' });

    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().getAttribute('data-value')).toBe('a');
  });
});

describe('下拉的搜索（spec: 会话标签行环境的搜索）', () => {
  it('过滤命中的选项，并按大小写不敏感匹配', () => {
    renderDropdown({ searchable: true });
    fireEvent.click(trigger());

    const search = screen.getByLabelText('搜索示例');
    fireEvent.change(search, { target: { value: 'bet' } });

    expect(within(options()).getAllByRole('option')).toHaveLength(1);
    expect(within(options()).getByRole('option', { name: 'Beta' })).toBeTruthy();
  });

  it('无命中时显示空态而不是空白面板', () => {
    renderDropdown({ searchable: true });
    fireEvent.click(trigger());

    fireEvent.change(screen.getByLabelText('搜索示例'), { target: { value: '不存在' } });

    expect(within(options()).queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('没有匹配的选项')).toBeTruthy();
  });

  it('搜索不改动外部的值：关掉菜单后仍是原值', () => {
    const { onChange } = renderDropdown({ searchable: true });
    fireEvent.click(trigger());
    fireEvent.change(screen.getByLabelText('搜索示例'), { target: { value: 'gamma' } });
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onChange).not.toHaveBeenCalled();
    expect(trigger().getAttribute('data-value')).toBe('a');
  });
});
