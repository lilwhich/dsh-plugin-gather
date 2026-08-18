# dsh-plugin-gather

> **中文 · [English](./README.en.md)**

我的 DeepSeek Harness Web 插件集合包 + 账户状态 + Checkpoint 快照系统：把已安装的插件封装成一个 bundle，一条命令装齐、自动挂载。**自研 UI 全界面中英双语，跟随系统语言自动切换**（系统语言为中文显示中文，其它语言显示 English，切换系统语言实时生效）。

## 💡 为什么选 dsh-plugin-gather？

| 能力 | 原生 dsh web | **dsh-plugin-gather（本包）** |
|------|:------------:|:-------------------------:|
| **🆕 本包独有（7 大功能）** | | |
| VSCode 左侧栏（文件 / 会话 / 大纲） | 无 | ✅ 内置 |
| 账户状态栏（余额 · 消耗 · 峰谷 · 上下文） | 无 | ✅ 内置 |
| 🛡️ 安全模式（删除确认拦截） | 无 | ✅ 内置 |
| 🚚 对话迁徙（Context Handoff，99% token 压缩） | 无 | ✅ 内置 |
| 📸 Checkpoint 快照（Git / 文件双轨） | 无 | ✅ 内置 |
| 👁️ Diff Review（实时行级 LCS diff） | 无 | ✅ 内置 |
| ⚙️ 全局设定（编辑 `~/.dsh/AGENTS.md`） | 无 | ✅ 内置 |
| **📦 精选插件（一条命令装齐）** | | |
| 右侧面板（预览 / 文件树 / SCM） | 无 | ✅ 含 |
| 任务看板（多列 + cron 定时） | 无 | ✅ 含 |
| 实时吞吐（Token 用量 / 统计） | 无 | ✅ 含 |
| 全家桶设置页 | 无 | ✅ 含 |
| 皮肤中心（10 款主题） | 无 | ✅ 含 |
| `@` 引用文件（dsh-at-file） | 无 | ✅ 含 |

> 一句话：**装上 dsh-plugin-gather = 原生 DSH + 13 项增强（7 大本包独有功能 + 6 项精选插件）**，一条命令装齐、自动挂载。

## 自带功能总览（本包内置）

- **输入框下方状态栏（两行式）**（composer dock）：**第一行**为官方运行统计——轮数/步数、LLM 时间、工具调用时间、首 token 平均、TPS、缓存命中、输入/输出 token（完整显示不截断）；**第二行**为本包账户状态——**API 余额**（¥，来自 DeepSeek 真实余额接口 `api.deepseek.com/user/balance`）、**本次已消耗**（余额差值，真实花费）、**当前时段**（高峰/空闲）与**距下次时段切换的倒计时**（官方峰谷定价：高峰=北京时间 9:00-12:00、14:00-18:00，空闲=其余时间，空闲半价；2026-08-17 起生效）、**当前对话剩余上下文窗口**（如 `剩 384K/1M`，绿/黄/红随剩余比例变色）

  ![输入框下方状态栏：运行统计 + 余额 + 峰谷 + 上下文 + 删除时确认](docs/screenshots/02-status-bar.png)
- **输入框内当前对话剩余上下文窗口指示**：输入框**未输入文字且光标聚焦**时，以及**智能体发送消息（回复中）**时，在输入框内浮动显示**当前对话剩余上下文窗口**（如 `剩 384K/1M`，绿/黄/红随剩余比例变色；来源为 DSH token-meter 的真实上下文投影）
- 余额/花费**每 60 秒**通过真实 API 刷新一次（host 侧用 `DEEPSEEK_API_KEY` 凭据调用，密钥不出主机）

  ![左侧栏底部三按钮：删除时确认 / 对话迁徙 / 全局](docs/screenshots/07-bottom-buttons.png)

- **VSCode 风格左侧栏**：左侧边栏分为「📁 文件 / 💬 会话 / 🗂 大纲」三栏（VSCode 活动栏风格）——文件栏点开显示**当前工作区文件树**（懒加载目录，点击文件在右侧边栏打开），会话栏保持原样（会话列表 + 运行/完成状态点，点击切换），大纲栏见下方「对话大纲」

  ![左侧栏文件树与右侧边栏多标签页](docs/screenshots/05-sidebar-layout.png)

  ![会话 ⋯ 菜单：置顶 / 复制路径 / 删除](docs/screenshots/08-session-menu.png)
- **对话大纲（Conversation Outline）**：左侧边栏「🗂 大纲」tab——自动扫描当前会话聊天的**用户消息**生成导航目录（每条用户消息 = 一个节点，标题取消息首句并截断）：**点击节点立即滚动定位**到对应消息并临时高亮（只定位、不改变聊天状态）；**滚动聊天时自动高亮当前阅读段**（绿色圆点 + 背景）；顶部 **🔍 搜索** 可实时过滤节点；长对话列表可滚动，带**始终可见的自定义滚动条**（DSH 默认隐藏原生滚动条）

  ![对话大纲](docs/screenshots/09-outline.png)
- **Checkpoint 快照系统**：

**Agent 每次开始运行（准备修改项目文件前）自动创建 Checkpoint**。右侧边栏新增 **CHECKPOINTS** 标签页，可查看快照列表、Files Changed、Diff，并支持**两次确认后恢复**。

- **Git 项目**：直接复用 Git（`git add -A` + `commit` 作为快照；diff 用 `git show`；恢复用 `git reset --hard <commit>`）——不自研、不重复实现。工作区无变化时自动跳过（不产生空快照）
- **非 Git 项目**：**不初始化 Git**，采用兼容方案——把项目文件复制快照到 `~/.dsh/checkpoints/`（自动排除 node_modules/.git/dist/build 等目录），快照间 diff 复用 `git diff --no-index`，恢复会覆盖快照中的文件（不删除快照后新增的文件，属已知限制）
- 快照数据存于 `~/.dsh/checkpoints/<工作区哈希>/index.json`，恢复操作在 UI 中必须经过**二次确认**
- **全局设定（Global Settings）**：编辑 DSH 的**用户级指令文件 `~/.dsh/AGENTS.md`**（模仿 Claude Code 的 CLAUDE.md）——写在这里的规则**对所有会话生效**（DSH 每次会话启动时把该文件作为工作区指令基线载入；项目目录下的 `AGENTS.md` / `CLAUDE.md` 优先级更高）。**左侧边栏底部「⚙️ 全局」按钮**（齿轮图标 + 汉字，悬停提示「全局设定（对所有会话生效）」，首次使用显示引导气泡并带提示圆点）展开二级菜单（含「全局设定」入口）与右侧边栏「全局设定」标签页均可编辑：Markdown 编辑器 + 保存（原子写入）/ 恢复模板 / 复制路径，未保存内容自动暂存本地，切换标签不丢失；**保存后自动返回上一页**，新会话立即生效、当前会话下一轮自动刷新。

  ![全局设定：编辑 ~/.dsh/AGENTS.md](docs/screenshots/06-global-settings.png)
- **Diff Review（实时改动审查）**：右侧边栏新增「**Diff Review**」标签页——Agent 每次 `read`/`write`/`edit`/`str_replace_editor` 修改文件时，宿主在**工具执行前捕获文件原状态**（`tools/pre-execute`）、执行成功后计算**行级 diff**（LCS 算法，绿=新增 / 红=删除 / 蓝=hunk 头），**实时**显示到面板：**保留最新 6 条，前 2 条展开、更早的自动折叠为摘要行**（点击标题可展开/收起，不堆叠影响查看），最新改动**黄色高亮闪烁**；**客户端常驻轮询**（不依赖标签页是否打开），**每个工作区第一次出现改动时自动打开面板**，标签栏带实时 **+N 未读徽标**；顶部「实时跟随」开关可关；按会话工作区隔离，每 1.5s 轮询 `/my-better-dsh/api/diff-review`。
  ![Diff Review 实时行级 diff](docs/screenshots/04-diff-review.png)
- **Security Mode（安全模式，默认 Full Access Except Delete）**：默认保持**完全访问**——所有读取/创建/修改/重命名/移动文件、终端命令、npm/pip 安装卸载、Git、网络请求、Tool 调用、Checkpoint、配置修改、安装插件、运行脚本**全部自动放行，不弹确认**（与 DSH 原生 danger-full-access 行为一致）；仅在 Agent 执行**删除操作**（删除文件 / 批量删除 / 删除目录）时，在 DSH 官方统一工具入口 `tools/pre-execute` **挂起该工具**并弹出确认框（显示路径列表、批量数量、目录内容统计、删除前已有 Checkpoint 提示），用户点「允许删除 / 取消」后放行或拒绝（拒绝时工具以 `用户拒绝了该删除操作。` 返回给 Agent，任务不中断）。删除识别基于**工具名 + 参数**与 **shell 删除命令解析**（`rm`/`rmdir`/`unlink`、`del`/`erase`/`rd`、`Remove-Item` 及其别名、`.NET [IO.File]::Delete` 等，区分 bash / PowerShell / CMD），**不会**因命令中仅出现 rm/delete/remove 字样就误判（echo、注释、grep、git rm、npm rm 等均不受影响）。模式可经 `GET/POST /my-better-dsh/api/security/mode` 查看/切换（`full-access-except-delete` / `full-access`），开关状态持久化（重启保留）。**独立开关**：左侧栏底部与「🚚 对话迁徙」「⚙️ 全局」并列的「删除时确认」开关（switch 滑块，点击即切、即时生效、全局实时同步，三按钮均分等大）；输入框下方状态栏的「🟢 删除时确认」标签为纯显示。

  ![删除确认弹框](docs/screenshots/03-delete-confirm.png)
- **对话迁徙（Conversation Handoff）**：左侧栏底部「**🚚 对话迁徙**」按钮（与「删除时确认」开关、「⚙️ 全局」按钮并列均分等大）——点击后先弹**二级确认框**（说明：分析当前对话生成 Context Handoff、创建新对话、原对话保持不变），确认后才开始；**复用 DSH 自身 Agent/LLM Runtime**（零新增外部 API / Provider / 模型 / Key）在后台创建一个**内部临时分析会话**（`handoff-<uuid>`，禁止一切工具调用）分析当前 Conversation，生成 **Context Handoff**（当前目标 / 已完成 / 当前进度 / 用户要求 / 用户限制 / 重要决定 / 已修改文件 / 当前问题 / 已失败方案 / Task Board / 下一步 / 最近重要上下文），然后**创建全新的 Conversation**，把 Handoff 作为初始上下文注入（不携带原完整历史，压缩上下文继续工作）。**迁徙上下文预处理**：先把完整对话交给 **host 本地轻量过滤**（不把 800K 原样喂给分析 agent）——保留用户消息/要求/限制、Agent 最终结论、重要 Tool Call/Result、文件路径、错误信息、技术决策、最近若干轮完整；过滤重复工具输出、npm/pip 安装日志、编译日志、被后续消息覆盖的中间信息（错误信息与用户限制**绝不**误删）；已有 DSH compaction 生成的摘要节点直接复用，不重复分析。UI 显示预处理后的**实际分析量估算**（「迁徙完成 · 约 XX tokens」）。过程提示：正在预处理当前对话…… → 正在分析当前对话…… → 正在提取任务状态…… → 正在生成迁徙上下文…… → 迁徙完成；完成后自动打开新对话并在状态栏显示「🚚 已从上一对话迁徙」标记（hover 提示「此对话由 Context Handoff 创建」）。**原 Conversation / Session 完全不变**；临时分析会话结束后自动清理，不显示在会话列表；失败时原对话不受影响，可重试。

  ![对话迁徙二级确认框](docs/screenshots/01-handoff-confirm.png)

## 包含的插件

| 插件 | 作用 | 版本 |
|---|---|---|
| [dsh-at-file](https://github.com/omdsh-dev/dsh-at-file) | 输入框 `@` 搜索并引用工作区文件/目录 | 0.6.0 |
| [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | VSCode 风格右侧边栏（资源管理器 / 编辑器 / 终端 / Git / 浏览器） | ^0.12.2 |
| [dsh-web-ui 精选](https://github.com/zhu1090093659/dsh-web-ui) | 右侧面板 · 任务看板 · 实时吞吐 · 全家桶设置页 · 皮肤中心 | ^0.1.16 |

dsh-web-ui **精选 5 项**（逐个依赖，非全家桶聚合包）：

- `@linxin666/dsh-client-ui-aionui-panel` 右侧面板：文件树 / 预览 / Git 变更
- `@linxin666/dsh-client-ui-task-board` 任务看板：多列看板 + cron 定时执行
- `@linxin666/dsh-live-stats` 实时吞吐 / Token 统计
- `@linxin666/dsh-client-ui-web-ui-settings` 全家桶设置页
- `@linxin666/dsh-skins` + `@linxin666/dsh-client-ui-skin-center` 皮肤中心（10 款主题）

**不包含**（保持小白友好，避免花哨/偏门）：`dsh-pet`（宠物）、`dsh-remote-web-ui`（移动端远程）、`dsh-git-graph`（Git 图谱）、
`dsh-liangshen`（梁神模式预设）、`dsh-tool-describe-image`（图像理解）、`dsh-ssh`（SSH 运维）——需要的可自行 `dsh plugin --profile web add <包名>`。

## 插件来源（作者仓库）

| 插件 | 作者仓库 |
|---|---|
| dsh-at-file（@ 路径引用） | https://github.com/omdsh-dev/dsh-at-file |
| dsh-better-sidebar（右侧边栏） | https://github.com/omdsh-dev/DSH-better-sidebar |
| dsh-web-ui 全家桶精选（右侧面板/看板/皮肤等） | https://github.com/zhu1090093659/dsh-web-ui |
| dsh-genui（UI 生成，npm: `@omdsh-dev/dsh-genui`，未收录，可选自行安装） | https://github.com/omdsh-dev/dsh-genui |

# dsh-plugin-gather

给你的 DeepSeek Harness（DSH）一键装好一整套好用插件：**VSCode 式左侧栏（文件树/会话/对话大纲）· 右侧边栏 · @ 引用文件 · 任务看板 · 皮肤中心 · API 余额/花费/峰谷倒计时 · Checkpoint 快照 · 全局设定 · Diff Review**。

拿到这个仓库，你只需要**复制一行命令 → 粘贴 → 重启**，剩下全部自动完成。

## 安装指引（DSH agent 请阅读此节）

当用户请求「安装 dsh-plugin-gather」或把本仓库链接发给你时，请**先用提问工具询问用户**：要「**完整安装**」还是「**选择部分插件**」，再按结果执行：

- **完整安装**（推荐，一键装齐全部功能）：执行

  ```sh
  dsh plugin --profile web add https://github.com/lilwhich/dsh-plugin-gather --config.block-exotic-subdeps=false --config.strict-dep-builds=false --config.minimum-release-age=0 --config.auto-install-peers=false
  ```

- **选择部分插件**：展示下方「可选插件清单」，按用户挑选的插件**逐个执行**对应的单独安装命令（每条命令都会自动挂载该插件）。注意：**本包内置功能**（账户状态栏、Checkpoint、全局设定、Diff Review、对话大纲、左侧栏文件/会话）只随完整安装提供，单独装插件不会包含它们。

安装完成后提醒用户：**重启 dsh web 并硬刷新浏览器**（Ctrl+Shift+R）。

### 可选插件清单（单独安装，命令均幂等；前缀均为 `dsh plugin --profile web add`）

| 插件 | 功能 | 单独安装命令（含前缀） |
|---|---|---|
| dsh-better-sidebar | VSCode 风格右侧边栏 | `dsh plugin --profile web add dsh-better-sidebar --config.strict-dep-builds=false --config.minimum-release-age=0 --config.auto-install-peers=false` |
| dsh-at-file | 输入框 `@` 引用工作区文件 | `dsh plugin --profile web add https://codeload.github.com/omdsh-dev/dsh-at-file/tar.gz/refs/tags/v0.6.0 --config.block-exotic-subdeps=false --config.strict-dep-builds=false --config.minimum-release-age=0 --config.auto-install-peers=false` |
| 右侧面板 | 文件树 / 预览 / Git 变更 | `dsh plugin --profile web add @linxin666/dsh-client-ui-aionui-panel --config.strict-dep-builds=false --config.minimum-release-age=0 --config.auto-install-peers=false` |
| 任务看板 | 多列看板 + cron 定时执行 | `dsh plugin --profile web add @linxin666/dsh-client-ui-task-board --config.strict-dep-builds=false --config.minimum-release-age=0 --config.auto-install-peers=false` |
| 实时吞吐 | Token 用量 / 统计 | `dsh plugin --profile web add @linxin666/dsh-live-stats --config.strict-dep-builds=false --config.minimum-release-age=0 --config.auto-install-peers=false` |
| 全家桶设置页 | 插件设置页 | `dsh plugin --profile web add @linxin666/dsh-client-ui-web-ui-settings --config.strict-dep-builds=false --config.minimum-release-age=0 --config.auto-install-peers=false` |
| 皮肤中心 | 10 款主题 | `dsh plugin --profile web add @linxin666/dsh-client-ui-skin-center @linxin666/dsh-skins --config.strict-dep-builds=false --config.minimum-release-age=0 --config.auto-install-peers=false` |

## 安装（拿到链接后，跟着做就行）

> 你只做两件事：**① 粘贴一行命令 ② 重启 dsh web**。下载、依赖、挂载全部自动，不用装任何东西、不用改任何配置。

### 🟢 第 1 步：粘贴这一行

在 **Windows PowerShell** 里粘贴并回车：

```powershell
irm https://tinyurl.com/28vgsuk6 | iex
```

> 这条命令会自动完成：下载安装脚本 → 从我的仓库拉取整套插件 → 自动处理 pnpm 依赖/原生模块构建/发布校验 → 写进你的 `web` profile 并挂载。全程无需干预。

**没有 PowerShell？或者更习惯直接在 DSH 里装？** —— 把下面这一整行**发给你的 DSH（在对话里粘贴即可，agent 会帮你执行）**：

```sh
dsh plugin --profile web add https://github.com/lilwhich/dsh-plugin-gather --config.block-exotic-subdeps=false --config.strict-dep-builds=false --config.minimum-release-age=0 --config.auto-install-peers=false
```

### 🟡 第 2 步：重启 `dsh web`

装完后**重启一次**（在运行 dsh web 的终端按 `Ctrl+C`，再运行 `dsh web`），然后浏览器**硬刷新**（`Ctrl+Shift+R`）。

### 🔵 第 3 步：确认装好了

重启后你应该能看到：

- 左侧边栏出现 **「📁 文件 | 💬 会话 | 🗂 大纲」** 切换（文件栏是工作区文件树，会话栏是会话列表，大纲栏是对话大纲）
- 右侧边栏出现 **CHECKPOINTS / Diff Review** 等标签
- 输入框下方出现**两行状态栏**（第一行运行统计：轮数/步数/LLM/工具/首 token/TPS/缓存命中/输入输出；第二行「余额 ¥… · 高峰/空闲 · 距切换 … · 上下文」）
- 输入框输入 `@` 可引用工作区文件

### ❓ 常见问题

| 现象 | 解决 |
|---|---|
| 提示 `dsh` 不是命令 | 先安装 DSH（`npm i -g @deepseek-ai/dsh` 或官方方式），再重跑第 1 步 |
| 提示找不到 profile | 先运行过一次 `dsh web` 再装 |
| 安装报错/网络超时（如 `UND_ERR_DESTROYED`、连接失败） | 网络抖动，**直接重跑一遍安装命令**即可（`dsh plugin add` 幂等，重复执行安全） |
| 装完没看到新功能 | 确认第 2 步的**重启 + 硬刷新**都做了；还没好就在浏览器 Console 看报错 |
| 想更新 | 见下方「更新」 |

## 更新

用**带版本号的 tag URL**（避免 pnpm 对同一 URL 的 tarball 校验和冲突）：

```sh
dsh plugin --profile web add https://codeload.github.com/lilwhich/dsh-plugin-gather/tar.gz/refs/tags/<新版本号> --config.block-exotic-subdeps=false --config.strict-dep-builds=false --config.minimum-release-age=0 --config.auto-install-peers=false
```

> 安装原理：三个 pnpm 11 开关（exotic 依赖 / 构建脚本 / 发布年龄）全部通过命令行 `--config.*` 参数传递，**不修改任何 profile 配置文件**；`dsh-at-file` 未发布 npm，以 codeload tarball 声明（等效官方 archive URL）。

## 原理

- 本包声明 `dsh.bundle.patch` → `cordis.patch.yml`，是合法的 DSH bundle 层；
- `cordis.patch.yml` 只做一件事：`insert` 各个插件的行（与各插件自己的 patch 完全一致），
  从而把插件挂进 loader 树——client 模块系统按 loader entries 扫描 `dsh.client` 声明，
  因此所有插件的浏览器端代码也会被组合进启动清单；
- `package.json` 的 `dependencies` 让 pnpm 自动拉入全部插件，一条命令装齐；
- dsh-web-ui 部分按「逐个依赖」而非聚合包 `@linxin666/dsh-web-ui-all`（它强制拉入全家桶 12 项），
  只保留精选 5 项，未挂载的行不会产生任何 UI 或 client 代码。

## 本地开发 / 测试

```sh
# 从本地目录安装（测试用）
dsh plugin --profile web add file:/path/to/dsh-plugin-gather
# 或
dsh plugin --profile <scratch> add file:/path/to/dsh-plugin-gather
```

## 更新插件版本

改 `package.json` 中对应依赖的版本号，重新执行安装命令即可（`dsh plugin add` 幂等）。

## License

MIT
