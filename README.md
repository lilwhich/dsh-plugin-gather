# my_better-dsh

我的 DeepSeek Harness Web 插件集合包：把已安装的插件封装成一个 bundle，一条命令装齐、自动挂载。

## 包含的插件

| 插件 | 作用 | 版本 |
|---|---|---|
| [dsh-at-file](https://github.com/omdsh-dev/dsh-at-file) | 输入框 `@` 搜索并引用工作区文件/目录 | 0.6.0 |
| [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | VSCode 风格右侧边栏（资源管理器 / 编辑器 / 终端 / Git / 浏览器） | ^0.12.2 |

## 安装

```sh
# 从本仓库安装（GitHub tarball）
dsh plugin --profile web add https://codeload.github.com/lilwhich/my_better-dsh/tar.gz/refs/heads/main
```

装完后**重启 `dsh web`**（或按各插件要求硬刷新浏览器），在「新建会话」或设置页确认插件生效。

> 说明：`dsh-at-file` 未发布到 npm，依赖以 codeload GitHub tarball 形式声明（等效于官方 README 的 archive URL，且在该网络环境可访问）。

## 原理

- 本包声明 `dsh.bundle.patch` → `cordis.patch.yml`，是合法的 DSH bundle 层；
- `cordis.patch.yml` 只做一件事：`insert` 两个插件的行（与各插件自己的 patch 完全一致），
  从而把 `dsh-at-file` 与 `dsh-better-sidebar` 挂进 loader 树——client 模块系统按 loader entries
  扫描 `dsh.client` 声明，因此两个插件的浏览器端代码也会被组合进启动清单；
- `package.json` 的 `dependencies` 让 pnpm 自动拉入两个插件，一条命令装齐。

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
