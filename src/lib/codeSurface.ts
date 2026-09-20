/**
 * CodeSurface 的**轻量**常量与工具——刻意不引入 Monaco，可被静态 import。
 *
 * Monaco 的装载在 `monacoEnv.ts`，只经动态 import 触达（不进启动模块图，
 * 与 scriptRuntime.ts 对 postman-sandbox 的处理同理）。把阈值这类需要同步读取的
 * 东西放在这里，正是为了避免「读一个常量就把整个 Monaco 拉进启动图」。
 */

/**
 * 超过这个体积的响应正文不交给富编辑器：Monaco 打开几 MB 文档要建 TextModel +
 * 全量 tokenizer，主线程会冻。
 *
 * 注意这是**渲染方式**的阈值，与 `ResponsePanel` 里后端 50MB 的**截断**上限
 * (`Math.min(response.size_bytes, 50 * 1024 * 1024)`) 是两回事，各自独立：前者决定
 * 「用不用 Monaco 高亮」，后者决定「正文最多保留多少」。
 */
export const CODE_SURFACE_MAX_BYTES = 10 * 1024 * 1024;

/** Monaco 语言 id 到模型文件扩展名（喂给 worker 的 `file://` 名，便于其按扩展名解析）。 */
const LANGUAGE_EXTENSION: Record<string, string> = {
  json: 'json',
  xml: 'xml',
  html: 'html',
  javascript: 'js',
  text: 'txt',
};

export function languageExtension(language: string): string {
  return LANGUAGE_EXTENSION[language] ?? 'txt';
}

/** 应用内的正文语言 → Monaco 语言 id（`text` 在 Monaco 里叫 `plaintext`）。 */
const MONACO_LANGUAGE: Record<string, string> = {
  json: 'json',
  xml: 'xml',
  html: 'html',
  javascript: 'javascript',
  text: 'plaintext',
};

export function monacoLanguage(language: string): string {
  return MONACO_LANGUAGE[language] ?? 'plaintext';
}
