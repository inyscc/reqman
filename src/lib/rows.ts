// 键值行与表单字段的空行清洗。
//
// 「幽灵行」是纯视图态——它不存在于模型里，所以预览、发送与保存天然看不到它。
// 但模型里仍可能留下空行：用户清空一个已有行的内容时我们**不删行**（删掉正在
// 编辑的行比留着更烦人），历史数据里也可能存着之前点出来的空行。
//
// 因此清洗发生在**出口**：预览、发送与保存前各过一遍这里。后端不会帮忙——
// Rust 侧只按行的 `enabled` 过滤（src-tauri/src/variables/mod.rs:312-419），
// 一个 enabled 的空名请求头会让发送直接失败（src-tauri/src/net/headers.rs:35-38）。

import type { FormField, KeyValue, SavedRequest } from './types';

/**
 * 发出判定：这一行是否构成请求数据。
 *
 * 名称与值皆为空白 → 不构成请求数据，不进入实际发出的请求。发出判定**不看描述**：
 * 描述是给人看的说明，不是请求的一部分（spec: 键值表的列与描述列）。
 */
export function hasRequestData(row: KeyValue): boolean {
  return row.key.trim() !== '' || row.value.trim() !== '';
}

/**
 * 只带描述、不构成请求数据的行——用户在表格里写下的说明。
 *
 * 它们不对应任何查询串（参数表的同步按名称匹配，见 `url.ts` 的 `keepNotes`），
 * 但也不该因为同步或清洗被丢掉。
 */
export function isDescriptionOnlyRow(row: KeyValue): boolean {
  return !hasRequestData(row) && (row.description ?? '').trim() !== '';
}

/**
 * 保留判定：名称、值、描述三者皆空才算空行。`enabled` 不参与判定。
 *
 * 与发出判定的区别只落在「只写了描述的行」上：它留在存储里（用户写下的东西不该
 * 静默消失），但不会进入请求。清洗发生在出口，因此两个判定各由对应的出口使用。
 */
export function isEmptyKeyValue(row: KeyValue): boolean {
  return !hasRequestData(row) && !isDescriptionOnlyRow(row);
}

/**
 * FormField 的保留判定：名称与描述皆空才算空行（file 类型本来就没有值）。
 * 与 `isEmptyKeyValue` 的保留判定同构——只写了描述的行会被保留下来，
 * 但它不构成请求数据：发出档在 `cleanForSend` 里按「名称非空」过滤。
 */
export function isEmptyFormField(row: FormField): boolean {
  return row.key.trim() === '' && (row.description ?? '').trim() === '';
}

export function withoutEmptyKeyValues(rows: KeyValue[]): KeyValue[] {
  return rows.filter((row) => !isEmptyKeyValue(row));
}

export function withoutEmptyFormFields(rows: FormField[]): FormField[] {
  return rows.filter((row) => !isEmptyFormField(row));
}

/**
 * 剔除请求里所有空行。
 *
 * 没有空行时返回原引用——调用方把它接在预览、发送与保存前，多数情况下不必
 * 因为一次清洗而产生新对象。
 */
export function withoutEmptyRows(request: SavedRequest): SavedRequest {
  const params = withoutEmptyKeyValues(request.params);
  const headers = withoutEmptyKeyValues(request.headers);
  const urlencoded = withoutEmptyKeyValues(request.body.urlencoded);
  const form = withoutEmptyFormFields(request.body.form);

  if (
    params.length === request.params.length &&
    headers.length === request.headers.length &&
    urlencoded.length === request.body.urlencoded.length &&
    form.length === request.body.form.length
  ) {
    return request;
  }

  return {
    ...request,
    params,
    headers,
    body: { ...request.body, urlencoded, form },
  };
}

/**
 * 发送 / 预览 / 导出时用的清洗：在「剔空行」基础上再排除被停用的行与不构成请求
 * 数据的行。
 *
 * 「不构成请求数据」这一半是发出判定（`hasRequestData`）——只写了描述的行会被输出
 * 路径剔除（它们留在存储里），名称为空的行也一并剔掉：Rust 侧只按 `enabled` 过滤，
 * 一个 enabled 的空名请求头会让发送直接失败（见 `src-tauri/src/net/headers.rs`）。
 *
 * 注意：只在发送出口调用，**不要**在落库（保存）路径使用——停用的行要带着
 * `enabled:false` 持久化，不能被删掉（见 `App.tsx` 的保存分支）。库内存储的请求
 * 仍可能含 `enabled:false` 的行，由这里在真正发出前剥掉。
 */
export function cleanForSend(request: SavedRequest): SavedRequest {
  const cleaned = withoutEmptyRows(request);
  const sendable = (row: KeyValue) => row.enabled && hasRequestData(row);

  return {
    ...cleaned,
    params: cleaned.params.filter(sendable),
    headers: cleaned.headers.filter(sendable),
    body: {
      ...cleaned.body,
      urlencoded: cleaned.body.urlencoded.filter(sendable),
      // form 行的发出档：名称非空才进入载荷（file 字段没有值，不能套用键值行的
      // 「名称或值非空」）。描述-only 的行会被保留判定留在存储里，但不发出。
      form: cleaned.body.form.filter((row) => row.enabled && row.key.trim() !== ''),
    },
  };
}
