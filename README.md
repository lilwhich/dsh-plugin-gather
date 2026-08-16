# my_better-dsh

我的 DeepSeek Harness Web 插件集合包 + 账户状态 + Checkpoint/Rollback 快照系统：把已安装的插件封装成一个 bundle，一条命令装齐、自动挂载。

## 自带功能总览（本包内置）

- **VSCode 三栏式左侧栏**：左侧边栏分为「📁 文件 / 💬 会话」两栏（VSCode 活动栏风格）——文件栏点开显示**当前工作区文件树**（懒加载目录，点击文件在右侧边栏打开），会话栏保持原样（会话列表 + 运行/完成状态点，点击切换）
- **Checkpoint / Rollback 快照系统（Phase 1）**：

**Agent 每次开始运行（准备修改项目文件前）自动创建 Checkpoint**。右侧边栏新增 **CHECKPOINTS** 标签页，可查看快照列表、Files Changed、Diff，并支持**两次确认后恢复**。

- **Git 项目**：直接复用 Git（`git add -A` + `commit` 作为快照；diff 用 `git show`；恢复用 `git reset --hard <commit>`）——不自研、不重复实现。工作区无变化时自动跳过（不产生空快照）
- **非 Git 项目**：**不初始化 Git**，采用兼容方案——把项目文件复制快照到 `~/.dsh/checkpoints/`（自动排除 node_modules/.git/dist/build 等目录），快照间 diff 复用 `git diff --no-index`，恢复会覆盖快照中的文件（不删除快照后新增的文件，属已知限制）
- 快照数据存于 `~/.dsh/checkpoints/<工作区哈希>/index.json`，恢复操作在 UI 中必须经过**二次确认**
- **全局设定（Global Settings）**：编辑 DSH 的**用户级指令文件 `~/.dsh/AGENTS.md`**（模仿 Claude Code 的 CLAUDE.md）——写在这里的规则**对所有会话生效**（DSH 每次会话启动时把该文件作为工作区指令基线载入；项目目录下的 `AGENTS.md` / `CLAUDE.md` 优先级更高）。**左侧边栏右下角「⚙️ 全局设定」文字按钮**（悬停提示「全局设定（对所有会话生效）」，首次使用显示引导气泡并带提示圆点）展开二级菜单（含「全局设定」入口）与右侧边栏「全局设定」标签页均可编辑：Markdown 编辑器 + 保存（原子写入）/ 恢复模板 / 复制路径，未保存内容自动暂存本地，切换标签不丢失；**保存后自动返回上一页**，新会话立即生效、当前会话下一轮自动刷新。
- **Diff Review（实时改动审查）**：右侧边栏新增「**Diff Review**」标签页——Agent 每次 `read`/`write`/`edit`/`str_replace_editor` 修改文件时，宿主在**工具执行前捕获文件原状态**（`tools/pre-execute`）、执行成功后计算**行级 diff**（LCS 算法，绿=新增 / 红=删除 / 蓝=hunk 头），**实时**显示到面板：最新改动**黄色高亮闪烁**、列表自动滚动跟随；顶部「实时跟随」开关可关（关闭后新改动累计为 **+N 未读数**）；按会话工作区隔离，每 1.5s 轮询 `/my-better-dsh/api/diff-review`。

## 自带的账户状态功能（本包内置）

- **输入框下方状态栏**（composer dock）：**API 余额**（¥，来自 DeepSeek 真实余额接口 `api.deepseek.com/user/balance`）、**本次已消耗**（余额差值，真实花费）、**当前时段**（高峰/空闲）与**距下次时段切换的倒计时**（官方峰谷定价：高峰=北京时间 9:00-12:00、14:00-18:00，空闲=其余时间，空闲半价；2026-08-17 起生效）
- **输入框内当前对话剩余上下文窗口指示**：输入框**未输入文字且光标聚焦**时，以及**智能体发送消息（回复中）**时，在输入框内浮动显示**当前对话剩余上下文窗口**（如 `剩 384K/1M`，绿/黄/红随剩余比例变色；来源为 DSH token-meter 的真实上下文投影）
- 余额/花费**每 60 秒**通过真实 API 刷新一次（host 侧用 `DEEPSEEK_API_KEY` 凭据调用，密钥不出主机）

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

## 安装（零配置，一个链接）

**方式一（推荐 · 一条命令，无需任何配置）** —— Windows PowerShell：

```powershell
irm https://tinyurl.com/2927jusc | iex
```

（等价完整地址：`irm https://raw.githubusercontent.com/lilwhich/my_better-dsh/main/scripts/install.ps1 | iex`）

**方式二（DSH 原生 · 一个链接）** —— 直接给别人的 DSH 执行：

```sh
dsh plugin --profile web add https://codeload.github.com/lilwhich/my_better-dsh/tar.gz/refs/tags/v0.8.6 --config.block-exotic-subdeps=false --config.strict-dep-builds=false --config.minimum-release-age=0
```

> 三种 pnpm 11 开关（exotic 依赖 / 构建脚本 / 发布年龄）全部走命令行 `--config.*` 参数，**不修改任何 profile 配置文件**，任何人复制即装。

装完后**重启 `dsh web`**（或硬刷新浏览器）生效。

**更新**：用**带版本号的 tag URL**（避免 pnpm 对同一 URL 的 tarball 校验和冲突）：

```sh
dsh plugin --profile web add https://codeload.github.com/lilwhich/my_better-dsh/tar.gz/refs/tags/<新版本号> --config.block-exotic-subdeps=false --config.strict-dep-builds=false --config.minimum-release-age=0
```

> 说明：`dsh-at-file` 未发布到 npm，依赖以 codeload GitHub tarball 形式声明（等效于官方 README 的 archive URL）。
> pnpm 11 默认禁止「URL 规格的传递依赖」（`blockExoticSubdeps`），安装前需在 profile 的 `pnpm-workspace.yaml`
> 写入 `blockExoticSubdeps: false`——`scripts/install.ps1` 会自动处理；手动安装请按「安装」节第 0 步先执行。

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
dsh plugin --profile web add file:/path/to/my_better-dsh
# 或
dsh plugin --profile <scratch> add file:/path/to/my_better-dsh
```

## 更新插件版本

改 `package.json` 中对应依赖的版本号，重新执行安装命令即可（`dsh plugin add` 幂等）。

## License

MIT
