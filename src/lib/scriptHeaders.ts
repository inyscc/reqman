// 前置脚本对请求头的改动如何落到**真正发出去的那一份**请求上（design D3）。
//
// 两条约束决定了这里的形状：
//
// 1. 沙箱里那份 `pm.request` 的头是**已解析**的（脚本要读出本次请求的目标与内容），
//    而待发请求的头还是原始的（`{{var}}` 原样，交给后端解析）。因此不能把回读的整份头
//    直接当成内联请求的头——那会把所有头的求值提前，脚本没碰的头也会失去后端的解析与
//    secret 掩码路径。
// 2. 于是这里只搬运**差异**：脚本真的动过哪些头，就把哪些头改到草稿上；一个都没动时
//    调用方走原路径，发送链路一字不变。
//
// 键的比较一律忽略大小写（HTTP 头名不区分大小写，`Content-Type` 与 `content-type` 是
// 同一个头）；取值的比较区分大小写。

import type { SandboxHeader, SandboxRequest } from './scriptRuntime';
import type { SavedRequest } from './types';

/** 脚本对请求头造成的改动。 */
export interface RequestHeaderChange {
  /** 需要设置的头（新增或按名改写），后出现的同名声覆盖先出现的。 */
  set: { key: string; value: string }[];
  /** 需要移除的头，存的是小写键。 */
  remove: string[];
}

const lower = (key: string): string => key.trim().toLowerCase();

/** 把一组头按小写键分组；组内保持原顺序。 */
function groupByKey(headers: SandboxHeader[]): Map<string, SandboxHeader[]> {
  const groups = new Map<string, SandboxHeader[]>();

  for (const header of headers) {
    if (header.disabled) continue;
    const key = lower(header.key);
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(header);
    else groups.set(key, [header]);
  }

  return groups;
}

/** 同一组同名头的取值是否一致（多重集比较：顺序不同不算改动）。 */
function sameValues(before: SandboxHeader[], after: SandboxHeader[]): boolean {
  if (before.length !== after.length) return false;

  const values = (list: SandboxHeader[]) => list.map((header) => header.value).sort();

  return values(before).every((value, index) => value === values(after)[index]);
}

/**
 * 比较「喂进沙箱的请求头」与「执行后回读的请求头」，得出脚本造成的改动。
 *
 * 未发生变化时返回 `null`——调用方据此完全跳过合并，也跳过"以 `inline` 发送"那条路径。
 */
export function diffRequestHeaders(
  fed: SandboxHeader[],
  final: SandboxHeader[],
): RequestHeaderChange | null {
  const before = groupByKey(fed);
  const after = groupByKey(final);

  const set: { key: string; value: string }[] = [];

  for (const [key, headers] of after) {
    const previous = before.get(key) ?? [];
    if (sameValues(previous, headers)) continue;
    // 同名多值时取最后一条：`upsert` 是脚本最常用的写法，它的语义就是"这个名字最终是
    // 这个值"，而"新增了第二个同名头"在请求编辑器里也不是常规用法（design D3）
    const last = headers[headers.length - 1];
    set.push({ key: last.key, value: last.value });
  }

  const remove = [...before.keys()].filter((key) => !after.has(key));

  if (set.length === 0 && remove.length === 0) return null;

  return { set, remove };
}

/**
 * 把改动合并进待发请求。
 *
 * 套在**草稿的原始头列表**上（dispatcher 已按"启用且有内容"过滤过，见 `cleanForSend`），
 * 因此脚本没碰的头仍然是原始占位符形态。`changed` 为假时原样返回同一个对象引用。
 */
export function applyScriptHeaders(
  request: SavedRequest,
  change: RequestHeaderChange | null,
): { request: SavedRequest; changed: boolean } {
  if (!change) return { request, changed: false };

  let headers = request.headers.filter((header) => !change.remove.includes(lower(header.key)));

  for (const { key, value } of change.set) {
    const target = lower(key);
    const index = headers.findIndex((header) => lower(header.key) === target);

    headers =
      index < 0
        ? [...headers, { key, value, enabled: true, description: null }]
        : headers.map((header, position) =>
            position === index ? { ...header, key, value, enabled: true } : header,
          );
  }

  return { request: { ...request, headers }, changed: true };
}

/**
 * 把「实际发出的请求头」盖到请求形态上，供后置阶段的 `pm.request` 与
 * `pm.response.originalRequest` 使用（design D4）。
 *
 * 后端没给这份头（该路径不产出）时原样返回传入的请求——宁可少几个头，也不要把请求头
 * 清空，更不要把方法、URL、正文一起丢掉。
 */
export function withSentHeaders(
  request: SandboxRequest,
  sent: [string, string][] | null | undefined,
): SandboxRequest {
  if (!sent || sent.length === 0) return request;

  return { ...request, header: sent.map(([key, value]) => ({ key, value })) };
}
