import { useEffect, useRef } from 'react';
import type * as Monaco from 'monaco-editor';
import {
  currentEditorAppearance,
  subscribeEditorAppearance,
  type EditorAppearance,
} from '../lib/editorAppearance';

export interface CodeSurfaceProps {
  /** 模型 URI（`file://` 开头）：决定 TS/JSON worker 看到的文件名。同一编辑面保持稳定。 */
  uri: string;
  value: string;
  /** Monaco 语言 id：json / xml / html / javascript / plaintext。 */
  language: string;
  readOnly?: boolean;
  /** 可访问名（真实编辑器给 Monaco 的 `ariaLabel`；happy-dom mock 给 `<textarea>`）。 */
  ariaLabel?: string;
  /** 容器 test id（happy-dom mock 的只读响应正文按它查询 `.textContent`）。 */
  testId?: string;
  placeholder?: string;
  /** 固定高度（px 或 CSS 值）；`fill` 为真时忽略。 */
  height?: number | string;
  /** 铺满父容器剩余空间（脚本右栏 / 响应正文用）。 */
  fill?: boolean;
  /** 脚本面：预热 JS/TS 语言服务，保证 `pm.*` 补全首次即就绪。 */
  enableCompletion?: boolean;
  onChange?: (value: string) => void;
}

/**
 * 外观 → Monaco 选项。
 *
 * 分两处写是有原因的：字体与字号是**编辑器**选项（Monaco 把它们写进 DOM 的
 * `.view-lines` 并用 canvas 量字宽，改 CSS 变量对它无效）；缩进是**模型**选项，
 * 显式写给模型，不去赌「create 会不会把构造选项透给一个既有模型」。
 */
function fontOptions(appearance: EditorAppearance) {
  return { fontFamily: appearance.fontFamily, fontSize: appearance.fontSize };
}

function indentOptions(appearance: EditorAppearance) {
  return {
    tabSize: appearance.indentCount,
    insertSpaces: appearance.indentType === 'space',
    // 按内容推断缩进必须关掉：开着它，正文里已有的缩进会覆盖设置，
    // 「缩进数 4」在打开一份 2 空格缩进的 JSON 后就显得不生效（spec 明写以设置为准）。
    detectIndentation: false,
  };
}

/** 把外观写到编辑器与它的模型上——创建时与订阅回调共用这一个入口。 */
function applyAppearance(
  editor: Monaco.editor.IStandaloneCodeEditor,
  appearance: EditorAppearance,
): void {
  editor.updateOptions(fontOptions(appearance));
  editor.getModel()?.updateOptions(indentOptions(appearance));
}

/**
 * 三处代码编辑面（请求体 raw / 脚本 / 响应正文）的统一 Monaco 薄壳。
 *
 * `monacoEnv`（重量级：worker / 语言贡献 / Monaco 本体）**只经动态 import 触达**，
 * 静态引入会把 Monaco 拉进启动模块图——这是本组件刻意不说 `import ... from
 * '../lib/monacoEnv'` 的原因。模型一律用 `file://` URI（见 `monacoEnv.ts`）。
 *
 * 测试分层（design 决策 8）：happy-dom 下本组件被 `vi.mock` 换成保形 mock，
 * 因此这里的分支/时序只对真实浏览器（`tests-browser`）负责。
 */
export function CodeSurface(props: CodeSurfaceProps) {
  const {
    uri,
    value,
    language,
    readOnly = false,
    ariaLabel,
    testId,
    placeholder,
    height,
    fill = false,
    enableCompletion = false,
  } = props;

  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);

  // 回调与「建编辑器时要读的」可变 prop 走 ref：避免把它们纳入依赖而重建编辑器，
  // 也避免异步创建完成时读到旧值。
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  const liveRef = useRef({ language, readOnly, ariaLabel, placeholder, enableCompletion });
  liveRef.current = { language, readOnly, ariaLabel, placeholder, enableCompletion };

  useEffect(() => {
    let cancelled = false;
    let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
    let model: Monaco.editor.ITextModel | null = null;
    let sub: Monaco.IDisposable | null = null;

    void import('../lib/monacoEnv').then(async (env) => {
      const monaco = await env.loadMonaco();
      if (cancelled || !hostRef.current) return;
      monacoRef.current = monaco;

      const modelUri = monaco.Uri.parse(uri);
      model =
        monaco.editor.getModel(modelUri) ??
        monaco.editor.createModel(value, liveRef.current.language, modelUri);
      if (model.getValue() !== value) model.setValue(value);

      // 读「此刻」的外观：编辑器是懒加载的，首次创建可能已经晚于用户改过设置
      const appearance = currentEditorAppearance();

      editor = monaco.editor.create(hostRef.current, {
        model,
        theme: env.THEME_NAME,
        readOnly: liveRef.current.readOnly,
        automaticLayout: true,
        // 不开 fixedOverflowWidgets：它会把浮层坐标系从「编辑器内绝对定位」改成
        //「页面 fixed」，补全详情面板（overlay 浮层）会因此错位到编辑器上方。
        // 裁切问题改在 CSS 侧解决——`.code-surface` 不设 overflow:hidden，
        // 浮层本就该溢出编辑器显示（见 App.css 该段注释）。
        minimap: { enabled: false },
        ...fontOptions(appearance),
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        renderLineHighlight: liveRef.current.readOnly ? 'none' : 'line',
        overviewRulerLanes: 0,
        folding: true,
        ...indentOptions(appearance),
        ariaLabel: liveRef.current.ariaLabel,
        placeholder: liveRef.current.placeholder,
        padding: { top: 8, bottom: 8 },
      });
      editorRef.current = editor;
      // 创建是异步的：这期间外观可能又变过一次，以此刻的值收口（同一入口，不重建编辑器）
      applyAppearance(editor, currentEditorAppearance());

      sub = model.onDidChangeContent(() => {
        if (model) onChangeRef.current?.(model.getValue());
      });

      if (
        liveRef.current.enableCompletion &&
        !liveRef.current.readOnly &&
        liveRef.current.language === 'javascript'
      ) {
        void env.warmupJavaScript(monaco);
      }
    });

    return () => {
      cancelled = true;
      sub?.dispose();
      editor?.dispose();
      model?.dispose();
      editorRef.current = null;
      monacoRef.current = null;
    };
    // uri 稳定 => 每个编辑面只创建一次（StrictMode 的双挂载由 cancelled 兜住）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri]);

  // 受控 value 同步：外部改动（Beautify / 相位切换 / 新响应）写回模型；键入时两者相等、不动作
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model && model.getValue() !== value) model.setValue(value);
  }, [value]);

  // 语言切换（body 语言下拉 / 响应内容类型变化）
  useEffect(() => {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (monaco && model && model.getLanguageId() !== language) {
      monaco.editor.setModelLanguage(model, language);
    }
  }, [language]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  useEffect(() => {
    editorRef.current?.updateOptions({ ariaLabel });
  }, [ariaLabel]);

  // 外观改动即时作用于**当前已打开**的编辑面：只改选项，SHALL NOT 重建编辑器——
  // 重建会丢滚动位置与折叠状态，而 spec 明确要求外观改动不重置查看状态。
  // （创建路径自己会读当前外观，因此这里不必先 apply 一次。）
  useEffect(
    () =>
      subscribeEditorAppearance((appearance) => {
        const editor = editorRef.current;
        if (editor) applyAppearance(editor, appearance);
      }),
    [],
  );

  return (
    <div
      className={`code-surface${fill ? ' fill' : ''}`}
      ref={hostRef}
      data-testid={testId}
      style={
        fill || height === undefined
          ? undefined
          : { height: typeof height === 'number' ? `${height}px` : height }
      }
    />
  );
}
