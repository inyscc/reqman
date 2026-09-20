import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CodeSurface } from '../components/CodeSurface';
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
}

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
