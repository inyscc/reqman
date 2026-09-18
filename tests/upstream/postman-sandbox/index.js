// 上游测试套件的入口转发（任务 4.5）。
//
// 上游用例里写的是 `require('../../../')`——相对 `test/unit/sandbox-libraries/`
// 向上三层，指向 postman-sandbox 仓库根。这里用 npm 安装的同版本包作为那个根，
// 因此用例跑的是**我们实际安装的依赖**，而不是另拿一份源码。
module.exports = require('postman-sandbox');
