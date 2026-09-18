# ui-layout

## Purpose

应用主界面的整体布局与外观：侧栏以两个内部 tab（Collections / Environments）承载导航，主区左侧为请求区、右侧为响应区（响应栏仅在选中请求时出现），低频面板（Cookie / 设置 / 导入导出）模态化，并提供底部状态条与浅色配色。

## ADDED Requirements

### Requirement: 侧栏双 tab

应用 SHALL 在侧栏顶部呈现恰好两个内部 tab：Collections 与 Environments；两个 tab 的内容互斥，默认显示 Collections。侧栏 SHALL NOT 提供工作区切换界面，应用固定使用当前激活工作区。

#### Scenario: 默认进入 Collections tab

- **WHEN** 应用启动且数据加载完成
- **THEN** 侧栏显示 Collections tab 的集合树

#### Scenario: 切换到 Environments tab

- **WHEN** 用户点击 Environments tab
- **THEN** 侧栏显示环境列表与变量区域，集合树不再显示

#### Scenario: 无工作区切换界面

- **WHEN** 应用启动
- **THEN** 界面中不存在工作区选择器，且集合树来自当前激活工作区

### Requirement: Collections tab 承载集合树

Collections tab SHALL 承载集合树，并保留既有交互：选中请求在主区打开编辑器；选中集合/文件夹在主区打开实体脚本面板；支持新建集合、新建请求、删除集合。

#### Scenario: 选中请求

- **WHEN** 用户在集合树中点击一个请求节点
- **THEN** 主区请求区打开该请求的编辑器

#### Scenario: 新建请求

- **WHEN** 用户在集合或文件夹节点上触发新建请求
- **THEN** 新请求出现在树中，并被选中打开

### Requirement: Environments tab 承载环境列表与变量

Environments tab SHALL 提供环境列表与一个固定的 Globals 项；点击环境项将其激活并显示该环境的变量，点击 Globals 显示全局变量并取消环境激活。变量的增删、secret 揭示等语义沿用既有 variable-engine 能力。

#### Scenario: 激活环境

- **WHEN** 用户在环境列表中点击一个环境
- **THEN** 该环境成为激活环境，变量区域显示该环境的变量，后续请求解析与发送使用该环境

#### Scenario: 切到 Globals

- **WHEN** 用户点击 Globals 项
- **THEN** 取消环境激活，变量区域显示全局变量

#### Scenario: 无环境选择下拉

- **WHEN** 界面渲染完成
- **THEN** 界面中不存在独立的环境选择下拉框

### Requirement: 主区左右分栏与响应栏可见性

主区 SHALL 将请求区置于左、响应区置于右，两列比例为固定值，不提供分隔线拖拽。响应区 SHALL 仅在**选中请求**时出现；未选中请求（包括选中的是集合或文件夹）时请求区 SHALL 独占主区整宽。

#### Scenario: 选中请求后右侧出现响应栏

- **WHEN** 用户选中一个请求
- **THEN** 主区左侧为请求编辑器、右侧为响应区；尚未发送时响应区显示空态

#### Scenario: 未选中请求时请求区独占整宽

- **WHEN** 用户未选中任何请求，或选中的是集合/文件夹
- **THEN** 界面不显示响应区，请求区（或实体脚本面板）占据主区整宽

#### Scenario: 分隔线不可拖拽

- **WHEN** 界面渲染完成
- **THEN** 不存在可拖拽的分隔线控件

### Requirement: 会话标签视觉壳

主区顶部 SHALL 呈现一行会话标签区域，其中始终只有一个标签，显示当前请求的方法与名称；不提供多标签打开。

#### Scenario: 选中请求时标签随行

- **WHEN** 用户选中一个请求
- **THEN** 会话标签显示该请求的方法徽标与名称

#### Scenario: 无选中请求

- **WHEN** 没有任何请求被选中且未选中集合/文件夹
- **THEN** 会话标签区域显示空态占位

### Requirement: 面包屑与请求操作行

主区 SHALL 在会话标签下方呈现面包屑（所属集合名 / 请求名）与请求级操作：保存、另存为、删除。

#### Scenario: 显示面包屑

- **WHEN** 用户选中一个请求
- **THEN** 面包屑显示该请求所属集合名与请求名

#### Scenario: 保存请求

- **WHEN** 用户修改请求后点击保存
- **THEN** 请求被持久化，未保存标记消失

### Requirement: 地址栏与解析预览条

请求区 SHALL 提供方法选择 + URL 输入 + 发送按钮的地址栏，URL 中的 `{{var}}` 占位符以高亮样式呈现。地址栏下一行 SHALL 为可折叠的解析预览条，默认展开；未解析变量警告 SHALL 常驻可见。

#### Scenario: 解析预览默认可见

- **WHEN** 用户选中或编辑一个请求
- **THEN** 地址栏下方的预览条展示解析后的方法与 URL

#### Scenario: 折叠与展开

- **WHEN** 用户点击预览条的折叠控件
- **THEN** 预览条收起，仅保留折叠控件；再次点击恢复展开

#### Scenario: 未解析变量警告常驻

- **WHEN** 请求中存在无法解析的变量，且用户折叠了预览条
- **THEN** 未解析变量警告仍然可见，提示保留 `{{name}}` 原文

### Requirement: 请求标签命名

请求编辑器的标签 SHALL 命名为 Params、Authorization、Headers、Body、Scripts、Settings。

#### Scenario: 标签集完整

- **WHEN** 用户打开一个请求
- **THEN** 请求区依次显示 Params、Authorization、Headers、Body、Scripts、Settings 六个标签

### Requirement: 低频面板模态化

Cookie、设置、导入导出 SHALL 通过底部状态条上的按钮以模态弹窗打开；同一时间至多一个模态打开，且模态可关闭。

#### Scenario: 打开导入导出模态

- **WHEN** 用户点击底栏的导入导出按钮
- **THEN** 模态弹窗显示导入导出面板，其余界面被遮挡

#### Scenario: 关闭模态

- **WHEN** 用户触发模态的关闭操作
- **THEN** 模态消失，界面回到打开前的状态

### Requirement: 底部状态条

应用 SHALL 在主界面底部提供状态条，承载 Cookie、设置、导入导出三个模态入口按钮；状态条左侧区域用于展示状态与提示信息。

#### Scenario: 状态条常显

- **WHEN** 应用启动
- **THEN** 底部状态条可见，并包含三个模态入口按钮

### Requirement: 浅色配色

界面 SHALL 采用浅色配色：面板与输入区为白/浅灰底、深色文字、蓝色主色；应用 SHALL NOT 提供深色变体或主题切换。承载响应文档的沙箱预览不受此约束。

#### Scenario: 启动即为浅色

- **WHEN** 应用启动
- **THEN** 界面以浅色呈现（浅底深字、蓝色主色），不存在深色配色分支，也不存在主题切换控件

#### Scenario: 状态色在浅底上可读

- **WHEN** 出现未解析变量警告、请求错误或响应状态徽标
- **THEN** 警告、错误与成功三种状态色在浅色底上均可辨识
