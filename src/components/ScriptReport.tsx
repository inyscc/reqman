import type { ConsoleEntry, TestAssertion } from '../lib/scriptRuntime';

export interface ScriptReportProps {
  console: ConsoleEntry[];
  assertions: TestAssertion[];
  error: string | null;
}

/**
 * 脚本阶段的结果呈现（任务 6.1 / 6.2）。
 *
 * 这里只做呈现，不做判断：断言的成功失败由沙箱给出，输出是否含明文由运行时的脱敏
 * 处理（取值匹配，挡得住原样打印、挡不住编码变换，详见 design D15）。
 */
export function ScriptReport({ console: entries, assertions, error }: ScriptReportProps) {
  return (
    <div className="stack" data-testid="script-report">
      {error && (
        <div className="notice danger" role="alert" data-testid="script-error">
          {error}
        </div>
      )}

      {assertions.length > 0 && (
        <table data-testid="script-assertions">
          <thead>
            <tr>
              <th>结果</th>
              <th>断言</th>
              <th>原因</th>
            </tr>
          </thead>
          <tbody>
            {assertions.map((assertion, index) => (
              <tr
                key={`${assertion.name}-${index}`}
                data-testid={
                  assertion.skipped
                    ? 'assertion-skip'
                    : assertion.passed
                      ? 'assertion-pass'
                      : 'assertion-fail'
                }
              >
                <td>{assertion.skipped ? '跳过' : assertion.passed ? '通过' : '失败'}</td>
                <td>{assertion.name}</td>
                <td className="mono">{assertion.error ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {entries.length > 0 && (
        <ul data-testid="script-console">
          {entries.map((entry, index) => (
            <li key={index} data-level={entry.level} data-phase={entry.phase}>
              <span className="mono muted">
                [{entry.phase === 'prerequest' ? '前置' : '后置'} · {entry.level}]
              </span>{' '}
              {entry.args.join(' ')}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
