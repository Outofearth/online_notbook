<p align="center">
  <img src="./public/inkstone-logo.svg" width="112" height="112" alt="Inkstone 项目 Logo" />
</p>

<h1 align="center">Inkstone</h1>

<p align="center">
  一套用于写作、整理、同步和备份个人知识的自托管 Markdown 笔记应用。
</p>

<p align="center">
  <a href="./README.en.md">English</a> ·
  <a href="./CONTRIBUTING.md">参与开发</a> ·
  <a href="./LICENSE">LGPL-3.0-only</a> ·
  <a href="https://inkstone-demo.pages.dev/">在线体验</a>
</p>

## 项目简介

Inkstone 是运行在 Cloudflare Workers 上的浏览器笔记本。笔记始终是普通 Markdown 文本；在此基础上，应用提供专注写作、实时预览、关键词与可选语义搜索、双链导航、离线编辑、多设备同步、私有 AI 接入、公开分享和异地备份。

它是一套需要自行部署的完整应用，数据库、附件和运行环境都由部署者掌控。

每个新账号都会自动获得中文版和英文版两篇标准起始笔记。纯前端体验版复用同一份笔记内容，刷新页面后恢复为这两篇起始笔记，不会另外维护一套示例数据。


## 主要功能

| 范围 | 已实现能力 |
| --- | --- |
| 写作 | CodeMirror 6 编辑器、可独立编辑的笔记标题、**桌面双笔记窗格**、各窗格独立的编辑/分栏/预览布局、双向滚动、大纲、**专注模式**、**打字机模式**、**自动保存**、**版本历史** |
| Markdown | GFM 表格与任务列表、脚注、Obsidian 风格注释、WikiLink、嵌入、块 ID、Callout、折叠块、标签页、**数学公式**、**Mermaid**、**PrismJS 代码高亮**、**Front Matter** |
| 整理 | 支持拖拽排序的多级文件夹、正文标签、收藏、置顶、归档、回收站、**Wiki 双链**、反向链接、块引用、笔记嵌入、关系图谱 |
| 搜索 | 基于 D1 FTS5 的全**文搜索**、中文索引、条件筛选、最近笔记、命令面板，以及由 Workers AI 提供的可选私有**语义/混合搜索** |
| **MCP** | 私有远程 MCP、带 PKCE 的 OAuth 2.1、可撤销的 `ink_...` API Key、标准 `search`/`fetch`、分段读取、版本安全写入、独立回收站权限和账号级授权管理 |
| 可靠性 | 可安装 PWA、离线启动、浏览器本地缓存、**离线写入队列与乐观并发控制**、常用操作立即本地生效并可失败回滚、过期同步保护、冲突副本、实时通知和主标签页轮询降级 |
| 分享 | 可设置访问口令和有效期的公开笔记链接 |
| 可迁移性 | JSON 与 ZIP 导出、可直接阅读的 **Markdown**、附件导出、**手动或定时 WebDAV/S3 备份** |
| 界面 | **桌面与移动布局**、**深浅主题**、强调色、简体中文和英文，以及仅站长可见的版本更新提醒 |

## 数据存放位置

| 组件 | 用途 |
| --- | --- |
| Cloudflare D1 | 账号、笔记、文件夹、标签、设置、版本、分享、关键词索引、按账号隔离的 AI 向量和后台索引队列 |
| Cloudflare R2 或 Workers KV | 通过 `FILES` 或 `FILES_KV` 绑定存放附件及上传头像的二进制 |
| Workers KV `OAUTH_KV` | OAuth 客户端注册、授权码、访问令牌、刷新令牌和授权记录；不存放笔记正文 |
| Workers AI `AI` 绑定 | 可选生成语义搜索向量；未配置时继续使用关键词搜索 |
| 浏览器 IndexedDB | 本地缓存与尚未上传的离线写入 |
| `SyncHub` Durable Object | 在线客户端之间的实时变更通知 |
| `CredentialVault` Durable Object | 隔离保存用于加密备份凭据的密钥 |
| WebDAV 或 S3 存储 | 用户自行配置的异地备份 |

## 部署教程

1. Fork Inkstone 仓库到自己的 GitHub 账号
2. 进入 [Cloudflare Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create)
3. 选择 Continue with GitHub 并选择你的仓库
4. 使用 R2 时，构建命令填 `npm run build`，部署命令填 `npm run deploy`
   - 如果你打算用 KV 模式，把部署命令改成 `npm run deploy:kv`
5. 等部署完成后，打开生成的 Workers 域名
6. （推荐）前往 **Settings → Variables and Secrets → Secrets**，设置 `ADMINISTRATOR` / `ADMINPASSWORD` 两个加密 Secret，然后关闭开放注册，改由你在用户管理里建号。详见下方「环境变量」章节。

现有数据库会通过带版本号、可重复安全执行的迁移自动升级。自托管实例更新前仍建议保留一份最新备份；发现新的稳定版本时，只有站长会收到专门的更新提醒，不会打扰普通成员。

## 环境变量

可以在 `wrangler.toml` 的 `[vars]` 里设置，也可以到 Cloudflare Dashboard 的 **Settings → Variables and Secrets** 覆盖。Dashboard 的值优先级始终高于 `wrangler.toml`。

| 变量 | 类型 | 必填 | 默认值 | 用途 |
| --- | --- | --- | --- | --- |
| `APP_NAME` | Variable | 否 | `Inkstone` | 前端 UI 与 meta 标签显示的站点名 |
| **`ADMINISTRATOR`** | **Secret** | 否 | *(无)* | 站长账号的用户名。与 `ADMINPASSWORD` 成对使用，决定哪个账号受配置托管。 |
| **`ADMINPASSWORD`** | **Secret** | 否 | *(无)* | 站长账号的密码。**它就是权威密码**：改这个值会在下次冷启动时覆盖数据库里的密码哈希，并把该账号从所有设备登出。使用 scrypt（`N=16384, r=8, p=5`）哈希，绝不以明文形式存储。 |
| `PUBLIC_URL` | Variable | 否 | *(无)* | 可选的公开域名，用于备份和公开分享生成绝对链接 |

> **两个都必须设置为 Secret**，不要写进 `wrangler.toml` 的 `[vars]`。原因见下方「站长账号由 Cloudflare 配置托管」。

### 站长账号由 Cloudflare 配置托管（ADMINISTRATOR + ADMINPASSWORD）

这两个变量**不是一次性 seed**，而是持续生效的配置来源。每次 Worker 冷启动（每个 isolate 一次，不是每个请求）都会做一次对账：

| 情况 | 行为 |
| --- | --- |
| 账号存在，密码一致且是 owner | 什么都不做 |
| 账号存在，密码**不一致** | 用新密码覆盖哈希，**并撤销该账号全部会话**（否则旧登录仍然有效） |
| 账号存在，但角色不是 owner | 恢复为 owner，避免「配置说是站长、实际没有权限」 |
| 账号不存在，且 `users` 表为空 | 创建为 owner（首次引导） |
| 账号不存在，但实例已有其他用户 | **只记录告警并跳过**，不会创建 —— 防止 `ADMINISTRATOR` 拼错时静默多出一个站长 |

**用户名不会被重命名**：改了 `ADMINISTRATOR` 不会改动已有账号；若指向一个不存在、而实例又非空的名字，只会告警跳过。

**推荐操作（Cloudflare 生产环境）**：
1. Worker → **Settings → Variables and Secrets** → **Secrets**
2. 新增 **`ADMINISTRATOR`**（🔒），填入你选定的用户名
3. 新增 **`ADMINPASSWORD`**（🔒），填入强密码（≥ 8 位）
4. 保存后访问一次站点，对账即生效
5. 想随时换密码，直接改 `ADMINPASSWORD` 即可，无需清库或删账号

> **安全提示**：改了 `ADMINPASSWORD` 就等于改站长密码，请确保你自己记得新值；否则会把自己锁在外面。另外，能修改 Cloudflare Secret 的人本来就等于能接管站长账号 —— 这是把凭据放在部署配置里的固有代价，请保护好你的 Cloudflare 账号。

## 客户端加密备份导出

除了普通的 JSON 和 ZIP 导出，Inkstone 还支持**密码加密**的 ZIP 备份。加密全程发生在浏览器里，Worker 永远拿不到密钥。

| 属性 | 说明 |
| --- | --- |
| 算法 | AES-256-GCM + PBKDF2-SHA256（60 万次迭代，零 npm 依赖） |
| 文件格式 | `.enc` 后缀，魔数头 `INKENC` + 版本字节 + 保留字节 + 16 B salt + 12 B IV + 密文 |
| 密钥派生 | PBKDF2（你的密码 + 每文件随机 salt） |
| 启用位置 | **Settings → 数据 → 导出 → "使用密码加密导出"** |
| 恢复方式 | 回到同一数据页上传 `.enc` 文件并输入密码 — Worker 收到明文 ZIP 后走标准导入流程 |
| 密码策略 | 与登录密码一致，≥ 8 位；弱密码在导出时被拒绝 |
| 安全保证 | 1) 密钥永远不离开浏览器。2) 密码错误会解密失败，不会半导入。3) 密文被篡改会被检测到（AES-GCM 认证标签）。 |

服务端无需额外配置 — 功能直接内置于前端构建产物。

## 站长用户管理（owner 专属）

站长可在 **Settings → 账户 → 访问控制 → 用户管理** 管理所有成员账号。

| 操作 | 入口 | 安全约束 |
| --- | --- | --- |
| **查看列表** | 面板加载时自动拉取 | 仅 owner 可见该面板 |
| **新建成员** | 面板右上角「新建用户」 | 只需填用户名，系统生成**只显示一次**的随机密码；服务端只保存哈希，关闭弹窗后无法再次查看。新账号自动是 member。 |
| **重置密码** | 成员行上的 🔑 按钮 → 确认 | 生成新的随机密码并**立即撤销该成员的全部会话**（否则旧登录仍然有效）。不能对自己使用 —— 自己的密码请走上方「登录安全」区域。 |
| **停用 / 恢复** | 成员行末的 🚫 / ↺ 按钮 → 确认 | 停用后该账号**保留全部笔记和附件**，但立即退出登录且无法再次登录；恢复后可用原密码继续登录。不能停用自己，也不能停用最后一个可用的 owner。 |
| **提升为 owner** | 成员行上的 ⬆ 按钮 | 不能提升/降级自己 |
| **降级为成员** | owner 行上的 ⬇ 按钮 | **最后一个 owner 不能被降级**（系统必须至少保留一个 owner） |
| **删除成员** | 行末 🗑️ 按钮 → 确认 | 不能删除 owner、不能删除自己。该成员名下所有笔记、文件夹、标签、附件、版本、会话、TOTP、OAuth 授权和备份**都会被永久清除**。 |
| **开启/关闭注册** | **Settings → 账户 → 访问控制 → 允许注册** | 仅 owner 可操作、需输入当前密码。开启后，访客登录页会出现注册入口，新账号自动是 **member**（不是 owner）。关闭后，账号只能由站长在用户管理里创建。 |

所有变更服务端都有保护，前端 UI 只是额外的便利层。站长身份完全由 D1 `users.role = 'owner'` 字段决定，不存在额外的 `is_owner` 标志。

### 受配置托管的站长账号

由 `ADMINISTRATOR` 指定的那个账号在整个用户管理界面里是**只读**的：删除、降级、重置密码、停用全部禁用，并标注「由部署配置管理」。原因是它的状态由 Cloudflare 配置对账决定，从界面改也会在下次冷启动被还原。要调整它，请改 Cloudflare 的 Secret。

## 路线图（待实现）

以下是明确尚未实现、但已在规划中的能力：

| 计划 | 说明 | 主要难点 |
| --- | --- | --- |
| **PDF 导入** | 把 PDF 转成 Markdown 笔记，与现有的 `.md/.txt/.docx/.epub/.html` 导入并列 | `pdf.js` 只能提取纯文本，拿不到标题层级、表格和列表结构，导入结果需要接受一定程度的降级 |
| **AI 多轮对话** | 目前的 AI 问答是单轮 RAG；计划加入追问与上下文延续 | 需要为会话历史引入存储（KV 或 Durable Objects），并处理历史裁剪与配额 |
| **笔记内嵌图片自动上传** | 从 `.docx` / `.epub` 解析出的图片直接存入 R2 并改写链接 | 需要在导入流程里接上附件上传与 `import_mappings` 去重，涉及跨端较大的数据流改造 |
| **修改用户名** | 允许站长修改成员的登录名 | 需要处理唯一性冲突、旧用户名遗留入口，以及与受配置托管账号的保护规则冲突 |
| **批量操作** | 用户列表支持多选批量停用/删除 | 依赖停用能力先行落地（已完成），再补多选交互与原子批处理 |

## 导出与备份

- JSON 导出保留可重新导入的旧版结构化笔记数据。
- ZIP 导出与远程备份使用同一套可校验的 Markdown 快照，包含可读正文、归档笔记、回收站笔记、附件和完整性标记。
- 远程备份支持 WebDAV 与 S3 兼容存储，同一快照内内容相同的附件只保存一份。
- 大型备份可直接选择备份文件夹分批恢复，不必把整包一次装入内存。
- 可以配置多个目标，并选择手动执行或定时运行。
- 登录密码、活动会话、分享口令和备份服务凭据不会进入导出文件。

## 开发与验证

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动本地 Worker 和前端 |
| `npm run dev:kv` | 使用 KV 附件配置启动本地环境 |
| `npm run dev:demo` | 启动刷新即重置的纯前端体验版 |
| `./scripts/dev-clean.ps1` | **Windows 专用** — 结束端口 7712 进程、擦除 `.wrangler`、启用临时 D1 启动 `npm run dev`。每次运行都是全新空数据库，适合重置用户或复现 bug。 |
| `npm run typecheck` | 执行 TypeScript 项目检查 |
| `npm run test:unit` | 运行 Vitest 单元测试 |
| `npm run i18n:check` | 检查中英文资源键是否完整一致 |
| `npm run comments:check` | 检查源码注释规范 |
| `npm run build` | 类型检查并生成生产构建 |
| `npm run deploy:kv` | 使用 `wrangler.kv.toml` 构建并部署 |
| `npm run deploy:demo` | 构建并部署纯静态体验版 |
| `npm run test:e2e` | 对正在运行的临时本地实例执行 API 端到端测试 |

端到端脚本会在 `http://localhost:7712` 创建、修改并删除数据，只能对专门用于测试的全新本地状态运行。

## 目录结构

```text
src/
├── client/   React 界面、编辑器、预览和本地状态
├── shared/   共享类型、限制、语言资源和 Markdown 工具
└── worker/   Hono API、认证、D1 访问、同步、分享和备份
public/       静态资源
scripts/      仓库检查与端到端验证脚本
tests/        跨模块回归测试
```

## 安全与参与开发

报告安全问题前请阅读 [`SECURITY.md`](./SECURITY.md)。开发环境和贡献要求见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

## 许可证

Inkstone 使用 [GNU Lesser General Public License v3.0 only](./LICENSE)，SPDX 标识为 `LGPL-3.0-only`。
