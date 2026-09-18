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

/** KeyValue 的空行：名称与值皆为空白。`enabled` 不参与判定。 */
export function isEmptyKeyValue(row: KeyValue): boolean {
  return row.key.trim() === '' && row.value.trim() === '';
}

/** FormField 的空行只以名称为准：file 类型的字段本来就没有值。 */
export function isEmptyFormField(row: FormField): boolean {
  return row.key.trim() === '';
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
