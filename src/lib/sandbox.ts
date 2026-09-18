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

/** 尝试格式化 JSON；失败则原样返回。 */
export function prettyJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
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
export function prettyXml(body: string): string {
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
      lines.push('  '.repeat(depth) + token);
      continue;
    }

    const isDeclaration = token.startsWith('<?') || token.startsWith('<!');
    const isSelfClosing = token.endsWith('/>');
    if (isDeclaration || isSelfClosing) {
      lines.push('  '.repeat(depth) + token);
      continue;
    }

    // 叶子元素：<tag>文本</tag> 合为一行
    const text = tokens[index + 1];
    const closing = tokens[index + 2];
    if (text && !text.startsWith('<') && closing && closing.startsWith('</')) {
      lines.push('  '.repeat(depth) + token + text + closing);
      index += 2;
      continue;
    }

    lines.push('  '.repeat(depth) + token);
    depth += 1;
  }

  return lines.join('\n');
}

/** 依据内容类型选择格式化方式。 */
export function prettyBody(contentType: string | null | undefined, body: string): string {
  const type = (contentType ?? '').toLowerCase();
  if (type.includes('json')) return prettyJson(body);
  if (type.includes('xml')) return prettyXml(body);
  return body;
}

/** 字节数的可读表示。 */
export function humanBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}
