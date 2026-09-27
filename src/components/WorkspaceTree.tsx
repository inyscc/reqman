import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { FolderIcon } from './icons';
import { NodeMenu, type MenuItem } from './NodeMenu';
import { OverlayScrollbar } from './OverlayScrollbar';
import type { CollectionTree, TreeNode } from '../lib/types';
import {
  buildMove,
  type ContainerParent,
  type DragNode,
  type DropTarget,
  type RowRef,
  type TreeMove,
  type TreeParent,
} from '../lib/treeMoves';

/** 树中被选中的实体：集合或文件夹（脚本编辑入口，任务 5.2）。 */
export interface EntitySelection {
  kind: 'collection' | 'folder';
  id: string;
  collectionId: string;
}

/**
 * 树对外暴露的命令式入口（spec: ui-layout「树操作的快捷键」）。
 *
 * 快捷键挂在 App 的 window 监听上，而「哪一行此刻可见」由树自己的折叠与搜索状态决定，
 * 所以「让某行进入就地改名」只能由树来做。
 */
export interface WorkspaceTreeHandle {
  /**
   * 让某个节点进入就地改名态，必要时先让它可见。
   *
   * 就地改名的输入框只在**该行被渲染**时存在：目标被折叠的祖先藏起、或被搜索词过滤掉
   * 时，直接设状态会让用户按了键却看不到任何反应。
   */
  startRename: (id: string) => void;
}

/**
 * 菜单里标出的键位（spec: ui-layout「树操作的快捷键」）。
 *
 * 不做平台判断：`Ctrl+S` 的实现本来就是 `ctrlKey || metaKey` 通吃，菜单文案写成
 * `Ctrl+` 与之并行，不再引入第二套真相。
 */
const RENAME_SHORTCUT = 'Ctrl+E';
const DUPLICATE_SHORTCUT = 'Ctrl+D';

/** 从集合一层层找到该节点，返回它所在的路径（集合 id 起、含自身）；找不到返回 null。 */
function pathTo(trees: CollectionTree[], id: string): string[] | null {
  for (const tree of trees) {
    if (tree.collection.id === id) return [tree.collection.id];
    const below = pathInNodes(tree.children, id);
    if (below) return [tree.collection.id, ...below];
  }
  return null;
}

function pathInNodes(nodes: TreeNode[], id: string): string[] | null {
  for (const node of nodes) {
    if (node.id === id) return [node.id];
    if (node.kind === 'folder') {
      const below = pathInNodes(node.children, id);
      if (below) return [node.id, ...below];
    }
  }
  return null;
}

export interface WorkspaceTreeProps {
  trees: CollectionTree[];
  selectedRequestId: string | null;
  /** 当前选中的集合/文件夹；请求选中时为 null。 */
  selectedEntity: EntitySelection | null;
  onSelectRequest: (id: string) => void;
  onSelectEntity: (entity: EntitySelection) => void;
  onNewCollection: () => void;
  onNewRequest: (collectionId: string, folderId: string | null) => void;
  onNewFolder: (collectionId: string, parentFolderId: string | null) => void;
  onDeleteCollection: (id: string) => void;
  onDeleteFolder: (id: string) => void;
  onDeleteRequest: (id: string) => void;
  /** 复制一条请求（spec: 集合树的操作入口默认隐藏）：请求节点菜单里的「复制」。 */
  onDuplicateRequest: (id: string) => void;
  /** 复制一个目录（连同整棵子树）：文件夹节点菜单里的「复制」。 */
  onDuplicateFolder: (id: string) => void;
  /** 选中实体并把焦点交给面包屑的名称输入框。 */
  onRenameEntity: (entity: EntitySelection) => void;
  onRenameRequest: (id: string) => void;
  /**
   * 树上就地改名的提交口（spec: 在集合树里就地重命名）。
   * 与面板头输入框走同一条写入路径，因此两处改名互为同一份真相；
   * 空名与未变化的判断交给调用方。
   */
  onRenameCommit: (target: RenameTarget, name: string) => void;
  /**
   * 拖拽落定：把一次「改变顺序 / 改变归属」交给调用方写入后端。
   * 未产生实际变化（拖回原处、跨集合、拖进自己的后代）时不会被调用。
   */
  onMove: (move: TreeMove) => void;
  /** 工具栏的导入入口；与底栏的导入/导出按钮打开同一个模态。 */
  onImport: () => void;
}

interface TreeActions {
  onSelectRequest: (id: string) => void;
  onSelectEntity: (entity: EntitySelection) => void;
  onNewRequest: (collectionId: string, folderId: string | null) => void;
  onNewFolder: (collectionId: string, parentFolderId: string | null) => void;
  onDeleteCollection: (id: string) => void;
  onDeleteFolder: (id: string) => void;
  onDeleteRequest: (id: string) => void;
  onDuplicateRequest: (id: string) => void;
  /** 复制一个目录（连同整棵子树）。 */
  onDuplicateFolder: (id: string) => void;
  onRenameEntity: (entity: EntitySelection) => void;
  onRenameRequest: (id: string) => void;
  onToggle: (id: string) => void;
  /** 把该目录置为展开（已展开则无变化）：新建子条目之前调用，保证新条目落在可见层级。 */
  onExpand: (id: string) => void;
}

/** 树的视图态：折叠、hover/聚焦、菜单与删除确认，全部不写入后端。 */
interface TreeView {
  /** 被折叠的节点 id；未记录即展开，因此默认是全展开。 */
  collapsed: Set<string>;
  /** 搜索态：强制全展开，并禁用折叠控件。 */
  searching: boolean;
  activeId: string | null;
  menuId: string | null;
  confirmId: string | null;
  setActive: (id: string | null) => void;
  setMenu: (id: string | null) => void;
  setConfirm: (id: string | null) => void;

  // ---- 拖拽（change: rework-collection-tree-and-variable-model）----
  /** 搜索态下不可拖拽：树被强制全展开，落点没有意义。 */
  draggable: boolean;
  /** 正在被拖动的节点；null 表示当前没有拖拽。 */
  drag: DragNode | null;
  /** 当前落点；null 表示这一处没有合法落点，于是不呈现任何指示。 */
  drop: DropTarget | null;
  beginDrag: (node: DragNode) => void;
  /** 指针落在某一行上：解算落点并返回（不合法为 null）。 */
  hoverRow: (
    row: RowRef,
    rect: { top: number; height: number },
    clientY: number,
  ) => DropTarget | null;
  /** 悬停在折叠的目录上：排队一次自动展开，否则没法把条目拖进看不见的层级。 */
  hoverFolder: (id: string, expanded: boolean) => void;
  /** 放下：把落点翻译成一次写入交给 `onMove`。 */
  commit: (target: DropTarget) => void;
  endDrag: () => void;
  /** 该行此刻该呈现的落点指示类名；没有则空串。 */
  dropClass: (id: string) => string;

  // ---- 树上就地改名 ----
  /** 正在就地改名的行 id；null 表示没有行在编辑。 */
  renamingId: string | null;
  startRename: (id: string) => void;
  cancelRename: () => void;
  commitRename: (target: RenameTarget, name: string) => void;
}

/** 树上就地改名的目标：集合、文件夹或请求。 */
export interface RenameTarget {
  kind: 'collection' | 'folder' | 'request';
  id: string;
  collectionId: string;
}

// ---------------------------------------------------------------------------
// 搜索过滤：纯前端视图态，不写入后端、不改变选中、不触碰折叠状态。
// ---------------------------------------------------------------------------

/** 大小写不敏感的包含匹配；`url` 可能为空。 */
function matches(text: string | null | undefined, needle: string): boolean {
  return typeof text === 'string' && text.toLowerCase().includes(needle);
}

function filterNodes(nodes: TreeNode[], needle: string): TreeNode[] {
  const kept: TreeNode[] = [];

  for (const node of nodes) {
    if (node.kind === 'request') {
      if (matches(node.name, needle) || matches(node.request?.url, needle)) kept.push(node);
      continue;
    }

    // 文件夹名命中：保留整棵子树，用户搜的是「这个文件夹里的东西」
    if (matches(node.name, needle)) {
      kept.push(node);
      continue;
    }

    const children = filterNodes(node.children, needle);
    if (children.length > 0) kept.push({ ...node, children });
  }

  return kept;
}

/**
 * 按请求名称或请求 URL 过滤集合树。
 *
 * 空查询直接返回入参引用——过滤是「没有输入就没有过滤」，也避免无谓的重渲染。
 * 集合与文件夹自底向上裁剪：只有自身名命中或后代有命中时才保留。
 */
export function filterTrees(trees: CollectionTree[], query: string): CollectionTree[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return trees;

  const kept: CollectionTree[] = [];
  for (const tree of trees) {
    if (matches(tree.collection.name, needle)) {
      kept.push(tree);
      continue;
    }

    const children = filterNodes(tree.children, needle);
    if (children.length > 0) kept.push({ ...tree, children });
  }

  return kept;
}

/** 行在指针悬停或获得键盘焦点时才亮出「⋯」，默认界面上没有常驻按钮。 */
function useRowReveal(id: string, view: TreeView) {
  /**
   * 指针或焦点在**行内**换元素（行容器 → 行内的「⋯」按钮）同样会冒泡出
   * mouseleave / focusout。若把它当成「离开本行」，行容器会在 mousedown 与
   * mouseup 之间把「⋯」卸载掉，随后的 click 只能落到共同祖先（行容器）上——
   * 菜单就会永远打不开。只有真的出去了才熄灯。
   *
   * 这个坑 jsdom 看不出来：`fireEvent.click` 不产生 mousedown、也不移动焦点。
   */
  const leaveRow = (event: { currentTarget: HTMLElement; relatedTarget: EventTarget | null }) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    if (view.menuId !== id) view.setActive(null);
  };

  return {
    onMouseEnter: () => view.setActive(id),
    onMouseLeave: leaveRow,
    onFocus: () => view.setActive(id),
    onBlur: leaveRow,
  };
}

function MoreButton({
  id,
  view,
  buttonRef,
}: {
  id: string;
  view: TreeView;
  /** 菜单要据这个按钮的实测位置决定朝上还是朝下展开（见 NodeMenu 的 anchor）。 */
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={buttonRef}
      className="node-more"
      aria-label="更多操作"
      title="更多操作"
      onClick={(event) => {
        event.stopPropagation();
        view.setMenu(view.menuId === id ? null : id);
      }}
    >
      ⋯
    </button>
  );
}

/**
 * 集合 / 文件夹 / 请求三种行共用的拖拽手势。
 *
 * 与 HTML5 DnD 的约定：只有 `dragover` 里 `preventDefault` 过的目标才允许放下。
 * 因此「没有合法落点」不是等到放下时才报错，而是压根不呈现落点、也不允许放下——
 * 跨集合拖动就是这么被挡掉的。
 */
function dragHandlers(
  row: RowRef,
  view: TreeView,
  onHoverContainer: () => void = () => {},
) {
  return {
    draggable: view.draggable,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      if (!view.draggable) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', row.id);
      view.beginDrag({
        id: row.id,
        kind: row.kind,
        collectionId: row.collectionId,
        parentFolderId: row.parent.kind === 'folder' ? row.parent.folderId : null,
      });
    },
    onDragEnd: () => view.endDrag(),
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!view.drag) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const target = view.hoverRow(row, rect, event.clientY);
      if (!target) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      onHoverContainer();
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!view.drag) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const target = view.hoverRow(row, rect, event.clientY);
      // 没有落点就什么都不做：不写入、也不报错
      if (!target) return;
      event.preventDefault();
      view.commit(target);
    },
  };
}

/** 收集整棵树里全部目录 id（集合根 + 全部后代文件夹），供工具栏「全部折叠」一次写入。 */
function collectDirectoryIds(trees: CollectionTree[]): string[] {
  const ids: string[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'folder') {
        ids.push(node.id);
        walk(node.children);
      }
    }
  };

  for (const tree of trees) {
    ids.push(tree.collection.id);
    walk(tree.children);
  }
  return ids;
}

/** 集合与文件夹共用的行：折叠箭头、图标、名称、hover 菜单、删除确认条。 */
function EntryRow({
  id,
  name,
  kind,
  collectionId,
  parent,
  index,
  selected,
  actions,
  view,
  children,
}: {
  id: string;
  name: string;
  kind: 'collection' | 'folder';
  collectionId: string;
  /** 该行所属父级：集合行是工作区根，文件夹行是集合根或外层文件夹。 */
  parent: TreeParent;
  /** 该行在父级子列表中的位置，落点判定据此算出插入下标。 */
  index: number;
  selected: boolean;
  actions: TreeActions;
  view: TreeView;
  children?: ReactNode;
}) {
  // 搜索态下强制展开：命中项被折叠藏起来就没有搜索可言
  const expanded = view.searching || !view.collapsed.has(id);
  const revealed = view.activeId === id || view.menuId === id;
  const entity: EntitySelection = { kind, id, collectionId };
  const reveal = useRowReveal(id, view);
  // 「⋯」按钮本身：菜单锚在它身上，据此决定朝上还是朝下
  const moreRef = useRef<HTMLButtonElement>(null);
  const row: RowRef = { id, kind, collectionId, parent, index };

  // 新建的条目落在这一行下面，所以先确保这一行是展开的（否则新条目生出来就被折叠藏住）。
  const menu: MenuItem[] = [
    {
      label: '新建请求',
      onSelect: () => {
        actions.onExpand(id);
        actions.onNewRequest(collectionId, kind === 'folder' ? id : null);
      },
    },
    {
      label: kind === 'folder' ? '新建子文件夹' : '新建文件夹',
      onSelect: () => {
        actions.onExpand(id);
        actions.onNewFolder(collectionId, kind === 'folder' ? id : null);
      },
    },
    { label: '编辑脚本', onSelect: () => actions.onSelectEntity(entity) },
    { label: '重命名', shortcut: RENAME_SHORTCUT, onSelect: () => view.startRename(id) },
    // 集合级复制会连带集合变量表，本次不做（design D8）：只有文件夹有「复制」。
    ...(kind === 'folder'
      ? [
          {
            label: '复制',
            shortcut: DUPLICATE_SHORTCUT,
            onSelect: () => actions.onDuplicateFolder(id),
          },
        ]
      : []),
    {
      label: kind === 'folder' ? '删除文件夹' : '删除集合',
      danger: true,
      onSelect: () =>
        kind === 'folder' ? view.setConfirm(id) : actions.onDeleteCollection(id),
    },
  ];

  const className = [
    'node',
    selected ? 'selected' : '',
    view.dropClass(id),
    view.drag?.id === id ? 'dragging' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li>
      <div
        className={className}
        role="button"
        tabIndex={0}
        title={`打开 ${name}（${expanded ? '折叠' : '展开'}）`}
        {...dragHandlers(row, view, () => view.hoverFolder(id, expanded))}
        onClick={(event) => {
          // 双击的第二击不重复切换，否则会「展开后又立刻折回」地闪一下
          if (event.detail === 2) return;
          // 单击目录行 = 打开该实体的面板 + 切换展开（spec: 集合树的展开、折叠与打开）。
          // 搜索态下 onToggle 是空操作，但打开面板与折叠无关，因此照常执行。
          actions.onToggle(id);
          actions.onSelectEntity(entity);
        }}
        onKeyDown={(event) => {
          // Enter 只归行容器自己。行内还有折叠箭头、「⋯」与菜单项，它们的 keydown 会
          // 冒泡到这里，而浏览器对聚焦的按钮按 Enter 还会再补一次 click——不拦住就会
          // 出现「在箭头上按 Enter 净零无效」「在「⋯」上按 Enter 把目录折叠掉」。
          if (event.key === 'Enter' && event.target === event.currentTarget) {
            actions.onToggle(id);
            actions.onSelectEntity(entity);
          }
        }}
        // 与请求行同款：右键与「⋯」是同一份菜单、同一个展开状态
        onContextMenu={(event) => {
          event.preventDefault();
          // 编辑名字时不弹菜单：它是锚在那一行右侧「⋯」上的，而编辑态下那个入口不渲染，
          // 没有锚点的菜单只会落到左上角
          if (view.renamingId !== id) view.setMenu(id);
        }}
        {...reveal}
      >
        <button
          className="tree-toggle"
          aria-expanded={expanded}
          aria-label={`${expanded ? '折叠' : '展开'} ${name}`}
          disabled={view.searching}
          onClick={(event) => {
            event.stopPropagation();
            // 双击箭头也只算一次，避免「折了又展开」的往返闪烁
            if (event.detail === 2) return;
            actions.onToggle(id);
          }}
        >
          {expanded ? '▾' : '▸'}
        </button>
        {kind === 'folder' && <FolderIcon className="tree-icon" aria-hidden="true" />}
        {view.renamingId === id ? (
          <input
            className="node-rename"
            autoFocus
            defaultValue={name}
            aria-label={`重命名 ${name}`}
            onClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                view.commitRename({ kind, id, collectionId }, event.currentTarget.value);
              }
              if (event.key === 'Escape') view.cancelRename();
            }}
            onBlur={(event) =>
              view.commitRename({ kind, id, collectionId }, event.currentTarget.value)
            }
          />
        ) : (
          <>
            <span className="tree-name">{name}</span>
            {/* 吸收剩余空间的占位只在非编辑态存在：编辑态留下它，输入框就只会分到一半宽度 */}
            <span className="grow" />
          </>
        )}
        {/* 编辑名字时不亮出操作入口：此时它不是可用的目标，还会占掉名称区域 */}
        {revealed && view.renamingId !== id && (
          <MoreButton id={id} view={view} buttonRef={moreRef} />
        )}
        {view.menuId === id && (
          <NodeMenu items={menu} anchor={moreRef} onClose={() => view.setMenu(null)} />
        )}
      </div>

      {view.confirmId === id && (
        <div className="node-confirm" role="alert" data-testid="folder-delete-confirm">
          <span>删除「{name}」会把其下的子文件夹与请求一并删除。</span>
          <div className="row">
            <button
              onClick={(event) => {
                event.stopPropagation();
                view.setConfirm(null);
                actions.onDeleteFolder(id);
              }}
            >
              删除
            </button>
            <button
              className="ghost"
              onClick={(event) => {
                event.stopPropagation();
                view.setConfirm(null);
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {expanded && children}
    </li>
  );
}

function RequestRow({
  node,
  parent,
  index,
  selected,
  actions,
  view,
}: {
  node: TreeNode;
  parent: ContainerParent;
  index: number;
  selected: boolean;
  actions: TreeActions;
  view: TreeView;
}) {
  const revealed = view.activeId === node.id || view.menuId === node.id;
  const reveal = useRowReveal(node.id, view);
  // 「⋯」按钮本身：菜单锚在它身上，据此决定朝上还是朝下
  const moreRef = useRef<HTMLButtonElement>(null);
  // 请求行不含「移入」语义——它装不下任何东西，因此只有上 / 下半区
  const row: RowRef = {
    id: node.id,
    kind: 'request',
    collectionId: parent.collectionId,
    parent,
    index,
  };
  const menu: MenuItem[] = [
    { label: '重命名', shortcut: RENAME_SHORTCUT, onSelect: () => view.startRename(node.id) },
    {
      label: '复制',
      shortcut: DUPLICATE_SHORTCUT,
      onSelect: () => actions.onDuplicateRequest(node.id),
    },
    { label: '删除', danger: true, onSelect: () => actions.onDeleteRequest(node.id) },
  ];

  const className = [
    'node',
    selected ? 'selected' : '',
    view.dropClass(node.id),
    view.drag?.id === node.id ? 'dragging' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li>
      <div
        className={className}
        role="button"
        tabIndex={0}
        {...dragHandlers(row, view)}
        onClick={() => actions.onSelectRequest(node.id)}
        onKeyDown={(event) => {
          // 同 EntryRow：Enter 只归行容器自己，别让「⋯」与菜单项上的 Enter 顺带把请求打开
          if (event.key === 'Enter' && event.target === event.currentTarget) {
            actions.onSelectRequest(node.id);
          }
        }}
        // 右键与「⋯」是同一份菜单、同一个展开状态：两处只是不同触发器，逻辑不分叉
        // （spec: 集合树的操作入口默认隐藏）。preventDefault 挡掉运行环境自带的页面菜单。
        onContextMenu={(event) => {
          event.preventDefault();
          // 同 EntryRow：编辑态没有可锚定的「⋯」，右键不开菜单
          if (view.renamingId !== node.id) view.setMenu(node.id);
        }}
        {...reveal}
      >
        <span className="tree-toggle-space" aria-hidden="true" />
        <span className="method-badge" data-method={node.request?.method ?? 'GET'}>
          {node.request?.method ?? 'GET'}
        </span>
        {view.renamingId === node.id ? (
          <input
            className="node-rename"
            autoFocus
            defaultValue={node.name}
            aria-label={`重命名 ${node.name}`}
            onClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                view.commitRename(
                  { kind: 'request', id: node.id, collectionId: parent.collectionId },
                  event.currentTarget.value,
                );
              }
              if (event.key === 'Escape') view.cancelRename();
            }}
            onBlur={(event) =>
              view.commitRename(
                { kind: 'request', id: node.id, collectionId: parent.collectionId },
                event.currentTarget.value,
              )
            }
          />
        ) : (
          <>
            <span className="tree-name">{node.name}</span>
            {/* 同 EntryRow：编辑态不留占位，输入框因此撑满名称区域 */}
            <span className="grow" />
          </>
        )}
        {/* 同 EntryRow：编辑态留给名称区域，不留操作入口 */}
        {revealed && view.renamingId !== node.id && (
          <MoreButton id={node.id} view={view} buttonRef={moreRef} />
        )}
        {view.menuId === node.id && (
          <NodeMenu items={menu} anchor={moreRef} onClose={() => view.setMenu(null)} />
        )}
      </div>
    </li>
  );
}

function TreeNodes({
  nodes,
  parent,
  selectedRequestId,
  selectedEntity,
  actions,
  view,
}: {
  nodes: TreeNode[];
  parent: ContainerParent;
  selectedRequestId: string | null;
  selectedEntity: EntitySelection | null;
  actions: TreeActions;
  view: TreeView;
}) {
  const collectionId = parent.collectionId;

  return (
    <ul className="tree">
      {nodes.map((node, index) =>
        node.kind === 'folder' ? (
          <EntryRow
            key={node.id}
            id={node.id}
            name={node.name}
            kind="folder"
            collectionId={collectionId}
            parent={parent}
            index={index}
            selected={selectedEntity?.kind === 'folder' && selectedEntity.id === node.id}
            actions={actions}
            view={view}
          >
            <TreeNodes
              nodes={node.children}
              parent={{ kind: 'folder', collectionId, folderId: node.id }}
              selectedRequestId={selectedRequestId}
              selectedEntity={selectedEntity}
              actions={actions}
              view={view}
            />
          </EntryRow>
        ) : (
          <RequestRow
            key={node.id}
            node={node}
            parent={parent}
            index={index}
            selected={selectedRequestId === node.id}
            actions={actions}
            view={view}
          />
        ),
      )}
    </ul>
  );
}

/**
 * 工具栏：搜索框 + 三个图标按钮（全部折叠 / 新建集合 / 导入）。
 *
 * tab 名已经是 Collections，行内不再重复「集合」标题；三个按钮都只有图标，
 * 文字留在 `aria-label` / `title` 里（可访问性与悬停提示都不丢）。
 */
function TreeToolbar({
  query,
  searching,
  onQuery,
  onCollapseAll,
  onNewCollection,
  onImport,
}: {
  query: string;
  /** 搜索态：树被强制全展开，「全部折叠」与行内折叠箭头一样不可用。 */
  searching: boolean;
  onQuery: (next: string) => void;
  onCollapseAll: () => void;
  onNewCollection: () => void;
  onImport: () => void;
}) {
  return (
    <div className="tree-toolbar">
      <div className="tree-search">
        <span className="tree-search-icon" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 16 16" focusable="false">
            <path
              d="M11.7 10.3a6 6 0 1 0-1.4 1.4l2.5 2.5 1.4-1.4zM7 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"
              fill="currentColor"
            />
          </svg>
        </span>
        <input
          className="tree-search-input"
          aria-label="搜索请求"
          placeholder="搜索请求名称或路由"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
        {query !== '' && (
          <button
            className="ghost tree-search-clear"
            aria-label="清空搜索"
            onClick={() => onQuery('')}
          >
            ×
          </button>
        )}
      </div>

      <button
        className="icon-button"
        aria-label="全部折叠"
        title="全部折叠"
        disabled={searching}
        onClick={onCollapseAll}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path
            d="M8 2 13 7 11.6 8.4 8 4.8 4.4 8.4 3 7ZM8 8.6 13 13.6 11.6 15 8 11.4 4.4 15 3 13.6Z"
            fill="currentColor"
          />
        </svg>
      </button>

      <button
        className="icon-button"
        aria-label="新建集合"
        title="新建集合"
        onClick={onNewCollection}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M7 2h2v5h5v2H9v5H7V9H2V7h5z" fill="currentColor" />
        </svg>
      </button>

      <button className="icon-button" aria-label="导入" title="导入" onClick={onImport}>
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path
            d="M7 1h2v7.2l2.6-2.6 1.4 1.4L8 12 3 7l1.4-1.4L7 8.2zM2 13h12v2H2z"
            fill="currentColor"
          />
        </svg>
      </button>
    </div>
  );
}

function WorkspaceTreeInner(props: WorkspaceTreeProps & { handle: Ref<WorkspaceTreeHandle> }) {
  const {
    handle,
    trees,
    selectedRequestId,
    selectedEntity,
    onSelectRequest,
    onSelectEntity,
    onNewCollection,
    onNewRequest,
    onNewFolder,
    onDeleteCollection,
    onDeleteFolder,
    onDeleteRequest,
    onDuplicateRequest,
    onDuplicateFolder,
    onRenameEntity,
    onRenameRequest,
    onRenameCommit,
    onMove,
    onImport,
  } = props;

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  /** 搜索词：组件内视图态，`App` 不知情（design D1）。 */
  const [query, setQuery] = useState('');
  /** 拖拽视图态：被拖动的节点与当前落点。 */
  const [dragNode, setDragNode] = useState<DragNode | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  /** 悬停在折叠目录上时排队的那次自动展开（Postman 行为：不用先手动展开再拖）。 */
  const autoExpand = useRef<{ id: string; timer: number } | null>(null);
  /** 真正滚动的那个列表；悬浮滚动条只读它的几何。 */
  const treeScrollRef = useRef<HTMLUListElement>(null);
  /** 正在就地改名的行 id（spec: 在集合树里就地重命名）。 */
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const searching = query.trim() !== '';
  const visible = useMemo(() => filterTrees(trees, query), [trees, query]);

  const actions: TreeActions = {
    onSelectRequest,
    onSelectEntity,
    onNewRequest,
    onNewFolder,
    onDeleteCollection,
    onDeleteFolder,
    onDeleteRequest,
    onDuplicateRequest,
    onDuplicateFolder,
    onRenameEntity,
    onRenameRequest,
    onToggle: (id) => {
      // 搜索态强制全展开，此时改折叠集合只会污染用户原来记住的状态
      if (searching) return;
      setCollapsed((previous) => {
        const next = new Set(previous);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    onExpand: (id) =>
      setCollapsed((previous) => {
        if (!previous.has(id)) return previous;
        const next = new Set(previous);
        next.delete(id);
        return next;
      }),
  };

  /** 「全部折叠」：把整棵树的展开状态一次归零；搜索态下与折叠控件一样不动折叠集合。 */
  const collapseAll = () => {
    if (searching) return;
    setCollapsed(new Set(collectDirectoryIds(trees)));
  };

  // ---- 拖拽 ----

  const clearAutoExpand = () => {
    if (!autoExpand.current) return;
    window.clearTimeout(autoExpand.current.timer);
    autoExpand.current = null;
  };

  const endDrag = () => {
    clearAutoExpand();
    setDragNode(null);
    setDropTarget(null);
  };

  /**
   * 落点解算：上 / 下半区 = 同级排序；目录行的中间区域 = 移入该目录（追加到末尾）。
   * 解算结果同时决定「画不画指示」——不合法的落点压根不画，松手也不报错。
   */
  const hoverRow = (row: RowRef, rect: { top: number; height: number }, clientY: number) => {
    if (!dragNode || searching) {
      setDropTarget(null);
      return null;
    }

    const ratio = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
    const canHold = row.kind === 'collection' || row.kind === 'folder';
    const target: DropTarget =
      canHold && ratio > 0.3 && ratio < 0.7
        ? {
            parent:
              row.kind === 'collection'
                ? { kind: 'collection', collectionId: row.id }
                : { kind: 'folder', collectionId: row.collectionId, folderId: row.id },
            index: Number.POSITIVE_INFINITY,
            marker: { rowId: row.id, position: 'into' },
          }
        : {
            parent: row.parent,
            index: ratio < 0.5 ? row.index : row.index + 1,
            marker: { rowId: row.id, position: ratio < 0.5 ? 'before' : 'after' },
          };

    const resolved = buildMove(trees, dragNode, target) ? target : null;
    setDropTarget(resolved);
    return resolved;
  };

  const hoverFolder = (id: string, expanded: boolean) => {
    if (!dragNode || searching || expanded) return;
    if (autoExpand.current?.id === id) return;
    clearAutoExpand();
    const timer = window.setTimeout(() => {
      autoExpand.current = null;
      actions.onExpand(id);
    }, 500);
    autoExpand.current = { id, timer };
  };

  const commit = (target: DropTarget) => {
    clearAutoExpand();
    setDragNode(null);
    setDropTarget(null);
    if (!dragNode) return;
    const move = buildMove(trees, dragNode, target);
    if (move) onMove(move);
  };

  const dropClass = (id: string) => {
    if (!dropTarget || dropTarget.marker.rowId !== id) return '';
    return `drop-${dropTarget.marker.position}`;
  };

  /**
   * 让某一行进入就地改名态，必要时先把它露出来。
   *
   * 输入框只在**该行被渲染**时存在（`view.renamingId === id ? <input/> : ...`），因此
   * 折叠的祖先、或被搜索词过滤掉的行都要先展开/清词——否则用户按了快捷键却看不到任何
   * 反应。搜索态下先清词再展开：清词让整棵树重新可见，展开才有意义。
   */
  const startRenameById = useCallback(
    (id: string) => {
      const path = pathTo(trees, id);
      // 编辑态不显示行末的操作入口，已经打开的菜单因此失去锚点（它锚在「⋯」上）。
      // 位置不会重算、菜单会留在原地继续可用——于是直接收起，不让两种浮层态并存
      setMenuId(null);
      setQuery('');
      setCollapsed((previous) => {
        if (!path) return previous;
        const next = new Set(previous);
        for (const item of path) next.delete(item);
        return next;
      });
      setRenamingId(id);
    },
    [trees],
  );

  // 把入口交给 App：快捷键挂在那边，而"哪一行此刻可见"只在这里知道
  useImperativeHandle(handle, () => ({ startRename: startRenameById }), [startRenameById]);

  const view: TreeView = {
    collapsed,
    searching,
    activeId,
    menuId,
    confirmId,
    setActive: setActiveId,
    setMenu: setMenuId,
    setConfirm: setConfirmId,
    draggable: !searching,
    drag: dragNode,
    drop: dropTarget,
    beginDrag: setDragNode,
    hoverRow,
    hoverFolder,
    commit,
    endDrag,
    dropClass,
    renamingId,
    startRename: setRenamingId,
    cancelRename: () => setRenamingId(null),
    commitRename: (target, name) => {
      // 先收起输入框，再交给调用方决定写不写：不留半开的编辑态
      setRenamingId(null);
      onRenameCommit(target, name);
    },
  };

  return (
    <div className="stack" data-testid="workspace-tree">
      <TreeToolbar
        query={query}
        searching={searching}
        onQuery={setQuery}
        onCollapseAll={collapseAll}
        onNewCollection={onNewCollection}
        onImport={onImport}
      />

      {trees.length === 0 && <div className="muted">暂无集合</div>}

      {searching && trees.length > 0 && visible.length === 0 && (
        <div className="muted" data-testid="tree-search-empty">
          没有匹配的请求
        </div>
      )}

      <ul className="tree tree-root" ref={treeScrollRef}>
        {visible.map((tree, index) => (
          <EntryRow
            key={tree.collection.id}
            id={tree.collection.id}
            name={tree.collection.name}
            kind="collection"
            collectionId={tree.collection.id}
            parent={{ kind: 'root' }}
            index={index}
            selected={
              selectedEntity?.kind === 'collection' && selectedEntity.id === tree.collection.id
            }
            actions={actions}
            view={view}
          >
            <TreeNodes
              nodes={tree.children}
              parent={{ kind: 'collection', collectionId: tree.collection.id }}
              selectedRequestId={selectedRequestId}
              selectedEntity={selectedEntity}
              actions={actions}
              view={view}
            />
          </EntryRow>
        ))}
      </ul>

      {/* 滚动条悬浮在内容之上，不占行宽：原生滚动条一出现一消失，
          右对齐的「⋯」就会跟着左右跳 */}
      <OverlayScrollbar targetRef={treeScrollRef} />
    </div>
  );
}

/**
 * 树的对外门面：命令式入口（就地改名）以 ref 交出去。
 *
 * 快捷键挂在 App 的 window 监听上，而「哪一行此刻可见」由树内部的折叠与搜索状态决定，
 * 所以这个入口只能由树自己提供（spec: ui-layout「树操作的快捷键」）。
 */
export const WorkspaceTree = forwardRef<WorkspaceTreeHandle, WorkspaceTreeProps>(
  function WorkspaceTree(props, ref) {
    return <WorkspaceTreeInner {...props} handle={ref} />;
  },
);
