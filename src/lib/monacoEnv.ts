/**
 * Monaco 的装载与环境装配（**重量级模块**）。
 *
 * 本模块**只允许动态 import**（见 CodeSurface.tsx）——它静态引入了 `?worker`
 * 构造器与语言贡献，若进启动模块图会把 Monaco 整个拉进入口 chunk。
 *
 * 装载要点全部来自已跑通的 spike（硬约束）：
 * - worker 走 `MonacoEnvironment.getWorker`（0.54 里 `getWorker()` 优先级最高的分支），
 *   label 是 modeId：`typescript`/`javascript` 共用 ts.worker（JS 是 TS 的降级模式），
 *   `json` 用 json.worker，其余用 editor.worker；
 * - 语言功能必须显式 import contribution，否则 `monaco.languages.typescript` 是 undefined；
 * - 模型必须用 `file://` URI——默认的 `inmemory://model/N` 会断 TS worker 的模型同步，
 *   补全/诊断全报 `Could not find source file`。
 */
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution';
import 'monaco-editor/esm/vs/language/json/monaco.contribution';
import type * as Monaco from 'monaco-editor';
import { rangeAtIndex } from './placeholders';
import { PM_DTS } from './pmDts';
import { describeHover, scopeLabel, type VariableSource } from './variableHover';
import { filterCandidates, suggestContext } from './variableSuggest';

export const THEME_NAME = 'reqman-light';

// worker 装载：必须在 monaco 被求值之前设好（本模块顶层即执行）。
(self as unknown as { MonacoEnvironment: Monaco.Environment }).MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    if (label === 'json') return new JsonWorker();
    return new EditorWorker();
  },
};

/** 把编辑器主题接到应用的浅色设计 token 上（`App.css` 的 `--panel` / `--surface-sunken` / `--accent`）。 */
function defineTheme(monaco: typeof Monaco): void {
  monaco.editor.defineTheme(THEME_NAME, {
    base: 'vs',
    inherit: true,
    // 语法配色参考 Postman 的浅色编辑器（Monaco + VS Code Light+ 系）：
    // 注释绿、字符串暗红、数字青绿、关键字蓝、JSON 键青蓝、布尔/null 蓝。
    rules: [
      { token: 'comment', foreground: '008000', fontStyle: 'italic' },
      { token: 'keyword', foreground: '0000ff' },
      { token: 'string', foreground: 'a31515' },
      { token: 'number', foreground: '098658' },
      { token: 'regexp', foreground: '811f3f' },
      { token: 'type', foreground: '267f99' },
      { token: 'function', foreground: '795e26' },
      { token: 'variable', foreground: '001080' },
      { token: 'constant', foreground: '0070c1' },
      { token: 'operator', foreground: '212121' },
      // JSON：键与字符串值分色，布尔/null 走关键字蓝
      { token: 'string.key.json', foreground: '0451a5' },
      { token: 'string.value.json', foreground: 'a31515' },
      { token: 'number.json', foreground: '098658' },
      { token: 'keyword.json', foreground: '0000ff' },
      // XML / HTML
      { token: 'tag', foreground: '800000' },
      { token: 'attribute.name', foreground: 'e50000' },
      { token: 'attribute.value', foreground: '0451a5' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#1c2024',
      'editor.lineHighlightBackground': '#f6f8fa',
      'editorLineNumber.foreground': '#9aa4b2',
      'editorLineNumber.activeForeground': '#4c6ef5',
      'editorGutter.background': '#ffffff',
      'editorIndentGuide.background1': '#eef0f4',
      'editorIndentGuide.activeBackground1': '#d3d8e0',
      'editor.selectionBackground': '#d7e0fb',
      'editorCursor.foreground': '#4c6ef5',
      // 补全面板刻意**不覆盖取色**：Postman 的代码编辑器本身就是 Monaco，
      // 它那套「选中行 = #0060c0 蓝底 + 白字 + 白图标、面板浅灰底」正是这里的
      // 默认值（editorSuggestWidget.selectedBackground → quickInputList.focusBackground
      // → list.activeSelectionBackground = light: #0060c0），照抄默认即可。
      //
      // 唯一需要补的是「选中行里被匹配到的字符」：其默认取 list.highlightForeground
      //（浅色下 #0066bf 蓝），落在 #0060c0 蓝底上等于蓝字蓝底、完全看不清；
      // VS Code / Postman 这一档是白色。
      'editorSuggestWidget.focusHighlightForeground': '#ffffff',
      'scrollbarSlider.background': '#00000010',
      'scrollbarSlider.hoverBackground': '#00000020',
      'scrollbarSlider.activeBackground': '#00000030',
    },
  });
}

let pmTypesReady = false;

/** 注入 `pm` 补全声明与 JS 编译选项（只做一次；全语言服务共享）。 */
function setupPmTypes(monaco: typeof Monaco): void {
  if (pmTypesReady) return;
  monaco.languages.typescript.javascriptDefaults.addExtraLib(PM_DTS, 'pm.d.ts');
  monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
    allowJs: true,
    checkJs: false,
  });
  pmTypesReady = true;
}

/** 已登记的取值源：键是模型 URI。 */
const variableSources = new Map<string, VariableSource>();

/**
 * 给一个模型登记取值源（Body raw 的占位符悬停与输入候选）。
 *
 * provider 只能按**语言**静态注册一次（Monaco 没有「随某个组件挂载而生效」的 provider），
 * 因此「这个模型该查哪个作用域的变量」只能反着传进来：编辑面按模型 URI 登记，回调再按
 * 当前模型去找。没有登记的模型（脚本面、响应正文）自然什么也不返回，不影响它们原有的
 * 悬停与补全。
 */
export function registerVariableSource(uri: string, source: VariableSource): void {
  variableSources.set(uri, source);
}

/** 编辑面卸载时撤掉登记：留着会让关掉的请求继续响应悬停/候选。 */
export function releaseVariableSource(uri: string): void {
  variableSources.delete(uri);
}

/** 当前已登记的模型（排查与浏览器用例用）。 */
export function registeredVariableSourceUris(): string[] {
  return Array.from(variableSources.keys());
}

let variableHoverReady = false;

/** 注册占位符悬停 provider（只做一次；语言名与编辑面实际用到的 mode 一致）。 */
function setupVariableHover(monaco: typeof Monaco): void {
  if (variableHoverReady) return;
  variableHoverReady = true;

  monaco.languages.registerHoverProvider(['json', 'xml', 'html', 'javascript', 'plaintext'], {
    async provideHover(model, position) {
      const lookup = variableSources.get(model.uri.toString());
      if (!lookup) return null;

      const text = model.getValue();
      // 与地址栏、键值表用的是同一条正则（`rangeAtIndex`）：Body 上能悬停的范围与别处一致
      const range = rangeAtIndex(text, model.getOffsetAt(position));
      if (!range) return null;

      const presented = describeHover(await lookup.resolve(range.name));
      const start = model.getPositionAt(range.start);
      const end = model.getPositionAt(range.end);

      const lines =
        presented.status === 'value'
          ? [`取值：\`${presented.value}\``, `来源：${presented.scopeLabel}`]
          : [presented.note ?? ''];

      return {
        range: {
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
        },
        contents: [{ value: [`**\`${presented.name}\`**`, '', ...lines].join('\n') }],
      };
    },
  });
}

let variableSuggestReady = false;

/** 补全挂在这些语言上——与编辑面实际用到的 mode 一致（raw 正文可为 json/xml/html/... ）。 */
const VARIABLE_LANGUAGES = ['json', 'xml', 'html', 'javascript', 'plaintext'];

/**
 * 注册输入 `{{` 时的变量候选（change: suggest-variables-in-body-editor）。
 *
 * 三条与原生输入框那套保持一致的约定：
 * - **判定同源**：`suggestContext` 决定「光标是否正在写一个未闭合的 `{{`」，因此正文里
 *   改名字（`{{ho|st}}`）替换的是整个占位符，不会插成 `{{{{name}}st}}`；
 * - **过滤同源**：`filterCandidates` 保证前缀命中排在包含命中之前，顺序与地址栏一致；
 * - **取值同源**：`candidates()` 就是悬停用的那一份（同名遮蔽只剩生效条、secret 只给掩码）。
 *
 * 触发字符取 `{`：Monaco 的触发是「字符插入之后」，用户敲下第二个 `{` 时才真的构成 `{{`，
 * 因此单敲一个 `{` 会走到这里但判定为 null、直接返回空集——不会弹出「无建议」面板。
 */
function setupVariableSuggest(monaco: typeof Monaco): void {
  if (variableSuggestReady) return;
  variableSuggestReady = true;

  monaco.languages.registerCompletionItemProvider(VARIABLE_LANGUAGES, {
    triggerCharacters: ['{'],
    async provideCompletionItems(model, position) {
      const source = variableSources.get(model.uri.toString());
      if (!source) return { suggestions: [] };

      const text = model.getValue();
      const caret = model.getOffsetAt(position);
      const context = suggestContext(text, caret);
      if (!context) return { suggestions: [] };

      // 打开时重新装载一次（刚加的变量要立刻可选），继续键入走同一份列表
      const items = filterCandidates(
        await source.candidates({ refresh: context.query === '' }),
        context.query,
      );
      const start = model.getPositionAt(context.start);
      const end = model.getPositionAt(context.end);
      const range = {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      };
      // Monaco 拿 `range` 到光标的这段文本做过滤：`filterText` 必须以它开头（`{{ho` ↔
      // `{{host`），否则刚敲下的两个花括号会把整份候选都滤掉
      return {
        suggestions: items.map((item, index) => ({
          // 行内就给出「名字 · 取值 · 来源」：用户是在挑「哪个变量」，取值与来源是判断依据，
          // 藏进详情面板等于让他逐条悬停（地址栏那套浮层也是把三样一起摆出来的）
          label: { label: item.name, description: `${item.value} · ${scopeLabel(item.scope)}` },
          kind: monaco.languages.CompletionItemKind.Variable,
          detail: item.value,
          documentation: {
            value: [
              `\`{{${item.name}}}\``,
              '',
              item.secret ? '取值：`••••••`（secret，发送时由后端展开）' : `取值：\`${item.value}\``,
              `来源：${scopeLabel(item.scope)}`,
            ].join('\n'),
          },
          insertText: `{{${item.name}}}`,
          // 前缀补上 `{{`：Monaco 的过滤是拿 `range` 到光标的文本比的
          filterText: `{{${item.name}`,
          // 用下标做排序键：列表顺序即 `filterCandidates` 的结果（当前作用域在前、前缀命中在前）
          sortText: String(index).padStart(4, '0'),
          range,
        })),
      };
    },
  });
}

let monacoPromise: Promise<typeof Monaco> | null = null;

/** 动态加载 Monaco 并完成一次性装配（同进程内只加载一次）。 */
export function loadMonaco(): Promise<typeof Monaco> {
  monacoPromise ??= import('monaco-editor').then((monaco) => {
    defineTheme(monaco);
    setupPmTypes(monaco);
    setupVariableHover(monaco);
    setupVariableSuggest(monaco);
    return monaco;
  });
  return monacoPromise;
}

let warmupPromise: Promise<void> | null = null;

/**
 * 预热 JS/TS 语言服务。
 *
 * `getJavaScriptWorker()` 在 `onLanguage("javascript")` 异步注册完成前会以**字符串**
 * `"JavaScript not registered!"` reject（不是 Error）——这是 spike 实测的竞态。这里带
 * 重试地取一次，确保脚本面首次触发补全时语言服务已就绪。
 */
export function warmupJavaScript(monaco: typeof Monaco): Promise<void> {
  warmupPromise ??= (async () => {
    for (let i = 0; i < 60; i++) {
      try {
        await monaco.languages.typescript.getJavaScriptWorker();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  })();
  return warmupPromise;
}
