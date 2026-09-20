import { Fragment, useRef, useState, type FocusEvent, type ReactNode, type RefObject } from 'react';
import { formatRawBody, type RawFormatMode } from '../lib/editing';
import { isEmptyFormField, isEmptyKeyValue } from '../lib/rows';
import { withParams, withUrl } from '../lib/url';
import { Dropdown } from './Dropdown';
import { CurlPanel, useCurlSnapshot } from './CurlSnapshot';
import { ScriptPane } from './ScriptPane';
import { CodeSurface } from './CodeSurface';
import { monacoLanguage } from '../lib/codeSurface';
import type {
  ApiKeyLocation,
  AuthKind,
  BodyKind,
  CurlCommand,
  HttpVersion,
  KeyValue,
  PickedFile,
  ProxyConfig,
  ProxyMode,
  RawLanguage,
  SavedRequest,
} from '../lib/types';

/** 请求编辑器的内层标签。`App` 直接复用它（容器侧不再另立一份同义声明）。 */
export type Tab = 'params' | 'headers' | 'body' | 'auth' | 'scripts' | 'settings' | 'curl';

export interface RequestBandProps {
  draft: SavedRequest;
  busy: boolean;
  onChange: (next: SavedRequest) => void;
  onSend: () => void;
  /** 请求面板头（spec: 请求面板头的身份）——请求身份落在这里，请求级操作不在这里。 */
  collectionName: string | null;
  dirty: boolean;
  /** 面板头里的请求名输入框：树菜单的「重命名」把焦点交给它。 */
  nameRef?: RefObject<HTMLInputElement | null>;
}

export interface RequestEditorProps {
  draft: SavedRequest;
  tab: Tab;
  onTab: (tab: Tab) => void;
  onChange: (next: SavedRequest) => void;
  /** 生成当前请求的 curl 快照（spec: cURL 快照标签）。 */
  onCurl: () => Promise<CurlCommand>;
  /**
   * 请求体文件的选取出口（spec: 请求体文件的选取）：拉起系统对话框，返回
   * 一次性句柄与文件名；用户取消时返回 null。由宿主注入（App 接
   * `client.pickUploadFile()`，与 `onCurl` 同款注入模式），组件不直连命令层。
   */
  onPickFile?: () => Promise<PickedFile | null>;
}

/** 请求标签的顺序与文案对齐 Postman（spec: 请求标签命名）；cURL 排在 Settings 右侧。 */
const TABS: { value: Tab; label: string }[] = [
  { value: 'params', label: 'Params' },
  { value: 'auth', label: 'Authorization' },
  { value: 'headers', label: 'Headers' },
  { value: 'body', label: 'Body' },
  { value: 'scripts', label: 'Scripts' },
  { value: 'settings', label: 'Settings' },
  { value: 'curl', label: 'cURL' },
];

/**
 * URL 里的 `{{var}}` 着色片段。原生 input 无法局部着色，因此文本由
 * 同字体的叠层渲染、输入框自身文字透明（见 App.css `.url-field`）。
 */
function highlightUrl(url: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /\{\{[^{}]*\}\}/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(url)) !== null) {
    if (match.index > last) parts.push(url.slice(last, match.index));
    parts.push(
      <span className="var" key={`${match.index}-${match[0]}`}>
        {match[0]}
      </span>,
    );
    last = match.index + match[0].length;
  }

  if (last < url.length) parts.push(url.slice(last));
  return parts;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const RAW_LANGUAGES: RawLanguage[] = ['json', 'xml', 'html', 'text', 'javascript'];
/** 请求体类型的顺序与文案（spec: 请求体类型的选择行）——英文小写，与内层标签命名一致。 */
const BODY_KINDS: { value: BodyKind; label: string }[] = [
  { value: 'none', label: 'none' },
  { value: 'form_data', label: 'form-data' },
  { value: 'url_encoded', label: 'x-www-form-urlencoded' },
  { value: 'raw', label: 'raw' },
  { value: 'binary', label: 'binary' },
];
const AUTH_KINDS: AuthKind[] = ['none', 'inherit', 'basic', 'bearer', 'api_key'];

/** 幽灵行的空内容：只在视图层流转，用户没写出东西就不会进模型。 */
const EMPTY_ROW: KeyValue = { key: '', value: '', enabled: true };

/**
 * 键值表：表体末尾常驻一个可输入的「幽灵行」，不再有「+ 添加一行」按钮。
 *
 * 幽灵行的内容在这两种形态之间切换：
 * - `owned === null`：纯粹的空行，内容只存在本地 `pending`，模型里没有这一行；
 * - 一旦写出任何内容，它立刻物化进模型（`owned` 指向那一行）——因此发送、
 *   保存、预览永远看得到用户已经写出的东西，不会因为「还没失焦」而丢。
 *
 * 行身份刻意保持稳定：物化时只在末尾追加，渲染上「幽灵行始终是最后一个元素」，
 * 因此物化前后不会移动正在输入的那个 input，中文输入法不会被打断。
 * 焦点离开整行（或按回车）时才把幽灵行交还给空态。
 */
function KeyValueTable({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  rows: KeyValue[];
  onChange: (rows: KeyValue[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  const [pending, setPending] = useState<KeyValue>(EMPTY_ROW);
  const [ownedIndex, setOwnedIndex] = useState<number | null>(null);
  const ghostKeyRef = useRef<HTMLInputElement>(null);

  const owned = ownedIndex !== null && ownedIndex < rows.length ? ownedIndex : null;
  const ghost = owned === null ? pending : rows[owned];

  const update = (index: number, patch: Partial<KeyValue>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const editGhost = (patch: Partial<KeyValue>) => {
    if (owned === null) {
      const next = { ...pending, ...patch };
      if (isEmptyKeyValue(next)) {
        setPending(next);
        return;
      }
      setPending(EMPTY_ROW);
      setOwnedIndex(rows.length);
      onChange([...rows, next]);
      return;
    }
    update(owned, patch);
  };

  /** 离开幽灵行：内容留在模型里，幽灵行回到空态；什么都没写就把它摘掉。 */
  const releaseGhost = () => {
    if (owned === null) return;
    const current = rows[owned];
    setOwnedIndex(null);
    setPending(EMPTY_ROW);
    if (isEmptyKeyValue(current)) onChange(rows.filter((_, index) => index !== owned));
  };

  const leaveGhost = (event: FocusEvent<HTMLInputElement>) => {
    // 在幽灵行内部换焦点（名称 → 值）不算离开
    const row = event.currentTarget.closest('tr');
    if (row?.contains(event.relatedTarget as Node | null)) return;
    releaseGhost();
  };

  const submitGhost = () => {
    releaseGhost();
    ghostKeyRef.current?.focus();
  };

  return (
    /* 满高滚动容器（spec: 请求编辑器正文区的满高与区域内滚动）：容器占满正文区
       剩余高度，行多时在容器内滚动，表头吸顶（见 App.css 的 .table-scroll）。 */
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th className="col-check" />
            <th>名称</th>
            <th>值</th>
            <th className="col-desc">描述</th>
            <th className="col-check" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) =>
            index === owned ? null : (
              <tr key={index}>
                <td>
                  <input
                    className="checkbox"
                    type="checkbox"
                    aria-label={`启用 ${keyPlaceholder} ${index}`}
                    checked={row.enabled}
                    onChange={(event) => update(index, { enabled: event.target.checked })}
                  />
                </td>
                <td>
                  <input
                    value={row.key}
                    placeholder={keyPlaceholder}
                    aria-label={`${keyPlaceholder} ${index}`}
                    onChange={(event) => update(index, { key: event.target.value })}
                  />
                </td>
                <td>
                  <input
                    value={row.value}
                    placeholder={valuePlaceholder}
                    aria-label={`${valuePlaceholder} ${index}`}
                    onChange={(event) => update(index, { value: event.target.value })}
                  />
                </td>
                {/* 描述列：人类可读说明。它不参与「是否发出」（见 lib/rows.ts 的两档
                    判定），但会被保留、并随请求持久化与导入导出往返。 */}
                <td>
                  <input
                    value={row.description ?? ''}
                    placeholder="描述"
                    aria-label={`描述 ${index}`}
                    onChange={(event) =>
                      update(index, { description: event.target.value === '' ? null : event.target.value })
                    }
                  />
                </td>
                <td>
                  <button
                    className="ghost row-delete"
                    aria-label="删除该行"
                    onClick={() => onChange(rows.filter((_, i) => i !== index))}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ),
          )}
          <tr className="ghost-row">
            <td />
            <td>
              <input
                ref={ghostKeyRef}
                value={ghost.key}
                placeholder={keyPlaceholder}
                aria-label="新增行的名称"
                onChange={(event) => editGhost({ key: event.target.value })}
                onBlur={leaveGhost}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  submitGhost();
                }}
              />
            </td>
            <td>
              <input
                value={ghost.value}
                placeholder={valuePlaceholder}
                aria-label="新增行的值"
                onChange={(event) => editGhost({ value: event.target.value })}
                onBlur={leaveGhost}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  submitGhost();
                }}
              />
            </td>
            <td>
              <input
                value={ghost.description ?? ''}
                placeholder="描述"
                aria-label="新增行的描述"
                onChange={(event) =>
                  editGhost({ description: event.target.value === '' ? null : event.target.value })
                }
                onBlur={leaveGhost}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  submitGhost();
                }}
              />
            </td>
            <td />
          </tr>
          {/* 正在编辑（owned 已置位）时，紧邻下方再铺一行空白：键入第一个字符后
           * editGhost 已把内容提交成真实行、owned 置位，这一行随之出现，对齐
           * Postman「在空白行键入就自动新增一行」——不必等失焦。这行是视觉占位 /
           * 快速跳板：点进去会先把当前行落定、再把焦点交回底部空白行。它不占用
           * ghost 的 aria-label，否则测试按 label 会取到两个元素。 */}
          {owned !== null && (
            <tr className="ghost-row">
              <td />
              <td>
                <input
                  placeholder={keyPlaceholder}
                  aria-label="下一行的名称"
                  onFocus={() => {
                    releaseGhost();
                    ghostKeyRef.current?.focus();
                  }}
                  onChange={(event) => editGhost({ key: event.target.value })}
                />
              </td>
              <td>
                <input
                  placeholder={valuePlaceholder}
                  aria-label="下一行的值"
                  onFocus={() => {
                    releaseGhost();
                    ghostKeyRef.current?.focus();
                  }}
                  onChange={(event) => editGhost({ value: event.target.value })}
                />
              </td>
              <td>
                <input
                  placeholder="描述"
                  aria-label="下一行的描述"
                  onFocus={() => {
                    releaseGhost();
                    ghostKeyRef.current?.focus();
                  }}
                  onChange={(event) => editGhost({ description: event.target.value || null })}
                />
              </td>
              <td />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 通栏请求带（spec: 请求面板头的身份 / 地址栏）：请求身份行 + 地址栏。它由主区作为独立
 * 网格项渲染、横跨整宽，位于左右分栏之上，因此地址栏不再被分栏切成半宽。
 *
 * 请求级操作都不在这里：复制与删除落在集合树的节点菜单（spec: 集合树的操作入口默认隐藏），
 * cURL 落在请求编辑器的标签里（spec: cURL 快照标签），保存由 `Ctrl+S` 承担。
 */
export function RequestBand(props: RequestBandProps) {
  const { draft, busy, onChange, onSend, collectionName, dirty, nameRef } = props;
  const patch = (next: Partial<SavedRequest>) => onChange({ ...draft, ...next });

  return (
    <div className="request-band">
      {/* 请求面板头（spec: 请求面板头的身份）：所属集合面包屑 + 可就地编辑的请求名。
          身份随请求区一同出现与消失，不再占用会话标签行；方法由紧邻其下的地址栏选择框
          承载，这里 SHALL NOT 重复方法徽标。 */}
      <div className="request-pane-header" data-testid="request-panel-header">
        {collectionName && (
          <>
            <span className="crumb">{collectionName}</span>
            <span className="crumb-sep">›</span>
          </>
        )}
        <input
          ref={nameRef}
          className="crumb-name request-name"
          aria-label="请求名称"
          value={draft.name}
          onChange={(event) => patch({ name: event.target.value })}
        />
        <span className="grow" />
        {/* 关闭证书校验的显著标识（spec: 请求级网络设置）：一个标记，不是一句解释 */}
        {!draft.settings.verify_tls && (
          <span
            className="badge danger"
            data-testid="insecure-request"
            title="证书校验已关闭"
          >
            证书未校验
          </span>
        )}
        {/* 未保存标记是这一行唯一的"还没存下"信号：保存入口已不存在，等价的键盘操作
            写在提示里，否则用户无从知道怎么保存。 */}
        {dirty && (
          <span className="badge warn" title="保存（Ctrl+S）">
            未保存
          </span>
        )}
      </div>

      <div className="request-toolbar">
        <select
          className="method-select"
          aria-label="请求方法"
          data-method={draft.method}
          value={draft.method}
          onChange={(event) => patch({ method: event.target.value })}
        >
          {METHODS.map((method) => (
            <option key={method} value={method}>
              {method}
            </option>
          ))}
          {!METHODS.includes(draft.method) && (
            <option value={draft.method}>{draft.method}</option>
          )}
        </select>

        <div className="url-field">
          <div className="url-overlay mono" aria-hidden="true">
            {highlightUrl(draft.url)}
          </div>
          {/* 地址栏是查询串的权威：改动即拆进参数表（spec: URL 与参数表保持同步） */}
          <input
            className="url-input mono"
            aria-label="请求地址"
            placeholder="https://api.example.com/users/:id"
            value={draft.url}
            onChange={(event) => onChange(withUrl(draft, event.target.value))}
          />
        </div>

        <button className="primary" onClick={onSend} disabled={busy}>
          发送
        </button>
      </div>
    </div>
  );
}

/**
 * 请求区的列内容：内层标签与正文。请求带（身份与地址栏）已抬到主区顶部，
 * 不再属于这里——本组件只负责分栏以下的那一列。
 */
export function RequestEditor({ draft, tab, onTab, onChange, onCurl, onPickFile }: RequestEditorProps) {
  const patch = (next: Partial<SavedRequest>) => onChange({ ...draft, ...next });

  /** binary 的文件选取：取消对话框时无副作用（spec: 请求体文件的选取）。 */
  const pickBinary = async () => {
    if (!onPickFile) return;
    const picked = await onPickFile();
    if (!picked) return;
    patch({ body: { ...draft.body, binary: { file_handle: picked.handle, description: picked.name } } });
  };

  /**
   * cURL 快照（spec: cURL 快照标签）：停在该标签时按当前请求生成；离开标签即清空，
   * 编辑不跨标签留存；换了请求同样重新生成（`draft.id` 参与触发）。
   */
  const curl = useCurlSnapshot(onCurl, tab === 'curl', draft.id);

  /**
   * Minify / Beautify 的失败原因（spec: raw 正文的格式化动作）。
   *
   * 失败时不改动正文，只把原因摆在正文旁；一旦正文被改动，这条提示就过期了，
   * 因此在写入正文的两处（动作成功 / 用户键入）都清掉它。
   */
  const [formatError, setFormatError] = useState<string | null>(null);

  /** 当前正文是不是「可以被格式化」的那一档：raw 且语言为 JSON。 */
  const isRawJson = draft.body.kind === 'raw' && (draft.body.raw_language ?? 'json') === 'json';
  const rawEmpty = (draft.body.raw ?? '').trim() === '';

  const applyFormat = (mode: RawFormatMode) => {
    try {
      patch({ body: { ...draft.body, raw: formatRawBody(draft.body.raw ?? '', mode) } });
      setFormatError(null);
    } catch (caught) {
      setFormatError(caught instanceof Error ? caught.message : '正文不是合法的 JSON');
    }
  };

  /** 切换请求体类型：清掉其它类型的残留内容（既有行为，与控件形态无关）。 */
  const patchBodyKind = (kind: BodyKind) => {
    patch({
      body: {
        ...draft.body,
        kind,
        raw: kind === 'raw' ? draft.body.raw : null,
        form: kind === 'form_data' ? draft.body.form : [],
        urlencoded: kind === 'url_encoded' ? draft.body.urlencoded : [],
      },
    });
  };

  return (
    <div className="request-editor">
      <div className="tabs request-tabs">
        {TABS.map((entry) => (
          <button
            key={entry.value}
            className={`tab ${tab === entry.value ? 'active' : ''}`}
            onClick={() => onTab(entry.value)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {/* 键值表三页（params / headers / body）与 scripts、cURL 一样把编辑面铺满
          正文区：正文区自身不再滚动（见 App.css 的 .pane-body.fill），滚动分别
          交给编辑器与表格容器自己。 */}
      <div
        className={`pane-body stack${
          tab === 'params' || tab === 'headers' || tab === 'body' || tab === 'scripts' || tab === 'curl'
            ? ' fill'
            : ''
        }`}
      >

        {tab === 'params' && (
          <KeyValueTable
            key={`params-${draft.id}`}
            rows={draft.params}
            keyPlaceholder="参数名"
            valuePlaceholder="参数值（可用 {{var}}）"
            /* 改参数表即把查询串写回地址栏，两者是同一份数据（spec: URL 与参数表保持同步） */
            onChange={(params) => onChange(withParams(draft, params))}
          />
        )}

        {tab === 'headers' && (
          <KeyValueTable
            key={`headers-${draft.id}`}
            rows={draft.headers}
            keyPlaceholder="头名称"
            valuePlaceholder="头值（可用 {{var}}）"
            onChange={(headers) => patch({ headers })}
          />
        )}

        {/* 铺满链路的中间层：pane-body.fill 之后，这一层也要把高度让下去
            （flex: 1; min-height: 0，见 App.css 的 .stack.fill），否则类型行
            下方固定高度以上的空间到不了编辑器/表格。 */}
        {tab === 'body' && (
          <div className="stack fill">
            {/* 请求体类型（spec: 请求体类型的选择行）：同一行内的互斥单选；语言选择
                紧接 `raw` 单选项之后（不再跑到行尾），只在 raw 时出现；这一行的
                最右侧留给当前正文可用的格式化动作。 */}
            <div className="body-kind-row" role="radiogroup" aria-label="请求体类型">
              {BODY_KINDS.map((kind) => (
                <Fragment key={kind.value}>
                  <label className="body-kind">
                    <input
                      type="radio"
                      name="body-kind"
                      value={kind.value}
                      checked={draft.body.kind === kind.value}
                      onChange={() => patchBodyKind(kind.value)}
                    />
                    <span>{kind.label}</span>
                  </label>

                  {kind.value === 'raw' && draft.body.kind === 'raw' && (
                    <Dropdown<RawLanguage>
                      className="raw-language"
                      label="raw 语言"
                      value={draft.body.raw_language ?? 'json'}
                      options={RAW_LANGUAGES.map((language) => ({
                        value: language,
                        label: language,
                      }))}
                      onChange={(language) => patch({ body: { ...draft.body, raw_language: language } })}
                    />
                  )}
                </Fragment>
              ))}

              {/* 只有 JSON 有解析器，其它语言下这两个入口不存在（不是禁用态） */}
              {isRawJson && (
                <span className="body-format-actions">
                  <button
                    type="button"
                    className="text-action"
                    data-testid="body-minify"
                    disabled={rawEmpty}
                    onClick={() => applyFormat('minify')}
                  >
                    Minify
                  </button>
                  <button
                    type="button"
                    className="text-action"
                    data-testid="body-beautify"
                    disabled={rawEmpty}
                    onClick={() => applyFormat('beautify')}
                  >
                    Beautify
                  </button>
                </span>
              )}
            </div>

            {formatError && (
              <div className="notice danger" role="alert" data-testid="body-format-error">
                {formatError}
              </div>
            )}

            {draft.body.kind === 'raw' && (
              <CodeSurface
                uri={`file:///reqman/request/${draft.id}/body`}
                ariaLabel="raw 正文"
                language={monacoLanguage(draft.body.raw_language ?? 'json')}
                value={draft.body.raw ?? ''}
                fill
                onChange={(next) => {
                  setFormatError(null);
                  patch({ body: { ...draft.body, raw: next } });
                }}
              />
            )}

            {draft.body.kind === 'url_encoded' && (
              <KeyValueTable
                key={`urlencoded-${draft.id}`}
                rows={draft.body.urlencoded}
                keyPlaceholder="字段名"
                valuePlaceholder="字段值"
                onChange={(urlencoded) => patch({ body: { ...draft.body, urlencoded } })}
              />
            )}

            {draft.body.kind === 'form_data' && (
              <FormDataEditor
                key={`form-${draft.id}`}
                rows={draft.body.form}
                onPickFile={onPickFile}
                onChange={(form) => patch({ body: { ...draft.body, form } })}
              />
            )}

            {draft.body.kind === 'binary' && (
              /* 文件选取入口（spec: 请求体文件的选取）：路径留在后端，应用只持有
                 一次性句柄——这句安全语义值得用一行提示说清，因此提示保留。 */
              <div className="row">
                {draft.body.binary?.file_handle ? (
                  <>
                    <span className="muted">
                      已选择：{draft.body.binary.description ?? '文件'}
                    </span>
                    <button
                      type="button"
                      className="text-action"
                      aria-label="重新选择二进制文件"
                      onClick={() => void pickBinary()}
                    >
                      重新选择
                    </button>
                    <button
                      type="button"
                      className="text-action"
                      aria-label="清除二进制文件"
                      onClick={() => patch({ body: { ...draft.body, binary: null } })}
                    >
                      清除
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="text-action"
                    aria-label="选择二进制文件"
                    onClick={() => void pickBinary()}
                  >
                    选择文件
                  </button>
                )}
                <span className="muted">文件由系统对话框选取，后端只给出一次性句柄。</span>
              </div>
            )}
          </div>
        )}

        {tab === 'auth' && <AuthEditor draft={draft} onChange={(auth) => patch({ auth })} />}

        {tab === 'scripts' && (
          <ScriptPane
            uri={`file:///reqman/request/${draft.id}/script.js`}
            pre={draft.pre_request_script ?? ''}
            test={draft.test_script ?? ''}
            preLabel="前置脚本"
            testLabel="后置脚本"
            prePlaceholder={'// 例如：pm.environment.set("token", "...");'}
            testPlaceholder={
              '// 例如：pm.test("状态码为 200", () => pm.expect(pm.response.code).to.eql(200));'
            }
            onChangePre={(value) => patch({ pre_request_script: value || null })}
            onChangeTest={(value) => patch({ test_script: value || null })}
          />
        )}

        {tab === 'settings' && (
          <SettingsEditor
            draft={draft}
            onChange={(settings) => patch({ settings })}
          />
        )}

        {tab === 'curl' && <CurlPanel {...curl} />}
      </div>
    </div>
  );
}

type FormRow = SavedRequest['body']['form'][number];

/** 幽灵行：默认按文本字段起步，用户可以在它自己的下拉里改成文件。 */
const EMPTY_FIELD: FormRow = {
  key: '',
  value: '',
  file_handle: null,
  description: null,
  kind: 'text',
  enabled: true,
};

/**
 * form-data 表格，与 `KeyValueTable` 同一套幽灵行机制（见那里的注释）。
 * 差异只有两处：多一个类型下拉；空行的判定只看字段名（文件字段本来就没有值）。
 */
function FormDataEditor({
  rows,
  onPickFile,
  onChange,
}: {
  rows: SavedRequest['body']['form'];
  onPickFile?: () => Promise<PickedFile | null>;
  onChange: (rows: SavedRequest['body']['form']) => void;
}) {
  const [pending, setPending] = useState<FormRow>(EMPTY_FIELD);
  const [ownedIndex, setOwnedIndex] = useState<number | null>(null);
  const ghostKeyRef = useRef<HTMLInputElement>(null);

  const owned = ownedIndex !== null && ownedIndex < rows.length ? ownedIndex : null;
  const ghost = owned === null ? pending : rows[owned];

  const update = (index: number, patch: Partial<FormRow>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const editGhost = (patch: Partial<FormRow>) => {
    if (owned === null) {
      const next = { ...pending, ...patch };
      if (isEmptyFormField(next)) {
        setPending(next);
        return;
      }
      setPending(EMPTY_FIELD);
      setOwnedIndex(rows.length);
      onChange([...rows, next]);
      return;
    }
    update(owned, patch);
  };

  const releaseGhost = () => {
    if (owned === null) return;
    const current = rows[owned];
    setOwnedIndex(null);
    setPending(EMPTY_FIELD);
    if (isEmptyFormField(current)) onChange(rows.filter((_, index) => index !== owned));
  };

  const leaveGhost = (event: FocusEvent<HTMLInputElement>) => {
    const row = event.currentTarget.closest('tr');
    if (row?.contains(event.relatedTarget as Node | null)) return;
    releaseGhost();
  };

  const submitGhost = () => {
    releaseGhost();
    ghostKeyRef.current?.focus();
  };

  /** 文件行的选取：取消对话框（null）时不动该行；确认则写入句柄与文件名。 */
  const pick = async (index: number) => {
    if (!onPickFile) return;
    const picked = await onPickFile();
    if (!picked) return;
    update(index, { file_handle: picked.handle, description: picked.name });
  };

  return (
    /* 与 KeyValueTable 同款满高滚动容器（见上面的注释）。 */
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th className="col-check" />
            <th>字段</th>
            <th>类型</th>
            <th>内容 / 文件</th>
            <th className="col-check" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) =>
            index === owned ? null : (
              <tr key={index}>
                <td>
                  <input
                    className="checkbox"
                    type="checkbox"
                    aria-label={`启用字段 ${index}`}
                    checked={row.enabled}
                    onChange={(event) => update(index, { enabled: event.target.checked })}
                  />
                </td>
                <td>
                  <input
                    value={row.key}
                    aria-label={`字段名 ${index}`}
                    onChange={(event) => update(index, { key: event.target.value })}
                  />
                </td>
                <td>
                  <select
                    aria-label={`字段类型 ${index}`}
                    value={row.kind}
                    onChange={(event) =>
                      update(index, { kind: event.target.value as 'text' | 'file' })
                    }
                  >
                    <option value="text">文本</option>
                    <option value="file">文件</option>
                  </select>
                </td>
                <td>
                  {row.kind === 'text' ? (
                    <input
                      value={row.value ?? ''}
                      aria-label={`字段值 ${index}`}
                      onChange={(event) => update(index, { value: event.target.value })}
                    />
                  ) : row.file_handle ? (
                    /* 文件名展示取自 description（导入与选取链路都把文件名写在
                        这里）——这是 description 在 file 行上兼作文件名的既有
                        语义：编辑描述会同时改变这里的展示文案（design D3）。 */
                    <span className="file-cell">
                      <span className="muted">已选择：{row.description ?? '文件'}</span>
                      <button
                        type="button"
                        className="text-action"
                        aria-label={`重新选择文件 ${index}`}
                        onClick={() => void pick(index)}
                      >
                        重新选择
                      </button>
                      <button
                        type="button"
                        className="text-action"
                        aria-label={`清除文件 ${index}`}
                        onClick={() => update(index, { file_handle: null, description: null })}
                      >
                        清除
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="text-action"
                      aria-label={`选择文件 ${index}`}
                      onClick={() => void pick(index)}
                    >
                      选择文件
                    </button>
                  )}
                </td>
                <td>
                  <input
                    value={row.description ?? ''}
                    placeholder="描述"
                    aria-label={`字段描述 ${index}`}
                    onChange={(event) =>
                      update(index, { description: event.target.value === '' ? null : event.target.value })
                    }
                  />
                </td>
                <td>
                  <button
                    className="ghost row-delete"
                    aria-label="删除该字段"
                    onClick={() => onChange(rows.filter((_, i) => i !== index))}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ),
          )}
          <tr className="ghost-row">
            {/* 首列是勾选列的占位：幽灵行此前只有 4 个 <td>，对不上表头的 5 列，
                整行左移了一格（spec: form-data 幽灵行与表头对齐）。 */}
            <td />
            <td>
              <input
                ref={ghostKeyRef}
                value={ghost.key}
                placeholder="字段名"
                aria-label="新增字段的名称"
                onChange={(event) => editGhost({ key: event.target.value })}
                onBlur={leaveGhost}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  submitGhost();
                }}
              />
            </td>
            <td>
              <select
                aria-label="新增字段的类型"
                value={ghost.kind}
                onChange={(event) =>
                  editGhost({ kind: event.target.value as 'text' | 'file' })
                }
              >
                <option value="text">文本</option>
                <option value="file">文件</option>
              </select>
            </td>
            <td>
              {ghost.kind === 'text' ? (
                <input
                  value={ghost.value ?? ''}
                  placeholder="字段值"
                  aria-label="新增字段的值"
                  onChange={(event) => editGhost({ value: event.target.value })}
                  onBlur={leaveGhost}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    submitGhost();
                  }}
                />
              ) : (
                <span className="muted">未选择文件</span>
              )}
            </td>
            <td>
              <input
                value={ghost.description ?? ''}
                placeholder="描述"
                aria-label="新增字段的描述"
                onChange={(event) =>
                  editGhost({ description: event.target.value === '' ? null : event.target.value })
                }
                onBlur={leaveGhost}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  submitGhost();
                }}
              />
            </td>
            <td />
          </tr>
          {/* 「下一行」跳板行：与 KeyValueTable 的同款机制（见那里的注释）——键入
           * 第一个字符后 editGhost 已把内容提交成真实行，这一行随之出现，对齐
           * Postman「键入即见新行」。点击会先落定当前行、再把焦点交回底部空白行。
           * aria-label 用「下一行的 *」，与幽灵行的「新增字段的 *」区分开，测试按
           * label 取元素不会取到两个。 */}
          {owned !== null && (
            <tr className="ghost-row">
              <td />
              <td>
                <input
                  placeholder="字段名"
                  aria-label="下一行的字段名"
                  onFocus={() => {
                    releaseGhost();
                    ghostKeyRef.current?.focus();
                  }}
                  onChange={(event) => editGhost({ key: event.target.value })}
                />
              </td>
              <td>
                <select
                  aria-label="下一行的类型"
                  value={ghost.kind}
                  onChange={(event) =>
                    editGhost({ kind: event.target.value as 'text' | 'file' })
                  }
                >
                  <option value="text">文本</option>
                  <option value="file">文件</option>
                </select>
              </td>
              <td>
                {ghost.kind === 'text' ? (
                  <input
                    placeholder="字段值"
                    aria-label="下一行的值"
                    onFocus={() => {
                      releaseGhost();
                      ghostKeyRef.current?.focus();
                    }}
                    onChange={(event) => editGhost({ value: event.target.value })}
                  />
                ) : (
                  <span className="muted">未选择文件</span>
                )}
              </td>
              <td>
                <input
                  placeholder="描述"
                  aria-label="下一行的描述"
                  onFocus={() => {
                    releaseGhost();
                    ghostKeyRef.current?.focus();
                  }}
                  onChange={(event) => editGhost({ description: event.target.value || null })}
                />
              </td>
              <td />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function AuthEditor({
  draft,
  onChange,
}: {
  draft: SavedRequest;
  onChange: (auth: SavedRequest['auth']) => void;
}) {
  const auth = draft.auth;
  const kind = auth.kind;

  return (
    <div className="stack">
      <select
        aria-label="认证方式"
        value={kind}
        onChange={(event) => onChange({ ...auth, kind: event.target.value as AuthKind })}
      >
        {AUTH_KINDS.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>

      {kind === 'inherit' && <div className="notice info">使用所属集合或文件夹的认证配置。</div>}

      {kind === 'basic' && (
        <div className="row">
          <input
            aria-label="用户名"
            placeholder="用户名（可用 {{var}}）"
            value={auth.basic?.username ?? ''}
            onChange={(event) =>
              onChange({
                ...auth,
                basic: { username: event.target.value, password: auth.basic?.password ?? '' },
              })
            }
          />
          <input
            aria-label="密码"
            type="password"
            placeholder="密码"
            value={auth.basic?.password ?? ''}
            onChange={(event) =>
              onChange({
                ...auth,
                basic: { username: auth.basic?.username ?? '', password: event.target.value },
              })
            }
          />
        </div>
      )}

      {kind === 'bearer' && (
        <input
          aria-label="令牌"
          placeholder="Token（可用 {{var}}）"
          value={auth.bearer?.token ?? ''}
          onChange={(event) => onChange({ ...auth, bearer: { token: event.target.value } })}
        />
      )}

      {kind === 'api_key' && (
        <div className="row">
          <input
            aria-label="API Key 名称"
            placeholder="名称"
            value={auth.api_key?.key ?? ''}
            onChange={(event) =>
              onChange({
                ...auth,
                api_key: {
                  key: event.target.value,
                  value: auth.api_key?.value ?? '',
                  location: auth.api_key?.location ?? 'header',
                },
              })
            }
          />
          <input
            aria-label="API Key 值"
            placeholder="值"
            value={auth.api_key?.value ?? ''}
            onChange={(event) =>
              onChange({
                ...auth,
                api_key: {
                  key: auth.api_key?.key ?? '',
                  value: event.target.value,
                  location: auth.api_key?.location ?? 'header',
                },
              })
            }
          />
          <select
            className="auth-location-select"
            aria-label="API Key 位置"
            value={auth.api_key?.location ?? 'header'}
            onChange={(event) =>
              onChange({
                ...auth,
                api_key: {
                  key: auth.api_key?.key ?? '',
                  value: auth.api_key?.value ?? '',
                  location: event.target.value as ApiKeyLocation,
                },
              })
            }
          >
            <option value="header">请求头</option>
            <option value="query">查询参数</option>
          </select>
        </div>
      )}
    </div>
  );
}

function SettingsEditor({
  draft,
  onChange,
}: {
  draft: SavedRequest;
  onChange: (settings: SavedRequest['settings']) => void;
}) {
  const settings = draft.settings;

  const patchProxy = (next: Partial<ProxyConfig>) => {
    const proxy: ProxyConfig = {
      mode: 'manual',
      url: null,
      username: null,
      password: null,
      no_proxy: [],
      ...settings.proxy,
      ...next,
    };
    onChange({ ...settings, proxy });
  };

  // 行式配置列表（spec: ui-layout「设置模态的配置列表」）：名称在左、控件在右，
  // 与设置模态同一套观感——两处都是「一堆配置项」的列表。
  return (
    <div className="settings-section">
      <div className="settings-row">
        <span className="settings-name">超时（毫秒）</span>
        <input
          aria-label="超时毫秒"
          type="number"
          placeholder="0"
          value={settings.timeout_ms ?? ''}
          onChange={(event) =>
            onChange({
              ...settings,
              timeout_ms: event.target.value === '' ? null : Number(event.target.value),
            })
          }
        />
      </div>

      <label className="settings-row">
        <span className="settings-name">跟随重定向</span>
        <input
          className="switch"
          type="checkbox"
          role="switch"
          checked={settings.follow_redirects}
          onChange={(event) => onChange({ ...settings, follow_redirects: event.target.checked })}
        />
      </label>

      {/* 关闭证书校验的警示由标记承担（spec: 请求级网络设置「关闭证书校验有警示」）：
          这一行以危险色呈现，配合请求带上的标识——不另写解释后果的句子。 */}
      <label className={`settings-row${settings.verify_tls ? '' : ' settings-row-danger'}`}>
        <span className="settings-name">校验证书</span>
        <input
          className={`switch${settings.verify_tls ? '' : ' switch-danger'}`}
          type="checkbox"
          role="switch"
          checked={settings.verify_tls}
          onChange={(event) => onChange({ ...settings, verify_tls: event.target.checked })}
        />
      </label>

      <div className="settings-row">
        <span className="settings-name">协议版本</span>
        <Dropdown<HttpVersion>
          label="协议版本"
          testId="http-version"
          value={settings.http_version}
          options={[
            { value: 'auto', label: '自动' },
            { value: 'http1', label: 'HTTP/1' },
            { value: 'http2', label: 'HTTP/2' },
          ]}
          onChange={(value) => onChange({ ...settings, http_version: value })}
        />
      </div>

      {/* 响应呈现格式的请求级覆盖（spec: ui-layout「请求级响应格式覆盖」）：
          「跟随全局」是缺省，改动随请求保存并计入未保存守卫。 */}
      <div className="settings-row">
        <span className="settings-name">响应格式</span>
        <Dropdown
          label="响应格式"
          testId="request-response-format"
          value={settings.response_format ?? 'inherit'}
          options={[
            { value: 'inherit', label: '跟随全局' },
            { value: 'auto', label: 'Auto' },
            { value: 'json', label: 'JSON' },
          ]}
          onChange={(value) =>
            onChange({
              ...settings,
              response_format: value === 'json' ? 'json' : value === 'auto' ? 'auto' : 'inherit',
            })
          }
        />
      </div>

      <div className="settings-row">
        <span className="settings-name">请求级代理</span>
        <Dropdown<ProxyMode>
          label="请求级代理模式"
          testId="request-proxy-mode"
          value={settings.proxy?.mode ?? 'none'}
          options={[
            { value: 'none', label: '不使用' },
            { value: 'system', label: '跟随系统' },
            { value: 'manual', label: '手工填写' },
          ]}
          onChange={(mode) => {
            if (mode === 'none') {
              onChange({ ...settings, proxy: null });
              return;
            }
            patchProxy({ mode });
          }}
        />
      </div>

      {settings.proxy?.mode === 'manual' && (
        <>
          <div className="settings-row stacked">
            <label className="settings-name" htmlFor="proxy-url">
              代理地址
            </label>
            <input
              id="proxy-url"
              aria-label="代理地址"
              placeholder="http://127.0.0.1:8080"
              value={settings.proxy.url ?? ''}
              onChange={(event) => patchProxy({ url: event.target.value })}
            />
          </div>
          <div className="settings-row stacked">
            <label className="settings-name" htmlFor="proxy-no-proxy">
              不走代理的主机
            </label>
            <input
              id="proxy-no-proxy"
              aria-label="不走代理的主机"
              placeholder="localhost, *.internal"
              value={settings.proxy.no_proxy.join(',')}
              onChange={(event) =>
                patchProxy({
                  no_proxy: event.target.value
                    .split(',')
                    .map((entry) => entry.trim())
                    .filter((entry) => entry.length > 0),
                })
              }
            />
          </div>
        </>
      )}
    </div>
  );
}
