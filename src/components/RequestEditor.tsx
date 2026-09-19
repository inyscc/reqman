import { useRef, useState, type FocusEvent, type ReactNode, type RefObject } from 'react';
import { isEmptyFormField, isEmptyKeyValue } from '../lib/rows';
import { ScriptPane } from './ScriptPane';
import type {
  ApiKeyLocation,
  AuthKind,
  BodyKind,
  HttpVersion,
  KeyValue,
  ProxyConfig,
  ProxyMode,
  RawLanguage,
  SavedRequest,
} from '../lib/types';

type Tab = 'params' | 'headers' | 'body' | 'auth' | 'settings' | 'scripts';

export interface RequestEditorProps {
  draft: SavedRequest;
  tab: Tab;
  busy: boolean;
  onTab: (tab: Tab) => void;
  onChange: (next: SavedRequest) => void;
  onSend: () => void;
  /** 地址栏正下方的解析预览条（change: rework-app-layout，design D4）。 */
  preview?: ReactNode;
  /** 请求面板头（spec: 请求面板头的身份与操作）——身份与请求级操作下沉到这里。 */
  collectionName: string | null;
  dirty: boolean;
  onSave: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** 面板头里的请求名输入框：树菜单的「重命名」把焦点交给它。 */
  nameRef?: RefObject<HTMLInputElement | null>;
}

/** 请求标签的顺序与文案对齐 Postman（spec: 请求标签命名）。 */
const TABS: { value: Tab; label: string }[] = [
  { value: 'params', label: 'Params' },
  { value: 'auth', label: 'Authorization' },
  { value: 'headers', label: 'Headers' },
  { value: 'body', label: 'Body' },
  { value: 'scripts', label: 'Scripts' },
  { value: 'settings', label: 'Settings' },
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
const BODY_KINDS: { value: BodyKind; label: string }[] = [
  { value: 'none', label: '无' },
  { value: 'raw', label: 'raw' },
  { value: 'form_data', label: 'form-data' },
  { value: 'url_encoded', label: 'x-www-form-urlencoded' },
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
    <div className="stack">
      <table>
        <thead>
          <tr>
            <th className="col-check" />
            <th>名称</th>
            <th>值</th>
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
              <td />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function RequestEditor(props: RequestEditorProps) {
  const {
    draft,
    tab,
    busy,
    onTab,
    onChange,
    onSend,
    preview,
    collectionName,
    dirty,
    onSave,
    onDuplicate,
    onDelete,
    nameRef,
  } = props;

  const patch = (next: Partial<SavedRequest>) => onChange({ ...draft, ...next });

  return (
    <div className="request-editor">
      {/* 请求面板头（spec: 请求面板头的身份与操作）：所属集合面包屑 + 可就地编辑的
          请求名 + 请求级操作。身份随请求区一同出现与消失，不再占用会话标签行；
          方法由紧邻其下的地址栏选择框承载，这里 SHALL NOT 重复方法徽标。 */}
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
        {/* 未保存标记与保存入口只在有改动时同时出现——默认界面上不存在「保存」按钮。 */}
        {dirty && (
          <>
            <span className="badge warn">未保存</span>
            <button
              data-testid="save-request"
              title="保存（Ctrl+S）"
              onClick={onSave}
              disabled={busy}
            >
              保存
            </button>
          </>
        )}
        {/* 另存为 / 删除：保留文字标签，指针悬停或面板头内键盘聚焦时显现（见 App.css），
            且显现与隐藏不改变该行布局宽度。 */}
        <span className="request-actions">
          <button onClick={onDuplicate} disabled={busy}>
            另存为
          </button>
          <button onClick={onDelete} disabled={busy}>
            删除
          </button>
        </span>
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
          <input
            className="url-input mono"
            aria-label="请求地址"
            placeholder="https://api.example.com/users/:id"
            value={draft.url}
            onChange={(event) => patch({ url: event.target.value })}
          />
        </div>

        <button className="primary" onClick={onSend} disabled={busy}>
          发送
        </button>
      </div>

      {preview}

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

      <div className="pane-body stack">

        {tab === 'params' && (
          <KeyValueTable
            key={`params-${draft.id}`}
            rows={draft.params}
            keyPlaceholder="参数名"
            valuePlaceholder="参数值（可用 {{var}}）"
            onChange={(params) => patch({ params })}
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

        {tab === 'body' && (
          <div className="stack">
            <select
              aria-label="请求体类型"
              value={draft.body.kind}
              onChange={(event) =>
                patch({
                  body: {
                    ...draft.body,
                    kind: event.target.value as BodyKind,
                    // 切换类型时清掉其它类型的残留内容
                    raw: event.target.value === 'raw' ? draft.body.raw : null,
                    form: event.target.value === 'form_data' ? draft.body.form : [],
                    urlencoded:
                      event.target.value === 'url_encoded' ? draft.body.urlencoded : [],
                  },
                })
              }
            >
              {BODY_KINDS.map((kind) => (
                <option key={kind.value} value={kind.value}>
                  {kind.label}
                </option>
              ))}
            </select>

            {draft.body.kind === 'raw' && (
              <div className="stack">
                <select
                  aria-label="raw 语言"
                  value={draft.body.raw_language ?? 'json'}
                  onChange={(event) =>
                    patch({
                      body: { ...draft.body, raw_language: event.target.value as RawLanguage },
                    })
                  }
                >
                  {RAW_LANGUAGES.map((language) => (
                    <option key={language} value={language}>
                      {language}
                    </option>
                  ))}
                </select>
                <textarea
                  aria-label="raw 正文"
                  rows={10}
                  value={draft.body.raw ?? ''}
                  onChange={(event) =>
                    patch({ body: { ...draft.body, raw: event.target.value } })
                  }
                />
              </div>
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
                onChange={(form) => patch({ body: { ...draft.body, form } })}
              />
            )}

            {draft.body.kind === 'binary' && (
              <div className="notice info">
                二进制正文需要先选择文件。文件由系统对话框选取，后端只给出一次性句柄。
              </div>
            )}
          </div>
        )}

        {tab === 'auth' && <AuthEditor draft={draft} onChange={(auth) => patch({ auth })} />}

        {tab === 'scripts' && (
          <div className="stack">
            <ScriptPane
              pre={draft.pre_request_script ?? ''}
              test={draft.test_script ?? ''}
              preLabel="前置脚本"
              testLabel="后置脚本"
              preHint="前置脚本 — 发送前执行；与本集合、文件夹的脚本按 集合 → 文件夹 → 请求 依次运行"
              testHint={
                <>
                  后置脚本 — 收到响应后执行；可读 <code>pm.response</code>、注册 <code>pm.test</code>
                </>
              }
              prePlaceholder={'// 例如：pm.environment.set("token", "...");'}
              testPlaceholder={
                '// 例如：pm.test("状态码为 200", () => pm.expect(pm.response.code).to.eql(200));'
              }
              onChangePre={(value) => patch({ pre_request_script: value || null })}
              onChangeTest={(value) => patch({ test_script: value || null })}
            />

            <p className="muted">
              在本应用中编写并保存的脚本视为已授权，发送时不再弹出脚本确认。
            </p>
          </div>
        )}

        {tab === 'settings' && (
          <SettingsEditor
            draft={draft}
            onChange={(settings) => patch({ settings })}
          />
        )}
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
  onChange,
}: {
  rows: SavedRequest['body']['form'];
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

  return (
    <div className="stack">
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
                  ) : (
                    <span className="muted">
                      {row.file_handle ? `已选择：${row.description ?? '文件'}` : '未选择文件'}
                    </span>
                  )}
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
            <td />
          </tr>
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

  return (
    <div className="stack">
      <div className="row">
        <label className="row auth-label-wide">
          <span className="muted">超时（毫秒）</span>
        </label>
        <input
          aria-label="超时毫秒"
          type="number"
          value={settings.timeout_ms ?? ''}
          onChange={(event) =>
            onChange({
              ...settings,
              timeout_ms: event.target.value === '' ? null : Number(event.target.value),
            })
          }
        />
      </div>

      <label className="row">
        <input
          className="checkbox"
          type="checkbox"
          checked={settings.follow_redirects}
          onChange={(event) => onChange({ ...settings, follow_redirects: event.target.checked })}
        />
        <span>跟随重定向</span>
      </label>

      <label className="row">
        <input
          className="checkbox"
          type="checkbox"
          checked={settings.verify_tls}
          onChange={(event) => onChange({ ...settings, verify_tls: event.target.checked })}
        />
        <span>校验证书</span>
      </label>

      {!settings.verify_tls && (
        <div className="notice danger" role="alert">
          已关闭证书校验。该请求不会被验证目标身份，仅应在明确知情时使用。
        </div>
      )}

      <div className="row">
        <span className="muted auth-label">
          协议版本
        </span>
        <select
          aria-label="协议版本"
          value={settings.http_version}
          onChange={(event) =>
            onChange({ ...settings, http_version: event.target.value as HttpVersion })
          }
        >
          <option value="auto">自动</option>
          <option value="http1">HTTP/1</option>
          <option value="http2">HTTP/2</option>
        </select>
      </div>

      <div className="row">
        <span className="muted auth-label">
          请求级代理
        </span>
        <select
          aria-label="请求级代理模式"
          value={settings.proxy?.mode ?? 'none'}
          onChange={(event) => {
            const mode = event.target.value as ProxyMode;
            if (mode === 'none') {
              onChange({ ...settings, proxy: null });
              return;
            }
            patchProxy({ mode });
          }}
        >
          <option value="none">不使用</option>
          <option value="system">跟随系统</option>
          <option value="manual">手工填写</option>
        </select>
      </div>

      {settings.proxy?.mode === 'manual' && (
        <>
          <input
            aria-label="代理地址"
            placeholder="http://127.0.0.1:8080 或 socks5://127.0.0.1:1080"
            value={settings.proxy.url ?? ''}
            onChange={(event) => patchProxy({ url: event.target.value })}
          />
          <input
            aria-label="不走代理的主机"
            placeholder="不走代理的主机，用逗号分隔"
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
        </>
      )}
    </div>
  );
}
