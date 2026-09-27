// 上游用例需要的宿主侧测试全局（本地新增，非上游文件）。
//
// 上游用 `test/unit/_bootstrap.js` 把 chai 的 `expect` 与 `sinon` 挂成全局——这些
// 用例在**宿主层**（mocha 回调里）直接用 `expect(...)` / `sinon.spy`，而不是在沙箱
// 脚本字符串里。那份 bootstrap 还带着它自己的 describe 块（引用了 `../../lib` 的
// 内部路径），我们不整体搬，只做同一件事：注入两个全局。
//
// 差异说明：上游用根钩子（before/after）挂载与还原，这里在加载时直接挂上。
// 对「跑一套一次性用例」而言两者等价，且少一层对 mocha 钩子时序的依赖。
var chai = require('chai'),
    sinon = require('sinon'),
    sinonChai = require('sinon-chai');

chai.use(sinonChai);

global.expect = chai.expect;
global.sinon = sinon;

// ---------------------------------------------------------------------------
// Node 后端特有的两条用例：跳过，并在这里写明原因（不改上游文件）
// ---------------------------------------------------------------------------
//
// 这两条断言「宿主向沙箱 `dispatch` 一个 `Error` 后，沙箱回抛的 `execution.error`
// 载荷里带着原来的 message」。在 Node 后端下跨 worker 的参数编解码走
// `teleport-javascript@1.0.0`（`postman-sandbox@6.7.4` 精确锁定的版本），而它**不
// 携带 Error 的内容**——实测：
//
//   teleport.stringify([new Error('Vault access denied')])  ===  '[["1"],{}]'
//   teleport.parse(...)[0].message                          ===  undefined
//
// 于是沙箱侧拿到的是一个空对象，回抛时的 `String(err)` 就成了 `'[object Object]'`。
// 浏览器后端走 `postMessage` 的结构化克隆（Error 的 message 本来就跨得过去），这两条
// 用例正是按那个后端写的——所以它们在 Node 下必然失败，与产品代码无关。
//
// 为什么不在本地「修好」它：worker 一侧的编解码在 uvm 的 worker 里 require 自己的
// 模块实例，从 bootstrap 打不到；要让它真通过就得改上游源码或 node_modules，代价大于
// 收益。这两条路径（`pm.vault` / `pm.datasets`）也都不在产品实现的桥出口内。
// 完整证据与判定见同目录 `../RESULTS.md`。
const NODE_BACKEND_ONLY_FAILURES = [
  'should trigger `execution.error` event if pm.vault.<operation> promise rejects',
  'should trigger `execution.error` event if pm.datasets promise rejects',
];

// 根级钩子（mocha 的 root hook plugin）：对所有用例文件生效，按标题匹配即跳过。
// 用 `exports.mochaHooks` 而不是裸的 `beforeEach`——后者在 `--require` 的模块里没有定义。
exports.mochaHooks = {
  beforeEach() {
    const title = this.currentTest && this.currentTest.fullTitle();

    if (title && NODE_BACKEND_ONLY_FAILURES.some((name) => title.includes(name))) {
      this.skip();
    }
  },
};
