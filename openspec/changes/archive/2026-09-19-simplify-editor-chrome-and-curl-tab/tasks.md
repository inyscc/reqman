## 1. cURL 变为标签

- [x] 1.1 扩展内层标签联合类型加入 `cURL`（`App.tsx` 与 `RequestEditor.tsx` 各有一份同名 `Tab` 声明，两处都要改），并在标签行 Settings 右侧渲染该标签；验证：`npx tsc --noEmit` 无错，打开请求时依次出现 Params、Authorization、Headers、Body、Scripts、Settings、cURL 七个标签
- [x] 1.2 把 `onCurl` 下传到 `RequestEditor` 并让 `useCurlSnapshot` 随之下沉，`RequestBand` 不再持有任何 cURL 状态；验证：`npx tsc --noEmit` 无错，`RequestBand` 的 props 中不再出现 `onCurl`
- [x] 1.3 让 `CurlPanel` 作为标签正文渲染：每次进入标签即重新生成，正文为等宽可编辑文本并撑满正文区，保留「重新生成」与「复制」；验证：`tests/request-editor.test.tsx` 的 cURL 用例改为按标签驱动后全部通过
- [x] 1.4 保持快照语义为"每次进入即重新生成、编辑不跨标签留存"，并覆盖"请求切换后也重新生成"（内层标签停在 cURL 时从树里打开另一条请求）；验证：用例覆盖"切走再切回内容被重新生成"与"切换请求后命令对应当前请求"，且既有「重新生成覆盖编辑」「复制的是改动后的内容」用例仍通过

## 2. 请求带瘦身与解析预览移除

- [x] 2.1 删除请求面板头的「另存为」「删除」「保存」三个按钮与 cURL 入口，保留未保存标记并让其提示说明 `Ctrl+S`；验证：请求带内不存在这三个按钮，改动后未保存标记仍出现
- [x] 2.2 删除 `PreviewStrip.tsx` 与随之成为死代码的 `PreviewBar.tsx`，移除请求带中的预览插槽与 `previewError` 状态（含其赋值；`noUnusedLocals` 下留着会编译不过），`preview` 轮询只保留给只读变量浮层；验证：`npx tsc --noEmit` 无错，地址栏下方不出现解析预览区，未解析变量不再出现在请求带
- [x] 2.3 删除 `ResponsePanel` 中因发送前拦截而失效的 `response.unresolved` 提示；验证：`npx tsc --noEmit` 无错，响应区不再渲染该提示
- [x] 2.4 清理随之失效的样式（`.request-actions`、`.curl-toggle`、`.preview-strip` 及其子规则）；验证：`npm run build` 通过，界面无样式回归

## 3. 集合树右键菜单与复制

- [x] 3.1 为请求节点接入右键入口，弹出与该节点「更多」控件相同的一份菜单并阻止运行环境自带的页面菜单；验证：浏览器用例断言右键出现同一份菜单且原生菜单不出现
- [x] 3.2 在请求节点菜单中新增「复制」，并把现有复制流程改成接受请求 id 的版本（现有实现取的是激活标签的 `draft`，被右键的节点不一定是它）；验证：用例断言复制一条非激活请求后新增内容一致的请求并打开其标签，被右键的原请求与其草稿不受影响
- [x] 3.3 右键菜单复用既有关闭规则（点外部、Esc、滚动）且不改变选中；验证：用例覆盖关闭后树与选中状态回到打开前

## 4. 保存模型

- [x] 4.1 集合/文件夹脚本面板改为编辑即自动保存（防抖、仅在内容变化时写、失败不清空输入并就地提示状态），去掉其保存按钮与未保存徽标，并在每次成功落库后前移基线，使会话标签上的未保存圆点随之消失；验证：用例断言停止输入后 `collection_set_script` / `folder_set_script` 各被调用一次、继续输入会再次写入，且落库后该标签不再显示未保存圆点
- [x] 4.2 设置面板改为编辑即自动保存并去掉「保存策略」按钮；验证：用例断言改动后 `settings_set` 被调用，界面上不再存在保存按钮
- [x] 4.3 让"脏"随基线前移自然消解：落库成功后实体标签与设置面不再显示未保存状态、关闭标签与退出应用不再询问，`Ctrl+S` 在其上成为空操作；落库失败时它们保持脏，守卫照常询问并提供重试。验证：用例覆盖"落库成功后关标签不询问"与"落库失败后关标签会询问"两条路径，且带改动的请求标签仍会询问

## 5. 未解析变量发送前拦截

- [x] 5.1 在 `performSend` 入口以发送时刻的解析结果判定：存在未解析变量则不发送，并把含变量名的错误写入现有错误提示位；验证：用例断言 `sendRequest` 未被调用且错误文案含变量名
- [x] 5.2 脚本门禁放行后的重发路径同样被拦截；验证：用例断言门禁放行后仍未调用 `sendRequest`
- [x] 5.3 无未解析变量时发送行为不变；验证：既有发送相关用例全部通过

## 6. 脚本编辑区

- [x] 6.1 删除请求 Scripts 标签与 `EntityScriptPanel` 中编辑器下方的授权说明段落；验证：两处界面均不再出现该段落
- [x] 6.2 打通高度链使脚本编辑器铺满右栏（容器参与拉伸，滚动交由编辑器自身）；验证：浏览器用例断言编辑器高度接近右栏可用高度
- [x] 6.3 重写长命令的浏览器用例：正文铺满后由正文区自身滚动且不挤压响应区，替换原 220px 高度上限断言；验证：`npm run test:browser` 相关用例通过

## 7. 回归与收尾

- [x] 7.1 更新 `tests/app.test.tsx` 中引用旧交互的用例（另存为、保存入口、解析预览、未解析变量提示）；验证：`npm test` 全部通过
- [x] 7.2 运行 `npx tsc --noEmit`、`npm run build`、`npm run test:browser`；验证：三条命令均无报错
- [x] 7.3 确认后端无需改动（复用既有命令、无新增迁移）并回归后端用例；验证：`cargo test --lib` 281 通过 / 0 失败。
  - 前置条件：`src-tauri/src/testutil.rs` 的 `generate_self_signed` 用 `Command::new("openssl")` 现场签发自签证书，因此这条用例要求 `openssl` 在 PATH 上。PATH 上没有它时，`net::tests::certificate_validation_is_on_by_default_and_can_be_disabled_per_request` 报 `program not found`——是环境缺少这个外部程序，与本次改动无关（本次没有改动任何 Rust 源码）。Git for Windows 自带它，把 `C:\Program Files\Git\usr\bin` 加进 PATH 即可。
