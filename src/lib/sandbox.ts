// 不可信响应内容的呈现（design.md D15）。
//
// HTML / SVG / Markdown 一律放进 **不带 allow-scripts** 的 sandbox iframe，并且
// 用 blob: 承载，使其拿到不透明来源：脚本不执行，也无法访问应用界面或后端能力。

export type PreviewKind = 'text' | 'image' | 'iframe' | 'binary';

export interface PreviewPlan {
  kind: PreviewKind;
  /** iframe 承载时给出的 blob URL。 */
  url?: string;
  /** 文本承载时的内容。 */
  text?: string;
}

/**
 * 响应的**呈现格式**：用户可选的编码/解释方式（spec: http-engine「响应内容与格式化」）。
 *
 * `auto` 是「跟随检测」——由内容类型决定；其余为强制解释，解释失败回退原样（见
 * `renderBody`）。`raw` 是纯文本原样，`hex` 是字节视图。
 */
export type ResponseFormat = 'auto' | 'raw' | 'json' | 'xml' | 'html' | 'hex';

/** 内容类型**检测**出的格式，供下拉标记与 `auto` 解释共用。 */
export type DetectedFormat = 'json' | 'xml' | 'html' | 'markdown' | 'text';

/** 格式化缩进宽度：固定空格，不提供 Tab（spec: http-engine「格式化缩进宽度」）。 */
export type IndentWidth = 2 | 4 | 8;

export const INDENT_WIDTHS: readonly IndentWidth[] = [2, 4, 8];

export const FORMAT_LABELS: Record<ResponseFormat, string> = {
  auto: '跟随检测',
  raw: 'Raw',
  json: 'JSON',
  xml: 'XML',
  html: 'HTML',
  hex: 'Hex',
};

/** 内容类型嗅探的**唯一**入口：格式化、高亮语言与下拉标记都由它派生。 */
export function detectResponseFormat(contentType: string | null | undefined): DetectedFormat {
  const type = (contentType ?? '').toLowerCase();
  if (type.includes('json')) return 'json';
  if (type.includes('xml')) return 'xml';
  if (type.includes('html')) return 'html';
  if (type.includes('markdown')) return 'markdown';
  return 'text';
}

function looksLikeHtml(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const type = contentType.toLowerCase();
  return type.includes('text/html') || type.includes('image/svg');
}

function looksLikeMarkdown(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  return contentType.toLowerCase().includes('text/markdown');
}

function looksLikeImage(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  return contentType.toLowerCase().startsWith('image/');
}

/**
 * 决定用哪种方式呈现响应正文。
 *
 * 返回 `iframe` 时，调用方必须把 `url` 交给一个 `sandbox=""` 的 iframe，
 * 并在卸载时撤销 blob URL。
 */
export function planPreview(
  contentType: string | null | undefined,
  body: string | null,
  bodyIsBinary: boolean,
): PreviewPlan {
  if (bodyIsBinary || body === null) {
    return { kind: 'binary' };
  }
  if (looksLikeHtml(contentType) || looksLikeMarkdown(contentType)) {
    return { kind: 'iframe' };
  }
  if (looksLikeImage(contentType)) {
    return { kind: 'image' };
  }
  return { kind: 'text', text: body };
}

/**
 * 为不可信内容创建隔离承载用的 blob URL。
 *
 * 类型必须带上 `charset=utf-8`。`html` 是后端已解码的字符串，写进 Blob 时按 UTF-8
 * 编码；但 blob 的 Content-Type 若不带字符集，iframe 会退回默认的单字节编码去解析，
 * 于是中文等非 ASCII 正文被渲染成乱码（`结构可见` → `ç»“æž„å¯è§`）。
 *
 * 这里刻意不取响应的 charset：`html` 已经是解码后的字符串，承载编码恒为 UTF-8，
 * 与源响应原本声明什么无关。
 */
export function createSandboxUrl(html: string): string {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  return URL.createObjectURL(blob);
}

export function revokeSandboxUrl(url: string | undefined): void {
  if (url && url.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
}

/** 尝试格式化 JSON；失败则原样返回（强制解释失败不报错，spec: http-engine）。 */
export function prettyJson(body: string, indent: IndentWidth = 2): string {
  try {
    return JSON.stringify(JSON.parse(body), null, indent);
  } catch {
    return body;
  }
}

/**
 * 把 XML 拆成「标签」与「文本」两类片段。
 *
 * 用简单的 `<[^>]*>` 匹配：属性值里如果出现 `>` 会被切断。这个格式化器只用于
 * 展示，不参与任何解析或执行，因此接受这一限制。
 */
function tokenizeXml(source: string): string[] {
  const tokens: string[] = [];
  const tagPattern = /<[^>]*>/g;
  let cursor = 0;
  let match = tagPattern.exec(source);

  while (match !== null) {
    if (match.index > cursor) {
      tokens.push(source.slice(cursor, match.index));
    }
    tokens.push(match[0]);
    cursor = match.index + match[0].length;
    match = tagPattern.exec(source);
  }

  if (cursor < source.length) {
    tokens.push(source.slice(cursor));
  }

  return tokens;
}

/** 对 XML 做最小缩进；不改变内容语义，纯文本叶子元素保持在同一行。 */
export function prettyXml(body: string, indent: IndentWidth = 2): string {
  const pad = ' '.repeat(indent);
  const compact = body.replace(/>\s+</g, '><').trim();
  if (!compact.startsWith('<')) return body;

  const tokens = tokenizeXml(compact);
  const lines: string[] = [];
  let depth = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const isEndTag = token.startsWith('</');

    if (isEndTag) {
      depth = Math.max(0, depth - 1);
      lines.push(pad.repeat(depth) + token);
      continue;
    }

    const isDeclaration = token.startsWith('<?') || token.startsWith('<!');
    const isSelfClosing = token.endsWith('/>');
    if (isDeclaration || isSelfClosing) {
      lines.push(pad.repeat(depth) + token);
      continue;
    }

    // 叶子元素：<tag>文本</tag> 合为一行
    const text = tokens[index + 1];
    const closing = tokens[index + 2];
    if (text && !text.startsWith('<') && closing && closing.startsWith('</')) {
      lines.push(pad.repeat(depth) + token + text + closing);
      index += 2;
      continue;
    }

    lines.push(pad.repeat(depth) + token);
    depth += 1;
  }

  return lines.join('\n');
}

/** 呈现结果：要么是可交给代码编辑面的文本（连同高亮语言），要么是字节视图。 */
export type RenderedBody =
  | { view: 'text'; text: string; language: string }
  | { view: 'hex' };

const DETECTED_LANGUAGE: Record<DetectedFormat, string> = {
  json: 'json',
  xml: 'xml',
  html: 'html',
  markdown: 'markdown',
  text: 'plaintext',
};

/**
 * 解释响应正文（spec: http-engine「响应内容与格式化」；design D2）。
 *
 * 纯函数，且**不抛错**：所选格式解释不了正文时回退为原样文本——强制解释失败是
 * 用户的合法选择，不该在界面上变成一条错误。
 */
export function renderBody(
  format: ResponseFormat,
  detected: DetectedFormat,
  body: string,
  indent: IndentWidth = 2,
): RenderedBody {
  if (format === 'hex') return { view: 'hex' };
  if (format === 'raw') return { view: 'text', text: body, language: 'plaintext' };

  if (format === 'json') {
    return { view: 'text', text: prettyJson(body, indent), language: 'json' };
  }
  if (format === 'xml') {
    return { view: 'text', text: prettyXml(body, indent), language: 'xml' };
  }
  if (format === 'html') return { view: 'text', text: body, language: 'html' };

  // auto：按检测结果格式化；检测为 html / markdown / text 时无格式化器，原样呈现
  if (detected === 'json') {
    return { view: 'text', text: prettyJson(body, indent), language: 'json' };
  }
  if (detected === 'xml') {
    return { view: 'text', text: prettyXml(body, indent), language: 'xml' };
  }
  return { view: 'text', text: body, language: DETECTED_LANGUAGE[detected] };
}

/** Hex 视图一次最多呈现的字节数；超出部分不渲染（design 风险项）。 */
export const HEX_MAX_BYTES = 256 * 1024;

/**
 * 响应的**原始字节**（spec: http-engine Hex 视图；design D4）。
 *
 * 双通道：非 UTF-8 响应后端的 `body_text` 解码失败，只给了 `body_base64`；合法
 * UTF-8 的「解码字符串 → TextEncoder 再编码」是无损往返。两者都缺时为空。
 */
export function bodyBytes(
  bodyText: string | null | undefined,
  bodyBase64: string | null | undefined,
): Uint8Array {
  if (bodyBase64) return base64Bytes(bodyBase64);
  if (typeof bodyText === 'string') return new TextEncoder().encode(bodyText);
  return new Uint8Array();
}

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * 「偏移 + 十六进制 + ASCII」三列的字节视图文本，每行 16 字节。
 *
 * 不可打印字节（ASCII 可见范围之外）在第三列显示 `.`，因此不可见字符在这里是
 * **看得见**的——这正是 Hex 视图存在的理由。
 */
export function hexDump(bytes: Uint8Array): string {
  const capped = bytes.length > HEX_MAX_BYTES ? bytes.subarray(0, HEX_MAX_BYTES) : bytes;
  const lines: string[] = [];

  for (let offset = 0; offset < capped.length; offset += 16) {
    const row = capped.subarray(offset, offset + 16);
    const hex: string[] = [];
    let ascii = '';

    for (let index = 0; index < 16; index += 1) {
      const byte = row[index];
      if (byte === undefined) {
        hex.push('  ');
        continue;
      }
      hex.push(byte.toString(16).padStart(2, '0'));
      ascii += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.';
    }

    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex.join(' ')}  ${ascii}`);
  }

  return lines.join('\n');
}

/** 字节数的可读表示。 */
export function humanBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}
