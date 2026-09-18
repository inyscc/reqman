import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { BottomBar, type ModalKind } from './components/BottomBar';
import { CookiePanel } from './components/CookiePanel';
import { EntityScriptPanel } from './components/EntityScriptPanel';
import { EnvironmentsPanel } from './components/EnvironmentsPanel';
import { ImportExportPanel } from './components/ImportExportPanel';
import { Modal } from './components/Modal';
import { PreviewStrip } from './components/PreviewStrip';
import { RequestEditor } from './components/RequestEditor';
import { ResponsePanel } from './components/ResponsePanel';
import { SettingsPanel } from './components/SettingsPanel';
import { VariablesPanel } from './components/VariablesPanel';
import { WorkspaceTree, type EntitySelection } from './components/WorkspaceTree';
import { commands as defaultCommands, describeError, type Commands } from './lib/commands';
import { createEditingRegistry, SURFACE_PRIORITY } from './lib/editing';
import {
  allowScriptExecution,
  isScriptExecutionAllowed,
  renderVisualizer,
  runScriptPhase,
} from './lib/scriptRuntime';
import type { ConsoleEntry, TestAssertion, VisualizerResult } from './lib/scriptRuntime';
import { withoutEmptyRows } from './lib/rows';
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
import { useEditingRegistryVersion, useEditingSurface } from './lib/useEditing';
import { useStoreValue } from './lib/useStore';
import { onBeforeUnload, tauriWindowCloser, type WindowCloser } from './lib/window';

type Tab = 'params' | 'headers' | 'body' | 'auth' | 'settings' | 'scripts';

/**
 * 用户已经表达「我要切走 / 关闭」，但被未保存改动挡住的意图。
 *
 * 意图是数据、执行是函数，两者分开之后守卫的语义就很清楚：先问、再决定要不要执行。
 */
type PendingIntent =
  | { kind: 'select-request'; id: string }
  | { kind: 'select-entity'; entity: EntitySelection }
  | { kind: 'rename-request'; id: string }
  | { kind: 'rename-entity'; entity: EntitySelection }
  | { kind: 'close-tab' }
  | { kind: 'delete-request'; id: string }
  /** 另存为与新建请求都会把主区换成另一条请求，同样会丢掉当前草稿。 */
  | { kind: 'duplicate-request' }
  | { kind: 'new-request'; collectionId: string; folderId: string | null }
  /** 退出应用：答案要还回 Tauri 的关闭回调（见 closeResolverRef）。 */
  | { kind: 'exit-app' };

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

export function App({ client = defaultCommands, windowCloser = tauriWindowCloser }: AppProps) {
  const requestStore = useMemo(() => createEntityStore<SavedRequest>(), []);
  /** 编辑面注册表：Ctrl+S 与未保存守卫共用它（见 lib/editing.ts）。 */
  const editingRegistry = useMemo(() => createEditingRegistry(), []);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [trees, setTrees] = useState<CollectionTree[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SavedRequest | null>(null);
  const [tab, setTab] = useState<Tab>('params');
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<RequestPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [response, setResponse] = useState<ResponsePayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 待确认的脚本门禁；非空时暂停发送，等用户在界面上做出选择（任务 9.3）。 */
  const [scriptGate, setScriptGate] = useState<{ collectionId: string; name: string } | null>(
    null,
  );
  /** 上一次发送的脚本输出与断言结果，供响应区的「脚本」标签页呈现（任务 6.1 / 6.2）。 */
  const [scriptReport, setScriptReport] = useState<{
    console: ConsoleEntry[];
    assertions: TestAssertion[];
    error: string | null;
    visualizer?: VisualizerResult | null;
  } | null>(null);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [variables, setVariables] = useState<Variable[]>([]);
  /** 侧栏内部 tab：Collections / Environments（design D2）。 */
  const [sidebarTab, setSidebarTab] = useState<'collections' | 'environments'>('collections');
  /** 低频面板的单例模态（design D5）：非空时打开对应弹窗，同一时间至多一个。 */
  const [modal, setModal] = useState<ModalKind | null>(null);
  /** 树中选中的集合/文件夹（脚本编辑入口，任务 5.2）；选中请求时清空。 */
  const [selectedEntity, setSelectedEntity] = useState<EntitySelection | null>(null);
  const [entityDraft, setEntityDraft] = useState<Collection | Folder | null>(null);
  /** 菜单的「重命名」只负责把焦点交给面包屑里的名称框（design D3）。 */
  const [pendingRenameFocus, setPendingRenameFocus] = useState(false);
  /** 被未保存改动挡下的意图；非空时界面给出三选一提示。 */
  const [pendingIntent, setPendingIntent] = useState<PendingIntent | null>(null);
  const entityNameRef = useRef<HTMLInputElement>(null);
  const requestNameRef = useRef<HTMLInputElement>(null);
  /** Ctrl+S 的一次保存尚未结束时，不再重复提交。 */
  const savingRef = useRef(false);
  /** 窗口关闭请求挂起时，用它把「要不要关」的答案还给 Tauri 的关闭回调。 */
  const closeResolverRef = useRef<((allow: boolean) => void) | null>(null);

  const storeVersion = useStoreValue(requestStore, (store) => store.version());
  const optimisticErrors = useStoreValue(requestStore, (store) => store.errors().length);
  /** 订阅编辑面注册表：某个面注册/脏状态变化时重算守卫与快捷键的判断依据。 */
  const editingVersion = useEditingRegistryVersion(editingRegistry);

  const previewSequence = useRef(0);

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
    },
    [client, requestStore],
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

  useEffect(() => {
    if (!workspaceId) return;
    void (async () => {
      try {
        await loadTree(workspaceId);
        await loadEnvironments(workspaceId);
      } catch (caught) {
        setError(describeError(caught).message);
      }
    })();
  }, [workspaceId, loadTree, loadEnvironments]);

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

  // 解析预览：自动跟随编辑，因此未解析变量在发送前就可见
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
            inline: dirty ? withoutEmptyRows(draft) : null,
            environment_id: environmentId,
          });
          if (sequence === previewSequence.current) {
            setPreview(next);
            setPreviewError(null);
          }
        } catch (caught) {
          if (sequence === previewSequence.current) {
            setPreview(null);
            setPreviewError(describeError(caught).message);
          }
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
            inline: dirty ? withoutEmptyRows(draft) : null,
            environment_id: environmentId,
          }
        : null,
    [draft, dirty, environmentId],
  );

  /** 只读展示当前工作区名；工作区切换界面已移除（design D8）。 */
  const activeWorkspace = workspaces.find((item) => item.id === workspaceId) ?? null;

  /** 面包屑左段：当前请求所属集合名（design D6）。 */
  const crumbCollectionName = draft
    ? (trees.find((tree) => tree.collection.id === draft.collection_id)?.collection.name ?? null)
    : null;

  /**
   * 侧栏 tab 决定主区内容（design D8）：停在 Environments 时主区就是环境编辑器。
   * 变量的表格放在这里而不是 280px 的侧栏里——侧栏留给列表，编辑要有地方铺开。
   * 打开的请求不会丢：切回 Collections 即恢复。
   */
  const showEnvironmentEditor = sidebarTab === 'environments';

  /** 环境编辑器标题用的名字：未激活环境时就是 Globals。 */
  const environmentName =
    (environmentId ? environments.find((item) => item.id === environmentId)?.name : null) ??
    'Globals';

  const reloadAfterImport = useCallback(async () => {
    if (!workspaceId) return;
    await loadTree(workspaceId);
    await loadEnvironments(workspaceId);
    await loadVariables(workspaceId, environmentId);
  }, [workspaceId, environmentId, loadTree, loadEnvironments, loadVariables]);

  /** 打开集合/文件夹的脚本编辑面板（5.2）——真正执行，不经过守卫。 */
  const activateEntity = async (entity: EntitySelection) => {
    setError(null);
    setSelectedEntity(entity);
    setDraft(null);
    setSelectedId(null);
    try {
      const loaded =
        entity.kind === 'collection'
          ? await client.collectionGet(entity.id)
          : await client.folderGet(entity.id);
      setEntityDraft(loaded);
    } catch (caught) {
      setEntityDraft(null);
      setError(describeError(caught).message);
    }
  };

  /** 实体脚本保存后：刷新树（脚本随条目持久化，5.3）。 */
  const entitySaved = () => {
    setBusy(false);
    if (workspaceId) void loadTree(workspaceId);
  };

  /** 切换主区到某个请求——真正执行，不经过守卫。 */
  const activateRequest = async (id: string) => {
    setError(null);
    setResponse(null);
    setSelectedId(id);
    setDirty(false);
    setSelectedEntity(null);
    setEntityDraft(null);
    const optimistic = requestStore.get(id);
    const loaded = optimistic ?? findRequest(trees, id) ?? (await client.requestGet(id));
    // 打开时清一次历史空行：此前存进去的空行不该在表格里占位
    setDraft(withoutEmptyRows(loaded));
  };

  const editDraft = (next: SavedRequest) => {
    setDraft(next);
    setDirty(true);
    requestStore.markDirty(next.id);
  };

  const saveDraft = async (): Promise<boolean> => {
    if (!draft) return false;
    // 空行不进存储：清洗只发生在出口，用户编辑过程中清空的行照旧留在表格里
    const payload = withoutEmptyRows(draft);
    setBusy(true);
    setError(null);
    try {
      await requestStore.update(payload.id, payload, (value) => client.requestSave(value));

      // 编辑即授权（design D6）：在本应用中编写并保存的脚本视为已授权，
      // 发送时不再走导入脚本的确认门禁
      if (payload.pre_request_script?.trim() || payload.test_script?.trim()) {
        await allowScriptExecution(client, payload.collection_id);
      }

      setDirty(false);
      if (workspaceId) await loadTree(workspaceId);
      return true;
    } catch (caught) {
      setError(describeError(caught).message);
      return false;
    } finally {
      setBusy(false);
    }
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key.toLowerCase() !== 's') return;
      // 拦掉运行环境自己的「保存网页」
      event.preventDefault();
      void saveCurrentSurface();
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
   * 页面重载不走 CloseRequested，只能用 beforeunload 兜底。它只能唤起运行环境自己的
   * 确认提示（文案不可控、没有「保存」选项），因此 spec 只承诺「不静默丢弃」。
   */
  useEffect(() => onBeforeUnload(() => editingRegistry.dirty().length > 0), [editingRegistry]);

  useEditingSurface(editingRegistry, {
    id: 'request',
    priority: SURFACE_PRIORITY.request,
    label: `请求「${draft?.name ?? ''}」`,
    // 主区让给环境编辑器、或模态盖住主区时，它不再是「当前面」，
    // 但仍然是需要守卫的脏面（关窗时照样要提示）
    isActive: () => !showEnvironmentEditor && modal === null,
    isDirty: () => dirty && draft !== null,
    save: saveDraft,
  });

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
    if (!draft) return;
    setBusy(true);
    setError(null);
    setScriptGate(null);
    setScriptReport(null);

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

        // `pm.cookies` 需要解析后的请求 URL（3.5）。复用预览的解析路径；URL 中
        // 引用 secret 变量的极端情形会以掩码形态出现，属已知限制。
        const preview = await client.variablesPreview({
          saved_id: dirty ? null : draft.id,
          inline: dirty ? withoutEmptyRows(draft) : null,
          environment_id: environmentId,
        });
        requestUrl = preview.url || null;

        const pre = await runScriptPhase(client, target, 'prerequest', phases.pre, null, requestUrl);

        scriptError = pre.error;
        scriptConsole.push(...pre.console);
        scriptAssertions.push(...pre.assertions);
      }

      const payload = await client.sendRequest({
        saved_id: dirty ? null : draft.id,
        inline: dirty ? withoutEmptyRows(draft) : null,
        environment_id: environmentId,
      });
      setResponse(payload);

      if (target && !skipScripts && phases) {
        const post = await runScriptPhase(client, target, 'test', phases.test, payload, requestUrl);

        scriptError = scriptError ?? post.error;
        scriptConsole.push(...post.console);
        scriptAssertions.push(...post.assertions);
        scriptVisualizer = post.visualizer;
      }
    } catch (caught) {
      setResponse(null);
      setError(describeError(caught).message);
      // 请求本身失败（离线、DNS、证书…）不该连带丢掉前置脚本已经产生的输出与断言：
      // console 的呈现要求没有「仅当请求成功」这一限定条件
      setScriptReport({
        console: scriptConsole,
        assertions: scriptAssertions,
        error: scriptError,
        visualizer: scriptVisualizer,
      });
      setBusy(false);
      return;
    }

    setBusy(false);
    setScriptReport({
      console: scriptConsole,
      assertions: scriptAssertions,
      error: scriptError,
      visualizer: scriptVisualizer,
    });
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

  /** 真正执行「新建请求」——不经过守卫。 */
  const createRequest = async (collectionId: string, folderId: string | null) => {
    const created = await client.requestCreate({
      collection_id: collectionId,
      folder_id: folderId,
      name: '新请求',
      method: 'GET',
      url: 'https://example.test/',
    });
    if (workspaceId) await loadTree(workspaceId);
    setSelectedId(created.id);
    setDraft(created);
    setDirty(false);
    setSelectedEntity(null);
    setEntityDraft(null);
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
      if (selectedEntity?.kind === 'folder' && selectedEntity.id === id) {
        setSelectedEntity(null);
        setEntityDraft(null);
      }
      if (workspaceId) await loadTree(workspaceId);
    } catch (caught) {
      setError(describeError(caught).message);
    }
  };

  const deleteRequestById = async (id: string) => {
    setError(null);
    try {
      await client.requestDelete(id);
      if (selectedId === id) {
        setDraft(null);
        setSelectedId(null);
      }
      if (workspaceId) await loadTree(workspaceId);
    } catch (caught) {
      setError(describeError(caught).message);
    }
  };

  /** 菜单的「重命名」：先过守卫，执行时再把焦点交给面包屑里的名称框。 */
  const renameEntity = (entity: EntitySelection) => {
    guard({ kind: 'rename-entity', entity });
  };

  const renameRequest = (id: string) => {
    guard({ kind: 'rename-request', id });
  };

  /** 集合与文件夹的改名走面包屑，与请求改名同一处（design D3）。 */
  const saveEntityName = async () => {
    if (!selectedEntity || !entityDraft) return;
    const name = entityDraft.name.trim();

    if (!name) {
      setError('名称不能为空');
      const original = findEntityName(trees, selectedEntity);
      if (original) setEntityDraft({ ...entityDraft, name: original });
      return;
    }

    // 改成失焦/回车提交之后，这里会被「点进名称框又原样离开」触发：
    // 名称没变就不打扰后端
    if (name === findEntityName(trees, selectedEntity)) return;

    setBusy(true);
    setError(null);
    try {
      const saved =
        selectedEntity.kind === 'collection'
          ? await client.collectionRename(selectedEntity.id, name)
          : await client.folderRename(selectedEntity.id, name);
      setEntityDraft(saved);
      if (workspaceId) await loadTree(workspaceId);
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(false);
    }
  };

  /** 真正执行「另存为」——不经过守卫。 */
  const duplicateRequest = async () => {
    if (!draft) return;
    const copy = await client.requestDuplicate(draft.id, null);
    if (workspaceId) await loadTree(workspaceId);
    setSelectedId(copy.id);
    setDraft(copy);
    setDirty(false);
  };

  /** 删除当前打开的请求（面包屑上的「删除」）：有未保存改动时先问。 */
  const removeRequest = () => {
    if (!draft) return;
    if (dirty) {
      guard({ kind: 'delete-request', id: draft.id });
      return;
    }
    void deleteRequestById(draft.id);
  };

  /** 树的菜单里删除请求：删的正是当前打开的那个且未保存时，先问。 */
  const removeRequestById = (id: string) => {
    if (id === selectedId && dirty) {
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
      case 'select-request':
        await activateRequest(intent.id);
        return;
      case 'select-entity':
        await activateEntity(intent.entity);
        return;
      case 'rename-request':
        await activateRequest(intent.id);
        setPendingRenameFocus(true);
        return;
      case 'rename-entity':
        await activateEntity(intent.entity);
        setPendingRenameFocus(true);
        return;
      case 'close-tab':
        setDraft(null);
        setSelectedId(null);
        setResponse(null);
        return;
      case 'delete-request':
        await deleteRequestById(intent.id);
        return;
      case 'duplicate-request':
        await duplicateRequest();
        return;
      case 'new-request':
        await createRequest(intent.collectionId, intent.folderId);
        return;
      case 'exit-app': {
        const resolve = closeResolverRef.current;
        closeResolverRef.current = null;
        resolve?.(true);
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

  /** 树里选中请求（守卫入口）。 */
  const selectRequest = (id: string) => {
    // 重复点当前已打开的请求：不重载草稿、不动未保存标记，更不该弹守卫
    if (id === selectedId) return;
    guard({ kind: 'select-request', id });
  };

  /** 树里选中集合/文件夹（守卫入口）。 */
  const selectEntity = (entity: EntitySelection) => {
    guard({ kind: 'select-entity', entity });
  };

  /** 另存为 / 新建请求：都会把主区换成另一条请求，先过守卫。 */
  const duplicate = () => {
    if (!draft) return;
    guard({ kind: 'duplicate-request' });
  };

  const newRequest = (collectionId: string, folderId: string | null) => {
    guard({ kind: 'new-request', collectionId, folderId });
  };

  const saveFullResponse = async () => {
    if (!response) return;
    try {
      await client.responseSaveFull(response.id);
    } catch (caught) {
      setError(describeError(caught).message);
    }
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="badge">工作区</span>
          <span className="grow">{activeWorkspace?.name ?? '未加载'}</span>
        </div>

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
              selectedRequestId={selectedId}
              selectedEntity={selectedEntity}
              onSelectRequest={(id) => void selectRequest(id)}
              onSelectEntity={(entity) => void selectEntity(entity)}
              onNewCollection={() => void newCollection()}
              onNewRequest={newRequest}
              onNewFolder={(collectionId, parentFolderId) =>
                void newFolder(collectionId, parentFolderId)
              }
              onDeleteCollection={(id) => void deleteCollection(id)}
              onDeleteFolder={(id) => void deleteFolder(id)}
              onDeleteRequest={removeRequestById}
              onRenameEntity={(entity) => renameEntity(entity)}
              onRenameRequest={(id) => renameRequest(id)}
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

      <main className={`main ${draft && !showEnvironmentEditor ? 'with-response' : ''}`}>
        {/* 会话标签：视觉壳，始终最多一个（spec: 会话标签视觉壳） */}
        <div className="session-bar">
          {showEnvironmentEditor ? (
            <div className="session-tab" data-testid="session-tab">
              <span className="badge">环境</span>
              <span className="name">{environmentName}</span>
            </div>
          ) : draft ? (
            <div className="session-tab" data-testid="session-tab">
              <span className="badge">{draft.method}</span>
              <span className="name">{draft.name}</span>
              <button
                className="ghost"
                aria-label="关闭标签"
                onClick={() => guard({ kind: 'close-tab' })}
              >
                ×
              </button>
            </div>
          ) : selectedEntity ? (
            <div className="session-tab" data-testid="session-tab">
              <span className="badge">
                {selectedEntity.kind === 'collection' ? '集合' : '文件夹'}
              </span>
              <span className="name">{entityDraft?.name ?? ''}</span>
            </div>
          ) : (
            <span className="muted">没有打开的请求</span>
          )}

          {/* 全局环境选择器（change: add-collection-search-and-env-management）：
              与侧栏 Environments tab 的激活态共用同一份状态；属于工作区级而非请求级，
              因此没有选中请求时同样可见。它自带「无环境 / 环境名」，不再另加标签。 */}
          <span className="grow" />
          <span className="env-select">
            <select
              aria-label="环境"
              value={environmentId ?? ''}
              onChange={(event) =>
                void activateEnvironment(event.target.value === '' ? null : event.target.value)
              }
            >
              <option value="">无环境</option>
              {environments.map((environment) => (
                <option key={environment.id} value={environment.id}>
                  {environment.name}
                </option>
              ))}
            </select>
          </span>
        </div>

        {/* 面包屑 + 请求级操作（spec: 面包屑与请求操作行） */}
        <div className="crumb-bar">
          {showEnvironmentEditor ? (
            <>
              <span className="crumb">环境</span>
              <span className="crumb-sep">/</span>
              <span className="crumb">{environmentName}</span>
            </>
          ) : draft ? (
            <>
              {crumbCollectionName && <span className="crumb">{crumbCollectionName}</span>}
              {crumbCollectionName && <span className="crumb-sep">/</span>}
              <input
                ref={requestNameRef}
                className="crumb-name"
                aria-label="请求名称"
                value={draft.name}
                onChange={(event) => editDraft({ ...draft, name: event.target.value })}
              />
              <span className="grow" />
              {/* 未保存标记与保存入口只在有改动时出现：默认界面上没有「保存」按钮 */}
              {dirty && (
                <>
                  <span className="badge warn">未保存</span>
                  <button
                    data-testid="save-request"
                    title="保存（Ctrl+S）"
                    onClick={() => void saveDraft()}
                    disabled={busy}
                  >
                    保存
                  </button>
                </>
              )}
              <button onClick={() => duplicate()} disabled={busy}>
                另存为
              </button>
              <button onClick={() => removeRequest()} disabled={busy}>
                删除
              </button>
            </>
          ) : selectedEntity && entityDraft ? (
            <>
              <input
                ref={entityNameRef}
                className="crumb-name"
                aria-label={selectedEntity.kind === 'collection' ? '集合名称' : '文件夹名称'}
                value={entityDraft.name}
                onChange={(event) => setEntityDraft({ ...entityDraft, name: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveEntityName();
                }}
                onBlur={() => void saveEntityName()}
              />
              <span className="grow" />
            </>
          ) : (
            <span className="crumb">未选择请求</span>
          )}
        </div>

        <div className="request-region">
          {/* 未保存守卫的三选一（spec: 未保存改动在切走前的守卫） */}
          {pendingIntent && (
            <div className="notice warn" role="alert" data-testid="unsaved-guard">
              <p>
                {dirtySurfaces.map((surface) => surface.label).join('、')}
                有未保存的改动。要保存后再继续吗？
              </p>
              <div className="row">
                <button onClick={() => void saveAndContinue()} disabled={busy}>
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

          {showEnvironmentEditor ? (
            /* 环境编辑器占主区（design D8）：变量表格需要宽度，侧栏只放列表 */
            <div className="pane" data-testid="environment-editor">
              <div className="pane-body var-editor">
                <VariablesPanel
                  client={client}
                  workspaceId={workspaceId ?? ''}
                  environmentId={environmentId}
                  variables={variables}
                  onChanged={() => {
                    if (workspaceId) void loadVariables(workspaceId, environmentId);
                  }}
                />
              </div>
            </div>
          ) : selectedEntity && entityDraft ? (
            <EntityScriptPanel
              /* 换实体时重置本地草稿与基线，否则上一个实体的脚本会留在输入框里 */
              key={selectedEntity.id}
              client={client}
              kind={selectedEntity.kind}
              entity={entityDraft}
              collectionId={selectedEntity.collectionId}
              editing={editingRegistry}
              onSaved={() => entitySaved()}
            />
          ) : draft ? (
            <RequestEditor
              draft={draft}
              tab={tab}
              busy={busy}
              onTab={setTab}
              onChange={editDraft}
              onSend={() => void send()}
              preview={<PreviewStrip preview={preview} error={previewError} />}
            />
          ) : (
            <div className="pane-body muted">从左侧选择一个请求，或新建一个。</div>
          )}
        </div>

        {/* 响应栏只在选中请求时出现（spec: 主区左右分栏与响应栏可见性）；
            主区被环境编辑器占用时不出现——响应属于请求，不属于环境 */}
        {draft && !showEnvironmentEditor && (
          <div className="response-region">
            <ResponsePanel
              response={response}
              busy={busy}
              error={null}
              onSaveFull={() => void saveFullResponse()}
              scriptConsole={scriptReport?.console}
              scriptAssertions={scriptReport?.assertions}
              scriptError={scriptReport?.error ?? null}
              visualizerHtml={
                scriptReport?.visualizer ? renderVisualizer(scriptReport.visualizer) : null
              }
            />
          </div>
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

      {modal === 'cookies' && (
        <Modal title="Cookie" onClose={() => setModal(null)}>
          <CookiePanel client={client} />
        </Modal>
      )}

      {modal === 'settings' && (
        <Modal title="设置" onClose={() => setModal(null)}>
          <SettingsPanel client={client} editing={editingRegistry} />
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
    </div>
  );
}

export default App;
