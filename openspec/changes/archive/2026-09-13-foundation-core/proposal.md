## Why

`rodemap` 定义了 12 个功能域、172 条需求（其中功能需求 115 条）的离线 Postman 类桌面工具，而代码库目前仍是未经改动的 Tauri v2 官方模板（Rust 侧只有一个 `greet` demo，前端是欢迎页，没有数据库、没有网络层、没有变量层）。

后续的集合树、请求编辑器、导入导出、脚本沙箱、集合运行器全部建立在三个地基能力之上：**数据怎么存**、**变量怎么解析**、**请求怎么发**。这三者互相咬合（HTTP 引擎依赖变量解析，变量解析依赖作用域真值，存储 schema 必须预知请求/响应形状），必须一次性设计，否则会按想象定 schema，再回头返工。本变更交付这一层地基。

## What Changes

- 新增 **本地存储**：SQLite 落盘，覆盖工作区、集合、文件夹、请求、环境与变量（含工作区级全局变量），以及全局代理一类的应用级设置；支持 schema 版本迁移与数据库备份恢复。
- 新增 **变量引擎**：实现 `local > data > environment > collection > global` 的作用域优先级，`{{var}}` 与路径变量 `:id` 的替换，动态变量，以及未解析变量与 secret 掩码的处理。
- 新增 **HTTP 引擎**：由 Rust 侧发起请求，覆盖方法、query、headers、各类 body、超时/重定向/证书校验开关、三级代理、基础认证，并返回受体积上限保护的响应元数据与内容。
- 收敛 **安全边界**：前端不获得文件系统、shell 或通用网络权限，所有网络、文件、数据库访问经由白名单化的 Rust 命令；敏感值不以明文落库或写入日志；主窗口 CSP 收紧。该边界不单列能力，分别落在 `storage-foundation` 的「存储访问边界」与 `http-engine` 的「网络访问边界」两条需求中。
- 排除在本变更之外（属后续 change）：集合树与请求编辑器的可视化界面、Postman v2.0/v2.1 导入导出、`pm.*` 脚本沙箱与集合运行器、Cookie Jar、mTLS、OAuth 2.0 与 OAuth 1.0、Digest、NTLM、AWS SigV4、JWT、历史记录界面、响应保存为示例、Mock、CLI。

## Capabilities

### New Capabilities

- `storage-foundation`: 本地持久化契约——工作区/集合/文件夹/请求/环境的创建与组织关系、工作区级全局变量与应用设置的持久化、schema 迁移与备份恢复、敏感值的存储与脱敏边界。
- `variable-engine`: 变量解析契约——五个作用域及其优先级、`{{var}}` 与 `:path` 替换、动态变量生成、未解析变量的可观察表现、初始值与当前值、secret 变量的掩码。
- `http-engine`: 请求执行契约——方法、URL 与 query、headers、body 类型、请求级网络设置（超时/重定向/证书校验/HTTP 版本/代理）、认证方式、响应元数据与内容、体积上限与错误呈现。

### Modified Capabilities

无。项目当前没有任何已归档的能力规格。

## Impact

- **代码**：`src-tauri/src/` 由单文件 demo 扩展为存储、变量、网络三个模块并注册对应 command；`src/` 从模板页改为可调用这些 command 的骨架。
- **依赖**：Rust 侧新增 HTTP 客户端、异步运行时、SQLite、TLS 与密钥存储相关 crate；前端新增状态管理与请求调用所需的库。
- **配置**：`tauri.conf.json` 的安全策略（CSP、外部导航）收紧；`capabilities/default.json` 收敛为最小权限白名单。
- **数据**：首次启动创建本地数据库文件并执行初始 schema，需要定义迁移与备份恢复路径。
- **兼容性**：本变更不触及任何已发布接口，无破坏性变更。
