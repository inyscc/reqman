/**
 * 脚本编辑器的 `pm` 补全声明（作为 extra lib 注入 Monaco 的 TS 语言服务）。
 *
 * **来源**：`postman-sandbox` 随包发布的类型 `types/index.d.ts` 里的 `Postman` 类——
 * 顶层成员与其一一对应（`info` / `environment` / `globals` / `collectionVariables` /
 * `variables` / `iterationData` / `vault` / `request` / `response` / `cookies` /
 * `visualizer` / `sendRequest` / `execution` / `require` / `expect`）。
 *
 * 那个上游文件**不自足**（`CookieList` / `VariableScope` / `Request` / `Response`
 * 只有引用没有声明，来自 `postman-collection` 等），所以不能整份注入；这里把它
 * 裁剪成一份自足的声明：可变面完整的 `VariableScope`，其余按需收成最小可用形态。
 *
 * 本项目补丁：`wrapUserScript`（scriptRuntime.ts）给 `pm.require` 打了别名，
 * 故保留 `require` 声明。`pm.test` 由沙箱在运行时挂上（不在 `Postman` 类里），一并声明。
 *
 * `pm.request` / `pm.response` / `pm.cookies` 的成员按**宿主实际喂进去与实测可读**的
 * 形态声明（见 `scriptRuntime.ts` 的 `toSandboxRequest` / `toSandboxResponse`）。把它们
 * 收成 `unknown` 会让这些成员之后的补全整体消失——`unknown` 上不允许访问任何属性。
 *
 * 两处刻意的"少声明"：
 * - `pm.request` 的写方法（`headers.add` / `url = ...`）**不声明**：宿主实现的是一份
 *   快照，脚本对它的改动既不跨段可见、也不影响实际发出的请求（design D6）。声明了
 *   会让人以为改得动。
 * - `pm.require` 的返回仍是 `unknown`：内置库有九个，逐个声明不划算。
 *
 * **同步**：升级 `postman-sandbox`（版本见 package.json，当前 6.7.4）时须按新的
 * `Postman` 类型复核本声明，勿让编辑器补全与真实运行时能力漂移。
 */
export const PM_DTS = `
declare namespace pm {
  interface VariableScope {
    get(key: string): string | undefined;
    set(key: string, value: unknown): void;
    unset(key: string): void;
    has(key: string): boolean;
    clear(): void;
    toObject(): Record<string, unknown>;
    replaceIn(template: string): string;
  }

  interface Info {
    eventName: string;
    iteration: number;
    iterationCount: number;
    requestName: string;
    requestId: string;
  }

  interface Vault {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
    unset(key: string): Promise<void>;
  }

  interface Visualizer {
    set(template: string, data?: unknown, options?: unknown): void;
    clear(): void;
  }

  interface Execution {
    skipRequest(): void;
    setNextRequest(request: string | null): void;
    location: unknown;
    runRequest(requestId: string, options?: unknown): Promise<unknown>;
  }

  /** 请求头或响应头的集合（postman-collection 的 HeaderList）。 */
  interface HeaderList {
    /** 取某个头的值；不存在时为 undefined。 */
    get(name: string): string | undefined;
    all(): Array<{ key: string; value: string }>;
  }

  /** 响应里的一条 Cookie（postman-collection 的 Cookie）。 */
  interface ResponseCookie {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    hostOnly?: boolean;
    /** 有效期（ISO 串）；会话 Cookie 为字符串 'Infinity'。 */
    expires?: string;
    maxAge?: number;
  }

  interface CookieList {
    all(): ResponseCookie[];
    /** 按名取一条；不存在时为 undefined。 */
    get(name: string): ResponseCookie | undefined;
  }

  interface RequestUrl {
    /** 完整的 URL 文本。 */
    toString(): string;
    /**
     * 原始形态。是否保留 \`{{name}}\` 取决于上游的解析方式，**不是**契约的一部分
     * （design R6）：脚本可依赖的是 \`toString()\` 读得出本次请求的目标。
     */
    raw?: string;
  }

  interface RequestBody {
    mode: string;
    raw?: string;
  }

  /**
   * 脚本执行时刻的请求快照（spec: pm-script-runtime「pm.request 的填充」）。
   *
   * **只读**：对它的改动既不跨脚本段可见，也不影响实际发出的请求（design D6），
   * 因此这里只声明读取面。
   */
  interface Request {
    url: RequestUrl;
    method: string;
    headers: HeaderList;
    body?: RequestBody;
    /** 认证**只暴露方式**，不含凭据。 */
    auth?: { type: string };
  }

  interface Response {
    code: number;
    status: string;
    responseTime: number;
    headers: HeaderList;
    /** 本次响应体的字节数。 */
    downloadedBytes?: number;
    cookies: CookieList;
    /** 本次实际发出的请求。 */
    originalRequest?: Request;
    json(): any;
    text(): string;
    size(): { body: number; header: number; total: number };
  }

  /** \`pm.cookies.jar()\` 给出的 Cookie 仓库代理：读写都经宿主落到真实的 Jar。 */
  interface CookieJar {
    set(url: string, name: string, value: string, callback?: (error: unknown) => void): void;
    set(
      url: string,
      options: {
        name: string;
        value: string;
        domain?: string;
        path?: string;
        secure?: boolean;
        httpOnly?: boolean;
        expires?: string;
      },
      callback?: (error: unknown) => void
    ): void;
    get(url: string, name: string, callback: (error: unknown, value?: string) => void): void;
    unset(url: string, name: string, callback?: (error: unknown) => void): void;
    getAll(url: string, callback: (error: unknown, list: CookieList) => void): void;
  }

  interface Cookies {
    /** 当前请求目标可用的一条 Cookie 取值。 */
    get(name: string): string | undefined;
    jar(): CookieJar;
  }

  /** \`pm.sendRequest\` 的请求描述：字符串（当作 URL）或对象。 */
  interface SendRequestPayload {
    url: string;
    method?: string;
    header?: Array<{ key: string; value: string }> | Record<string, string>;
    body?: { mode?: string; raw?: string };
  }

  const info: Info;
  const environment: VariableScope;
  const globals: VariableScope;
  const collectionVariables: VariableScope;
  const variables: VariableScope;
  const iterationData: VariableScope;
  const vault: Vault;
  const visualizer: Visualizer;
  const execution: Execution;
  const request: Request;
  const response: Response;
  const cookies: Cookies;
  function sendRequest(
    request: SendRequestPayload | string,
    callback?: (error: unknown, response: Response) => void
  ): Promise<Response> | undefined;
  function test(name: string, fn: (() => void) | (() => Promise<void>)): void;
  function require(name: string): unknown;
  const expect: any;
}
`;
