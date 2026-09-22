import { useCallback, useEffect, useState } from 'react';
import { describeError } from '../lib/commands';
import { SURFACE_PRIORITY, type EditingRegistry } from '../lib/editing';
import {
  DEFAULT_PRESENTATION,
  readPresentation,
  writePresentation,
  type FormatDetection,
  type ResponsePresentation,
} from '../lib/responsePresentation';
import {
  DEFAULT_EDITOR_APPEARANCE,
  FONT_SIZE_RANGE,
  INDENT_COUNT_RANGE,
  applyEditorAppearance,
  readEditorAppearance,
  writeEditorAppearance,
  type IndentType,
} from '../lib/editorAppearance';
import { INDENT_WIDTHS, type IndentWidth } from '../lib/sandbox';
import {
  DEFAULT_APP_TIMEOUT,
  DEFAULT_REQUEST_LIMITS,
  THRESHOLD_CHOICES_MB,
  appTimeoutFromMs,
  readRequestPreferences,
  timeoutMsOf,
  writeRequestPreferences,
  type AppTimeout,
  type RequestLimits,
} from '../lib/requestPreferences';
import type { ProxyConfig } from '../lib/types';
import { Dropdown } from './Dropdown';
import { ProxyConfigRows } from './ProxyConfigRows';
import {
  readSendRequestPolicyRaw,
  writeSendRequestPolicy,
  type SendRequestPolicy,
} from '../lib/scriptRuntime';

/**
 * 数值 + 单位同框（spec: ui-layout「设置模态的请求配置」）。
 *
 * 单位贴在数字右边，而不是写进名称里：`[ 30000 | ms ]` 比「超时（毫秒）」再加一整行
 * 输入少占一行，用户也不必把单位心算进值里。只接受非负整数——0 的含义由上层赋予
 * （请求这一节里 0 表示不限制）。
 */
function NumberUnit(props: {
  label: string;
  unit: string;
  value: number;
  testId: string;
  /** 允许的最小值：超时传 0（0 表示不限制），没有这一档的项传 1。 */
  min?: number;
  /** 允许的最大值；不传即只有下界（超时与体积上限没有上界）。 */
  max?: number;
  onChange: (value: number) => void;
}) {
  const min = props.min ?? 0;
  const max = props.max ?? Number.POSITIVE_INFINITY;

  return (
    <div className="unit-field">
      <input
        type="number"
        min={min}
        max={Number.isFinite(max) ? max : undefined}
        step={1}
        aria-label={props.label}
        data-testid={props.testId}
        value={props.value}
        onChange={(event) => {
          const parsed = Number.parseInt(event.target.value, 10);
          // 只收区间内的整数：区间外的输入不进状态，受控输入会把那一下抹掉
          if (Number.isFinite(parsed) && parsed >= min && parsed <= max) props.onChange(parsed);
        }}
      />
      <span className="unit">{props.unit}</span>
    </div>
  );
}
import { useEditingSurface } from '../lib/useEditing';

export interface SettingsPanelProps {
  client: Parameters<typeof readSendRequestPolicyRaw>[0];
  /** 编辑面注册表：Ctrl+S 与未保存守卫据此找到这一面。 */
  editing?: EditingRegistry;
  /** 响应呈现配置的当前值（App 持有，改动后立即作用于之后的响应呈现）。 */
  presentation?: ResponsePresentation;
  onPresentationChange?: (value: ResponsePresentation) => void;
}

/** 改动停止后自动落库的延迟（spec: 脚本的编辑与保存对设置面同样适用）。 */
const SETTINGS_AUTOSAVE_DELAY_MS = 500;

/**
 * 应用设置。目前只有一项：`pm.sendRequest` 的目标策略。
 *
 * 这一项之所以要有界面，是因为它是**安全相关**的设置：默认与 Postman 一致、不限制
 * 目标地址，用户必须能主动收紧，也必须能看出当前是松是紧。
 *
 * 这里**没有保存按钮**：改动停止后自动落库，落库成功后基线前移，脏判据自然为假。
 */
export function SettingsPanel({
  client,
  editing,
  presentation = DEFAULT_PRESENTATION,
  onPresentationChange,
}: SettingsPanelProps) {
  const [mode, setMode] = useState<'allow' | 'deny'>('allow');
  const [hosts, setHosts] = useState('');
  /** null = 未配置（不限制）；字符串 = 已配置的原始值。 */
  const [raw, setRaw] = useState<string | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 响应呈现配置（spec: ui-layout「设置模态的响应呈现配置」）。 */
  const [formatDetection, setFormatDetection] = useState<FormatDetection>(
    presentation.formatDetection,
  );
  const [indentWidth, setIndentWidth] = useState<IndentWidth>(presentation.indentWidth);
  /** 请求类偏好（spec: ui-layout「设置模态的请求配置」）。 */
  const [appTimeout, setAppTimeout] = useState<AppTimeout>(DEFAULT_APP_TIMEOUT);
  const [limits, setLimits] = useState<RequestLimits>(DEFAULT_REQUEST_LIMITS);
  /** 全局代理（三级代理的最低层）；`null` = 未配置。 */
  const [proxy, setProxy] = useState<ProxyConfig | null>(null);
  /** 编辑器外观（spec: code-editors「编辑器外观可配置」）：四项一起落库、一起生效。 */
  const [fontFamily, setFontFamily] = useState(DEFAULT_EDITOR_APPEARANCE.fontFamily);
  const [fontSize, setFontSize] = useState(DEFAULT_EDITOR_APPEARANCE.fontSize);
  const [indentCount, setIndentCount] = useState(DEFAULT_EDITOR_APPEARANCE.indentCount);
  const [indentType, setIndentType] = useState<IndentType>(DEFAULT_EDITOR_APPEARANCE.indentType);
  /** 读回来的基线：未保存守卫据此判断草稿有没有偏离已配置的值。 */
  const [baseline, setBaseline] = useState({
    mode: 'allow' as 'allow' | 'deny',
    hosts: '',
    formatDetection: presentation.formatDetection as FormatDetection,
    indentWidth: presentation.indentWidth as IndentWidth,
    appTimeout: DEFAULT_APP_TIMEOUT as AppTimeout,
    limits: DEFAULT_REQUEST_LIMITS as RequestLimits,
    fontFamily: DEFAULT_EDITOR_APPEARANCE.fontFamily,
    fontSize: DEFAULT_EDITOR_APPEARANCE.fontSize,
    indentCount: DEFAULT_EDITOR_APPEARANCE.indentCount,
    indentType: DEFAULT_EDITOR_APPEARANCE.indentType,
    proxy: null as ProxyConfig | null,
  });

  const load = useCallback(async () => {
    try {
      const [value, storedPresentation, preferences, storedProxy, storedAppearance] =
        await Promise.all([
          readSendRequestPolicyRaw(client),
          readPresentation(client),
          readRequestPreferences(client),
          client.globalProxyGet(),
          readEditorAppearance(client),
        ]);

      setRaw(value);
      setUnreadable(false);

      let nextMode: 'allow' | 'deny' = 'allow';
      let nextHosts = '';

      if (value) {
        try {
          const parsed = JSON.parse(value) as SendRequestPolicy;

          nextMode = parsed?.mode === 'deny' ? 'deny' : 'allow';
          nextHosts = (parsed?.hosts ?? []).join('\n');
        } catch {
          // 存进去的东西读不懂：保持输入框为空，并明确告诉用户，而不是假装没配置
          setUnreadable(true);
        }
      }

      setMode(nextMode);
      setHosts(nextHosts);
      setFormatDetection(storedPresentation.formatDetection);
      setIndentWidth(storedPresentation.indentWidth);
      setAppTimeout(preferences.timeout);
      setLimits(preferences.limits);
      setProxy(storedProxy);
      setFontFamily(storedAppearance.fontFamily);
      setFontSize(storedAppearance.fontSize);
      setIndentCount(storedAppearance.indentCount);
      setIndentType(storedAppearance.indentType);
      setBaseline({
        mode: nextMode,
        hosts: nextHosts,
        formatDetection: storedPresentation.formatDetection,
        indentWidth: storedPresentation.indentWidth,
        appTimeout: preferences.timeout,
        limits: preferences.limits,
        fontFamily: storedAppearance.fontFamily,
        fontSize: storedAppearance.fontSize,
        indentCount: storedAppearance.indentCount,
        indentType: storedAppearance.indentType,
        proxy: storedProxy,
      });
      // 读回来的值即应用当前生效的值，同步给 App
      onPresentationChange?.(storedPresentation);
      setError(null);
    } catch (caught) {
      setError(describeError(caught).message);
    }
    // onPresentationChange 只在 App 内定义一次；纳入依赖不会造成额外读取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<boolean> => {
    const list = hosts
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);

    setError(null);
    try {
      await writeSendRequestPolicy(client, { mode, hosts: list });
      const nextPresentation = { formatDetection, indentWidth };
      await writePresentation(client, nextPresentation);
      // 请求类偏好与全局代理也立即落库并作用于之后的请求；代理凭据的加密在命令层完成
      await writeRequestPreferences(client, { timeout: appTimeout, limits });
      await client.globalProxySet(proxy);
      // 外观四项一起落库；写库之外还要把值推给**当前已打开**的编辑面与等宽 CSS 面
      const nextAppearance = { fontFamily, fontSize, indentCount, indentType };
      await writeEditorAppearance(client, nextAppearance);
      // 改动立即作用于之后的响应呈现，不需要重启（spec: ui-layout 配置生效）
      onPresentationChange?.(nextPresentation);
      applyEditorAppearance(nextAppearance);
      await load();
      return true;
    } catch (caught) {
      setError(describeError(caught).message);
      return false;
    }
  };

  // 结构化的三项按整份比较：它们没有更细的判据可用（这也让「改了又改回去」不算脏）
  const dirty = () =>
    mode !== baseline.mode ||
    hosts !== baseline.hosts ||
    formatDetection !== baseline.formatDetection ||
    indentWidth !== baseline.indentWidth ||
    JSON.stringify(appTimeout) !== JSON.stringify(baseline.appTimeout) ||
    JSON.stringify(limits) !== JSON.stringify(baseline.limits) ||
    fontFamily !== baseline.fontFamily ||
    fontSize !== baseline.fontSize ||
    indentCount !== baseline.indentCount ||
    indentType !== baseline.indentType ||
    JSON.stringify(proxy) !== JSON.stringify(baseline.proxy);

  // 编辑即自动保存（spec: 脚本的编辑与保存）：改动停止后落库。
  // 失败时基线不前移，因此这里会随下一次键入再次排期；退出/关模态时守卫也会拦。
  useEffect(() => {
    if (!dirty()) return;
    const timer = window.setTimeout(() => {
      void save();
    }, SETTINGS_AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
    // save 每次渲染都是新函数，进依赖会让定时器永远重排；脏判据已由上面的 state 表达
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mode,
    hosts,
    formatDetection,
    indentWidth,
    appTimeout,
    limits,
    fontFamily,
    fontSize,
    indentCount,
    indentType,
    proxy,
    baseline,
  ]);

  useEditingSurface(editing, {
    id: 'settings-policy',
    priority: SURFACE_PRIORITY.modal,
    label: '脚本目标策略',
    isDirty: dirty,
    save,
  });

  const reset = async () => {
    await writeSendRequestPolicy(client, null);
    setHosts('');
    await load();
  };

  return (
    <div className="stack" data-testid="settings-panel">
      {/* 编辑器外观（spec: code-editors「编辑器外观可配置」）：字体与字号作用于所有等宽
          表面（三处编辑面 + 纯文本降级 / Hex / 二进制 / cURL 文本域），缩进数与缩进类型只
          作用于代码编辑面。与「响应」一节里的「格式化缩进宽度」是两个独立设置，因此这一节
          不解释两者的关系，各自只写自己的口径。 */}
      <section className="settings-section" data-testid="editor-appearance">
        <h4>编辑器</h4>

        <div className="settings-row">
          <span className="settings-name">字体</span>
          <input
            className="field-wide"
            aria-label="字体"
            data-testid="editor-font-family"
            // 示例收进 placeholder（spec: 语义落在操作上）：空着即用这条缺省栈
            placeholder={DEFAULT_EDITOR_APPEARANCE.fontFamily}
            value={fontFamily}
            onChange={(event) => setFontFamily(event.target.value)}
          />
        </div>

        <div className="settings-row">
          <span className="settings-name">字号</span>
          <NumberUnit
            label="字号"
            unit="px"
            testId="editor-font-size"
            min={FONT_SIZE_RANGE.min}
            max={FONT_SIZE_RANGE.max}
            value={fontSize}
            onChange={setFontSize}
          />
        </div>

        <div className="settings-row">
          <span className="settings-name">缩进数</span>
          <input
            className="field-narrow"
            type="number"
            min={INDENT_COUNT_RANGE.min}
            max={INDENT_COUNT_RANGE.max}
            step={1}
            aria-label="缩进数"
            data-testid="editor-indent-count"
            value={indentCount}
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10);
              // 同 NumberUnit：区间外的输入不进状态，受控输入把那一下抹掉
              if (parsed >= INDENT_COUNT_RANGE.min && parsed <= INDENT_COUNT_RANGE.max) {
                setIndentCount(parsed);
              }
            }}
          />
        </div>

        <div className="settings-row">
          <span className="settings-name">缩进类型</span>
          <Dropdown
            label="缩进类型"
            testId="editor-indent-type"
            align="right"
            value={indentType}
            options={[
              { value: 'space', label: '空格' },
              { value: 'tab', label: 'Tab' },
            ]}
            onChange={(value) => setIndentType(value === 'tab' ? 'tab' : 'space')}
          />
        </div>
      </section>

      {/* 请求类偏好（spec: ui-layout「设置模态的请求配置」）：改动后立即作用于之后的请求。
          行形态抄 Postman——数值与单位同框，因此不必再写一行「超时（毫秒）」；0 表示
          不限制，提示只说这一句（不写「想怎样就怎样」的长句）。 */}
      <section className="settings-section">
        <h4>请求</h4>

        <div className="settings-row stacked">
          <div className="settings-row-main">
            <span className="settings-name">超时</span>
            <NumberUnit
              label="全局超时"
              unit="ms"
              testId="global-timeout"
              value={timeoutMsOf(appTimeout)}
              onChange={(ms) => setAppTimeout(appTimeoutFromMs(ms))}
            />
          </div>
          <p className="settings-hint muted">0 代表不限制</p>
        </div>

        {/* 体积上限没有「不限制」：0 会让整份正文进内存（`大响应保护` 要求上限存在），
            因此这一行不写那句提示，控件也不接受 0。 */}
        <div className="settings-row">
          <span className="settings-name">响应体积上限</span>
          <NumberUnit
            label="响应体积上限"
            unit="MB"
            testId="size-limit"
            min={1}
            value={limits.sizeLimitMb}
            onChange={(mb) => setLimits({ ...limits, sizeLimitMb: mb })}
          />
        </div>

        {/* 超过上限的阈值档位不可能生效，因此不可选——由控件自身的可选状态表达，
            不写解释（spec: ui-layout「语义落在操作上」）。上限为「不限制」时没有越界的档位。 */}
        <div className="settings-row">
          <span className="settings-name">格式化阈值</span>
          <Dropdown
            label="格式化阈值"
            testId="pretty-threshold"
            align="right"
            value={String(limits.prettyThresholdMb)}
            options={THRESHOLD_CHOICES_MB.map((mb) => ({
              value: String(mb),
              label: `${mb} MB`,
              disabled: limits.sizeLimitMb > 0 && mb > limits.sizeLimitMb,
            }))}
            onChange={(value) =>
              setLimits({ ...limits, prettyThresholdMb: Number(value) })
            }
          />
        </div>
      </section>

      {/* 响应呈现配置（spec: ui-layout「设置模态的响应呈现配置」）：应用级偏好，
          改动后立即作用于之后的响应呈现。 */}
      <section className="settings-section">
        <h4>响应</h4>

        <div className="settings-row">
          <span className="settings-name">响应格式检测</span>
          <Dropdown
            label="响应格式检测"
            testId="format-detection"
            align="right"
            value={formatDetection}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'json', label: 'JSON' },
            ]}
            onChange={(value) => setFormatDetection(value === 'json' ? 'json' : 'auto')}
          />
        </div>

        <div className="settings-row">
          <span className="settings-name">格式化缩进宽度</span>
          <Dropdown
            label="格式化缩进宽度"
            testId="indent-width"
            align="right"
            value={String(indentWidth)}
            options={INDENT_WIDTHS.map((width) => ({
              value: String(width),
              label: `${width} 空格`,
            }))}
            onChange={(value) => {
              const width = INDENT_WIDTHS.find((candidate) => String(candidate) === value);
              if (width) setIndentWidth(width);
            }}
          />
        </div>
      </section>

      {/* 全局代理（三级代理的最低层）：环境级代理落在环境自身的编辑面、请求级沿用请求
          编辑器的 Settings 标签，三层不挤在同一屏（spec: 设置模态的代理配置）。 */}
      <section className="settings-section">
        <h4>代理</h4>
        <ProxyConfigRows
          proxy={proxy}
          onChange={setProxy}
          allowInherit={false}
          idPrefix="global"
          name="代理"
        />
      </section>

      {/* 脚本目标策略（`pm.sendRequest` 的目标策略）：安全相关，默认与 Postman 一致、
          不限制目标，用户必须能主动收紧。放在最后一节——它只在写脚本时才用得上。 */}
      <section className="settings-section">
        <h4>脚本目标策略</h4>

        <div className="settings-row">
          <span className="settings-name">状态</span>
          <span className="muted settings-control" data-testid="policy-state">
            {raw ? (unreadable ? '已配置（无法解析）' : '已配置') : '未配置'}
          </span>
        </div>

        <div className="settings-row">
          <span className="settings-name">策略模式</span>
          <Dropdown
            label="策略模式"
            testId="policy-mode"
            align="right"
            value={mode}
            options={[
              { value: 'allow', label: '只允许名单内' },
              { value: 'deny', label: '只拒绝名单内' },
            ]}
            onChange={(value) => setMode(value === 'deny' ? 'deny' : 'allow')}
          />
        </div>

        <div className="settings-row stacked">
          <label className="settings-name" htmlFor="policy-hosts">
            主机名单
          </label>
          <textarea
            id="policy-hosts"
            aria-label="主机名单"
            placeholder="api.test"
            rows={4}
            value={hosts}
            onChange={(event) => setHosts(event.target.value)}
          />
        </div>

        <div className="settings-row actions">
          <button
            className="ghost"
            onClick={() => {
              void reset();
            }}
          >
            恢复为不限制
          </button>
        </div>
      </section>

      {error && (
        <div className="notice danger" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
