// 变量占位符的悬浮值提示：取值判定（change: show-variable-values-on-hover，任务 1.1）。
//
// 提示要回答的问题只有「这个名字当前的值是什么、来自哪一层」，不是「把这段文本替换成什么」
// ——后者是发送与 `variables_preview` 的事。因此这里复用 `effectiveByName` 那一处生效判定
// （`VariablesPeek` 与变量表格已在用），不新写第二套：判定一旦分裂，界面就会说 A 生效、
// 而实际发出的是 B（design D1）。
//
// 作用域优先级与 `variable-engine`「作用域优先级」一致：集合级条目先放、当前作用域
// （环境或全局）后放，后者覆盖前者。`local` / `data` 只存在于单次执行期间，编辑器里
// 不可能查到，因此不参与。

import type { Commands } from './commands';
import type { Variable } from './types';
import { displayValue, effectiveByName } from './variables';

/** 提示里能标出的来源作用域。 */
export type VariableHoverScope = 'environment' | 'collection' | 'global';

/** 一条提示的取值：名字、当前取值、来源作用域，以及它是否标记为 secret。 */
export interface VariableHoverValue {
  kind: 'value';
  name: string;
  value: string;
  scope: VariableHoverScope;
  /** 标记为 secret 的条目：取值默认是掩码，明文另经揭示出口取得（任务 1.2）。 */
  secret: boolean;
}

/** 每次独立求值的动态变量：不给具体取值（给出一个必然与实际发出的请求不符）。 */
export interface VariableHoverDynamic {
  kind: 'dynamic';
  name: string;
}

/** 当前无法解析的名字：只标明未解析，不呈现看似有效的取值。 */
export interface VariableHoverUnresolved {
  kind: 'unresolved';
  name: string;
}

export type VariableHoverInfo = VariableHoverValue | VariableHoverDynamic | VariableHoverUnresolved;

/** 提示取值的唯一出口：命中一个名字时问它要一条呈现信息。 */
export interface VariableHoverSource {
  resolve(name: string): Promise<VariableHoverInfo>;
}

/** 取值源的可传递形态（Monaco 的 hover provider 要的正是这个形状）。 */
export type VariableHoverLookup = (name: string) => Promise<VariableHoverInfo>;

/**
 * 提示需要的后端出口。
 *
 * 收窄成这几条而不是整个 `Commands`：提示只读变量（`secret_reveal` 也是读），
 * 窄接口把这个事实写在类型上——没有写入可以调用，也顺带让测试不必造一整套命令面。
 */
export type VariableHoverCommands = Pick<
  Commands,
  'variableList' | 'globalsList' | 'secretReveal'
>;

export interface VariableHoverContext {
  workspaceId: string;
  /** 当前激活环境；null 表示 Globals。 */
  environmentId: string | null;
  /** 提示所在请求所属的集合；没有所属集合时为 null。 */
  collectionId: string | null;
}

/**
 * 组件层的接线：上下文 + 入口命令。
 *
 * 收成一个对象是因为它要穿过 `App → 请求带 / 请求编辑器 → 各编辑面` 这条链——分成四个
 * prop 只会让每一个中间层都得重复一遍同一组参数。
 */
export interface VariableHoverWiring extends VariableHoverContext {
  client: VariableHoverCommands;
}

/**
 * 动态变量的名字（`{{$name}}` 里的 `$name` 部分）。
 *
 * 与后端 `dynamic_value` 的名单逐字对齐：名单外的东西（含 `$notAThing` 这类拼错的名字）
 * 后端按未解析处理，因此这里也 SHALL NOT 把它当成动态变量——否则提示会为一次注定失败的
 * 解析背书。这里只做判定，不求值（求值仍只在发送路径上发生）。
 */
const DYNAMIC_NAMES = new Set([
  'guid',
  'randomUUID',
  'timestamp',
  'isoTimestamp',
  'randomInt',
  'randomBoolean',
  'randomFullName',
  'randomName',
  'randomFirstName',
  'randomLastName',
  'randomEmail',
  'randomEmailAddress',
  'randomColor',
]);

/** 该名字是不是动态变量（用户定义的 `$guid` 不会遮蔽这个命名空间）。 */
export function isDynamicVariable(name: string): boolean {
  return name.startsWith('$') && DYNAMIC_NAMES.has(name.slice(1));
}

/** 作用域在界面上的说法。 */
const SCOPE_LABELS: Record<VariableHoverScope, string> = {
  environment: '环境',
  collection: '集合',
  global: '全局',
};

/**
 * 提示呈现的中间形态。
 *
 * 四个编辑面（地址栏、参数表、请求头表、Body raw）说的是同一份内容——Body 走 Monaco 的
 * hover、其余走自研浮层，两边的排版方式完全不同，因此把「说了什么」收在这里、由两边各自
 * 排版。分开写两份文案，迟早会出现同一个变量在两处显示得不一样。
 */
export interface VariableHoverPresentation {
  name: string;
  status: 'value' | 'dynamic' | 'unresolved';
  /** 呈现的取值；动态变量与未解析时为空串（那里没有「取值」可言）。 */
  value: string;
  /** 机器可读的来源作用域；动态变量与未解析时为 null。 */
  scope: VariableHoverScope | null;
  /** 来源作用域的说法；动态变量与未解析时为 null。 */
  scopeLabel: string | null;
  secret: boolean;
  /** 一句话说明，用于动态变量与未解析这两条分支。 */
  note: string | null;
}

/** 把一条取值信息整理成可呈现的样子。 */
export function describeHover(info: VariableHoverInfo): VariableHoverPresentation {
  if (info.kind === 'dynamic') {
    return {
      name: info.name,
      status: 'dynamic',
      value: '',
      scope: null,
      scopeLabel: null,
      secret: false,
      note: '每次独立求值，不给具体取值',
    };
  }

  if (info.kind === 'unresolved') {
    return {
      name: info.name,
      status: 'unresolved',
      value: '',
      scope: null,
      scopeLabel: null,
      secret: false,
      note: '未解析',
    };
  }

  return {
    name: info.name,
    status: 'value',
    value: info.value,
    scope: info.scope,
    scopeLabel: SCOPE_LABELS[info.scope],
    secret: info.secret,
    note: null,
  };
}

/** 命中那一条所属的作用域——提示据此标出「哪一层在生效」。 */
interface ScopedVariable {
  variable: Variable;
  scope: VariableHoverScope;
}

/**
 * 建一个提示取值源。
 *
 * **惰性装载**：变量列表在第一次真的需要时才取，且只取一次——提示是「按需看」的能力，
 * 把它变成 `App` 的常驻状态就得再为「改了变量之后何时失效」立一套规则（design D2）。
 * 因此缓存挂在**这个源**上：源随「工作区 / 环境 / 集合」变化而重建，那三者不变时列表
 * 在本次会话内保持不变。
 *
 * 装载失败按「查不到」处理：提示退化成一整条未解析，比把界面拖进错误态更合适——它只是
 * 一次悬停，而发送路径的判定不受任何影响。
 */
export function createVariableHoverSource(
  client: VariableHoverCommands,
  context: VariableHoverContext,
): VariableHoverSource {
  let scoped: Promise<Map<string, ScopedVariable>> | null = null;

  const load = (): Promise<Map<string, ScopedVariable>> => {
    scoped ??= (async () => {
      const { workspaceId, environmentId, collectionId } = context;

      const [scopeVariables, collectionVariables] = await Promise.all([
        environmentId
          ? client.variableList('environment', environmentId)
          : client.globalsList(workspaceId),
        collectionId ? client.variableList('collection', collectionId) : Promise.resolve([]),
      ]);

      const scope: VariableHoverScope = environmentId ? 'environment' : 'global';
      const byName = new Map<string, ScopedVariable>();

      // 集合级先放、当前作用域后放：同名时作用域内的那份胜出（与 VariablesPeek 同款）
      for (const [name, variable] of effectiveByName(collectionVariables)) {
        byName.set(name, { variable, scope: 'collection' });
      }
      for (const [name, variable] of effectiveByName(scopeVariables)) {
        byName.set(name, { variable, scope });
      }

      return byName;
    })().catch(() => new Map<string, ScopedVariable>());

    return scoped;
  };

  return {
    async resolve(name: string): Promise<VariableHoverInfo> {
      // 动态变量命名空间优先：用户定义的 `$guid` 不参与（与后端一致）
      if (isDynamicVariable(name)) return { kind: 'dynamic', name };

      const found = (await load()).get(name);
      if (!found) return { kind: 'unresolved', name };

      const { variable, scope } = found;

      // secret 的取值默认是掩码，要明文只能经既有的揭示出口取一次。
      //
      // **每次悬停取一次、不缓存**：明文只活在这一次提示的呈现期间，指针移开即随之丢弃
      // （design D5）。所以它 SHALL NOT 进上面那份列表缓存，也 SHALL NOT 落到任何
      // 可复制的输出或持久化形态里。
      if (variable.is_secret) {
        const revealed = await client.secretReveal(variable.id).catch(() => null);
        return {
          kind: 'value',
          name,
          value: revealed ? displayValue(revealed) : '不可读',
          scope,
          secret: true,
        };
      }

      return {
        kind: 'value',
        name,
        value: displayValue(variable),
        scope,
        secret: false,
      };
    },
  };
}
