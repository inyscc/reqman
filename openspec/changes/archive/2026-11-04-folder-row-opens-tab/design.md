# Design

## D1 行单击只保留「打开」，折叠交给箭头

`WorkspaceTree.tsx` 的行 `onClick` 现在连着调两件事：`actions.onToggle(id)` 与 `actions.onSelectEntity(entity)`。去掉前者即可，后者本来就走 `openEntity`：标签已存在时只 `setActiveTabKey`，不存在才拉 `folderGet` 并插入。

选择「箭头是唯一折叠入口」而不是「单击折叠、箭头也折叠」的双入口，是因为后者无法表达「我只想看看、别动树」——两个入口做同一件事，等于没有选择权。VS Code 的资源管理器就是这个模型：点文件/文件夹 = 打开，点箭头 = 展开。

## D2 已折叠的目录被单击后仍保持折叠

不采用「打开顺带展开」的折中。理由：那样单击的第二个效果回来了，只是换了个条件（折叠态下才展开），用户依旧无法预测「这一击会不动树」。要展开就点箭头，规则只有一条。

## D3 双击的第二击仍按 `detail === 2` 忽略

原来的作用是防「展开后又折回」的闪烁，去掉折叠后这个作用消失，但守卫要留：`openEntity` 是异步的（要 `await client.folderGet`），两次派发会在标签插入前同时通过「标签是否已存在」的检查，可能插出两个标签。守卫的注释随之改写。

## D4 键盘 Enter 同步收窄

`onKeyDown` 里 Enter 的分支与 `onClick` 是同一段逻辑，同样去掉 `onToggle`。行内控件（箭头、「⋯」、菜单项）的 keydown 依旧被 `event.target === event.currentTarget` 挡在外面。

## D5 搜索态不受影响

搜索态下折叠箭头本来就是 `disabled`，行单击只打开面板——去掉 `onToggle` 之后，这一路甚至不再需要「搜索态下 onToggle 是空操作」这句解释了。规格里保留该场景，是因为它同时约束了「命中项保持可见」。
