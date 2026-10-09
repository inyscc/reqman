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
import { applyEnvironmentOrder } from './lib/environmentMoves';
import { CollectionIcon, FolderIcon } from './components/icons';
import { ImportExportPanel } from './components/ImportExportPanel';
import { Modal } from './components/Modal';
import { ProxyConfigRows } from './components/ProxyConfigRows';
import type { ProxyConfig, ProxyDecisionView } from './lib/types';
import { RequestBand, RequestEditor, type Tab } from './components/RequestEditor';
import { ResizeStrips, isInteractiveSessionBarTarget } from './components/ResizeStrips';
import { ResponsePanel } from './components/ResponsePanel';
import { SettingsPanel } from './components/SettingsPanel';
import { SplitHandle } from './components/SplitHandle';
import { VariablesPeek } from './components/VariablesPeek';
import { VariablesPanel } from './components/VariablesPanel';
import {
  WorkspaceTree,
  type EntitySelection,
  type RenameTarget,
  type WorkspaceTreeHandle,
} from './components/WorkspaceTree';
import { commands as defaultCommands, describeError, type Commands } from './lib/commands';
import { createEditingRegistry, SURFACE_PRIORITY } from './lib/editing';
import { applyTreeMove, type TreeMove } from './lib/treeMoves';
import { readSplitRatio, SPLIT_DEFAULT, writeSplitRatio } from './lib/layout';
import {
  DEFAULT_EDITOR_APPEARANCE,
  applyEditorAppearance,
  indentUnit,
  readEditorAppearance,
  resolveWrapLines,
  subscribeEditorAppearance,
  type EditorAppearance,
} from './lib/editorAppearance';
import {
  DEFAULT_CURL_BODY_COMPRESS,
  DEFAULT_CURL_LINE_LAYOUT,
  applyCurlBodyCompress,
  applyCurlLineLayout,
  readRequestPreferences,
} from './lib/requestPreferences';
import {
  DEFAULT_PRESENTATION,
  readPresentation,
  type ResponsePresentation,
} from './lib/responsePresentation';
import { readTabs, writeTabs } from './lib/sessionTabs';
import {
  SCRIPT_TIMEOUT_MS,
  allowScriptExecution,
  isScriptExecutionAllowed,
  renderVisualizer,
  runScriptPhase,
  toSandboxRequest,
} from './lib/scriptRuntime';
import type {
  ConsoleEntry,
  PhaseCancellation,
  TestAssertion,
  VisualizerResult,
} from './lib/scriptRuntime';

/**
 * 取消的稳定错误码（与 Rust 侧 `ErrorCode::Cancelled` 一致）。
 *
 * 取消**不是失败**：它要单独处理，不能与超时、离线等失败走同一条呈现——那条路会清空
 * 响应区并弹出红色错误条（spec: http-engine「请求取消」）。
 */
const CANCELLED_CODE = 'cancelled';

/**
 * 变量未能解析，请求没有发出去（spec: variable-engine「未解析变量提示」）。
 *
 * 与取消同属「请求没出去」：响应区不该被清空。但它**要**报错误——用户得知道是哪个
 * 变量没解析出来。判定在后端的建连之前完成，因此这个错误来自 sendRequest 而不是
 * 这里的预检查。
 */
const UNRESOLVED_CODE = 'unresolved_variables';
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

/**
 * 一次**在飞**的发送会话（spec: http-engine「请求取消」）。
 *
 * 它自带取消出口与作废标志，不再挂在应用级单例上：多条请求可以同时在飞，每条都能被
 * 单独取消，取消不会退化成「取消最后一次」。
 */
interface SendAttempt extends PhaseCancellation {
  /** 立刻兑现前端的取消（脚本段据此收手）；后端撤销另发 `cancel_send`。 */
  cancel: () => void;
}

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

/** 某目录子树里带着未保存改动的标签：删除要问、复制直接禁止，两处共用同一判定。 */
function dirtyTabsInFolder(tabs: SessionTab[], subtree: Set<string>): SessionTab[] {
  return tabs.filter(
    (item) =>
      isTabDirty(item) &&
      (item.kind === 'request'
        ? item.draft.folder_id != null && subtree.has(item.draft.folder_id)
        : item.entityKind === 'folder' && subtree.has(item.entityId)),
  );
}

function folderHasDirtyTab(tabs: SessionTab[], subtree: Set<string>): boolean {
  return dirtyTabsInFolder(tabs, subtree).length > 0;
}

/**
 * 树操作的快捷键是否应当让位给当前的输入目标（spec: 树操作的快捷键）。
 *
 * 与「保存」相反：「保存」要求在输入框与代码编辑器里同样生效，而复制 / 重命名键在
 * 可编辑区域里恰恰是用户想用来做别的事的地方——重命名键在 macOS 上是文本框的「移到
 * 行尾」，复制键在编辑器里常被当作删除行或重复行。
 *
 * 代码编辑器（Monaco）用一个隐藏的 textarea 接收输入，`textarea` 那一条已经覆盖它，
 * `.monaco-editor` 只作兜底。
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return target.closest('.monaco-editor') !== null;
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
  /**
   * 在飞的发送会话，**按标签 key**（spec: 地址栏 / http-engine「请求取消」）。
   *
   * 多条请求可以同时在飞：每条会话自带取消出口与作废标志，取消因此精确到它自己，不会
   * 退化成「取消最后一次」。它与 `busy` 分开：`busy` 还被保存请求、保存实体脚本与改名
   * 共用，那些状态下该出现的是禁用的「发送」，不是「取消」。
   */
  const [sending, setSending] = useState<Record<string, SendAttempt>>({});
  /**
   * 发送相关的错误反馈，**按标签 key** 归属（spec: ui-layout「请求级错误提示」）。
   *
   * 与全局的 `error` 并存：后者承载保存失败、树操作失败等与某次发送无关的消息。
   */
  const [sendErrors, setSendErrors] = useState<Record<string, string>>({});
  /**
   * 发送**失败**时那一次代理决定的落地处，同样按标签 key 归属
   * （spec: ui-layout「响应区的代理决定」）。
   *
   * 成功时的决定随响应一起回来（`response.proxy_decision`），不必在这里存一份；失败时
   * 没有响应可依附，只能由这里接住。两处合起来，决定在两条路径上都归属于**产生它的那条
   * 请求**——与「请求级错误提示」同一套归属。
   */
  const [sendDecisions, setSendDecisions] = useState<Record<string, ProxyDecisionView>>({});
  /** `sending` 的镜像：经 ref 触达的地方（关闭标签、快捷键）要读到最新的一份。 */
  const sendingRef = useRef<Record<string, SendAttempt>>({});
  sendingRef.current = sending;
  /**
   * 关闭标签时撤销它的在飞发送（spec: ui-layout「cURL 快照标签」无关；见 http-engine
   * 「请求取消」与 design D8）。`removeTabsWhere` 的依赖刻意留空，因此出口经 ref 触达。
   */
  const cancelOnRemoveRef = useRef<(key: string) => void>(() => {});
  const [error, setError] = useState<string | null>(null);
  /**
   * 待确认的脚本门禁（任务 9.3），**按标签 key**：并发时两条发送各自的门禁互不覆盖，
   * 「允许执行并继续」也重发那一条而不是当前激活的请求
   * （spec: pm-script-runtime「脚本来源的可执行性门禁」）。
   */
  const [scriptGates, setScriptGates] = useState<
    Record<string, { collectionId: string; name: string }>
  >({});
  /** 集合/文件夹脚本自动保存的就地状态（spec: 脚本的编辑与保存）。 */
  const [entitySave, setEntitySave] = useState<({ key: string } & EntitySaveStatus) | null>(null);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  /** 环境编辑器标题里正在编辑的名字；`null` 表示跟随后端的值。 */
  const [environmentNameDraft, setEnvironmentNameDraft] = useState<string | null>(null);
  /**
   * 环境级代理的草稿（spec: ui-layout「设置模态的代理配置」）。
   *
   * 三层不挤在同一屏：这一层落在环境自身的编辑面，缺省「未配置」即顺位到全局。
   */
  const [environmentProxy, setEnvironmentProxy] = useState<ProxyConfig | null>(null);
  /** 上一次同步或落库后的形态：草稿是否真的变了由它判断（对象身份每次都可能不同）。 */
  const savedEnvironmentProxyRef = useRef<string>('null');
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

  /**
   * 编辑器外观的应用级当前值。
   *
   * `applyEditorAppearance` 是它的唯一写入口（启动读取与设置面保存都经它）；这里订阅一份，
   * 供**响应正文的格式化缩进**与**折行的应用级缺省**使用——这两处不必经 Monaco，但必须与
   * 编辑面看到的是同一份值（spec: code-editors「等宽面的外观与缩进」）。
   */
  const [editorAppearance, setEditorAppearance] = useState<EditorAppearance>(
    DEFAULT_EDITOR_APPEARANCE,
  );
  /** 侧栏内部 tab：Collections / Environments（design D2）。 */
  const [sidebarTab, setSidebarTab] = useState<'collections' | 'environments'>('collections');
  /** 低频面板的单例模态（design D5）：非空时打开对应弹窗，同一时间至多一个。 */
  const [modal, setModal] = useState<ModalKind | null>(null);
  /**
   * 复制被未保存改动挡下时要点名的对象。它只是那个模态的**数据**——开关仍在 `modal`
   * 里（`'copy-blocked'`），因此不存在两个遮罩并存的可能（design D9）。
   */
  const [copyBlocked, setCopyBlocked] = useState<string[] | null>(null);
  /** 被未保存改动挡下的意图；非空时界面给出三选一提示。 */
  const [pendingIntent, setPendingIntent] = useState<PendingIntent | null>(null);
  /** 菜单的「重命名」只负责把焦点交给面板头里的名称框（design D3）。 */
  const [pendingRenameFocus, setPendingRenameFocus] = useState(false);
  const entityNameRef = useRef<HTMLInputElement>(null);
  const requestNameRef = useRef<HTMLInputElement>(null);
  /** 树里的就地改名入口：快捷键要触发它，而"哪一行可见"只由树内部知道（design D7）。 */
  const treeHandleRef = useRef<WorkspaceTreeHandle>(null);
  /**
   * 复制的两个入口经 ref 交给快捷键的 effect。
   *
   * 那个 effect 只依赖 `saveCurrentSurface`，直接闭包引用会取到旧渲染里的状态；
   * `activeKeyRef` / `requestCloseTabRef` 是同一套做法。
   */
  const duplicateRef = useRef<(kind: 'request' | 'folder', id: string) => void>(() => {});
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
  /**
   * 当前激活标签是否在发送（spec: 地址栏）。判定按标签 key——别的请求在飞 SHALL NOT 让
   * 本请求的地址栏变成「取消」，也不该让它的响应区出现遮罩。
   */
  const activeSending = activeTabKey !== null && sending[activeTabKey] !== undefined;
  /** 当前激活标签的发送错误（spec: ui-layout「请求级错误提示」）。 */
  const activeSendError = activeTabKey !== null ? (sendErrors[activeTabKey] ?? null) : null;
  /**
   * 当前激活标签的代理决定（spec: ui-layout「响应区的代理决定」）。
   *
   * 优先取响应里带回的那一份——它属于**这一次**；没响应的失败才看按标签存的那一份。
   */
  const activeProxyDecision =
    response?.proxy_decision ??
    (activeTabKey !== null ? (sendDecisions[activeTabKey] ?? null) : null);
  /** 当前激活标签的门禁提示：只有触发它的那条请求在看着时才呈现。 */
  const activeScriptGate = activeTabKey !== null ? (scriptGates[activeTabKey] ?? null) : null;
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

    // 被移除的标签若还在发送，撤销它那一次（结果丢弃）——否则会出现「界面已没有该请求、
    // 后台仍在跑并写库」的悬挂（design D8）。
    for (const item of current) {
      if (predicate(item)) cancelOnRemoveRef.current(item.id);
    }

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

  /**
   * 环境顺序重排（spec: Environments tab 环境列表的拖拽排序）。
   *
   * 顺序由这里持有而不是面板本地：侧栏列表与主区会话标签行的环境选择器读的是**同一份**
   * `environments`，乐观重排因此同时体现在两处（面板本地顺序会让两处不一致一个往返的
   * 时间）。失败回滚到拖动前的数组并报错，避免界面与存储不一致。
   */
  const reorderEnvironments = async (orderedIds: string[]) => {
    if (!workspaceId) return;
    const previous = environments;
    setEnvironments(applyEnvironmentOrder(previous, orderedIds));
    setError(null);
    try {
      await client.environmentReorder(workspaceId, orderedIds);
    } catch (caught) {
      setEnvironments(previous);
      setError(describeError(caught).message);
    }
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

  // 编辑器外观同样是应用级的（不随工作区走），启动时读一次即生效：
  // `applyEditorAppearance` 一头把等宽变量写到文档根（非 Monaco 的等宽面立刻跟随），
  // 一头通知已挂出的编辑面各自 updateOptions。读不到就回落缺省。
  useEffect(() => {
    void readEditorAppearance(client)
      .then((value) => applyEditorAppearance(value))
      .catch(() => applyEditorAppearance(DEFAULT_EDITOR_APPEARANCE));
  }, [client]);

  // 订阅这份外观：设置面保存时也会 `applyEditorAppearance`，因此不需要额外的回写通道，
  // 响应正文的缩进与折行缺省就会跟着变（不改这处的话，改设置要重开请求才生效）。
  useEffect(() => subscribeEditorAppearance(setEditorAppearance), []);

  // 两项 cURL 缺省（正文压缩、命令布局）同样是应用级的（不随工作区走）：启动读一次即生效。
  // cURL 标签与请求 Settings 行的显示都读这份进程内当前值，设置模态保存时会再 apply 一次
  // （同 editorAppearance 的回写通道）。
  useEffect(() => {
    void readRequestPreferences(client)
      .then((value) => {
        applyCurlBodyCompress(value.curlBodyCompress);
        applyCurlLineLayout(value.curlLineLayout);
      })
      .catch(() => {
        applyCurlBodyCompress(DEFAULT_CURL_BODY_COMPRESS);
        applyCurlLineLayout(DEFAULT_CURL_LINE_LAYOUT);
      });
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

  /**
   * 环境级代理：切环境与落库后读回时对齐草稿。
   *
   * 读回的只有掩码视图（凭据只给「已设置」这一事实），因此对齐之后密码输入框自然回到空
   * ——`ProxyConfigRows` 就是按这个约定清草稿的。
   */
  useEffect(() => {
    const stored = activeEnvironment?.proxy ?? null;
    setEnvironmentProxy(stored);
    savedEnvironmentProxyRef.current = JSON.stringify(stored);
  }, [environmentId, activeEnvironment?.proxy]);

  /** 改动停止后落库；写入失败不抛出——它只是环境的一条属性，下一次改动会再写一遍。 */
  useEffect(() => {
    if (!environmentId) return;
    if (JSON.stringify(environmentProxy) === savedEnvironmentProxyRef.current) return;

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await client.environmentSetProxy(environmentId, environmentProxy);
          const id = workspaceIdRef.current;
          if (id) await loadEnvironments(id);
        } catch (caught) {
          setError(describeError(caught).message);
        }
      })();
    }, 500);

    return () => window.clearTimeout(timer);
  }, [environmentProxy, environmentId, client, loadEnvironments]);

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

  /**
   * 折行的**生效值**：应用级缺省 + 当前请求的覆盖（spec: ui-layout「折行」）。
   *
   * 解析规则只在 `resolveWrapLines` 一处；响应正文、请求正文与两处开关都吃这一个值。
   */
  const wrapLines = resolveWrapLines(editorAppearance.wrap, draft?.settings.wrap_lines);

  /**
   * 把当前请求的折行落为**显式**值——请求 Body 类型行的开关与响应正文工具条右端的开关都走
   * 这里，等同于在请求 Settings 标签页里改同一项（spec: ui-layout「折行」）。
   * 「跟随全局」只在 Settings 行里可选，因此这里只写 on / off。
   */
  const setWrapLines = (next: boolean) => {
    if (!draft) return;
    editDraft({ ...draft, settings: { ...draft.settings, wrap_lines: next ? 'on' : 'off' } });
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

      if (event.key.toLowerCase() === 'd' || event.key.toLowerCase() === 'e') {
        // 带 Shift 的组合另有归属（浏览器里 Ctrl+Shift+D 是「所有标签页加入书签」）
        if (event.shiftKey) return;
        // 模态打开时不作用于树：树不是模态里的编辑面，而复制键会**真的**发起一次
        // 复制。与「保存」同源——它同样把模态纳入"当前生效面"的判断（design D6 / D9）
        if (modalRef.current !== null) return;
        // 可编辑区域里让位：这两个键在输入框与代码编辑器里是用户自己的键（design D7）
        if (isEditableTarget(event.target)) return;
        // 即使本次不触发动作，也要吞掉运行环境的默认行为（书签 / 页内搜索）
        event.preventDefault();

        const tab = tabsRef.current.find((item) => item.id === activeKeyRef.current);
        if (!tab) return;

        if (event.key.toLowerCase() === 'd') {
          // 作用对象是当前点击的实体：点击树行即打开它，所以这里读激活标签（design D6）。
          // 集合级复制本次不做，于是在集合标签上无动作。
          if (tab.kind === 'request') duplicateRef.current('request', tab.requestId);
          else if (tab.entityKind === 'folder') duplicateRef.current('folder', tab.entityId);
          return;
        }

        // 重命名走树里的就地改名——与菜单里那一项是同一条路径，两者因此必然等价
        if (tab.kind === 'request') treeHandleRef.current?.startRename(tab.requestId);
        else treeHandleRef.current?.startRename(tab.entityId);
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
   * 开一次发送会话（spec: http-engine「请求取消」）。
   *
   * 取消信号用 Promise 表达，脚本段拿它做 `Promise.race` 立刻兑现——**不能**改成「先销毁
   * 沙箱再等回调」：`disposeContext` 的注释记着同一个事实，uvm 终止 Worker 之后回调可能
   * 永不触发，那样发送态就卡在「发送中」了。
   *
   * 标识带随机后缀，避免同一毫秒内的两次发送撞号；脚本内的请求按它归组。取消出口与作废
   * 标志都落在这一个对象上，因此并发时各条互不影响。
   */
  const openAttempt = (): SendAttempt => {
    let fire: () => void = () => {};
    const signal = new Promise<void>((resolve) => {
      fire = resolve;
    });
    let cancelled = false;

    return {
      attemptId: `attempt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      signal,
      isCancelled: () => cancelled,
      cancel: () => {
        cancelled = true;
        fire();
      },
    };
  };

  /** 一次发送的收尾：只收这一条会话，别的在飞发送不受影响。正常结束与取消走同一条路。 */
  const finishSend = (key: string) => {
    setSending((previous) => {
      if (!(key in previous)) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  };

  /**
   * 取消某条发送：后端撤销该会话下的全部在飞请求（含脚本内发出的那些），前端让脚本段
   * 立刻兑现。它作用于**那一条**会话——并发时取消 A 不会碰到 B。
   *
   * 不抢答结果归属——本次发送由被撤销的请求自己以 `cancelled` 结束。撤销本身失败也不弹错：
   * 发送仍会以自己的结果收场，只是晚一点。
   */
  const cancelSend = async (key: string | null) => {
    if (key === null) return;
    const attempt = sendingRef.current[key];
    if (!attempt) return;

    attempt.cancel();

    try {
      await client.cancelSend(attempt.attemptId);
    } catch {
      // 有意静默：见上
    }
  };

  // 关闭标签走同一条撤销路径（`removeTabsWhere` 的依赖留空，因此出口经 ref 触达）
  cancelOnRemoveRef.current = (key) => {
    void cancelSend(key);
  };

  /** 清掉某条标签的门禁提示（门禁按标签存，别的标签的不受影响）。 */
  const clearScriptGate = (key: string) => {
    setScriptGates((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  /** 写入 / 清除某条标签的发送错误（spec: ui-layout「请求级错误提示」）。 */
  const setSendError = (
    key: string,
    message: string | null,
    decision?: ProxyDecisionView | null,
  ) => {
    setSendErrors((previous) => {
      if (message === null) {
        if (!(key in previous)) return previous;
        const next = { ...previous };
        delete next[key];
        return next;
      }
      return { ...previous, [key]: message };
    });

    // 错误与它的代理决定同进同出：错误被清掉时决定也一并清掉，否则会看到"上一条错误
    // 的决定"挂在这一条上。
    setSendDecisions((previous) => {
      if (!decision) {
        if (!(key in previous)) return previous;
        const next = { ...previous };
        delete next[key];
        return next;
      }
      return { ...previous, [key]: decision };
    });
  };

  /**
   * `skipScripts` 为真时跳过全部脚本只发请求——门禁被拒绝后的「不执行脚本，仍发送」。
   *
   * `keyOverride` 让门禁的「允许执行并继续」重发**触发它的那一条**，而不是当前激活的请求；
   * 缺省发当前激活的请求。
   */
  const performSend = async (skipScripts: boolean, keyOverride?: string | null) => {
    const key = keyOverride ?? activeKeyRef.current;
    const tab = key ? tabsRef.current.find((item) => item.id === key) : undefined;
    if (!key || !tab || tab.kind !== 'request') return;
    // 发送作用于**这一条**标签：草稿、脏状态、响应与脚本报告都写回它自己
    const draft = tab.draft;
    const dirty = tab.dirty;
    setError(null);
    setSendError(key, null);
    // 只清掉这一条自己的门禁；并发时别的发送的门禁不受影响
    clearScriptGate(key);

    // 解析一次请求，供脚本构造 `pm.request` 与前置阶段的 Cookie 目标使用。
    //
    // 用**揭示模式**：脚本要读到真实取值来组装请求（掩码那一份是给界面浮层看的）。
    //
    // 未解析变量的拦截**不在这里**——它在后端的建连之前完成（spec: 未解析变量提示）。
    // 拦在这一步会让「前置脚本写入变量 + 请求体引用它」这条 Postman 里的常规用法永远
    // 发不出去：脚本是唯一会创建该变量的东西，却因为该变量不存在而跑不到。
    const sendInput = {
      saved_id: dirty ? null : draft.id,
      inline: cleanForSend(draft),
      environment_id: environmentId,
    };
    let resolved: RequestPreview;
    try {
      resolved = await client.variablesPreview(sendInput, true);
    } catch (caught) {
      setSendError(key, describeError(caught).message);
      return;
    }

    const attempt = openAttempt();
    // 只登记这一条会话；`busy` 不再由发送置位（它留给保存与改名）
    setSending((previous) => ({ ...previous, [key]: attempt }));
    patchRequestTab(key, (item) => ({ ...item, scriptReport: null }));

    // 三级脚本：集合 → 文件夹 → 请求（任务 2.4）。集合与文件夹的脚本挂在实体上，
    // 树形接口不给，因此单独取回（任务 2.5）。
    const target = workspaceId
      ? { workspaceId, collectionId: draft.collection_id, environmentId }
      : null;
    let phases: { pre: (string | null)[]; test: (string | null)[] } | null = null;
    let requestUrl: string | null = null;
    // 喂给沙箱的请求形态：一个阶段里的三段脚本共用同一份快照（design D6）。
    // 它带上的是解析后的取值，脚本因此读得出本次请求的目标与内容。
    const sandboxRequest = toSandboxRequest(resolved);
    let scriptError: string | null = null;
    let scriptVisualizer: VisualizerResult | null = null;
    const scriptConsole: ConsoleEntry[] = [];
    const scriptAssertions: TestAssertion[] = [];

    /**
     * 把本次发送已经产生的脚本输出写回标签（三条出口共用：正常、失败、取消）。
     */
    const writeScriptReport = () => {
      patchRequestTab(key, (item) => ({
        ...item,
        scriptReport: {
          console: scriptConsole,
          assertions: scriptAssertions,
          error: scriptError,
          visualizer: scriptVisualizer,
        },
      }));
    };

    try {
      if (target && !skipScripts) {
        const collection = await client.collectionGet(draft.collection_id);

        // 门禁：脚本可能来自导入的集合，执行前必须确认（任务 9.3 / design D6）。
        // 门禁按标签存——并发时两条各自的门禁互不覆盖。
        if (!(await isScriptExecutionAllowed(client, draft.collection_id))) {
          setScriptGates((current) => ({
            ...current,
            [key]: { collectionId: draft.collection_id, name: collection.name },
          }));
          finishSend(key);
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

        // `pm.cookies` 在前置阶段以**脚本执行前解析出的目标**为准（spec: pm.cookies 的
        // 当前请求目标）。这次解析走揭示模式，因此不再有「URL 里引用 secret 会以掩码
        // 形态出现」那条旧限制。
        requestUrl = resolved.url || null;

        const pre = await runScriptPhase(
          client,
          target,
          'prerequest',
          phases.pre,
          null,
          requestUrl,
          SCRIPT_TIMEOUT_MS,
          attempt,
          sandboxRequest,
        );

        scriptError = pre.error;
        scriptConsole.push(...pre.console);
        scriptAssertions.push(...pre.assertions);

        // 取消发生在脚本段：不再往后走，已经产生的输出照常写回
        if (attempt.isCancelled()) {
          writeScriptReport();
          finishSend(key);
          return;
        }
      }

      const payload = await client.sendRequest({
        saved_id: dirty ? null : draft.id,
        inline: cleanForSend(draft),
        environment_id: environmentId,
        // 会话标识：主请求与脚本内的请求归同一组，取消时一并撤销
        attempt_id: attempt.attemptId,
      });
      patchRequestTab(key, (item) => ({ ...item, response: payload }));

      if (target && !skipScripts && phases) {
        const post = await runScriptPhase(
          client,
          target,
          'test',
          phases.test,
          payload,
          // 后置阶段的 `pm.cookies` 以**实际发出的请求目标**为准（spec: pm.cookies 的
          // 当前请求目标）。它取自后端回带的发送目标，而不是重定向之后的 `final_url`：
          // 前置脚本改写过目标变量时，两者并不是一回事。
          payload.request_url || requestUrl,
          SCRIPT_TIMEOUT_MS,
          attempt,
          sandboxRequest,
        );

        scriptError = scriptError ?? post.error;
        scriptConsole.push(...post.console);
        scriptAssertions.push(...post.assertions);
        scriptVisualizer = post.visualizer;
      }
    } catch (caught) {
      const described = describeError(caught);

      // 取消不是失败（spec: http-engine「请求取消」）：不弹红条、**不动响应区**。响应区里
      // 谁在里面就留着——可能是上一次的，也可能是本次已经到达的那一份（取消发生在后置
      // 脚本阶段时，响应早就写回了）。
      //
      // 未解析变量同属「请求没有出去」：响应区不该被清空，但错误要报出来
      // （spec: variable-engine「未解析变量提示」）。
      if (described.code !== CANCELLED_CODE) {
        if (described.code !== UNRESOLVED_CODE) {
          patchRequestTab(key, (item) => ({ ...item, response: null }));
        }
        // 错误按标签归属：并发时不会串到别的请求的界面上。
        // 决定一并带上——失败时响应区要有它（spec: ui-layout「响应区的代理决定」）。
        setSendError(key, described.message, described.proxy_decision);
      }

      // 请求本身失败（离线、DNS、证书…）不该连带丢掉前置脚本已经产生的输出与断言：
      // console 的呈现要求没有「仅当请求成功」这一限定条件
      writeScriptReport();
      finishSend(key);
      return;
    }

    writeScriptReport();
    finishSend(key);
    // 脚本出错不阻断：请求已发出、响应已可查看，脚本的错误另行呈现
    // （spec: 脚本超时与错误处置）。
    if (scriptError) setSendError(key, scriptError);
  };

  const send = () => performSend(false, activeKeyRef.current);

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
    // 该请求带着未保存改动时禁止复制：副本取的是数据库里的内容，放行只会静默丢掉
    // 编辑器里的改动（spec: 未保存的改动阻止复制）。
    const dirty = tabsRef.current.find(
      (item) => item.kind === 'request' && item.requestId === id && item.dirty,
    );
    if (dirty) {
      blockCopy([tabName(dirty)]);
      return;
    }

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

  /**
   * 复制被未保存改动挡下：弹出独立的模态提示（spec: 未保存的改动阻止复制）。
   *
   * 刻意**不提供**「放弃改动并继续」：规则是"禁止复制"，给一个绕过的按钮等于把它
   * 降级成一条提示。名字交给模态显示，页面内不出现并行的错误条。
   */
  const blockCopy = (names: string[]) => {
    setError(null);
    setCopyBlocked(names);
    // 走单例状态：另立一个开关的话，两处同时触发会叠出两个遮罩，
    // 而「按 Esc 该关哪一个」也变得不确定（design D9）
    setModal('copy-blocked');
  };

  /**
   * 复制目录：连同整棵子树在新位置重建一份（spec: 复制请求与目录）。
   *
   * 判定范围是**整棵子树**——复制会把其中每个请求都取一遍，任何一个带着未保存改动都会
   * 被静默丢掉，因此一并挡住并点名。判定与请求复制共用 `dirtyTabsInFolder`，两条路径
   * 对"这棵子树干不干净"给出同一个答案。
   *
   * 新目录不需要特意展开：折叠状态记的是"被折叠的 id"，新 id 不在其中，于是它默认
   * 就是展开的（父级与源目录相同，用户看得见源目录即看得见它）。
   */
  const duplicateFolderById = async (id: string) => {
    const dirty = dirtyTabsInFolder(
      tabsRef.current,
      collectFolderSubtreeIds(treesRef.current, id),
    );
    if (dirty.length > 0) {
      blockCopy(dirty.map(tabName));
      return;
    }

    setError(null);
    try {
      await client.folderDuplicate(id, null);
      if (workspaceId) await loadTree(workspaceId);
    } catch (caught) {
      setError(describeError(caught).message);
    }
  };

  duplicateRef.current = (kind, id) => {
    if (kind === 'request') void duplicateRequestById(id);
    else void duplicateFolderById(id);
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
              ref={treeHandleRef}
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
              onDuplicateFolder={(id) => void duplicateFolderById(id)}
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
              onReorder={(orderedIds) => void reorderEnvironments(orderedIds)}
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
              sending={activeSending}
              onChange={editDraft}
              onSend={() => void send()}
              onCancel={() => void cancelSend(activeTabKey)}
              collectionName={crumbCollectionName}
              dirty={dirty}
              nameRef={requestNameRef}
            />
          )}

          {/* 错误条：全局 `error`（保存失败、树操作失败…）与**当前标签的**发送错误共用这一格。
              发送错误按标签归属（spec: ui-layout「请求级错误提示」）：切到别的请求看不到它，
              切回来仍在；并发时也不会被别条发送的结果冲掉。 */}
          {(error ?? activeSendError) && (
            <div className="notice danger" role="alert" data-testid="app-error">
              {error ?? activeSendError}
            </div>
          )}
          {activeScriptGate && (
            <div className="notice warn" role="alert" data-testid="script-gate">
              <p>
                集合「{activeScriptGate.name}」带有脚本，而它可能来自导入。执行后可以读写变量、
                经 <code>pm.sendRequest</code> 发起网络请求（默认不限制目标地址）。
              </p>
              <div className="row">
                <button
                  onClick={() => {
                    // 「允许执行并继续」重发**触发门禁的那一条**。门禁按标签存、只有这一条
                    // 在看着时才呈现，因此它就是当前激活的这条。
                    const gateKey = activeTabKey;
                    if (!gateKey) return;
                    void allowScriptExecution(client, activeScriptGate.collectionId).then(() =>
                      performSend(false, gateKey),
                    );
                  }}
                >
                  允许执行（记住此集合）
                </button>
                <button
                  onClick={() => {
                    if (activeTabKey) void performSend(true, activeTabKey);
                  }}
                >
                  不执行脚本，仍发送
                </button>
                <button
                  className="ghost"
                  onClick={() => {
                    if (activeTabKey) clearScriptGate(activeTabKey);
                  }}
                >
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
                {/* 环境级代理（spec: 设置模态的代理配置）：三层不挤在同一屏，这一层落在
                    环境自身的编辑面。Globals 不是环境，没有这一层——它对应的是设置模态里
                    的全局代理。 */}
                {environmentId && (
                  <section className="settings-section" data-testid="environment-proxy">
                    <h4>代理</h4>
                    <ProxyConfigRows
                      proxy={environmentProxy}
                      onChange={setEnvironmentProxy}
                      allowInherit
                      idPrefix="environment"
                      name="环境代理"
                    />
                  </section>
                )}

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
              wrapLines={wrapLines}
              onWrapLinesChange={setWrapLines}
              sending={activeSending}
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
                error={null}
                // 失败时 `response` 为空，但决定仍要出现（spec: ui-layout「响应区的代理决定」）
                proxyDecision={activeProxyDecision}
                onSaveFull={() => void saveFullResponse()}
                presentation={presentation}
                indent={indentUnit(editorAppearance)}
                wrapLines={wrapLines}
                onWrapLinesChange={setWrapLines}
                sending={activeSending}
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
        sending={Object.keys(sending).length > 0}
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

      {modal === 'copy-blocked' && copyBlocked && (
        <Modal title="无法复制" onClose={() => setModal(null)}>
          <p>以下内容还有未保存的改动，复制会丢掉它们：</p>
          <ul className="copy-blocked-list">
            {copyBlocked.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
          <p className="muted">先保存（Ctrl+S）再复制。</p>
        </Modal>
      )}

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
