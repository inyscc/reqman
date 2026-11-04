import type { ConsoleEntry, TestAssertion } from '../lib/scriptRuntime';

export interface ScriptReportProps {
  /**
   * console 输出。**只有运行器的请求明细会传**：响应区的「脚本」页签不再承载输出——
   * 它只有全局 Console 一个去处，同一条输出不该在两个面板里各抄一遍。
   *
   * 运行器明细里的这份是**按请求归拢**的：全局 Console 是按时间混排的一条线，而这里要回答
   * 的是"这一条为什么挂了"，两者切法不同，不是同一份东西。
   */
  console?: ConsoleEntry[];
  assertions: TestAssertion[];
  error: string | null;
}

/**
 * 脚本阶段的结果呈现（任务 6.1 / 6.2）。
 *
 * 这里只做呈现，不做判断：断言的成功失败由沙箱给出，输出是否含明文由运行时的脱敏
 * 处理（取值匹配，挡得住原样打印、挡不住编码变换，详见 design D15）。
 */
export function ScriptReport({ console: entries = [], assertions, error }: ScriptReportProps) {
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
        // 输出的换行与缩进按原文呈现（见 App.css 的 .script-console）：脚本自己写的多行文本
        // 折叠成一行就没法读了。对象是紧凑 JSON 一行——要格式化的脚本自己 JSON.stringify。
        // 文本取自 `values[].text`——结构与文本在收集时一起算好，这里只挑文本那一半。
        <ul className="script-console" data-testid="script-console">
          {entries.map((entry, index) => (
            <li key={index} data-level={entry.level} data-phase={entry.phase}>
              <span className="mono muted">
                [{entry.phase === 'prerequest' ? '前置' : '后置'}
                {entry.segment ? ` · ${entry.segment}` : ''} · {entry.level}]
              </span>{' '}
              {entry.values.map((value) => value.text).join(' ')}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
