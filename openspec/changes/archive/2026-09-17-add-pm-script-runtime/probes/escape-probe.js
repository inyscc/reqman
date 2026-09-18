// ============================================================================
// 1.4 实机逃逸探针
//
// 用法：整段粘进某条请求的「前置脚本」，然后点发送。
// 结果在右侧「响应 → 脚本」标签页：一条 ESCAPE-PROBE 开头的 JSON + 四条断言。
// 请求本身成功与否不影响结果（前置脚本的输出在请求失败时也会呈现）。
//
// 建议跑两遍：
//   A. 默认（设置里的「脚本目标策略」未配置）
//   B. 已配置策略且只放行一个无关目标（例如 allow: api.test）
// 两遍的差别本身就是 1.4 要记录的东西。
//
// 判定标准是**能力**而非「是否抛错」：沙箱把 `fs` / `path` 这类模块以空壳 stub 提供
// （能 require 到，但没有任何危险 API）。把「没抛错」当作「加载成功」会得到假阳性。
// 实测（Node 后端）：`require('fs')` 返回对象但 `readFileSync` 不存在。
// ============================================================================

const report = { primitives: {}, recovery: {}, modules: {}, faker: {}, ipc: {}, fsAttempt: null };

// ---- A. 直接原语是否存在（应全部 undefined） ----
const PRIMITIVES = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'importScripts',
  'Worker',
  'SharedWorker',
  'indexedDB',
  'caches',
  'localStorage',
  'sessionStorage',
  'document',
  'navigator',
  'location',
  'window',
  'self',
  'globalThis',
  'process',
];

PRIMITIVES.forEach(function (name) {
  try {
    // eslint-disable-next-line no-eval
    const value = eval(name);
    report.primitives[name] = typeof value;
  } catch (e) {
    // 引用不存在的全局会抛 ReferenceError——与「存在但为 undefined」不是一回事，
    // 两种都记下来，别把它们混成一个
    report.primitives[name] = 'THROWS';
  }
});

// ---- B. 回收全局对象的向量（经典逃逸手法；应全部不成立） ----
const VECTORS = {
  'Function("return this")': function () {
    return Function('return this')();
  },
  '空函数.constructor': function () {
    return function () {}.constructor('return this')();
  },
  '对象.constructor.constructor': function () {
    return {}.constructor.constructor('return this')();
  },
  '数组.constructor.constructor': function () {
    return [].constructor.constructor('return this')();
  },
  'async 函数.constructor': function () {
    return (async function () {}).constructor('return this')();
  },
  'Object.prototype.constructor': function () {
    return Object.getPrototypeOf({}).constructor('return this')();
  },
  'prepareStackTrace → getThis': function () {
    // 沙箱用 Object.defineProperty 重写了 Error.prepareStackTrace（bootcode 的 index.js），
    // 多半是不可写。**写不进去本身就是结果**（说明这条回收路被显式堵住），因此先读描述符：
    // 只有确实可写时才去试，免得把「预期中的拒绝」记成脚本错误、看着像崩了。
    let descriptor = 'unknown';
    try {
      const d = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
      descriptor = d
        ? 'writable=' + String(d.writable) + ' configurable=' + String(d.configurable)
        : 'absent';
    } catch (e) {
      descriptor = 'descriptor THROWS';
    }

    if (descriptor.indexOf('writable=true') !== 0) {
      return '不可写，赋值被拒（' + descriptor + '）';
    }

    let leaked = 'not-called';
    const original = Error.prepareStackTrace;
    try {
      Error.prepareStackTrace = function (err, frames) {
        try {
          leaked = frames && frames[0] ? frames[0].getThis() : 'no-frames';
        } catch (e) {
          leaked = 'getThis THROWS';
        }
        return null;
      };
      void new Error().stack;
    } finally {
      // 还原也要护住：这句在不可写时同样会抛
      try {
        Error.prepareStackTrace = original;
      } catch (e) {
        leaked = '还原失败';
      }
    }
    return leaked;
  },
  'arguments.callee': function () {
    return (function () {
      return arguments.callee;
    })();
  },
};

Object.keys(VECTORS).forEach(function (name) {
  try {
    const value = VECTORS[name]();
    const leaks = Boolean(value) && typeof value === 'object' && 'fetch' in value;
    if (leaks) {
      report.recovery[name] = 'LEAKS fetch';
    } else if (typeof value === 'string') {
      // 向量自己给出的说明比 typeof 有用得多（例如「不可写，赋值被拒（writable=false …）」），
      // 别把它压成一句 no-fetch——报告是给人看的
      report.recovery[name] = value;
    } else {
      report.recovery[name] = 'no-fetch（' + typeof value + '）';
    }
  } catch (e) {
    report.recovery[name] = 'THROWS: ' + String(e && e.message).slice(0, 80);
  }
});

// ---- C. 模块引入：按**能力**判定，不看是否抛错 ----
// 每个危险模块列出「有它就等于有该能力」的 API。stub 里没有这些，因此判为无害。
const CAPABILITY_CHECKS = {
  http: ['request', 'get', 'createServer'],
  https: ['request', 'get', 'createServer'],
  net: ['connect', 'createServer', 'Socket'],
  fs: ['readFileSync', 'writeFileSync', 'readdirSync', 'createReadStream', 'createWriteStream'],
  'node:fs': ['readFileSync', 'writeFileSync', 'readdirSync', 'createReadStream'],
  child_process: ['exec', 'execSync', 'spawn', 'spawnSync'],
  worker_threads: ['Worker', 'MessageChannel'],
};

function capabilityOf(id, mod) {
  if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) {
    return { verdict: '空值（' + typeof mod + '）', caps: [] };
  }
  const wanted = CAPABILITY_CHECKS[id] || [];
  const caps = wanted.filter(function (key) {
    return typeof mod[key] === 'function';
  });
  return {
    verdict: caps.length > 0 ? 'CAPABLE' : 'stub（无危险 API）',
    caps: caps,
  };
}

function loadModule(id, usePmRequire) {
  try {
    const mod = usePmRequire ? pm.require(id) : require(id);
    const cap = capabilityOf(id, mod);
    return { verdict: cap.verdict, caps: cap.caps, type: typeof mod };
  } catch (e) {
    return { verdict: 'THROWS', message: String(e && e.message).slice(0, 90) };
  }
}

const DANGEROUS_MODULES = [
  'http',
  'https',
  'net',
  'fs',
  'node:fs',
  'child_process',
  'worker_threads',
];
// 只记录可达性：postman-collection 与 faker 是已知的 upstream 告警路径（见 design Risks）
const REPORTED_MODULES = ['postman-collection', '@faker-js/faker', 'faker'];

DANGEROUS_MODULES.concat(REPORTED_MODULES).forEach(function (id) {
  report.modules[id] = {
    require: loadModule(id, false),
    'pm.require': loadModule(id, true),
  };
});

// ---- C-2. 真的试着读一次文件（比看 API 更硬） ----
report.fsAttempt = (function () {
  try {
    const fs = require('fs');
    if (!fs || typeof fs.readFileSync !== 'function') {
      return 'no readFileSync on module';
    }
    return 'READ: ' + String(fs.readFileSync('/etc/hostname', 'utf8')).slice(0, 40);
  } catch (e) {
    return 'THROWS: ' + String(e && e.message).slice(0, 90);
  }
})();

// ---- D. faker 路径的细节（2.1 的 high 告警） ----
try {
  const pc = pm.require('postman-collection');
  const names = Object.keys(pc || {});
  report.faker['postman-collection'] = 'LOADED';
  report.faker.pc_exports = names.slice(0, 25);
  report.faker.pc_faker_like = names.filter(function (name) {
    return /faker|dynamic/i.test(name);
  });
} catch (e) {
  report.faker['postman-collection'] = 'THROWS: ' + String(e && e.message).slice(0, 80);
}

try {
  const faker = pm.require('@faker-js/faker');
  report.faker['@faker-js/faker'] = 'LOADED';
  report.faker.fake_callable = Boolean(
    faker && faker.helpers && typeof faker.helpers.fake === 'function',
  );
} catch (e) {
  report.faker['@faker-js/faker'] = 'THROWS: ' + String(e && e.message).slice(0, 80);
}

// ---- E. IPC 入口（1.3 已证 CSP 不拦它；这条路径没有 CSP 兜底） ----
function callBridge(target) {
  return new Promise(function (resolve) {
    const started = Date.now();
    try {
      pm.sendRequest(
        {
          url: target,
          method: 'POST',
          header: { 'Content-Type': 'application/json' },
          body: {
            mode: 'raw',
            raw: JSON.stringify({ cmd: 'workspace_list', payload: {} }),
          },
        },
        function (err, res) {
          if (err) {
            resolve({ error: String(err.message || err).slice(0, 160), ms: Date.now() - started });
            return;
          }
          let body = '';
          try {
            body = String(res.text()).slice(0, 200);
          } catch (e) {
            body = '<text() 失败>';
          }
          resolve({ code: res.code, body: body, ms: Date.now() - started });
        },
      );
    } catch (e) {
      resolve({ error: 'THROWS: ' + String(e && e.message).slice(0, 160) });
    }
  });
}

report.ipc['http://ipc.localhost/'] = await callBridge('http://ipc.localhost/');
report.ipc['ipc://localhost/'] = await callBridge('ipc://localhost/');
report.ipc['http://probe.invalid/'] = await callBridge('http://probe.invalid/');

// ---- 顺带记录 pm.require 是否与 require 一致（上游在未提供 resolvedPackages 时会摘掉它） ----
report.requireAlias = typeof pm.require === 'function' && pm.require === require;

// ---- 输出 + 四条判定 ----
console.log('ESCAPE-PROBE ' + JSON.stringify(report));

const leakedPrimitives = Object.keys(report.primitives).filter(function (name) {
  return report.primitives[name] !== 'undefined' && report.primitives[name] !== 'THROWS';
});
pm.test('沙箱内没有联网 / 存储 / Worker 原语', function () {
  pm.expect(leakedPrimitives, '泄漏：' + leakedPrimitives.join(', ')).to.eql([]);
});

const workingVectors = Object.keys(report.recovery).filter(function (name) {
  return String(report.recovery[name]).indexOf('LEAKS') === 0;
});
pm.test('回收全局对象的向量都不成立', function () {
  pm.expect(workingVectors, '可用向量：' + workingVectors.join(', ')).to.eql([]);
});

const capableModules = [];
DANGEROUS_MODULES.forEach(function (id) {
  ['require', 'pm.require'].forEach(function (how) {
    const entry = report.modules[id][how];
    if (entry.verdict === 'CAPABLE') {
      capableModules.push(how + ':' + id + ' → ' + entry.caps.join(','));
    }
  });
});
pm.test('网络与文件系统模块没有可达能力（stub 不算）', function () {
  pm.expect(capableModules, '有能力的模块：' + capableModules.join(' | ')).to.eql([]);
});

pm.test('读文件尝试失败', function () {
  pm.expect(report.fsAttempt).to.not.match(/^READ:/);
});
