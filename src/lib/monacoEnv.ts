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
import { describeHover, type VariableHoverLookup } from './variableHover';

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
const hoverLookups = new Map<string, VariableHoverLookup>();

/**
 * 给一个模型登记取值源（Body raw 的占位符悬停）。
 *
 * provider 只能按**语言**静态注册一次（Monaco 没有「随某个组件挂载而生效」的 provider），
 * 因此「这个模型该查哪个作用域的变量」只能反着传进来：编辑面按模型 URI 登记，回调再按
 * 当前模型去找。没有登记的模型（脚本面、响应正文）自然返回 null，不影响它们原有的悬停。
 */
export function registerVariableHoverLookup(uri: string, lookup: VariableHoverLookup): void {
  hoverLookups.set(uri, lookup);
}

/** 编辑面卸载时撤掉登记：留着会让关掉的请求继续响应悬停。 */
export function releaseVariableHoverLookup(uri: string): void {
  hoverLookups.delete(uri);
}

/** 当前已登记的模型（排查用）。 */
export function registeredVariableHoverUris(): string[] {
  return Array.from(hoverLookups.keys());
}

let variableHoverReady = false;

/** 注册占位符悬停 provider（只做一次；语言名与编辑面实际用到的 mode 一致）。 */
function setupVariableHover(monaco: typeof Monaco): void {
  if (variableHoverReady) return;
  variableHoverReady = true;

  monaco.languages.registerHoverProvider(['json', 'xml', 'html', 'javascript', 'plaintext'], {
    async provideHover(model, position) {
      const lookup = hoverLookups.get(model.uri.toString());
      if (!lookup) return null;

      const text = model.getValue();
      // 与地址栏、键值表用的是同一条正则（`rangeAtIndex`）：Body 上能悬停的范围与别处一致
      const range = rangeAtIndex(text, model.getOffsetAt(position));
      if (!range) return null;

      const presented = describeHover(await lookup(range.name));
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

let monacoPromise: Promise<typeof Monaco> | null = null;

/** 动态加载 Monaco 并完成一次性装配（同进程内只加载一次）。 */
export function loadMonaco(): Promise<typeof Monaco> {
  monacoPromise ??= import('monaco-editor').then((monaco) => {
    defineTheme(monaco);
    setupPmTypes(monaco);
    setupVariableHover(monaco);
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
