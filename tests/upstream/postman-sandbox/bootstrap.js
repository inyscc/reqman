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
