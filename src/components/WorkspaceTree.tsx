import { useMemo, useState, type ReactNode } from 'react';
import { FolderIcon } from './icons';
import { NodeMenu, type MenuItem } from './NodeMenu';
import type { CollectionTree, TreeNode } from '../lib/types';

/** 树中被选中的实体：集合或文件夹（脚本编辑入口，任务 5.2）。 */
export interface EntitySelection {
  kind: 'collection' | 'folder';
  id: string;
  collectionId: string;
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
  /** 选中实体并把焦点交给面包屑的名称输入框。 */
  onRenameEntity: (entity: EntitySelection) => void;
  onRenameRequest: (id: string) => void;
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

function MoreButton({ id, view }: { id: string; view: TreeView }) {
  return (
    <button
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
  selected,
  actions,
  view,
  children,
}: {
  id: string;
  name: string;
  kind: 'collection' | 'folder';
  collectionId: string;
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
    { label: '重命名', onSelect: () => actions.onRenameEntity(entity) },
    {
      label: kind === 'folder' ? '删除文件夹' : '删除集合',
      danger: true,
      onSelect: () =>
        kind === 'folder' ? view.setConfirm(id) : actions.onDeleteCollection(id),
    },
  ];

  return (
    <li>
      <div
        className={`node ${selected ? 'selected' : ''}`}
        role="button"
        tabIndex={0}
        title={`${expanded ? '折叠' : '展开'} ${name}`}
        onClick={(event) => {
          // 双击的第二击不重复切换，否则会「展开后又立刻折回」地闪一下
          if (event.detail === 2) return;
          actions.onToggle(id);
        }}
        onKeyDown={(event) => {
          // Enter 只归行容器自己。行内还有折叠箭头、「⋯」与菜单项，它们的 keydown 会
          // 冒泡到这里，而浏览器对聚焦的按钮按 Enter 还会再补一次 click——不拦住就会
          // 出现「在箭头上按 Enter 净零无效」「在「⋯」上按 Enter 把目录折叠掉」。
          if (event.key === 'Enter' && event.target === event.currentTarget) actions.onToggle(id);
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
        <span className="tree-name">{name}</span>
        <span className="grow" />
        {revealed && <MoreButton id={id} view={view} />}
        {view.menuId === id && <NodeMenu items={menu} onClose={() => view.setMenu(null)} />}
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
  selected,
  actions,
  view,
}: {
  node: TreeNode;
  selected: boolean;
  actions: TreeActions;
  view: TreeView;
}) {
  const revealed = view.activeId === node.id || view.menuId === node.id;
  const reveal = useRowReveal(node.id, view);
  const menu: MenuItem[] = [
    { label: '重命名', onSelect: () => actions.onRenameRequest(node.id) },
    { label: '复制', onSelect: () => actions.onDuplicateRequest(node.id) },
    { label: '删除', danger: true, onSelect: () => actions.onDeleteRequest(node.id) },
  ];

  return (
    <li>
      <div
        className={`node ${selected ? 'selected' : ''}`}
        role="button"
        tabIndex={0}
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
          view.setMenu(node.id);
        }}
        {...reveal}
      >
        <span className="tree-toggle-space" aria-hidden="true" />
        <span className="method-badge" data-method={node.request?.method ?? 'GET'}>
          {node.request?.method ?? 'GET'}
        </span>
        <span className="tree-name">{node.name}</span>
        <span className="grow" />
        {revealed && <MoreButton id={node.id} view={view} />}
        {view.menuId === node.id && (
          <NodeMenu
            items={menu}
            onClose={() => view.setMenu(null)}
          />
        )}
      </div>
    </li>
  );
}

function TreeNodes({
  nodes,
  collectionId,
  selectedRequestId,
  selectedEntity,
  actions,
  view,
}: {
  nodes: TreeNode[];
  collectionId: string;
  selectedRequestId: string | null;
  selectedEntity: EntitySelection | null;
  actions: TreeActions;
  view: TreeView;
}) {
  return (
    <ul className="tree">
      {nodes.map((node) =>
        node.kind === 'folder' ? (
          <EntryRow
            key={node.id}
            id={node.id}
            name={node.name}
            kind="folder"
            collectionId={collectionId}
            selected={selectedEntity?.kind === 'folder' && selectedEntity.id === node.id}
            actions={actions}
            view={view}
          >
            <TreeNodes
              nodes={node.children}
              collectionId={collectionId}
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

export function WorkspaceTree(props: WorkspaceTreeProps) {
  const {
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
    onRenameEntity,
    onRenameRequest,
    onImport,
  } = props;

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  /** 搜索词：组件内视图态，`App` 不知情（design D1）。 */
  const [query, setQuery] = useState('');

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

  const view: TreeView = {
    collapsed,
    searching,
    activeId,
    menuId,
    confirmId,
    setActive: setActiveId,
    setMenu: setMenuId,
    setConfirm: setConfirmId,
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

      <ul className="tree tree-root">
        {visible.map((tree) => (
          <EntryRow
            key={tree.collection.id}
            id={tree.collection.id}
            name={tree.collection.name}
            kind="collection"
            collectionId={tree.collection.id}
            selected={
              selectedEntity?.kind === 'collection' && selectedEntity.id === tree.collection.id
            }
            actions={actions}
            view={view}
          >
            <TreeNodes
              nodes={tree.children}
              collectionId={tree.collection.id}
              selectedRequestId={selectedRequestId}
              selectedEntity={selectedEntity}
              actions={actions}
              view={view}
            />
          </EntryRow>
        ))}
      </ul>
    </div>
  );
}
