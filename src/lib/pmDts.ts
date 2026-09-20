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

  interface Response {
    code: number;
    status: string;
    responseTime: number;
    headers: unknown;
    json(): any;
    text(): string;
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
  const request: unknown;
  const response: Response;
  const cookies: unknown;
  function sendRequest(req: unknown, callback?: (...args: unknown[]) => unknown): Promise<Response> | undefined;
  function test(name: string, fn: (() => void) | (() => Promise<void>)): void;
  function require(name: string): unknown;
  const expect: any;
}
`;
