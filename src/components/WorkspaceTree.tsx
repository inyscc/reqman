import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  onRenameEntity: (entity: EntitySelection) => void;
  onRenameRequest: (id: string) => void;
  onToggle: (id: string) => void;
  /** 双击目录名：对当前节点及其全部后代目录做递归折叠/展开。 */
  onToggleRecursive: (id: string, childNodes: TreeNode[]) => void;
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
  return {
    onMouseEnter: () => view.setActive(id),
    onMouseLeave: () => {
      if (view.menuId !== id) view.setActive(null);
    },
    onFocus: () => view.setActive(id),
    onBlur: () => {
      if (view.menuId !== id) view.setActive(null);
    },
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

/** 单击选中实体的延迟阈值（毫秒）：用于把「单击」和「双击」区分开，双击时不选中。 */
const SELECT_DEBOUNCE_MS = 200;

/** 收集子树里所有文件夹节点 id（不含请求叶子），深度优先遍历其 children。 */
function collectFolderIds(nodes: TreeNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    if (node.kind === 'folder') {
      ids.push(node.id);
      ids.push(...collectFolderIds(node.children));
    }
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
  childNodes,
  children,
}: {
  id: string;
  name: string;
  kind: 'collection' | 'folder';
  collectionId: string;
  selected: boolean;
  actions: TreeActions;
  view: TreeView;
  /** 子节点（仅用于双击时计算后代目录 id）。 */
  childNodes: TreeNode[];
  children?: ReactNode;
}) {
  // 搜索态下强制展开：命中项被折叠藏起来就没有搜索可言
  const expanded = view.searching || !view.collapsed.has(id);
  const revealed = view.activeId === id || view.menuId === id;
  const entity: EntitySelection = { kind, id, collectionId };
  const reveal = useRowReveal(id, view);

  // 单击选中走去抖：双击发生时取消待提交的选中，使双击只做递归折叠/展开（不切主区）。
  const selectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (selectTimer.current) clearTimeout(selectTimer.current);
    },
    [],
  );
  const scheduleSelect = () => {
    if (selectTimer.current) clearTimeout(selectTimer.current);
    selectTimer.current = setTimeout(() => {
      selectTimer.current = null;
      actions.onSelectEntity(entity);
    }, SELECT_DEBOUNCE_MS);
  };
  const cancelSelect = () => {
    if (selectTimer.current) {
      clearTimeout(selectTimer.current);
      selectTimer.current = null;
    }
  };

  const menu: MenuItem[] = [
    {
      label: '新建请求',
      onSelect: () => actions.onNewRequest(collectionId, kind === 'folder' ? id : null),
    },
    {
      label: kind === 'folder' ? '新建子文件夹' : '新建文件夹',
      onSelect: () => actions.onNewFolder(collectionId, kind === 'folder' ? id : null),
    },
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
        title={`编辑${kind === 'collection' ? '集合' : '文件夹'}脚本`}
        onClick={() => scheduleSelect()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') actions.onSelectEntity(entity);
        }}
        onDoubleClick={(event) => {
          if (view.searching) return;
          const target = event.target as HTMLElement;
          if (target.closest('.tree-toggle') || target.closest('.node-more')) return;
          cancelSelect();
          actions.onToggleRecursive(id, childNodes);
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
          if (event.key === 'Enter') actions.onSelectRequest(node.id);
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
            childNodes={node.children}
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
 * 工具栏（对齐 Postman）：搜索框 + 两个图标按钮。
 *
 * tab 名已经是 Collections，行内不再重复「集合」标题；新建与导入是图标按钮，
 * 文字只留在 `aria-label` / `title` 里（可访问性与悬停提示都不丢）。
 */
function TreeToolbar({
  query,
  onQuery,
  onNewCollection,
  onImport,
}: {
  query: string;
  onQuery: (next: string) => void;
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
    onRenameEntity,
    onRenameRequest,
    onToggle: (id) =>
      setCollapsed((previous) => {
        const next = new Set(previous);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    onToggleRecursive: (id, childNodes) =>
      setCollapsed((previous) => {
        const next = new Set(previous);
        const subtree = [id, ...collectFolderIds(childNodes)];
        if (next.has(id)) subtree.forEach((nodeId) => next.delete(nodeId));
        else subtree.forEach((nodeId) => next.add(nodeId));
        return next;
      }),
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
        onQuery={setQuery}
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
            childNodes={tree.children}
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
