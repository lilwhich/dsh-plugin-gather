# my_better-dsh 一键安装脚本（Windows PowerShell）
#
# 零配置安装：不修改任何 profile 配置文件——所有 pnpm 开关都通过命令行
# --config.* 参数传递，任何人复制一行即可完成安装。
#
# 用法：
#   # 一条命令（推荐，无需任何前置配置）
#   irm https://raw.githubusercontent.com/lilwhich/my_better-dsh/main/scripts/install.ps1 | iex
#   # 或直接用下面的 dsh 命令（等价的"一个链接"方式）
#   dsh plugin --profile web add https://codeload.github.com/lilwhich/my_better-dsh/tar.gz/refs/tags/v0.8.6 --config.block-exotic-subdeps=false --config.strict-dep-builds=false --config.minimum-release-age=0
#   # 从本地目录安装
#   powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Source file:C:\path\to\my_better-dsh
param(
  [string]$Source = 'https://codeload.github.com/lilwhich/my_better-dsh/tar.gz/refs/tags/v0.8.6',
  [string]$Profile = 'web',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$DSH_HOME = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$PROFILE_DIR = Join-Path $DSH_HOME "profiles\$Profile"

if (-not (Test-Path $PROFILE_DIR)) { Write-Error "找不到 profile 目录：$PROFILE_DIR（请先运行过一次 dsh web）" }

# pnpm 11 开关全部走命令行参数，不写入任何配置文件：
#   block-exotic-subdeps=false  放行 URL 规格的传递依赖（dsh-at-file 未发布 npm）
#   strict-dep-builds=false     被忽略的原生模块构建脚本只告警、不失败（node-pty 自带预编译）
#   minimum-release-age=0       放行发布不足 24h 的新包
$FLAGS = '--config.block-exotic-subdeps=false --config.strict-dep-builds=false --config.minimum-release-age=0'

if ($DryRun) {
  Write-Host "[dry-run] dsh plugin --profile $Profile add $Source $FLAGS"
  exit 0
}

Write-Host "安装 $Source -> profile $Profile ..."
$cmd = "dsh plugin --profile $Profile add `"$Source`" $FLAGS"
Invoke-Expression $cmd
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host '安装完成 ✅ 请重启 dsh web（或硬刷新浏览器）使插件生效。'
Write-Host '功能：左侧栏文件树/会话 · 右侧边栏 · @引用文件 · 余额/花费/峰谷倒计时 · Checkpoint 快照回滚'
