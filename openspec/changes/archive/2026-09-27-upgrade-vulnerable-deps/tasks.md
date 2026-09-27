## 1. 三处升级（D1 / D2）

- [x] 1.0 先试"升级 monaco-editor 以带上新 dompurify"这条路，实测否决（0.56 重排 ESM 入口，构建与浏览器套件立刻失败） — 验证：`npm run build` 报 `Cannot find module .../editor.worker`、TS2882/TS2339；已回退该尝试并改走 D1
- [x] 1.1 dompurify 经 `overrides` 提升到 `^3.4.15`（monaco 留在 0.54.0） — 验证：`npm ls dompurify` 显示 3.4.15，且 `npm run build` 通过（1584 modules）
- [x] 1.2 `crypto-js` `^3.3.0` → `^4.2.0` — 验证：`npm ls crypto-js` 显示 4.2.0
- [x] 1.3 `mocha` `^10.8.2` → `^12`，`serialize-javascript` 随之离开漏洞区间 — 验证：`npm ls serialize-javascript` 显示 7.1.2

## 2. 回归验证（R1 / R2 / R3）

- [x] 2.1 单元测试全过 — 验证：`npx vitest run` 477 passed / 0 failed
- [x] 2.2 浏览器套件全过 — 验证：`npm run test:browser` 13 个文件通过。首次跑曾有 7 个用例超时，根因是 vite 预打包落盘 `EPERM`（缓存刚被让位、重建期的瞬时竞态），重跑即全过；与代码无关
- [x] 2.3 上游套件全过 — 验证：`npm run test:upstream` 212 passing / 0 failing（先前记录的 2 个上游自身失败在 mocha 12 下消失，单独跑 `pm.test.js` 也是 85 passing / 0 failing）

## 3. 收尾

- [x] 3.1 复查本地解析版本 — 验证：`dompurify@3.4.15`、`crypto-js@4.2.0`、`serialize-javascript@7.1.2` 三处均离开漏洞区间
- [x] 3.2 `openspec validate --changes --strict` 通过 — 验证：命令退出码为 0
