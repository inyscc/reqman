import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CodeSurface } from '../components/CodeSurface';
import {
  applyEditorAppearance,
  currentEditorAppearance,
  type EditorAppearance,
} from '../lib/editorAppearance';
import '../App.css';

/**
 * `tests-browser` 用的 CodeSurface 真身挂载点（仅 dev / 浏览器测试使用，不进产物）。
 *
 * 存在的理由：Monaco 在 happy-dom 跑不了，单元测试里 CodeSurface 被 mock 掉了
 * （tests/setup.ts）。真身（worker 装载、补全、折叠、行号、Ctrl+S 冒泡、非 ASCII 输入）
 * 只能在真实 Blink 里验，于是这里把组件挂起来并暴露一个驱动钩子 `window.__surface__`。
 *
 * 不走 `main.tsx` 的 hash 路由，而是由 `code-surface-harness.html` 单独作为入口加载，
 * 这样既不动产品入口，也不进生产构建（Vite 只 build index.html）。
 */

const JS_URI = 'file:///reqman/harness/script.js';
const JSON_URI = 'file:///reqman/harness/body.json';
const RESPONSE_URI = 'file:///reqman/harness/response.json';

const INITIAL_JSON = '{\n  "a": 1,\n  "b": {\n    "c": [1, 2, 3]\n  }\n}';
/** 只读响应正文的初值（验证只读面不可编辑）。 */
const RESPONSE_BODY = '{\n  "ok": true\n}';

interface SurfaceApi {
  getValue(uri: string): string;
  setValue(uri: string, next: string): void;
  saveCount(): number;
  foldingCount(uri: string): Promise<number>;
  /** 以下为编辑器外观用例的钩子（change: add-editor-appearance-settings）。 */
  setAppearance(patch: Partial<EditorAppearance>): void;
  /** 读编辑器与模型上**实际生效**的字体与缩进选项。 */
  optionsOf(uri: string): Promise<{
    fontFamily: string;
    fontSize: number;
    tabSize: number | null;
    insertSpaces: boolean | null;
  } | null>;
  /** 给当前编辑器实例贴一个编号；`markOf` 拿不回来即说明实例被重建过。 */
  markEditor(uri: string): Promise<number>;
  markOf(uri: string): Promise<number | null>;
  setScrollTop(uri: string, top: number): Promise<void>;
  scrollTopOf(uri: string): Promise<number | null>;
  foldAll(uri: string): Promise<void>;
  /** 该编辑器 DOM 里可见的行数（折叠生效时会小于总行数）。 */
  viewLineCount(uri: string): Promise<number>;
}

type MonacoModule = typeof import('monaco-editor');

/** 按 uri 找到当前编辑器实例（与 `foldingCount` 同一套查找）。 */
async function editorOf(uri: string): Promise<{
  monaco: MonacoModule;
  /** `getEditors()` 给的是更宽的 `ICodeEditor`（够用：只读选项、模型与滚动）。 */
  editor: import('monaco-editor').editor.ICodeEditor | null;
}> {
  const { loadMonaco } = await import('../lib/monacoEnv');
  const monaco = await loadMonaco();
  const editor =
    monaco.editor.getEditors().find((candidate) => candidate.getModel()?.uri.toString() === uri) ??
    null;
  return { monaco, editor };
}

/** 标记表：编号 → 被标记的实例。实例被重建后 `markOf` 会因身份不符返回 null。 */
const editorMarks = new Map<string, { editor: unknown; id: number }>();
let nextMarkId = 0;

function Harness() {
  const [js, setJs] = useState('pm.environment.');
  const [json, setJson] = useState(INITIAL_JSON);
  const [response] = useState(RESPONSE_BODY);
  const jsRef = useRef(js);
  const jsonRef = useRef(json);
  jsRef.current = js;
  jsonRef.current = json;
  const saveCount = useRef(0);

  // 模拟 App 的 window 层 Ctrl+S 监听（App.tsx 里「不依赖焦点」的那一个）：
  // 验证焦点在 Monaco 里时按键仍会冒泡到 window。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        saveCount.current += 1;
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const api: SurfaceApi = {
      getValue: (uri) => {
        if (uri === JSON_URI) return jsonRef.current;
        if (uri === RESPONSE_URI) return RESPONSE_BODY;
        return jsRef.current;
      },
      setValue: (uri, next) => (uri === JSON_URI ? setJson(next) : setJs(next)),
      saveCount: () => saveCount.current,
      foldingCount: async (uri) => {
        const { loadMonaco } = await import('../lib/monacoEnv');
        const monaco = await loadMonaco();
        const editor = monaco.editor
          .getEditors()
          .find((candidate) => candidate.getModel()?.uri.toString() === uri);
        if (!editor) return -1;
        const controller = editor.getContribution('editor.contrib.folding') as unknown as {
          triggerFoldingModelChanged?: () => void;
          getFoldingModel?: () => Promise<{ regions?: unknown[] } | null> | undefined;
        } | null;
        if (!controller) return -1;
        // getFoldingModel() 返回的是 foldingModelPromise；先触发一次计算再等它 resolve
        controller.triggerFoldingModelChanged?.();
        const model = await controller.getFoldingModel?.();
        return model?.regions?.length ?? 0;
      },
      setAppearance: (patch) => {
        // 与设置面板同一条路径：归一 + 注入等宽变量 + 通知已挂出的编辑面
        applyEditorAppearance({ ...currentEditorAppearance(), ...patch });
      },
      optionsOf: async (uri) => {
        const { monaco, editor } = await editorOf(uri);
        if (!editor) return null;
        const model = editor.getModel();
        return {
          fontFamily: editor.getOption(monaco.editor.EditorOption.fontFamily),
          fontSize: editor.getOption(monaco.editor.EditorOption.fontSize),
          tabSize: model?.getOptions().tabSize ?? null,
          insertSpaces: model?.getOptions().insertSpaces ?? null,
        };
      },
      markEditor: async (uri) => {
        const { editor } = await editorOf(uri);
        if (!editor) throw new Error(`没有找到编辑器：${uri}`);
        nextMarkId += 1;
        editorMarks.set(uri, { editor, id: nextMarkId });
        return nextMarkId;
      },
      markOf: async (uri) => {
        const { editor } = await editorOf(uri);
        const marked = editorMarks.get(uri);
        // 身份不符 = 实例被重建过（外观改动不该走到这里）
        if (!editor || !marked || marked.editor !== editor) return null;
        return marked.id;
      },
      setScrollTop: async (uri, top) => {
        const { editor } = await editorOf(uri);
        editor?.setScrollTop(top);
      },
      scrollTopOf: async (uri) => {
        const { editor } = await editorOf(uri);
        return editor ? editor.getScrollTop() : null;
      },
      foldAll: async (uri) => {
        const { editor } = await editorOf(uri);
        await editor?.getAction('editor.foldAll')?.run();
      },
      viewLineCount: async (uri) => {
        const { editor } = await editorOf(uri);
        return editor?.getDomNode()?.querySelectorAll('.view-line').length ?? -1;
      },
    };
    (window as unknown as { __surface__: SurfaceApi }).__surface__ = api;
  }, []);

  return (
    <div style={{ display: 'flex', gap: 8, height: '100vh', padding: 8, boxSizing: 'border-box' }}>
      <CodeSurface
        uri={JS_URI}
        ariaLabel="脚本编辑器"
        language="javascript"
        value={js}
        onChange={setJs}
        fill
        enableCompletion
      />
      <CodeSurface
        uri={JSON_URI}
        ariaLabel="JSON 编辑器"
        language="json"
        value={json}
        onChange={setJson}
        fill
      />
      <CodeSurface
        uri={RESPONSE_URI}
        ariaLabel="响应正文"
        language="json"
        value={response}
        readOnly
        fill
      />
    </div>
  );
}

const host = document.getElementById('root');
if (host) createRoot(host).render(<Harness />);
