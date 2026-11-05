# 任务

## 1 修复

- [x] 1.1 `CodeSurface` 打开 `fixedOverflowWidgets`，并把原注释里「会错位」的推测换成实测结论
- [x] 1.2 在真实应用里核对：面板贴光标、溢出请求区完整可见、插入写回正确

## 2 验证

- [x] 2.1 新增浏览器用例 `variable-suggest.spec.ts`「窗口变窄时列表仍完整可见，不被请求区裁掉右半边」
- [x] 2.2 反证：把开关改回 `false`，该用例失败（四角 `[true, false, true, false]`）
- [x] 2.3 `code-surface` / `variable-hover-tip` / `variable-suggest-body` / `variable-suggest` 并行复跑
- [x] 2.4 `tsc --noEmit`、`npm test`、`npm run build`
