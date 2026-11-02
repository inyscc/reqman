// 前置脚本对请求体的改动如何落到**真正发出去的那一份**请求上。
//
// 与请求头（`scriptHeaders.ts`）同一套思路，但只处理 `raw` 正文：
//
// 1. 喂进沙箱的正文是**已解析**的（脚本要读到本次请求实际要发的内容），待发正文还是
//    原始的（`{{var}}` 原样，交给后端解析）。因此不能把回读的整份正文直接当待发正文——
//    脚本没碰的正文不该因为跑了一次脚本就丢掉后端的解析与 secret 掩码路径。
// 2. 于是这里只搬运**差异**：脚本真的动过正文才改草稿。没动时调用方走原路径。
// 3. 表单 / 二进制正文不参与改写：沙箱只建模了 `raw`，那里的"正文"是给脚本读的文本投影，
//    把它写回去会把一张表单压成一段文本（spec: pm-script-runtime「pm.request 的填充」）。

import type { SandboxBody } from './scriptRuntime';
import type { SavedRequest } from './types';

/** 脚本对请求体造成的改动。 */
export interface RequestBodyChange {
  /** 脚本执行后的正文文本。 */
  raw: string;
}

/**
 * 比较「喂进沙箱的请求体」与「执行后回读的请求体」，得出脚本造成的改动。
 *
 * 回读不到（这一段没跑完 / 形态不是 raw）或正文一字未变时返回 `null`——调用方据此
 * 完全跳过合并。
 */
export function diffRequestBody(
  fed: SandboxBody | undefined,
  final: SandboxBody | undefined,
): RequestBodyChange | null {
  if (!final) return null;
  if (fed?.raw === final.raw) return null;

  return { raw: final.raw };
}

export interface AppliedScriptBody {
  request: SavedRequest;
  /** 正文是否被改动（决定是否必须走内联发送）。 */
  changed: boolean;
  /** 脚本改了正文，但该请求的正文不是 raw 形态，改动没有落地。 */
  ignored: boolean;
}

/**
 * 把改动合并进待发请求。
 *
 * `changed` 为假时原样返回同一个对象引用。
 */
export function applyScriptBody(
  request: SavedRequest,
  change: RequestBodyChange | null,
): AppliedScriptBody {
  if (!change) return { request, changed: false, ignored: false };

  const kind = request.body.kind;
  if (kind !== 'raw' && kind !== 'none') {
    return { request, changed: false, ignored: true };
  }

  return {
    request: {
      ...request,
      body: {
        ...request.body,
        // 本来没有正文的请求在脚本里补上了正文：类型随之变为 raw。语言沿用原有取值
        // （空值由编辑器按 JSON 呈现），不在这里替用户猜一种语法。
        kind: 'raw',
        raw: change.raw,
      },
    },
    changed: true,
    ignored: false,
  };
}
