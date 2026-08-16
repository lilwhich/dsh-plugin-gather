# my_better-dsh

我的 DeepSeek Harness Web 插件集合包：把已安装的插件封装成一个 bundle，一条命令装齐、自动挂载。

## 包含的插件

| 插件 | 作用 | 版本 |
|---|---|---|
| [dsh-at-file](https://github.com/omdsh-dev/dsh-at-file) | 输入框 `@` 搜索并引用工作区文件/目录 | 0.6.0 |
| [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | VSCode 风格右侧边栏（资源管理器 / 编辑器 / 终端 / Git / 浏览器） | ^0.12.2 |
| [dsh-web-ui 全家桶](https://github.com/zhu1090093659/dsh-web-ui)（`@linxin666/dsh-web-ui-all`） | 梁神模式预设 · 任务看板 · Git 图谱 · 右侧面板 · 移动端远程 · SSH 运维 · 图像理解 · 鲸鱼娘宠物 · 实时吞吐 · 皮肤中心 | ^0.1.16 |

dsh-web-ui 全家桶内部包含（由聚合包 `@linxin666/dsh-web-ui-all` 统一引入）：
`dsh-liangshen` / `dsh-client-ui-task-board` / `dsh-client-ui-git-graph` / `dsh-client-ui-aionui-panel` / `dsh-remote-web-ui` /
`dsh-ssh` / `dsh-tool-describe-image` / `dsh-pet` / `dsh-live-stats` / `dsh-skins` / `dsh-client-ui-skin-center` / `dsh-client-ui-web-ui-settings`

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
- `cordis.patch.yml` 只做一件事：`insert` 各个插件的行（与各插件自己的 patch 完全一致，
  dsh-web-ui 全家桶的行直接镜像 `@linxin666/dsh-web-ui-all` 的 cordis.patch.yml），
  从而把插件挂进 loader 树——client 模块系统按 loader entries 扫描 `dsh.client` 声明，
  因此所有插件的浏览器端代码也会被组合进启动清单；
- `package.json` 的 `dependencies` 让 pnpm 自动拉入全部插件，一条命令装齐。

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
