import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import './App.css';
import { BottomBar, type ModalKind } from './components/BottomBar';
import { CookiePanel } from './components/CookiePanel';
import { Dropdown } from './components/Dropdown';
import {
  EntityScriptPanel,
  type EntityInnerTab,
  type EntitySaveStatus,
} from './components/EntityScriptPanel';
import { EnvironmentsPanel } from './components/EnvironmentsPanel';
import { CollectionIcon, FolderIcon } from './components/icons';
import { ImportExportPanel } from './components/ImportExportPanel';
import { Modal } from './components/Modal';
import { RequestBand, RequestEditor, type Tab } from './components/RequestEditor';
import { ResizeStrips, isInteractiveSessionBarTarget } from './components/ResizeStrips';
import { ResponsePanel } from './components/ResponsePanel';
import { SettingsPanel } from './components/SettingsPanel';
import { SplitHandle } from './components/SplitHandle';
import { VariablesPeek } from './components/VariablesPeek';
import { VariablesPanel } from './components/VariablesPanel';
import { WorkspaceTree, type EntitySelection, type RenameTarget } from './components/WorkspaceTree';
import { commands as defaultCommands, describeError, type Commands } from './lib/commands';
import { createEditingRegistry, SURFACE_PRIORITY } from './lib/editing';
import { applyTreeMove, type TreeMove } from './lib/treeMoves';
import { readSplitRatio, SPLIT_DEFAULT, writeSplitRatio } from './lib/layout';
import {
  DEFAULT_PRESENTATION,
  readPresentation,
  type ResponsePresentation,
} from './lib/responsePresentation';
import { readTabs, writeTabs } from './lib/sessionTabs';
import {
  allowScriptExecution,
  isScriptExecutionAllowed,
  renderVisualizer,
  runScriptPhase,
} from './lib/scriptRuntime';
import type { ConsoleEntry, TestAssertion, VisualizerResult } from './lib/scriptRuntime';
import { withoutEmptyRows, cleanForSend } from './lib/rows';
import { alignUrlAndParams } from './lib/url';
import { createEntityStore } from './lib/store';
import type {
  Collection,
  CollectionTree,
  Environment,
  Folder,
  RequestPreview,
  ResponsePayload,
  SavedRequest,
  TreeNode,
  Variable,
  Workspace,
} from './lib/types';
import { useEditingRegistryVersion } from './lib/useEditing';
import { useStoreValue } from './lib/useStore';
import { onBeforeUnload, tauriWindowCloser, type WindowCloser } from './lib/window';

type EntityKind = 'collection' | 'folder';

/**
 * 集合/文件夹脚本的自动保存延迟：用户停止输入后这么久落库。
 * 短到"改完就走"不会丢，长到连续键入不会每次按键都写一次。
 */
const ENTITY_AUTOSAVE_DELAY_MS = 500;

interface ScriptReport {
  console: ConsoleEntry[];
  assertions: TestAssertion[];
  error: string | null;
  visualizer?: VisualizerResult | null;
}

/**
 * 请求编辑会话（design D1）：草稿、未保存标记、响应、内层标签与脚本报告
 * 都按标签各持一份——切换标签不再覆盖任何东西，守卫因此收缩到「关闭」。
 */
interface RequestSessionTab {
  kind: 'request';
  /** `request:<requestId>`，同时是编辑面 id。 */
  id: string;
  requestId: string;
  draft: SavedRequest;
  dirty: boolean;
  response: ResponsePayload | null;
  innerTab: Tab;
  scriptReport: ScriptReport | null;
}

/**
 * 集合/文件夹脚本面板会话。实体草稿（含就地编辑的脚本与名称）放在标签里，
 * 而不是面板组件的本地 state——否则切走标签就会把没存下的脚本丢掉。
 */
interface EntitySessionTab {
  kind: 'entity';
  /** `entity:<kind>:<id>`，同时是编辑面 id。 */
  id: string;
  entityKind: EntityKind;
  entityId: string;
  collectionId: string;
  entity: Collection | Folder | null;
  /** 已保存的脚本基线：保存成功后前移，未保存守卫据此判断。 */
  baseline: { pre: string; test: string } | null;
  /** 集合面板的内层页签（变量 / 脚本）；文件夹不使用。 */
  innerTab: EntityInnerTab;
}

type SessionTab = RequestSessionTab | EntitySessionTab;

const requestTabId = (requestId: string): string => `request:${requestId}`;
const entityTabId = (kind: EntityKind, id: string): string => `entity:${kind}:${id}`;

const entityPre = (entity: Collection | Folder): string => entity.pre_request_script ?? '';
const entityTest = (entity: Collection | Folder): string => entity.test_script ?? '';

function isTabDirty(tab: SessionTab): boolean {
  if (tab.kind === 'request') return tab.dirty;
  if (!tab.entity || !tab.baseline) return false;
  return entityPre(tab.entity) !== tab.baseline.pre || entityTest(tab.entity) !== tab.baseline.test;
}

function tabName(tab: SessionTab): string {
  return tab.kind === 'request' ? tab.draft.name : (tab.entity?.name ?? '');
}

/**
 * 用户已经表达「我要丢弃某些未保存改动」的意图。
 *
 * 多标签把「切换」从这张清单上拿掉了（切换不丢东西）；剩下的只有真正的丢弃：
 * 关脏标签、删除（含集合/文件夹的级联）与退出应用。
 */
type PendingIntent =
  | { kind: 'close-tab'; key: string }
  | { kind: 'delete-request'; id: string }
  | { kind: 'delete-collection'; id: string }
  | { kind: 'delete-folder'; id: string }
  /** 退出应用：答案要还回 Tauri 的关闭回调（见 closeResolverRef）。 */
  | { kind: 'exit-app' };

/** 树里是否还存在某个集合/文件夹——标签对账的判据只用「条目是否仍存在」（design D5）。 */
function entityExists(trees: CollectionTree[], kind: EntityKind, id: string): boolean {
  if (kind === 'collection') {
    return trees.some((tree) => tree.collection.id === id);
  }

  const search = (nodes: TreeNode[]): boolean => {
    for (const node of nodes) {
      if (node.kind === 'folder' && node.id === id) return true;
      if (search(node.children)) return true;
    }
    return false;
  };

  return trees.some((tree) => search(tree.children));
}

function tabExistsInTrees(tab: SessionTab, trees: CollectionTree[]): boolean {
  return tab.kind === 'request'
    ? findRequest(trees, tab.requestId) !== null
    : entityExists(trees, tab.entityKind, tab.entityId);
}

/** 收集某个文件夹及其全部后代文件夹的 id——删除文件夹的级联范围。 */
function collectFolderSubtreeIds(trees: CollectionTree[], folderId: string): Set<string> {
  const ids = new Set<string>();

  const search = (nodes: TreeNode[]): boolean => {
    for (const node of nodes) {
      if (node.kind !== 'folder') continue;
      if (node.id === folderId) {
        ids.add(node.id);
        const collect = (children: TreeNode[]) => {
          for (const child of children) {
            if (child.kind === 'folder') {
              ids.add(child.id);
              collect(child.children);
            }
          }
        };
        collect(node.children);
        return true;
      }
      if (search(node.children)) return true;
    }
    return false;
  };

  for (const tree of trees) {
    if (search(tree.children)) break;
  }
  return ids;
}

function collectionHasDirtyTab(tabs: SessionTab[], collectionId: string): boolean {
  return tabs.some(
    (item) =>
      isTabDirty(item) &&
      (item.kind === 'request'
        ? item.draft.collection_id === collectionId
        : item.entityKind === 'collection'
          ? item.entityId === collectionId
          : item.collectionId === collectionId),
  );
}

function folderHasDirtyTab(tabs: SessionTab[], subtree: Set<string>): boolean {
  return tabs.some(
    (item) =>
      isTabDirty(item) &&
      (item.kind === 'request'
        ? item.draft.folder_id != null && subtree.has(item.draft.folder_id)
        : item.entityKind === 'folder' && subtree.has(item.entityId)),
  );
}

export interface AppProps {
  /** 命令层可注入，测试用假的实现替换真实 IPC。 */
  client?: Commands;
  /** 窗口控制口可注入，测试用假的实现替换真实 Tauri（见 lib/window.ts）。 */
  windowCloser?: WindowCloser;
}

/** 用乐观值覆盖树里的请求节点，使重命名等编辑立刻可见。 */
function applyOverlay(
  trees: CollectionTree[],
  resolve: (id: string) => SavedRequest | undefined,
): CollectionTree[] {
  const walk = (nodes: TreeNode[]): TreeNode[] =>
    nodes.map((node) => {
      if (node.kind === 'request') {
        const optimistic = resolve(node.id);
        return optimistic
          ? { ...node, name: optimistic.name, request: optimistic }
          : node;
      }
      return { ...node, children: walk(node.children) };
    });

  return trees.map((tree) => ({ ...tree, children: walk(tree.children) }));
}

/** 树里集合或文件夹的当前名称——空名称保存失败时用它把输入框还原。 */
function findEntityName(trees: CollectionTree[], entity: EntitySelection): string | null {
  if (entity.kind === 'collection') {
    return trees.find((tree) => tree.collection.id === entity.id)?.collection.name ?? null;
  }

  const search = (nodes: TreeNode[]): string | null => {
    for (const node of nodes) {
      if (node.kind === 'folder' && node.id === entity.id) return node.name;
      const found = search(node.children);
      if (found) return found;
    }
    return null;
  };

  for (const tree of trees) {
    const found = search(tree.children);
    if (found) return found;
  }
  return null;
}

function findRequest(trees: CollectionTree[], id: string): SavedRequest | null {
  const search = (nodes: TreeNode[]): SavedRequest | null => {
    for (const node of nodes) {
      if (node.kind === 'request' && node.id === id && node.request) return node.request;
      const found = search(node.children);
      if (found) return found;
    }
    return null;
  };
  for (const tree of trees) {
    const found = search(tree.children);
    if (found) return found;
  }
  return null;
}

/** 集合或文件夹当前的名字；找不到返回 undefined。 */
function entityNameIn(trees: CollectionTree[], id: string): string | undefined {
  const search = (nodes: TreeNode[]): string | undefined => {
    for (const node of nodes) {
      if (node.id === id) return node.name;
      const found = search(node.children);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  for (const tree of trees) {
    if (tree.collection.id === id) return tree.collection.name;
    const found = search(tree.children);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function App({ client = defaultCommands, windowCloser = tauriWindowCloser }: AppProps) {
  const requestStore = useMemo(() => createEntityStore<SavedRequest>(), []);
  /** 编辑面注册表：Ctrl+S 与未保存守卫共用它（见 lib/editing.ts）。 */
  const editingRegistry = useMemo(() => createEditingRegistry(), []);
  const [, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [trees, setTrees] = useState<CollectionTree[]>([]);
  // ---------------------------------------------------------------------------
  // 会话标签状态（design D1）：主区显示什么由 activeTabKey 唯一决定，
  // 树的选中态由它派生（spec「标签激活态与树的选中一致」）。
  // ---------------------------------------------------------------------------
  const [tabs, setTabs] = useState<SessionTab[]>([]);
  const [activeTabKey, setActiveTabKey] = useState<string | null>(null);
  /** 标签集合是否已按当前工作区恢复完成；恢复前不写持久化，避免把空集合写回去。 */
  const [tabsHydrated, setTabsHydrated] = useState(false);
  const [preview, setPreview] = useState<RequestPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 待确认的脚本门禁；非空时暂停发送，等用户在界面上做出选择（任务 9.3）。 */
  const [scriptGate, setScriptGate] = useState<{ collectionId: string; name: string } | null>(
    null,
  );
  /** 集合/文件夹脚本自动保存的就地状态（spec: 脚本的编辑与保存）。 */
  const [entitySave, setEntitySave] = useState<({ key: string } & EntitySaveStatus) | null>(null);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  /** 环境编辑器标题里正在编辑的名字；`null` 表示跟随后端的值。 */
  const [environmentNameDraft, setEnvironmentNameDraft] = useState<string | null>(null);
  const [variables, setVariables] = useState<Variable[]>([]);
  /** 请求区与响应区的分栏比例（design D7）；以工作区为单位持久化。 */
  const [splitRatio, setSplitRatio] = useState(SPLIT_DEFAULT);
  /**
   * 应用级响应呈现配置（spec: ui-layout「设置模态的响应呈现配置」）。
   *
   * 由 App 持有而不是设置面板私有：它同时决定**新响应**的初始呈现格式，设置面板
   * 保存后经 `onPresentationChange` 回写这里，改动因此立即生效。
   */
  const [presentation, setPresentation] = useState<ResponsePresentation>(DEFAULT_PRESENTATION);
  /** 侧栏内部 tab：Collections / Environments（design D2）。 */
  const [sidebarTab, setSidebarTab] = useState<'collections' | 'environments'>('collections');
  /** 低频面板的单例模态（design D5）：非空时打开对应弹窗，同一时间至多一个。 */
  const [modal, setModal] = useState<ModalKind | null>(null);
  /** 被未保存改动挡下的意图；非空时界面给出三选一提示。 */
  const [pendingIntent, setPendingIntent] = useState<PendingIntent | null>(null);
  /** 菜单的「重命名」只负责把焦点交给面板头里的名称框（design D3）。 */
  const [pendingRenameFocus, setPendingRenameFocus] = useState(false);
  const entityNameRef = useRef<HTMLInputElement>(null);
  const requestNameRef = useRef<HTMLInputElement>(null);
  /** Ctrl+S 的一次保存尚未结束时，不再重复提交。 */
  const savingRef = useRef(false);
  /** 关闭标签的实现声明在组件靠后处；全局快捷键 effect 经 ref 引用，避免「声明前使用」。 */
  const requestCloseTabRef = useRef<(key: string) => void>(() => {});
  /** 窗口关闭请求挂起时，用它把「要不要关」的答案还给 Tauri 的关闭回调。 */
  const closeResolverRef = useRef<((allow: boolean) => void) | null>(null);
  /** 窗口是否处于最大化：最大化 / 还原按钮的图标跟随这个真实状态（window-chrome spec）。 */
  const [maximized, setMaximized] = useState(false);

  const storeVersion = useStoreValue(requestStore, (store) => store.version());
  const optimisticErrors = useStoreValue(requestStore, (store) => store.errors().length);
  /** 订阅编辑面注册表：某个面注册/脏状态变化时重算守卫与快捷键的判断依据。 */
  const editingVersion = useEditingRegistryVersion(editingRegistry);

  const previewSequence = useRef(0);

  // ---------------------------------------------------------------------------
  // 派生值：单槽位时代的 draft/dirty/tab/response/scriptReport/selectedEntity
  // 全部从激活标签读出（design D1）。
  // ---------------------------------------------------------------------------
  const activeTab = tabs.find((item) => item.id === activeTabKey) ?? null;
  const activeRequestTab = activeTab?.kind === 'request' ? activeTab : null;
  const activeEntityTab = activeTab?.kind === 'entity' ? activeTab : null;
  const draft = activeRequestTab?.draft ?? null;
  const dirty = activeRequestTab?.dirty ?? false;
  const tab: Tab = activeRequestTab?.innerTab ?? 'params';
  const response = activeRequestTab?.response ?? null;
  const scriptReport = activeRequestTab?.scriptReport ?? null;
  const entityDraft = activeEntityTab?.entity ?? null;
  /** 树中选中的集合/文件夹（脚本编辑入口）；选中请求时为 null。 */
  const selectedEntity: EntitySelection | null = activeEntityTab
    ? {
        kind: activeEntityTab.entityKind,
        id: activeEntityTab.entityId,
        collectionId: activeEntityTab.collectionId,
      }
    : null;

  // 命令式编辑面注册需要读取「最新」值，因此维护一组镜像 ref。
  const tabsRef = useRef<SessionTab[]>(tabs);
  tabsRef.current = tabs;
  const treesRef = useRef<CollectionTree[]>(trees);
  treesRef.current = trees;
  const activeKeyRef = useRef<string | null>(activeTabKey);
  activeKeyRef.current = activeTabKey;
  const workspaceIdRef = useRef<string | null>(workspaceId);
  workspaceIdRef.current = workspaceId;
  const showEnvironmentEditorRef = useRef(sidebarTab === 'environments');
  showEnvironmentEditorRef.current = sidebarTab === 'environments';
  const modalRef = useRef(modal);
  modalRef.current = modal;

  const patchRequestTab = useCallback(
    (key: string, patch: (item: RequestSessionTab) => RequestSessionTab) => {
      setTabs((previous) =>
        previous.map((item) =>
          item.id === key && item.kind === 'request' ? patch(item) : item,
        ),
      );
    },
    [],
  );

  const patchEntityTab = useCallback(
    (key: string, patch: (item: EntitySessionTab) => EntitySessionTab) => {
      setTabs((previous) =>
        previous.map((item) =>
          item.id === key && item.kind === 'entity' ? patch(item) : item,
        ),
      );
    },
    [],
  );

  /**
   * 移除满足条件的标签，并在被移除的正是激活标签时把激活态移交给相邻标签
   * （spec「关闭激活标签后激活态移交」；没有标签则回空态）。
   */
  const removeTabsWhere = useCallback((predicate: (item: SessionTab) => boolean) => {
    const current = tabsRef.current;
    const kept = current.filter((item) => !predicate(item));
    if (kept.length === current.length) return;

    const removedActiveIndex = current.findIndex(
      (item) => predicate(item) && item.id === activeKeyRef.current,
    );
    setTabs(kept);
    if (removedActiveIndex >= 0) {
      setActiveTabKey(
        kept.length > 0 ? kept[Math.min(removedActiveIndex, kept.length - 1)].id : null,
      );
    }
  }, []);

  // ---------------------------------------------------------------------------
  // 唯一的打开入口（design D1）：同一 id 至多一个标签是硬约束。
  // 已在册则只聚焦既有标签，SHALL NOT 重载其草稿。
  // ---------------------------------------------------------------------------
  const openRequest = useCallback(
    async (id: string) => {
      const key = requestTabId(id);
      setError(null);

      if (tabsRef.current.some((item) => item.id === key)) {
        setActiveTabKey(key);
        return;
      }

      const optimistic = requestStore.get(id);
      const loaded =
        optimistic ?? findRequest(treesRef.current, id) ?? (await client.requestGet(id));
      const next: RequestSessionTab = {
        kind: 'request',
        id: key,
        requestId: id,
        // 打开时清一次历史空行：此前存进去的空行不该在表格里占位；
        // 再对齐 URL 与参数表（spec: URL 与参数表保持同步），存量不一致在此自愈
        draft: alignUrlAndParams(withoutEmptyRows(loaded)),
        dirty: false,
        response: null,
        innerTab: 'params',
        scriptReport: null,
      };
      setTabs((previous) =>
        previous.some((item) => item.id === key) ? previous : [...previous, next],
      );
      setActiveTabKey(key);
    },
    [client, requestStore],
  );

  const openEntity = useCallback(
    async (kind: EntityKind, id: string, collectionId: string) => {
      const key = entityTabId(kind, id);
      setError(null);

      if (tabsRef.current.some((item) => item.id === key)) {
        setActiveTabKey(key);
        return;
      }

      try {
        const loaded =
          kind === 'collection' ? await client.collectionGet(id) : await client.folderGet(id);
        const next: EntitySessionTab = {
          kind: 'entity',
          id: key,
          entityKind: kind,
          entityId: id,
          collectionId,
          entity: loaded,
          baseline: { pre: entityPre(loaded), test: entityTest(loaded) },
          // 集合面板默认停在变量页（spec: 集合面板的变量与脚本站签）
          innerTab: 'variables',
        };
        setTabs((previous) =>
          previous.some((item) => item.id === key) ? previous : [...previous, next],
        );
        setActiveTabKey(key);
      } catch (caught) {
        setError(describeError(caught).message);
      }
    },
    [client],
  );

  const loadTree = useCallback(
    async (id: string) => {
      const loaded = await client.workspaceTree(id);
      setTrees(loaded);
      requestStore.seed(
        loaded.flatMap(function collect(tree): SavedRequest[] {
          const walk = (nodes: TreeNode[]): SavedRequest[] =>
            nodes.flatMap((node) =>
              node.kind === 'request' && node.request ? [node.request] : walk(node.children),
            );
          return walk(tree.children);
        }),
      );
      // 对账（design D5）：必须在条目写回 store 之后跑（先 seed 再对账），
      // 丢弃指向已不存在条目的标签；判据只用「条目是否仍存在」，不看标签是否脏。
      removeTabsWhere((item) => !tabExistsInTrees(item, loaded));
    },
    [client, requestStore, removeTabsWhere],
  );

  const loadEnvironments = useCallback(
    async (id: string) => {
      const [list, active] = await Promise.all([
        client.environmentList(id),
        client.environmentActive(id),
      ]);
      setEnvironments(list);
      setEnvironmentId(active?.id ?? null);
    },
    [client],
  );

  const loadVariables = useCallback(
    async (id: string, environment: string | null) => {
      if (environment) {
        setVariables(await client.variableList('environment', environment));
      } else {
        setVariables(await client.globalsList(id));
      }
    },
    [client],
  );

  /**
   * 集合变量的加载（spec: 集合变量就地可维护）：只在激活的是集合面板时取一次，
   * 写入后由 `collectionVariablesVersion` 触发重取。与只读浮层的按需读取互不依赖。
   */
  const [collectionVariables, setCollectionVariables] = useState<Variable[]>([]);
  const [collectionVariablesVersion, setCollectionVariablesVersion] = useState(0);
  const collectionVariablesOwner = activeEntityTab?.entityKind === 'collection'
    ? activeEntityTab.entityId
    : null;

  useEffect(() => {
    if (!collectionVariablesOwner) {
      setCollectionVariables([]);
      return;
    }
    let cancelled = false;
    void client
      .variableList('collection', collectionVariablesOwner)
      .then((list) => {
        if (!cancelled) setCollectionVariables(list);
      })
      .catch((caught) => {
        if (!cancelled) setError(describeError(caught).message);
      });
    return () => {
      cancelled = true;
    };
  }, [client, collectionVariablesOwner, collectionVariablesVersion]);

  /**
   * 环境激活的唯一入口（design D4）：侧栏列表与主区环境选择器共用它。
   *
   * 先乐观更新再落库——后端 `environment_set_active` 会按工作区先清空再置位，
   * 因此这次写入也让选择跨重启保留；失败则回滚并报错，避免界面与存储不一致。
   */
  const activateEnvironment = useCallback(
    async (id: string | null) => {
      if (!workspaceId) return;
      const previous = environmentId;
      setEnvironmentId(id);
      try {
        await client.environmentSetActive(workspaceId, id);
      } catch (caught) {
        setEnvironmentId(previous);
        setError(describeError(caught).message);
      }
    },
    [client, workspaceId, environmentId],
  );

  /** 环境删除后的收尾：刷新列表；删的正是激活环境时回落 Globals。 */
  const environmentRemoved = (id: string) => {
    if (workspaceId) void loadEnvironments(workspaceId);
    if (environmentId === id) void activateEnvironment(null);
  };

  useEffect(() => {
    void (async () => {
      try {
        const list = await client.workspaceList();
        setWorkspaces(list);
        const active = (await client.workspaceActive()) ?? list[0] ?? null;
        setWorkspaceId(active?.id ?? null);
      } catch (caught) {
        setError(describeError(caught).message);
      }
    })();
  }, [client]);

  /**
   * 加载工作区：先 `loadTree` 把条目写回 store（seed，内部已含对账）→ 再恢复
   * 标签集合。三者必须串好，否则恢复出的标签会被「指向不存在」误杀（design D6
   * 的恢复顺序）。
   */
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setTabsHydrated(false);

    void (async () => {
      try {
        await loadTree(workspaceId);
        await loadEnvironments(workspaceId);
        if (cancelled) return;

        // 恢复标签集合（spec「会话标签集合的持久化」）：指向已不存在的条目被丢弃。
        const persisted = await readTabs(client, workspaceId);
        if (cancelled) return;

        const restored: SessionTab[] = [];
        for (const entry of persisted.tabs) {
          if (entry.kind === 'request') {
            const request =
              requestStore.get(entry.id) ?? findRequest(treesRef.current, entry.id);
            if (!request) continue;
            restored.push({
              kind: 'request',
              id: requestTabId(entry.id),
              requestId: entry.id,
              draft: alignUrlAndParams(withoutEmptyRows(request)),
              dirty: false,
              response: null,
              innerTab: 'params',
              scriptReport: null,
            });
            continue;
          }

          if (!entityExists(treesRef.current, entry.entityKind, entry.id)) continue;
          try {
            const loaded =
              entry.entityKind === 'collection'
                ? await client.collectionGet(entry.id)
                : await client.folderGet(entry.id);
            restored.push({
              kind: 'entity',
              id: entityTabId(entry.entityKind, entry.id),
              entityKind: entry.entityKind,
              entityId: entry.id,
              collectionId: 'collection_id' in loaded ? loaded.collection_id : entry.id,
              entity: loaded,
              baseline: { pre: entityPre(loaded), test: entityTest(loaded) },
              innerTab: entry.innerTab ?? 'variables',
            });
          } catch {
            // 取不回的实体按「已删除」处理：丢弃而不是进入错误态
          }
        }

        if (cancelled) return;
        setTabs(restored);
        setActiveTabKey(
          persisted.activeId && restored.some((item) => item.id === persisted.activeId)
            ? persisted.activeId
            : (restored[0]?.id ?? null),
        );
        setTabsHydrated(true);
      } catch (caught) {
        if (!cancelled) setError(describeError(caught).message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceId, loadTree, loadEnvironments, client, requestStore]);

  // 标签集合持久化：只在开/关/切时写（design D6），不在每次编辑时写；
  // 恢复完成之前不写，避免用空集合覆盖上次的记录。
  useEffect(() => {
    if (!workspaceId || !tabsHydrated) return;
    const value = {
      tabs: tabs.map((item) =>
        item.kind === 'request'
          ? ({ kind: 'request', id: item.requestId } as const)
          : ({
              kind: 'entity',
              entityKind: item.entityKind,
              id: item.entityId,
              innerTab: item.innerTab,
            } as const),
      ),
      activeId: activeTabKey,
    };
    void writeTabs(client, workspaceId, value);
  }, [client, workspaceId, tabsHydrated, tabs, activeTabKey]);

  // 分栏比例：切换工作区时读回该工作区上次调整的值（design D7）。
  // 读不到就回落默认——一条显示偏好不该把界面拖进错误态。
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;

    void readSplitRatio(client, workspaceId)
      .then((value) => {
        if (!cancelled) setSplitRatio(value);
      })
      .catch(() => {
        if (!cancelled) setSplitRatio(SPLIT_DEFAULT);
      });

    return () => {
      cancelled = true;
    };
  }, [client, workspaceId]);

  // 响应呈现配置是**应用级**的（不随工作区走），启动时读一次即可；
  // 读不到就回落默认——一条显示偏好不该把界面拖进错误态。
  useEffect(() => {
    let cancelled = false;

    void readPresentation(client)
      .then((value) => {
        if (!cancelled) setPresentation(value);
      })
      .catch(() => {
        if (!cancelled) setPresentation(DEFAULT_PRESENTATION);
      });

    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    if (!workspaceId) return;
    void loadVariables(workspaceId, environmentId).catch((caught) =>
      setError(describeError(caught).message),
    );
  }, [workspaceId, environmentId, loadVariables, storeVersion]);

  // 名称框可能还没渲染出来（实体是异步取回的），因此等到它出现再交焦点
  useEffect(() => {
    if (!pendingRenameFocus) return;
    const target = entityNameRef.current ?? requestNameRef.current;
    if (!target) return;
    target.focus();
    target.select();
    setPendingRenameFocus(false);
  }, [pendingRenameFocus, entityDraft, draft]);

  // 解析预览：只读变量浮层靠它回答「这个请求用了哪些变量」。
  // 解析预览条已移除，因此这里的失败不再有呈现位——预览是辅助展示，失败不该比请求本身
  // 更显眼，浮层在拿不到数据时降级为空列表（有意接受的信息损失，见 design D9）。
  useEffect(() => {
    if (!draft) {
      setPreview(null);
      return;
    }
    const sequence = ++previewSequence.current;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const next = await client.variablesPreview({
            saved_id: dirty ? null : draft.id,
            inline: cleanForSend(draft),
            environment_id: environmentId,
          });
          if (sequence === previewSequence.current) setPreview(next);
        } catch {
          if (sequence === previewSequence.current) setPreview(null);
        }
      })();
    }, 200);
    return () => clearTimeout(timer);
  }, [client, draft, dirty, environmentId]);

  const displayTrees = useMemo(
    () => applyOverlay(trees, (id) => requestStore.get(id)),
    // storeVersion 变化时重算
    [trees, requestStore, storeVersion],
  );

  /** 导出集合的目标：优先当前请求所属集合，否则第一个集合。 */
  const exportCollectionId = draft?.collection_id ?? trees[0]?.collection.id ?? null;

  /** 导出 curl 的目标请求：与发送使用同一份输入（未保存时走内联载荷）。 */
  const exportSendInput = useMemo(
    () =>
      draft
        ? {
            saved_id: dirty ? null : draft.id,
            inline: cleanForSend(draft),
            environment_id: environmentId,
          }
        : null,
    [draft, dirty, environmentId],
  );


  /** 面包屑左段：当前请求所属集合名（design D6）。 */
  const crumbCollectionName = draft
    ? (trees.find((tree) => tree.collection.id === draft.collection_id)?.collection.name ?? null)
    : null;

  /**
   * 侧栏 tab 决定主区内容（design D8）：停在 Environments 时主区就是环境编辑器。
   * 变量的表格放在这里而不是 280px 的侧栏里——侧栏留给列表，编辑要有地方铺开。
   * 打开的请求不会丢：切回 Collections 即恢复。
   */
  /**
   * 环境编辑器的标题就是**环境名**，并且可以就地改（与集合/文件夹/请求的面板头同款）。
   * 未激活环境时标题是 Globals，它没有实体可改名，因此不可编辑。
   */
  const activeEnvironment = environments.find((item) => item.id === environmentId) ?? null;

  const commitEnvironmentName = async () => {
    const draft = environmentNameDraft;
    if (draft === null || !activeEnvironment) return;

    setEnvironmentNameDraft(null);
    const next = draft.trim();
    if (next === '' || next === activeEnvironment.name) return;

    setError(null);
    try {
      await client.environmentRename(activeEnvironment.id, next);
      if (workspaceId) await loadEnvironments(workspaceId);
    } catch (caught) {
      setError(describeError(caught).message);
    }
  };

  const showEnvironmentEditor = sidebarTab === 'environments';

  const reloadAfterImport = useCallback(async () => {
    if (!workspaceId) return;
    await loadTree(workspaceId);
    await loadEnvironments(workspaceId);
    await loadVariables(workspaceId, environmentId);
  }, [workspaceId, environmentId, loadTree, loadEnvironments, loadVariables]);

  const editDraft = (next: SavedRequest) => {
    const key = activeKeyRef.current;
    if (!key) return;
    patchRequestTab(key, (item) => ({ ...item, draft: next, dirty: true }));
    requestStore.markDirty(next.id);
  };

  /** 切换请求编辑器的内层标签（Params/Body/…）：只动当前标签。 */
  const setInnerTab = (next: Tab) => {
    const key = activeKeyRef.current;
    if (!key) return;
    patchRequestTab(key, (item) => ({ ...item, innerTab: next }));
  };

  /** 保存某个请求标签：只动那一个标签的 dirty，不影响其他标签的草稿。 */
  const saveRequestTab = async (key: string): Promise<boolean> => {
    const current = tabsRef.current.find((item) => item.id === key);
    if (!current || current.kind !== 'request') return false;

    // 空行不进存储：清洗只发生在出口，用户编辑过程中清空的行照旧留在表格里
    const payload = withoutEmptyRows(current.draft);
    setBusy(true);
    setError(null);
    try {
      await requestStore.update(payload.id, payload, (value) => client.requestSave(value));

      // 编辑即授权（design D6）：在本应用中编写并保存的脚本视为已授权，
      // 发送时不再走导入脚本的确认门禁
      if (payload.pre_request_script?.trim() || payload.test_script?.trim()) {
        await allowScriptExecution(client, payload.collection_id);
      }

      patchRequestTab(key, (item) => ({ ...item, dirty: false }));
      const id = workspaceIdRef.current;
      if (id) await loadTree(id);
      return true;
    } catch (caught) {
      setError(describeError(caught).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** 保存某个实体脚本标签：基线前移后 dirty 归零。 */
  const saveEntityTab = async (key: string): Promise<boolean> => {
    const current = tabsRef.current.find((item) => item.id === key);
    if (!current || current.kind !== 'entity' || !current.entity) return false;

    const pre = entityPre(current.entity).trim() ? entityPre(current.entity) : null;
    const test = entityTest(current.entity).trim() ? entityTest(current.entity) : null;

    setBusy(true);
    setError(null);
    try {
      if (current.entityKind === 'collection') {
        await client.collectionSetScript(current.entityId, pre, test);
      } else {
        await client.folderSetScript(current.entityId, pre, test);
      }

      if (pre || test) {
        await allowScriptExecution(client, current.collectionId);
      }

      patchEntityTab(key, (item) => ({
        ...item,
        baseline: {
          pre: item.entity ? entityPre(item.entity) : '',
          test: item.entity ? entityTest(item.entity) : '',
        },
      }));
      const id = workspaceIdRef.current;
      if (id) await loadTree(id);
      return true;
    } catch (caught) {
      setError(describeError(caught).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** 自动保存一个实体脚本标签，并把结果写成就地状态（失败不清空输入，继续编辑会重试）。 */
  const autosaveEntity = async (key: string) => {
    setEntitySave({ key, status: 'saving', message: null });
    const saved = await saveEntityTab(key);
    setEntitySave(
      saved
        ? { key, status: 'saved', message: null }
        : { key, status: 'error', message: '自动保存失败，继续编辑会重试' },
    );
  };

  /**
   * 集合/文件夹脚本的自动保存（spec: 脚本的编辑与保存）：编辑停止后短暂延迟落库。
   *
   * 遍历**全部**实体标签而不只是激活的那一个——"改完就切走"是常态，只盯激活标签会把
   * 还没落库的编辑永远留在草稿里。签名带上脚本内容本身，因此每敲一下都重排定时器：
   * 落库发生在"停止输入"之后，而不是第一次按键之后。
   */
  const entityDraftSignature = tabs
    .map((item) =>
      item.kind === 'entity' && item.entity
        ? `${item.id}\u0000${entityPre(item.entity)}\u0000${entityTest(item.entity)}`
        : '',
    )
    .join('\u0001');

  useEffect(() => {
    const pending = tabsRef.current.filter(
      (item): item is EntitySessionTab => item.kind === 'entity' && isTabDirty(item),
    );
    if (pending.length === 0) return;

    const timer = window.setTimeout(() => {
      for (const item of pending) void autosaveEntity(item.id);
    }, ENTITY_AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
    // 只依赖脚本内容签名：落库成功后基线前移，脏判据自然为假，不会反复排期
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityDraftSignature]);

  /** 保存任意一个标签（编辑面注册表经由它保存各自的面）。 */
  const saveTab = async (key: string): Promise<boolean> => {
    const current = tabsRef.current.find((item) => item.id === key);
    if (!current) return false;
    return current.kind === 'request' ? saveRequestTab(key) : saveEntityTab(key);
  };

  /**
   * Ctrl+S：保存「当前生效」的那一个编辑面。
   *
   * 与守卫的「保存并继续」刻意不同——那里保存全部脏面（语义是"别丢东西"），
   * 这里只保存用户正在看的那一个（语义是"存我现在弄的这个"）。没有改动时
   * 不发任何写请求，一次保存尚未结束时也不重复提交。
   */
  const saveCurrentSurface = useCallback(async () => {
    if (savingRef.current || busy) return;
    const surface = editingRegistry.top();
    if (!surface || !surface.isDirty()) return;

    savingRef.current = true;
    setError(null);
    try {
      await surface.save();
    } catch (caught) {
      // 各编辑面自己会呈现错误；这里兜住没有自行处理的漏网情形
      setError(describeError(caught).message);
    } finally {
      savingRef.current = false;
    }
  }, [busy, editingRegistry]);

  /**
   * 全局快捷键（任务 6.1），全部挂在 window 层、不依赖焦点位置（与 Ctrl+S 一致）：
   * - Ctrl+S：保存当前生效的编辑面
   * - Ctrl+W：关闭激活标签（走守卫；交由 requestCloseTab，脏则先问）
   * - Ctrl+Tab / Ctrl+Shift+Tab：前后切换标签（环形）
   * - Ctrl+1..9：跳到第 N 个标签
   *
   * Ctrl+W 是否被 WebView2 交给页面，是 design 的 Open Question（任务 6.2）——若宿主
   * 吞掉它，快捷键清单只保留中键与关闭按钮，不影响其余逻辑。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;

      if (event.key.toLowerCase() === 's') {
        // 拦掉运行环境自己的「保存网页」
        event.preventDefault();
        void saveCurrentSurface();
        return;
      }

      if (event.key.toLowerCase() === 'w') {
        event.preventDefault();
        const active = activeKeyRef.current;
        if (active) requestCloseTabRef.current(active);
        return;
      }

      if (event.key === 'Tab') {
        event.preventDefault();
        const list = tabsRef.current;
        if (list.length === 0) return;
        const currentIndex = list.findIndex((item) => item.id === activeKeyRef.current);
        const delta = event.shiftKey ? -1 : 1;
        const nextIndex = (currentIndex + delta + list.length) % list.length;
        setActiveTabKey(list[nextIndex].id);
        return;
      }

      if (/^[1-9]$/.test(event.key)) {
        event.preventDefault();
        const target = tabsRef.current[Number(event.key) - 1];
        if (target) setActiveTabKey(target.id);
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveCurrentSurface]);

  /**
   * 退出应用前的未保存处置。
   *
   * `onCloseRequested` 的回调返回 true 才允许关窗，所以这里把一个 Promise 挂在守卫的
   * 提示上：选「保存并继续」或「不保存」时 resolve(true)，选「取消」时 resolve(false)。
   * 没有脏面就直接放行——不打断正常关闭。
   */
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      const off = await windowCloser.onCloseRequested(
        () =>
          new Promise<boolean>((resolve) => {
            if (editingRegistry.dirty().length === 0) {
              resolve(true);
              return;
            }
            closeResolverRef.current = resolve;
            setPendingIntent({ kind: 'exit-app' });
          }),
      );

      if (cancelled) off();
      else unlisten = off;
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [windowCloser, editingRegistry]);

  /**
   * 最大化 / 还原图标跟随窗口的真实状态（window-chrome spec）：
   * 初始查询一次，之后订阅尺寸变化（最大化 / 还原都会触发 resize）重查。
   */
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      setMaximized(await windowCloser.isMaximized());
      const off = await windowCloser.onResized(() => {
        void windowCloser.isMaximized().then(setMaximized);
      });
      if (cancelled) off();
      else unlisten = off;
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [windowCloser]);

  /**
   * 页面重载不走 CloseRequested，只能用 beforeunload 兜底。它只能唤起运行环境自己的
   * 确认提示（文案不可控、没有「保存」选项），因此 spec 只承诺「不静默丢弃」。
   */
  useEffect(() => onBeforeUnload(() => editingRegistry.dirty().length > 0), [editingRegistry]);

  // ---------------------------------------------------------------------------
  // 编辑面按标签注册（design D4）：每个打开的标签一个面，未激活的标签同样注册，
  // 因此它照样进入 dirty()，关窗时会被守卫提示——这正是「另一个标签里有没存下
  // 的东西」要保住的。
  //
  // 钩子数量不能随标签数变化，因此不走 useEditingSurface，而是在一个 effect 里
  // 命令式注册；isDirty/save/label 经 ref 读最新值，注册只随标签集合变化重建。
  // 实体面同样带 isActive（否则 top() 会选中后台实体标签，Ctrl+S 就会去保存
  // 用户没在看的脚本——本次改动引入的新缺陷面，必测）。
  // ---------------------------------------------------------------------------
  const saveTabRef = useRef(saveTab);
  saveTabRef.current = saveTab;

  const tabIdsSignature = tabs.map((item) => item.id).join('|');
  useEffect(() => {
    const offs = tabsRef.current.map((entry) =>
      editingRegistry.register({
        id: entry.id,
        priority:
          entry.kind === 'request' ? SURFACE_PRIORITY.request : SURFACE_PRIORITY.panel,
        get label() {
          const current = tabsRef.current.find((item) => item.id === entry.id);
          if (!current) return '';
          if (current.kind === 'request') return `请求「${current.draft.name}」`;
          const kindLabel = current.entityKind === 'collection' ? '集合' : '文件夹';
          return `${kindLabel}「${current.entity?.name ?? ''}」的脚本`;
        },
        isDirty: () => {
          const current = tabsRef.current.find((item) => item.id === entry.id);
          return current ? isTabDirty(current) : false;
        },
        save: () => saveTabRef.current(entry.id),
        isActive: () =>
          activeKeyRef.current === entry.id &&
          (entry.kind === 'entity' ||
            (!showEnvironmentEditorRef.current && modalRef.current === null)),
      }),
    );
    return () => offs.forEach((off) => off());
    // 标签集合（id 列表）变化时重建；脏状态经 ref 读取，不需要重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingRegistry, tabIdsSignature]);

  // 脏状态翻转时唤醒订阅者：守卫与 Ctrl+S 据此重新判断（对应 useEditingSurface 的 touch）。
  const dirtySignature = `${tabs
    .map((item) => (isTabDirty(item) ? '1' : '0'))
    .join('')}|${tabs.length}`;
  useEffect(() => {
    editingRegistry.touch();
  }, [editingRegistry, dirtySignature]);

  /** 有未保存改动的编辑面：未保存守卫据此判断要不要先问用户。 */
  const dirtySurfaces = useMemo(
    () => editingRegistry.dirty(),
    // editingVersion 变化时重算
    [editingRegistry, editingVersion],
  );

  /**
   * `skipScripts` 为真时跳过全部脚本只发请求——门禁被拒绝后的「不执行脚本，仍发送」。
   */
  const performSend = async (skipScripts: boolean) => {
    // 发送永远作用于当前激活的请求标签；响应与脚本报告写回它自己的标签
    const key = activeRequestTab?.id;
    if (!key || !draft) return;
    setError(null);
    setScriptGate(null);

    // 未解析变量在发出请求之前拦截（spec: 未解析变量提示）：占位符解析不出来时请求
    // 不放出去，错误里点名是哪些变量。判据取**发送时刻**的解析结果，而不是界面上那份
    // 防抖的预览状态——后者可能比用户最后一次键入滞后，会漏拦。
    //
    // 拦在最前面（早于脚本门禁、早于任何网络调用），因此门禁放行后的重发同样被拦。
    const sendInput = {
      saved_id: dirty ? null : draft.id,
      inline: cleanForSend(draft),
      environment_id: environmentId,
    };
    let resolved: RequestPreview;
    try {
      resolved = await client.variablesPreview(sendInput);
    } catch (caught) {
      setError(describeError(caught).message);
      return;
    }
    if (resolved.unresolved.length > 0) {
      setError(`以下变量未能解析，请求没有发出：${resolved.unresolved.join('、')}`);
      return;
    }

    setBusy(true);
    patchRequestTab(key, (item) => ({ ...item, scriptReport: null }));

    // 三级脚本：集合 → 文件夹 → 请求（任务 2.4）。集合与文件夹的脚本挂在实体上，
    // 树形接口不给，因此单独取回（任务 2.5）。
    const target = workspaceId
      ? { workspaceId, collectionId: draft.collection_id, environmentId }
      : null;
    let phases: { pre: (string | null)[]; test: (string | null)[] } | null = null;
    let requestUrl: string | null = null;
    let scriptError: string | null = null;
    let scriptVisualizer: VisualizerResult | null = null;
    const scriptConsole: ConsoleEntry[] = [];
    const scriptAssertions: TestAssertion[] = [];

    try {
      if (target && !skipScripts) {
        const collection = await client.collectionGet(draft.collection_id);

        // 门禁：脚本可能来自导入的集合，执行前必须确认（任务 9.3 / design D6）
        if (!(await isScriptExecutionAllowed(client, draft.collection_id))) {
          setScriptGate({ collectionId: draft.collection_id, name: collection.name });
          setBusy(false);
          return;
        }

        const folder = draft.folder_id ? await client.folderGet(draft.folder_id) : null;

        phases = {
          pre: [
            collection.pre_request_script ?? null,
            folder?.pre_request_script ?? null,
            draft.pre_request_script ?? null,
          ],
          test: [
            collection.test_script ?? null,
            folder?.test_script ?? null,
            draft.test_script ?? null,
          ],
        };

        // `pm.cookies` 需要解析后的请求 URL（3.5）。复用拦截处那一次解析的结果——
        // 启用脚本的请求不该为此多跑一趟。URL 中引用 secret 变量的极端情形会以掩码
        // 形态出现，属已知限制。
        requestUrl = resolved.url || null;

        const pre = await runScriptPhase(client, target, 'prerequest', phases.pre, null, requestUrl);

        scriptError = pre.error;
        scriptConsole.push(...pre.console);
        scriptAssertions.push(...pre.assertions);
      }

      const payload = await client.sendRequest({
        saved_id: dirty ? null : draft.id,
        inline: cleanForSend(draft),
        environment_id: environmentId,
      });
      patchRequestTab(key, (item) => ({ ...item, response: payload }));

      if (target && !skipScripts && phases) {
        const post = await runScriptPhase(client, target, 'test', phases.test, payload, requestUrl);

        scriptError = scriptError ?? post.error;
        scriptConsole.push(...post.console);
        scriptAssertions.push(...post.assertions);
        scriptVisualizer = post.visualizer;
      }
    } catch (caught) {
      patchRequestTab(key, (item) => ({ ...item, response: null }));
      setError(describeError(caught).message);
      // 请求本身失败（离线、DNS、证书…）不该连带丢掉前置脚本已经产生的输出与断言：
      // console 的呈现要求没有「仅当请求成功」这一限定条件
      patchRequestTab(key, (item) => ({
        ...item,
        scriptReport: {
          console: scriptConsole,
          assertions: scriptAssertions,
          error: scriptError,
          visualizer: scriptVisualizer,
        },
      }));
      setBusy(false);
      return;
    }

    setBusy(false);
    patchRequestTab(key, (item) => ({
      ...item,
      scriptReport: {
        console: scriptConsole,
        assertions: scriptAssertions,
        error: scriptError,
        visualizer: scriptVisualizer,
      },
    }));
    // 脚本出错不阻断：请求已发出、响应已可查看，脚本的错误另行呈现
    // （spec: 脚本超时与错误处置）。
    if (scriptError) setError(scriptError);
  };

  const send = () => performSend(false);

  const newCollection = async () => {
    if (!workspaceId) return;
    await client.collectionCreate(workspaceId, '新集合');
    await loadTree(workspaceId);
  };

  /** 真正执行「新建请求」：后端立即分配真实 id，直接据此开新标签（design D1）。 */
  const createRequest = async (collectionId: string, folderId: string | null) => {
    setError(null);
    try {
      const created = await client.requestCreate({
        collection_id: collectionId,
        folder_id: folderId,
        name: '新请求',
        method: 'GET',
        url: 'https://example.test/',
      });
      if (workspaceId) await loadTree(workspaceId);
      const key = requestTabId(created.id);
      setTabs((previous) =>
        previous.some((item) => item.id === key)
          ? previous
          : [
              ...previous,
              {
                kind: 'request' as const,
                id: key,
                requestId: created.id,
                draft: withoutEmptyRows(created),
                dirty: false,
                response: null,
                innerTab: 'params' as const,
                scriptReport: null,
              },
            ],
      );
      setActiveTabKey(key);
    } catch (caught) {
      setError(describeError(caught).message);
    }
  };

  const deleteCollection = async (id: string) => {
    await client.collectionDelete(id);
    if (workspaceId) await loadTree(workspaceId);
  };

  /** 新建文件夹：`parentFolderId` 为 null 时挂在集合根，否则挂在指定文件夹下。 */
  const newFolder = async (collectionId: string, parentFolderId: string | null) => {
    setError(null);
    try {
      await client.folderCreate(collectionId, parentFolderId, '新文件夹');
      if (workspaceId) await loadTree(workspaceId);
    } catch (caught) {
      setError(describeError(caught).message);
    }
  };

  /** 删除文件夹会级联删掉其下的子文件夹与请求，确认由树侧负责（design D4）。 */
  const deleteFolder = async (id: string) => {
    setError(null);
    try {
      await client.folderDelete(id);
      // 指向被删文件夹（含后代）的脚本标签随删除一并关闭；loadTree 的对账兜底
      removeTabsWhere(
        (item) =>
          item.kind === 'entity' &&
          item.entityKind === 'folder' &&
          collectFolderSubtreeIds(treesRef.current, id).has(item.entityId),
      );
      if (workspaceId) await loadTree(workspaceId);
    } catch (caught) {
      setError(describeError(caught).message);
    }
  };

  /**
   * 集合树拖拽落定：先就地重排让界面立刻跟上，再写后端；写失败就把整棵树重新
   * 加载回来（回滚）并提示原因。拖拽只改顺序与归属——不动选中、不动已打开的
   * 标签、不触发未保存守卫。
   */
  const moveNode = async (move: TreeMove) => {
    const id = workspaceId;
    setTrees((previous) => applyTreeMove(previous, move));
    try {
      if (move.kind === 'reorder-collections') {
        if (!id) return;
        await client.collectionReorder(id, move.orderedIds);
      } else if (move.kind === 'reorder-children') {
        await client.childrenReorder(move.collectionId, move.parentFolderId, move.items);
      } else if (move.kind === 'move-folder') {
        // 位置一路透传到后端：跨父级移动同样按落点插入，而不是一律追加到末尾
        await client.folderMove(move.id, move.parentFolderId, move.index);
      } else {
        await client.requestMove(move.id, move.folderId, move.index);
      }
    } catch (caught) {
      setError(describeError(caught).message);
      if (id) await loadTree(id);
    }
  };

  const deleteRequestById = async (id: string) => {
    setError(null);
    try {
      await client.requestDelete(id);
      // 该请求的标签随删除一并关闭；loadTree 的对账兜底
      removeTabsWhere((item) => item.kind === 'request' && item.requestId === id);
      if (workspaceId) await loadTree(workspaceId);
    } catch (caught) {
      setError(describeError(caught).message);
    }
  };

  /**
   * 树上就地改名的提交（spec: 在集合树里就地重命名）。
   *
   * 与面板头的输入框**同一条写入路径**：集合 / 文件夹走 rename 命令，请求走保存；
   * 已打开的标签持有的是同一份数据的另一份拷贝，因此一并同步过去。
   * 空名与「没改」都在这里被丢弃——界面已经把输入框收起来了，树会显示原名。
   */
  const renameFromTree = async (target: RenameTarget, rawName: string) => {
    const name = rawName.trim();
    if (name === '') return;

    setError(null);
    try {
      if (target.kind === 'request') {
        const current =
          requestStore.get(target.id) ?? findRequest(treesRef.current, target.id);
        if (!current || current.name === name) return;
        await requestStore.update(
          target.id,
          { ...current, name },
          (value) => client.requestSave(value),
        );
        setTabs((previous) =>
          previous.map((item) =>
            item.kind === 'request' && item.requestId === target.id
              ? { ...item, draft: { ...item.draft, name } }
              : item,
          ),
        );
      } else {
        if (entityNameIn(treesRef.current, target.id) === name) return;
        const saved =
          target.kind === 'collection'
            ? await client.collectionRename(target.id, name)
            : await client.folderRename(target.id, name);
        setTabs((previous) =>
          previous.map((item) =>
            item.kind === 'entity' && item.entityId === target.id
              ? { ...item, entity: saved }
              : item,
          ),
        );
      }

      if (workspaceId) await loadTree(workspaceId);
    } catch (caught) {
      setError(describeError(caught).message);
      if (workspaceId) await loadTree(workspaceId);
    }
  };

  /** 菜单的「重命名」：打开对应标签并把焦点交给面板头里的名称框（不经过守卫）。 */
  const renameEntity = (entity: EntitySelection) => {
    void openEntity(entity.kind, entity.id, entity.collectionId).then(() =>
      setPendingRenameFocus(true),
    );
  };

  const renameRequest = (id: string) => {
    void openRequest(id).then(() => setPendingRenameFocus(true));
  };

  /** 集合与文件夹的改名落在实体脚本面板的面板头（design D3）。 */
  const commitEntityName = async () => {
    const current = activeEntityTab;
    if (!current || !current.entity) return;
    const entity: EntitySelection = {
      kind: current.entityKind,
      id: current.entityId,
      collectionId: current.collectionId,
    };
    const name = current.entity.name.trim();

    if (!name) {
      setError('名称不能为空');
      const original = findEntityName(trees, entity);
      if (original) {
        patchEntityTab(current.id, (item) =>
          item.entity ? { ...item, entity: { ...item.entity, name: original } } : item,
        );
      }
      return;
    }

    // 改成失焦/回车提交之后，这里会被「点进名称框又原样离开」触发：
    // 名称没变就不打扰后端
    if (name === findEntityName(trees, entity)) return;

    setBusy(true);
    setError(null);
    try {
      const saved =
        current.entityKind === 'collection'
          ? await client.collectionRename(current.entityId, name)
          : await client.folderRename(current.entityId, name);
      patchEntityTab(current.id, (item) => ({ ...item, entity: saved }));
      if (workspaceId) await loadTree(workspaceId);
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * 复制请求（spec: 集合树的操作入口默认隐藏）：入口是集合树请求节点菜单里的「复制」。
   *
   * 按请求 id 复制，而不是"复制当前激活的那条"——被点的节点不一定是激活请求。收尾与
   * 原先面板头的「另存为」一致：为副本打开并激活一个标签，原标签与其草稿原样保留。
   */
  const duplicateRequestById = async (id: string) => {
    setError(null);
    try {
      const copy = await client.requestDuplicate(id, null);
      if (workspaceId) await loadTree(workspaceId);
      const key = requestTabId(copy.id);
      setTabs((previous) =>
        previous.some((item) => item.id === key)
          ? previous
          : [
              ...previous,
              {
                kind: 'request' as const,
                id: key,
                requestId: copy.id,
                draft: withoutEmptyRows(copy),
                dirty: false,
                response: null,
                innerTab: 'params' as const,
                scriptReport: null,
              },
            ],
      );
      setActiveTabKey(key);
    } catch (caught) {
      setError(describeError(caught).message);
    }
  };

  /** 该请求是否带着一个有未保存改动的标签——删除前的守卫判据。 */
  const requestHasDirtyTab = (id: string) =>
    tabsRef.current.some(
      (item) => item.kind === 'request' && item.requestId === id && item.dirty,
    );


  /** 树的菜单里删除请求：该请求带着脏标签时先问。 */
  const removeRequestById = (id: string) => {
    if (requestHasDirtyTab(id)) {
      guard({ kind: 'delete-request', id });
      return;
    }
    void deleteRequestById(id);
  };

  /**
   * 未保存守卫的入口：所有会丢弃草稿的动作都从这里过。
   *
   * 没有脏面就直接执行；有脏面时先把意图记下来，由界面上的三选一决定去留。
   * 明确**不**经过这里的动作：切侧栏 tab、切脚本相位、切环境、发送、开关模态——
   * 它们都不会丢弃编辑内容（spec: 未保存改动在切走前的守卫）。
   */
  const guard = (intent: PendingIntent) => {
    if (dirtySurfaces.length === 0) {
      void runIntent(intent);
      return;
    }
    setPendingIntent(intent);
  };

  /** 执行一个意图：守卫的「不保存」与「保存并继续」成功后都落到这里。 */
  const runIntent = async (intent: PendingIntent) => {
    setPendingIntent(null);
    switch (intent.kind) {
      case 'close-tab':
        removeTabsWhere((item) => item.id === intent.key);
        return;
      case 'delete-request':
        await deleteRequestById(intent.id);
        return;
      case 'delete-collection':
        await deleteCollection(intent.id);
        return;
      case 'delete-folder':
        await deleteFolder(intent.id);
        return;
      case 'exit-app': {
        // 双路径收尾（design D4）：有原生关闭请求挂起（Alt+F4）就把答案还给它的
        // 回调（由其实现自行 destroy）；页面内按钮没有事件可 resolve，直接关窗。
        const resolve = closeResolverRef.current;
        closeResolverRef.current = null;
        if (resolve) {
          resolve(true);
        } else {
          void windowCloser.close();
        }
        return;
      }
    }
  };

  /**
   * 取消待执行的意图。
   *
   * 退出应用时还必须把 false 还给窗口的关闭回调，否则 Tauri 那边会一直等这个答案。
   */
  const cancelIntent = () => {
    setPendingIntent(null);
    const resolve = closeResolverRef.current;
    closeResolverRef.current = null;
    resolve?.(false);
  };

  /**
   * 守卫的「保存并继续」：把**全部**脏面都存下来。
   *
   * 与 Ctrl+S 的「只存当前面」刻意不同——守卫的语义是"别丢东西"，所以不挑。
   * 任一保存失败就停在原地并清掉意图：继续执行原操作会把没存上的改动丢掉。
   */
  const saveAndContinue = async () => {
    const intent = pendingIntent;
    if (!intent) return;
    setError(null);

    for (const surface of editingRegistry.dirty()) {
      const saved = await surface.save();
      if (!saved) {
        // 存不上就停在原地：继续执行会把没保存的改动丢掉
        cancelIntent();
        return;
      }
    }

    await runIntent(intent);
  };

  /** 树里选中请求：打开/聚焦标签。切换不丢草稿，因此不经过守卫。 */
  const selectRequest = (id: string) => {
    // 重复点当前已打开的请求：不重载草稿、不动未保存标记
    if (activeKeyRef.current === requestTabId(id)) return;
    void openRequest(id);
  };

  /** 树里选中集合/文件夹：打开/聚焦其脚本标签，同样不经过守卫。 */
  const selectEntity = (entity: EntitySelection) => {
    void openEntity(entity.kind, entity.id, entity.collectionId);
  };

  /** 关闭一个标签（标签上的关闭入口 / 中键）：有未保存改动时先问。 */
  const requestCloseTab = (key: string) => {
    const current = tabsRef.current.find((item) => item.id === key);
    if (current && isTabDirty(current)) {
      guard({ kind: 'close-tab', key });
      return;
    }
    removeTabsWhere((item) => item.id === key);
  };
  requestCloseTabRef.current = requestCloseTab;

  /** 树的菜单里删除集合：其下有脏标签（含级联到的请求/实体）时先问。 */
  const removeCollection = (id: string) => {
    if (collectionHasDirtyTab(tabsRef.current, id)) {
      guard({ kind: 'delete-collection', id });
      return;
    }
    void deleteCollection(id);
  };

  /** 树的菜单里删除文件夹：其子树里有脏标签时先问。 */
  const removeFolder = (id: string) => {
    if (folderHasDirtyTab(tabsRef.current, collectFolderSubtreeIds(treesRef.current, id))) {
      guard({ kind: 'delete-folder', id });
      return;
    }
    void deleteFolder(id);
  };

  const newRequest = (collectionId: string, folderId: string | null) => {
    void createRequest(collectionId, folderId);
  };

  const saveFullResponse = async () => {
    if (!response) return;
    try {
      await client.responseSaveFull(response.id);
    } catch (caught) {
      setError(describeError(caught).message);
    }
  };

  /** 松手才落库：拖动过程中每一帧都写一次存储没有意义（design D7）。 */
  const commitSplit = (ratio: number) => {
    if (!workspaceId) return;
    void writeSplitRatio(client, workspaceId, ratio);
  };

  /**
   * 会话标签行的手动拖拽与双击最大化（design D5）。
   *
   * `data-tauri-drag-region` 只对直接挂载元素生效、子元素不继承，而这一行最大的
   * 空白区恰是 `.grow` 子元素，因此监听 mousedown 自行分发：交互控件（环境选择器、
   * 窗口控制按钮、标签关闭按钮）不触发；双击（`detail === 2`）切换最大化。
   */
  const onSessionBarMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (isInteractiveSessionBarTarget(event)) return;
    if (event.detail === 2) {
      void windowCloser.toggleMaximize();
      return;
    }
    void windowCloser.startDragging();
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-tabs" role="tablist" aria-label="侧栏">
          <button
            role="tab"
            aria-selected={sidebarTab === 'collections'}
            className={`sidebar-tab ${sidebarTab === 'collections' ? 'active' : ''}`}
            onClick={() => setSidebarTab('collections')}
          >
            Collections
          </button>
          <button
            role="tab"
            aria-selected={sidebarTab === 'environments'}
            className={`sidebar-tab ${sidebarTab === 'environments' ? 'active' : ''}`}
            onClick={() => setSidebarTab('environments')}
          >
            Environments
          </button>
        </div>

        <div className="sidebar-body">
          {sidebarTab === 'collections' ? (
            <WorkspaceTree
              trees={displayTrees}
              selectedRequestId={activeRequestTab?.requestId ?? null}
              selectedEntity={selectedEntity}
              onSelectRequest={(id) => void selectRequest(id)}
              onSelectEntity={(entity) => void selectEntity(entity)}
              onNewCollection={() => void newCollection()}
              onNewRequest={newRequest}
              onNewFolder={(collectionId, parentFolderId) =>
                void newFolder(collectionId, parentFolderId)
              }
              onDeleteCollection={removeCollection}
              onDeleteFolder={removeFolder}
              onDeleteRequest={removeRequestById}
              onDuplicateRequest={(id) => void duplicateRequestById(id)}
              onRenameEntity={(entity) => renameEntity(entity)}
              onRenameRequest={(id) => renameRequest(id)}
              onRenameCommit={(target, name) => void renameFromTree(target, name)}
              onMove={(move) => void moveNode(move)}
              onImport={() => setModal('import-export')}
            />
          ) : workspaceId ? (
            <EnvironmentsPanel
              client={client}
              workspaceId={workspaceId}
              environments={environments}
              environmentId={environmentId}
              onActivate={(id) => void activateEnvironment(id)}
              onEnvironmentsChanged={() => void loadEnvironments(workspaceId)}
              onDeleted={environmentRemoved}
            />
          ) : (
            <div className="muted">正在加载工作区…</div>
          )}
        </div>
      </aside>

      {/* 分栏比例通过 --split 传给 CSS：拖动时只改这一个变量（design D7） */}
      <main
        className={`main ${draft && !showEnvironmentEditor ? 'with-response' : ''}`}
        style={{ '--split': `${splitRatio * 100}%` } as CSSProperties}
      >
        {/* 会话标签栏（spec: 会话标签栏）：左侧承载标签集合，右侧只有环境选择器
            与窗口控制按钮。这一行同时是事实上的标题栏：拖拽移动与双击最大化挂在这里，
            标签本身渲染成 button，自然落在拖拽排除清单里（window-chrome）。 */}
        <div className="session-bar" data-testid="session-bar" onMouseDown={onSessionBarMouseDown}>
          {!showEnvironmentEditor && (
            <div
              className="session-tabs"
              data-testid="session-tabs"
              role="tablist"
              aria-label="会话标签"
              onWheel={(event) => {
                // 垂直滚轮转成横向滚动（design D7）：滚动条已隐藏，滚轮是唯一的滚动暗示
                if (event.deltaY === 0) return;
                event.currentTarget.scrollLeft += event.deltaY;
              }}
            >
              {tabs.length === 0 ? (
                <span className="muted">没有打开的请求</span>
              ) : (
                tabs.map((item) => {
                  const active = item.id === activeTabKey;
                  const itemDirty = isTabDirty(item);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      className={`session-tab ${active ? 'active' : ''}`}
                      data-testid="session-tab"
                      data-tab-kind={item.kind}
                      title={tabName(item)}
                      onClick={() => setActiveTabKey(item.id)}
                      onMouseDown={(event) => {
                        // 中键会触发自动滚动，关掉它让中键专用于关闭标签
                        if (event.button === 1) event.preventDefault();
                      }}
                      onAuxClick={(event) => {
                        if (event.button !== 1) return;
                        event.preventDefault();
                        requestCloseTab(item.id);
                      }}
                    >
                      {item.kind === 'request' ? (
                        <span className="method-badge" data-method={item.draft.method}>
                          {item.draft.method}
                        </span>
                      ) : item.entityKind === 'collection' ? (
                        <CollectionIcon className="tab-kind-icon" role="img" aria-label="集合" />
                      ) : (
                        <FolderIcon className="tab-kind-icon" role="img" aria-label="文件夹" />
                      )}
                      <span className="session-tab-name">{tabName(item)}</span>
                      <span className="session-tab-close">
                        {itemDirty && (
                          <span
                            className="dirty-dot"
                            data-testid="tab-unsaved-dot"
                            aria-hidden="true"
                          />
                        )}
                        <span
                          className="session-tab-close-btn"
                          role="button"
                          aria-label="关闭标签"
                          onClick={(event) => {
                            event.stopPropagation();
                            requestCloseTab(item.id);
                          }}
                        >
                          ×
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          )}

          {showEnvironmentEditor && <span className="grow" />}

          {/* 全局环境选择器（change: add-collection-search-and-env-management）：
              与侧栏 Environments tab 的激活态共用同一份状态；属于工作区级而非请求级，
              因此没有选中请求时同样可见。它自带「无环境 / 环境名」，不再另加标签。 */}
          <span className="env-select">
            {/* 环境选择器（spec: 会话标签行的全局环境选择器）：由通用下拉承载，
                自带搜索——环境数量多时靠肉眼扫名字不可行。 */}
            <Dropdown
              label="环境"
              value={environmentId ?? ''}
              options={[
                { value: '', label: '无环境' },
                ...environments.map((environment) => ({
                  value: environment.id,
                  label: environment.name,
                })),
              ]}
              onChange={(next) => void activateEnvironment(next === '' ? null : next)}
              searchable
              align="right"
              className="env-dropdown"
              testId="env-select-trigger"
            />

            {/* 只读变量浮层（spec: 环境变量的只读浮层）：锚在选择器下方、覆盖在内容
                之上，不改变任何栏的布局；「去环境编辑器」把改动量交回主区。 */}
            <VariablesPeek
              client={client}
              workspaceId={workspaceId ?? ''}
              environmentId={environmentId}
              collectionId={draft?.collection_id ?? null}
              used={draft ? (preview?.used ?? []) : null}
              unresolved={preview?.unresolved ?? []}
              onOpenEditor={() => setSidebarTab('environments')}
            />
          </span>

          {/* 窗口控制按钮（window-chrome spec）：最小化、最大化/还原、关闭。
              关闭与 Alt+F4 汇入同一条未保存守卫（design D4）。 */}
          <span className="window-controls" role="group" aria-label="窗口控制">
            <button aria-label="最小化" title="最小化" onClick={() => void windowCloser.minimize()}>
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M1 5h8" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
            <button
              aria-label={maximized ? '还原' : '最大化'}
              title={maximized ? '还原' : '最大化'}
              onClick={() => void windowCloser.toggleMaximize()}
            >
              {maximized ? (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" />
                  <path d="M2.5 2.5v-2h7v7h-2" fill="none" stroke="currentColor" />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
                </svg>
              )}
            </button>
            <button
              className="close"
              aria-label="关闭"
              title="关闭"
              onClick={() => guard({ kind: 'exit-app' })}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" />
              </svg>
            </button>
          </span>
        </div>

        {/* 通栏请求带（spec: 请求面板头的身份与操作）：请求身份行 + 地址栏 +
            解析预览条横跨整宽，位于左右分栏之上；提示块与它同处这一行，因此也通栏。
            主区让给环境编辑器或实体脚本面板时，请求带不存在。 */}
        <div className="request-top" data-testid="request-top">
          {draft && !showEnvironmentEditor && (
            <RequestBand
              draft={draft}
              busy={busy}
              onChange={editDraft}
              onSend={() => void send()}
              collectionName={crumbCollectionName}
              dirty={dirty}
              nameRef={requestNameRef}
            />
          )}

          {error && (
            <div className="notice danger" role="alert" data-testid="app-error">
              {error}
            </div>
          )}
          {scriptGate && (
            <div className="notice warn" role="alert" data-testid="script-gate">
              <p>
                集合「{scriptGate.name}」带有脚本，而它可能来自导入。执行后可以读写变量、
                经 <code>pm.sendRequest</code> 发起网络请求（默认不限制目标地址）。
              </p>
              <div className="row">
                <button
                  onClick={() => {
                    void allowScriptExecution(client, scriptGate.collectionId).then(() =>
                      performSend(false),
                    );
                  }}
                >
                  允许执行（记住此集合）
                </button>
                <button onClick={() => void performSend(true)}>不执行脚本，仍发送</button>
                <button className="ghost" onClick={() => setScriptGate(null)}>
                  取消发送
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 分栏区（spec: 主区左右分栏与可调比例）：请求带以下的这一块才参与分栏，
            左为请求区、右为响应区。 */}
        <div className="request-region">
          {showEnvironmentEditor ? (
            /* 环境编辑器占主区（design D8）：变量表格需要宽度，侧栏只放列表 */
            <div className="pane entity-pane" data-testid="environment-editor">
              {/* 面板头放的是**环境名**，与集合 / 文件夹 / 请求的面板头同一款式与同一字号 */}
              <div className="pane-header">
                <input
                  className="crumb-name entity-name"
                  aria-label="当前环境名称"
                  value={environmentNameDraft ?? activeEnvironment?.name ?? 'Globals'}
                  disabled={!activeEnvironment}
                  onChange={(event) => setEnvironmentNameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void commitEnvironmentName();
                    if (event.key === 'Escape') setEnvironmentNameDraft(null);
                  }}
                  onBlur={() => void commitEnvironmentName()}
                />
                <span className="grow" />
              </div>

              <div className="pane-body var-editor">
                <VariablesPanel
                  client={client}
                  scope={environmentId ? 'environment' : 'global'}
                  ownerId={environmentId ?? workspaceId ?? ''}
                  variables={variables}
                  // 标题已经是环境名，面板内不再重复一行「环境变量」
                  hideHeader
                  onChanged={() => {
                    if (workspaceId) void loadVariables(workspaceId, environmentId);
                  }}
                />
              </div>
            </div>
          ) : activeEntityTab && entityDraft ? (
            <EntityScriptPanel
              key={activeEntityTab.id}
              kind={activeEntityTab.entityKind}
              entity={entityDraft}
              nameRef={entityNameRef}
              tab={activeEntityTab.innerTab}
              variablesCount={collectionVariables.length}
              onTab={(next) =>
                patchEntityTab(activeEntityTab.id, (item) => ({ ...item, innerTab: next }))
              }
              variablesPane={
                <VariablesPanel
                  client={client}
                  scope="collection"
                  ownerId={activeEntityTab.entityId}
                  // 页签已经说了「变量」，再放一行「集合变量」小节标题，
                  // 只会在标题层级里跟集合名抢权重——这里由页签承担上下文
                  hideHeader
                  variables={collectionVariables}
                  onChanged={() => setCollectionVariablesVersion((value) => value + 1)}
                />
              }
              onChange={(next) =>
                patchEntityTab(activeEntityTab.id, (item) => ({ ...item, entity: next }))
              }
              onCommitName={() => void commitEntityName()}
              saveStatus={
                entitySave?.key === activeEntityTab.id
                  ? { status: entitySave.status, message: entitySave.message }
                  : null
              }
            />
          ) : draft ? (
            <RequestEditor
              draft={draft}
              tab={tab}
              onTab={setInnerTab}
              onChange={editDraft}
              onPickFile={() => client.pickUploadFile()}
              onCurl={() => {
                // 与发送共用同一份输入（未保存时走内联载荷），因此两处命令必然一致
                if (!exportSendInput) throw new Error('没有可导出的请求');
                return client.curlExport(exportSendInput);
              }}
            />
          ) : (
            <div className="pane-body muted">从左侧选择一个请求，或新建一个。</div>
          )}
        </div>

        {/* 响应栏只在选中请求时出现（spec: 主区左右分栏与可调比例）；
            主区被环境编辑器占用时不出现——响应属于请求，不属于环境。
            分隔线的命中区与响应区同生同灭：请求区独占整宽时不存在可拖的分隔线。 */}
        {draft && !showEnvironmentEditor && (
          <>
            <SplitHandle ratio={splitRatio} onRatio={setSplitRatio} onCommit={commitSplit} />
            <div className="response-region">
              <ResponsePanel
                response={response}
                busy={busy}
                error={null}
                onSaveFull={() => void saveFullResponse()}
                presentation={presentation}
                requestFormat={draft.settings.response_format}
                scriptConsole={scriptReport?.console}
                scriptAssertions={scriptReport?.assertions}
                scriptError={scriptReport?.error ?? null}
                visualizerHtml={
                  scriptReport?.visualizer ? renderVisualizer(scriptReport.visualizer) : null
                }
              />
            </div>
          </>
        )}
      </main>

      <BottomBar
        busy={busy}
        error={error}
        optimisticErrors={optimisticErrors}
        onShowOptimisticErrors={() => {
          requestStore.clearErrors();
          setError(requestStore.errors().map((item) => item.message).join('；') || null);
        }}
        onOpenModal={setModal}
        importExportDisabled={!workspaceId}
      />

      {/* 自绘边缘缩放边条（design D6）：贴窗口内沿的透明窄条 */}
      <ResizeStrips windowApi={windowCloser} />

      {modal === 'cookies' && (
        <Modal title="Cookie" onClose={() => setModal(null)}>
          <CookiePanel client={client} />
        </Modal>
      )}

      {modal === 'settings' && (
        <Modal title="设置" onClose={() => setModal(null)}>
          <SettingsPanel
            client={client}
            editing={editingRegistry}
            presentation={presentation}
            onPresentationChange={setPresentation}
          />
        </Modal>
      )}

      {modal === 'import-export' && workspaceId && (
        <Modal title="导入 / 导出" onClose={() => setModal(null)}>
          <ImportExportPanel
            client={client}
            workspaceId={workspaceId}
            collectionId={exportCollectionId}
            environmentId={environmentId}
            sendInput={exportSendInput}
            onImported={() => void reloadAfterImport()}
          />
        </Modal>
      )}

      {/* 未保存守卫以模态弹框呈现（spec: 未保存改动在被丢弃前的守卫）：
          它属于整窗而非主区，浮层不会像内联块那样把主区挤出一截。
          标题给判断题、正文给事实，避免两处各说一遍「未保存的改动」；
          默认动作走 .primary 且自动聚焦，把键盘用户直接带进弹框。 */}
      {pendingIntent && (
        <Modal
          title="要保存后再继续吗？"
          onClose={() => cancelIntent()}
          className="modal-confirm"
        >
          <div className="stack" data-testid="unsaved-guard">
            <p>{dirtySurfaces.map((surface) => surface.label).join('、')}有未保存的改动。</p>
            <div className="row">
              <button
                className="primary"
                autoFocus
                onClick={() => void saveAndContinue()}
                disabled={busy}
              >
                保存并继续
              </button>
              <button onClick={() => void runIntent(pendingIntent)} disabled={busy}>
                不保存
              </button>
              <button className="ghost" onClick={() => cancelIntent()}>
                取消
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default App;
