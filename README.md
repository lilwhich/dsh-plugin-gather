# my_better-dsh

我的 DeepSeek Harness Web 插件集合包 + 账户状态 + Checkpoint/Rollback 快照系统：把已安装的插件封装成一个 bundle，一条命令装齐、自动挂载。

## 自带的 Checkpoint / Rollback 快照系统（本包内置，Phase 1）

**Agent 每次开始运行（准备修改项目文件前）自动创建 Checkpoint**。右侧边栏新增 **CHECKPOINTS** 标签页，可查看快照列表、Files Changed、Diff，并支持**两次确认后恢复**。

- **Git 项目**：直接复用 Git（`git add -A` + `commit` 作为快照；diff 用 `git show`；恢复用 `git reset --hard <commit>`）——不自研、不重复实现。工作区无变化时自动跳过（不产生空快照）
- **非 Git 项目**：**不初始化 Git**，采用兼容方案——把项目文件复制快照到 `~/.dsh/checkpoints/`（自动排除 node_modules/.git/dist/build 等目录），快照间 diff 复用 `git diff --no-index`，恢复会覆盖快照中的文件（不删除快照后新增的文件，属已知限制）
- 快照数据存于 `~/.dsh/checkpoints/<工作区哈希>/index.json`，恢复操作在 UI 中必须经过**二次确认**

## 自带的账户状态功能（本包内置）

- **输入框下方状态栏**（composer dock）：**API 余额**（¥，来自 DeepSeek 真实余额接口 `api.deepseek.com/user/balance`）、**本次已消耗**（余额差值，真实花费）、**当前时段**（高峰/空闲）与**距下次时段切换的倒计时**（官方峰谷定价：高峰=北京时间 9:00-12:00、14:00-18:00，空闲=其余时间，空闲半价；2026-08-17 起生效）
- **输入框内上下文剩余指示**：输入框**未输入文字且光标聚焦**时，在输入框内浮动显示**上下文窗口剩余百分比**（只显示数字，绿/黄/红随剩余量变色；来源为 DSH token-meter 的真实上下文投影）
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

## 安装

**第 0 步（仅手动安装需要）**：在 profile 的 `pnpm-workspace.yaml` 里加一行（一键脚本会自动处理）：

```yaml
blockExoticSubdeps: false
```

然后：

```sh
# 从本仓库安装（GitHub tarball）
dsh plugin --profile web add https://codeload.github.com/lilwhich/my_better-dsh/tar.gz/refs/heads/main
```

装完后**重启 `dsh web`**（或按各插件要求硬刷新浏览器），在「新建会话」或设置页确认插件生效。

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
