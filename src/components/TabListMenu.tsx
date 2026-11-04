import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMenuDismiss } from '../lib/useMenuDismiss';
import { useMenuPlacement } from '../lib/useMenuPlacement';
import { CollectionIcon, FolderIcon, RunnerIcon } from './icons';

/** 菜单里一项需要的全部信息：够在本行重复陈述标签自身（spec: 会话标签栏）。 */
export interface TabListEntry {
  key: string;
  name: string;
  /** 请求标签的方法徽标；实体标签没有。 */
  method: string | null;
  /** 实体标签的种类图标；请求标签没有。 */
  entityKind: 'collection' | 'folder' | null;
  /** 运行器标签：与请求、实体并列的第三种标签（change: runner-as-tab）。 */
  runner?: boolean;
  dirty: boolean;
  active: boolean;
}

export interface TabListMenuProps {
  tabs: TabListEntry[];
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
}

/**
 * 菜单自身的选择器。
 *
 * 菜单被 portal 到 `document.body`，不是触发器的后代，因此「点菜单不算点到外面」只能靠
 * 选择器豁免（与 `Dropdown` 的 `.dropdown-menu` 同一套做法）。
 */
const MENU_SELECTOR = '.tab-menu';

/**
 * 「全部标签」菜单（spec: 会话标签栏；change: preview-tabs-and-tab-strip）。
 *
 * 标签行只会显示下得下的那几个：宽度不够时它横向滚动，可见范围之外的那几个既没有名字、
 * 也没有位置暗示。这个菜单是那条路的**兜底入口**——把当前打开的标签原样列一遍，逐个陈述
 * 与标签一致的识别信息（方法徽标 / 种类图标、名称、未保存标记），可跳转、可就地关闭。
 *
 * 就地关闭**不收菜单**：这里最常见的用法是连续整理几个标签，关一个就收起来等于把一条
 * 连贯的动作拆成来回（展开 → 点 × → 再展开 → 再点 ×）。收起条件见关闭入口处的注释。
 *
 * 定位与关闭沿用行内菜单与下拉共用的两份实现（`useMenuPlacement` / `useMenuDismiss`）：
 * 会话行同时是窗口拖拽区与浮层的宿主，菜单必须按触发器的实测矩形定位、并且能溢出这一行。
 */
export function TabListMenu({ tabs, onSelect, onClose }: TabListMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // 靠右边缘：它挂在标签行最右端，往左展开才不会跑出窗口
  const position = useMenuPlacement({ open, anchor: trigger, menu, align: 'right' });

  const close = () => setOpen(false);
  /**
   * 「别人滚了」这条不适用：这个菜单锚在会话标签行的固定触发器上，不跟着任何滚动容器走。
   * 而就地关闭一个标签本身就会连带滚动别处（激活标签自动进入可见范围、控制台追到底部），
   * 那条规则会让菜单在用户点完之后自己消失——正是要修的症状。
   */
  useMenuDismiss(root, close, MENU_SELECTOR, { dismissOnOutsideScroll: false });

  return (
    <div className="tab-list" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="tab-list-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="全部标签"
        data-testid="tab-list-trigger"
        title={`全部标签（${tabs.length}）`}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">☰</span>
        <span className="tab-list-count" aria-hidden="true">
          {tabs.length}
        </span>
      </button>

      {open &&
        createPortal(
          <div
            className="tab-menu"
            ref={menu}
            role="menu"
            aria-label="全部标签"
            data-testid="tab-menu"
            /* 就地关闭一项后焦点收回到菜单自身（见关闭入口的注释），因此这里必须可聚焦：
               -1 表示不进 Tab 序列，只在被程序化聚焦时接住焦点 */
            tabIndex={-1}
            style={{
              top: position?.top ?? 0,
              left: position?.left,
              right: position?.right,
            }}
          >
            {tabs.map((tab) => (
              /* 跳转与关闭是两个并列的按钮：按钮里套按钮是非法 HTML，键盘与读屏都会出错 */
              <div
                key={tab.key}
                className={`tab-menu-row ${tab.active ? 'active' : ''}`}
                role="none"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="tab-menu-pick"
                  data-testid="tab-menu-item"
                  aria-current={tab.active || undefined}
                  onClick={() => {
                    onSelect(tab.key);
                    close();
                  }}
                >
                  {tab.method ? (
                    <span className="method-badge" data-method={tab.method}>
                      {tab.method}
                    </span>
                  ) : tab.runner ? (
                    <RunnerIcon className="tab-kind-icon" role="img" aria-label="运行器" />
                  ) : tab.entityKind === 'collection' ? (
                    <CollectionIcon className="tab-kind-icon" role="img" aria-label="集合" />
                  ) : (
                    <FolderIcon className="tab-kind-icon" role="img" aria-label="文件夹" />
                  )}
                  <span className="tab-menu-name">{tab.name}</span>
                  {tab.dirty && <span className="dirty-dot" aria-hidden="true" />}
                </button>
                <button
                  type="button"
                  className="tab-menu-close"
                  aria-label={`关闭 ${tab.name}`}
                  onClick={() => {
                    /**
                     * 焦点先收回菜单：这一行随后连按钮一起卸载，焦点留在按钮上会掉到 body，
                     * 键盘用户下一次 Tab 得从页面开头重新走。
                     */
                    menu.current?.focus();
                    onClose(tab.key);
                    /**
                     * 就地关闭**不收起菜单**：整理一批标签时，「展开 → 点 × → 再展开 → 再点 ×」
                     * 把一条本该连贯的动作拆成来回跑；菜单留着，下一项就在指针下面。
                     *
                     * 例外只有脏标签——关它会拉起「未保存」确认，而菜单的 z 序（40）高于模态
                     * 遮罩（20），不收起就会浮在确认框上面，所以这里先让位。
                     */
                    if (tab.dirty) close();
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
