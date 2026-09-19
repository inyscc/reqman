// URL 与查询参数表的双向同步（spec: http-engine「URL 与参数表保持同步」）。
//
// 请求模型里 URL 与参数表是两份字段（存储层整块 JSON 落库，见
// `src-tauri/src/storage/requests.rs`），发送与预览时由 Rust 的
// `url_util::compose_url` 把两者合成为真实请求地址。只要界面不同步，地址栏、
// 参数表与解析预览就可以互相矛盾——因此这里把两者绑成一份数据：
//
// - 编辑地址栏 → URL 为准，参数表跟随（写入查询串里出现的行）；
// - 编辑参数表 → 参数表为准，URL 的查询串跟随。
//
// 刻意不依赖 `URL` 构造器：URL 里可能有未解析的 `{{var}}`、`:path` 变量或相对
// 地址，构造器会规范化（甚至拒绝解析）这些输入，而用户看到的应当是原文（与
// Rust 侧 `compose_url` 的注释同一条理由）。

import type { KeyValue, SavedRequest } from './types';

export interface SplitUrl {
  /** 不含查询串的部分（fragment 保留）。 */
  base: string;
  /** URL 里是否出现了 `?`——用来区分「没有参数」与「用户刚把参数删掉」。 */
  hasQuery: boolean;
  params: KeyValue[];
}

/** 把 URL 的查询串拆成参数行；重复键按出现顺序各占一行。 */
export function splitUrlQuery(url: string): SplitUrl {
  const hashIndex = url.indexOf('#');
  const head = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const fragment = hashIndex >= 0 ? url.slice(hashIndex) : '';

  const markIndex = head.indexOf('?');
  if (markIndex < 0) return { base: url, hasQuery: false, params: [] };

  const params: KeyValue[] = [];
  for (const [key, value] of new URLSearchParams(head.slice(markIndex + 1))) {
    params.push({ key, value, enabled: true });
  }

  return { base: head.slice(0, markIndex) + fragment, hasQuery: true, params };
}

/**
 * 把参数表写成 URL 的查询串：整体替换原有查询串（参数表是唯一真相），
 * fragment 保留。
 *
 * 编码规则与 Rust 的 `form_urlencoded`（发送时实际使用的规则）一致；唯一的
 * 例外是 `{{var}}` 还原成原文——地址栏里要能看见变量，而不是 `%7B%7B`。
 */
export function composeUrl(url: string, params: KeyValue[]): string {
  const { base } = splitUrlQuery(url);
  if (params.length === 0) return base;

  // 查询串要插在 fragment 之前：`base` 里 fragment 是保留的（`#top`）
  const hashIndex = base.indexOf('#');
  const head = hashIndex >= 0 ? base.slice(0, hashIndex) : base;
  const fragment = hashIndex >= 0 ? base.slice(hashIndex) : '';

  const search = new URLSearchParams();
  for (const param of params) search.append(param.key, param.value);

  return `${head}?${search.toString().replace(/%7B%7B/gi, '{{').replace(/%7D%7D/gi, '}}')}${fragment}`;
}

/** 编辑地址栏：URL 为准，参数表跟随。URL 里没有查询串即视为参数表为空。 */
export function withUrl(request: SavedRequest, url: string): SavedRequest {
  const split = splitUrlQuery(url);
  if (!split.hasQuery) return { ...request, url, params: [] };

  return { ...request, url, params: carryRowMeta(split.params, request.params) };
}

/** 编辑参数表：参数表为准，URL 的查询串跟随。 */
export function withParams(request: SavedRequest, params: KeyValue[]): SavedRequest {
  return { ...request, params, url: composeUrl(request.url, params) };
}

/**
 * 打开请求时对齐两份数据（存量数据的自愈）：
 *
 * - URL 里带查询串 → 以 URL 为准（多出来的表格行是历史残留）；
 * - URL 里没有查询串而表格有参数 → 把参数补写进 URL。**不能反过来清空表格**：
 *   此前参数表与 URL 各自独立落库，大量请求的 URL 里本就没有查询串，清空等于
 *   丢数据。
 */
export function alignUrlAndParams(request: SavedRequest): SavedRequest {
  const split = splitUrlQuery(request.url);

  if (split.hasQuery) {
    const params = carryRowMeta(split.params, request.params);
    return sameRows(params, request.params) ? request : { ...request, params };
  }

  if (request.params.length === 0) return request;
  return { ...request, url: composeUrl(request.url, request.params) };
}

/**
 * 从 URL 拆出来的行是「新读到的」，但启用状态与备注只存在于表格里：同键的旧行
 * 优先沿用，否则用户在地址栏里改一个字符就会把停用的参数重新启用。
 */
function carryRowMeta(params: KeyValue[], previous: KeyValue[]): KeyValue[] {
  const used = previous.map(() => false);

  return params.map((param) => {
    const index = previous.findIndex((row, i) => !used[i] && row.key === param.key);
    if (index < 0) return param;

    used[index] = true;
    const old = previous[index];
    return {
      key: param.key,
      value: param.value,
      enabled: old.enabled,
      description: old.description,
    };
  });
}

function sameRows(left: KeyValue[], right: KeyValue[]): boolean {
  if (left.length !== right.length) return false;

  return left.every(
    (row, index) =>
      row.key === right[index].key &&
      row.value === right[index].value &&
      row.enabled === right[index].enabled &&
      (row.description ?? null) === (right[index].description ?? null),
  );
}
