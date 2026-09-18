// ============================================================================
// 1.3 blob Worker 是否继承文档 CSP —— WebKitGTK（Linux）侧探针
//
// 用法：在应用窗口内打开 devtools（右键 → 检查元素，开发构建带 devtools），
// 整段粘进 Console 回车。结果以 CSP-PROBE 开头的对象打印在 Console 里。
//
// 为什么在窗口上下文里跑：blob Worker 的 CSP 继承与创建它的文档有关，
// 而沙箱里连 Worker 构造器都已被删除（这正是 1.4 覆盖的事）。在应用主文档里建一个
// 同样形态的 blob Worker，就能回答「这份文档的 CSP 是否作用于 worker 内部的
// fetch / importScripts / 嵌套 Worker」。Chromium 侧已由
// tests-browser/worker-csp.spec.ts 证明为「继承」，本探针补的是 WebKitGTK。
//
// 判读要点：**`securitypolicyviolation` 事件是否触发**是最可靠的信号；
// 报错文本里出现 Content Security Policy / CSP 字样是次要信号。
// 网络不通会让「远程目标失败」这一项失去区分力（失败原因可能是 DNS），因此必须看事件。
// ============================================================================

(async () => {
  const workerCode = `
    const out = { violations: [], results: {} };
    self.addEventListener('securitypolicyviolation', (event) => {
      out.violations.push({ directive: event.violatedDirective, blocked: event.blockedURI });
    });
    (async () => {
      // 正对照：同源目标。它若也失败，说明这个 worker 根本没有网络，后面的结论都不可用
      try {
        const res = await fetch(self.location.origin + '/');
        out.results.sameOriginFetch = 'ok ' + res.status;
      } catch (e) {
        out.results.sameOriginFetch = 'error: ' + String(e && e.message).slice(0, 160);
      }
      // connect-src：远程目标应当被 CSP 拦下
      try {
        await fetch('http://probe.invalid/x');
        out.results.remoteFetch = 'reached';
      } catch (e) {
        out.results.remoteFetch = 'error: ' + String(e && e.message).slice(0, 160);
      }
      // script-src：远程脚本应当被 CSP 拦下
      try {
        importScripts('http://probe.invalid/x.js');
        out.results.remoteImportScripts = 'loaded';
      } catch (e) {
        out.results.remoteImportScripts = 'error: ' + String(e && e.message).slice(0, 160);
      }
      // worker-src：应用 CSP 放行 blob:，所以嵌套 blob Worker 应当被允许
      try {
        const nestedUrl = URL.createObjectURL(
          new Blob(['postMessage("nested-ok")'], { type: 'text/javascript' }),
        );
        const nested = new Worker(nestedUrl);
        out.results.nestedBlobWorker = await new Promise((resolve) => {
          nested.onmessage = (event) => resolve('created: ' + String(event.data));
          setTimeout(() => resolve('timeout'), 1500);
        });
        nested.terminate();
        URL.revokeObjectURL(nestedUrl);
      } catch (e) {
        out.results.nestedBlobWorker = 'error: ' + String(e && e.message).slice(0, 160);
      }
      // 给违规事件一点时间抵达再回传
      setTimeout(() => postMessage(out), 300);
    })();
  `;

  const url = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
  const worker = new Worker(url);

  const report = await new Promise((resolve) => {
    const violations = [];
    const timer = setTimeout(() => resolve({ timeout: true, violations }), 8000);
    worker.onmessage = (event) => {
      const data = event.data || {};
      if (data.violations && data.results) {
        clearTimeout(timer);
        resolve({ violations: violations.concat(data.violations), results: data.results });
      } else if (data.directive) {
        violations.push(data);
      }
    };
  });

  URL.revokeObjectURL(url);
  worker.terminate();

  const cspHeader = (() => {
    try {
      const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      return meta ? meta.getAttribute('content') : '（无 meta，由响应头注入）';
    } catch (e) {
      return '读取失败';
    }
  })();

  console.log('CSP-PROBE ' + JSON.stringify({ origin: location.origin, cspHeader, report }, null, 2));
})();
