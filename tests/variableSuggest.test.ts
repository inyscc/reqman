// 变量候选的判定、过滤与替换（change: suggest-variables-while-typing，任务 1.1）。
//
// 这三件事共用一份判定：**触发条件**（光标处是否正在输入名字）与**替换范围**（插入时
// 盖掉哪一段）必须同源，否则会出现「候选弹了、插入位置却错」——那类偏差在界面上表现为
// `{{{{name}}st}}`，用户只会认为功能坏了。
import { describe, expect, it } from 'vitest';
import {
  applySuggestion,
  filterCandidates,
  suggestContext,
  type Suggestible,
} from '../src/lib/variableSuggest';

function candidate(name: string, value = `value-${name}`, scope: Suggestible['scope'] = 'environment') {
  return { name, value, scope, secret: false };
}

describe('候选的触发判定', () => {
  it('刚键入两个左花括号就触发，名字片段为空', () => {
    expect(suggestContext('{{', 2)).toEqual({ start: 0, end: 2, query: '' });
  });

  it('继续键入后名字片段跟着变长', () => {
    expect(suggestContext('https://api.test/{{ho', 21)).toEqual({
      start: 17,
      end: 21,
      query: 'ho',
    });
  });

  it('光标停在已闭合的占位符里时，替换范围覆盖到右花括号之后', () => {
    // `{{host}}` 里光标在 `ho` 之后
    expect(suggestContext('{{host}}', 4)).toEqual({ start: 0, end: 8, query: 'ho' });
  });

  it('光标停在右花括号之后就不再触发', () => {
    expect(suggestContext('{{host}}', 8)).toBeNull();
  });

  it('光标在两个左花括号之间不算输入名字', () => {
    expect(suggestContext('{{host}}', 1)).toBeNull();
  });

  it('光标位于占位符之前时不触发', () => {
    expect(suggestContext('abc{{host}}', 1)).toBeNull();
  });

  it('第三个左花括号之外的那一对仍可触发（取最近的一对）', () => {
    expect(suggestContext('{{{ho', 5)).toEqual({ start: 1, end: 5, query: 'ho' });
  });

  it('名字片段跨行即不算', () => {
    expect(suggestContext('{{ho\nst', 7)).toBeNull();
  });

  it('名字片段里出现右花括号即不算（说明这一段已经闭合过）', () => {
    expect(suggestContext('{{a}} {{b}}', 6)).toBeNull();
  });

  it('光标越界时不触发（防御：调用方可能传进一个过期的 selectionStart）', () => {
    expect(suggestContext('{{', 99)).toBeNull();
    expect(suggestContext('{{', -1)).toBeNull();
  });
});

describe('候选的过滤', () => {
  const list = [candidate('host'), candidate('api_host'), candidate('xhook'), candidate('API_KEY')];

  it('空查询原样返回（浮层一打开就列出全部）', () => {
    expect(filterCandidates(list, '')).toBe(list);
  });

  it('前缀匹配排在包含匹配之前', () => {
    expect(filterCandidates(list, 'ho').map((item) => item.name)).toEqual([
      'host',
      'api_host',
      'xhook',
    ]);
  });

  it('大小写不敏感', () => {
    // 两条都是前缀命中，因此保持传入顺序；第二条证明小写查询能匹配大写的名字
    expect(filterCandidates(list, 'API').map((item) => item.name)).toEqual([
      'api_host',
      'API_KEY',
    ]);
    expect(filterCandidates(list, 'key').map((item) => item.name)).toEqual(['API_KEY']);
  });

  it('没有匹配时返回空数组', () => {
    expect(filterCandidates(list, 'zzz')).toEqual([]);
  });
});

describe('插入', () => {
  it('把光标处的未闭合片段补成完整占位符，光标停在它之后', () => {
    const text = 'https://api.test/{{ho';
    const context = suggestContext(text, text.length)!;

    expect(applySuggestion(text, context, 'host')).toEqual({
      text: 'https://api.test/{{host}}',
      caret: 25,
    });
  });

  it('改已有占位符时整个替换，不产生嵌套花括号', () => {
    const text = 'https://api.test/{{host}}/users';
    // 光标在 `ho` 之后
    const context = suggestContext(text, 21)!;

    expect(context.query).toBe('ho');
    expect(applySuggestion(text, context, 'baseUrl')).toEqual({
      text: 'https://api.test/{{baseUrl}}/users',
      caret: 28,
    });
  });

  it('原地重选同一个名字时结果不变（幂等）', () => {
    const text = '{{host}}';
    const context = suggestContext(text, 4)!;

    expect(applySuggestion(text, context, 'host').text).toBe('{{host}}');
  });
});
