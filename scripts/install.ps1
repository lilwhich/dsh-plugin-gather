# dsh-plugin-gather 一键安装脚本（Windows PowerShell / PowerShell 7）
#
# 零配置安装：不修改任何 profile 配置文件——所有 pnpm 开关都通过命令行
# --config.* 参数传递，任何人复制一行即可完成安装。
#
# 用法（推荐，无需任何前置配置）：
#   irm https://tinyurl.com/22ve2mv5 | iex
# 或直接用等价的 dsh 命令（"一个链接"方式）：
#   dsh plugin --profile web add https://codeload.github.com/lilwhich/dsh-plugin-gather/tar.gz/refs/tags/v0.9.6 --config.block-exotic-subdeps=false --config.strict-dep-builds=false --config.minimum-release-age=0 --config.auto-install-peers=false
# 从本地目录安装（注意：-File 直读请用 PowerShell 7；Windows PowerShell 5.1 会把无 BOM 的 UTF-8 中文当 GBK 解析）：
#   pwsh -ExecutionPolicy Bypass -File scripts/install.ps1 -Source file:C:\path\to\dsh-plugin-gather
#
# 重要：本文件必须保持 UTF-8 无 BOM。
#   - 有 BOM 时（EF BB BF），irm | iex 得到的字符串以 U+FEFF 开头，PowerShell
#     无法识别脚本开头的 param()/注释/赋值，整段脚本解析失败；
#   - 无 BOM 时 iex 一切正常，因为 Invoke-WebRequest 已按 UTF-8 解码正文。
param(
  [string]$Source = 'https://codeload.github.com/lilwhich/dsh-plugin-gather/tar.gz/refs/tags/v0.9.6',
  [string]$Profile = 'web',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$DSH_HOME = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$PROFILE_DIR = Join-Path $DSH_HOME "profiles\$Profile"

if (-not (Test-Path $PROFILE_DIR)) { Write-Error "找不到 profile 目录：$PROFILE_DIR（请先运行过一次 dsh web）" }

# pnpm 11 开关全部走命令行参数，不写入任何配置文件：
#   block-exotic-subdeps=false   放行 URL 规格的传递依赖（dsh-at-file 未发布 npm）
#   strict-dep-builds=false      被忽略的原生模块构建脚本只告警、不失败（node-pty 自带预编译）
#   minimum-release-age=0        放行发布不足 24h 的新包
#   auto-install-peers=false     不自动安装 peer 依赖。dsh-better-sidebar 的 @deepseek-ai peer
#                                声明为 ^0.1.0-rc.6，但上游只发布了 rc 版本且无稳定版；
#                                pnpm 11 的 peer 自动安装会把它按稳定范围(>=0.1.0 <0.2.0)匹配而
#                                直接失败（ERR_PNPM_NO_MATCHING_VERSION）。关掉后与线上 profile
#                                行为一致：peer 由 base/web-app bundle 已带的版本满足，缺的
#                                (如 dsh-settings) 运行时并不需要，实测可正常启动。
# 必须调用 dsh.cmd（而非 PowerShell 里的 dsh.ps1）：
# PowerShell 参数绑定会把 --config.* 当作命名参数解析而报错；
# .cmd 垫片把参数原样透传给 node，行为与命令行手敲完全一致。
$dshCmd = (Get-Command dsh.cmd -ErrorAction SilentlyContinue).Source
if (-not $dshCmd) { $dshCmd = 'dsh.cmd' }

$FLAGS = @(
  '--config.block-exotic-subdeps=false'
  '--config.strict-dep-builds=false'
  '--config.minimum-release-age=0'
  '--config.auto-install-peers=false'
)

if ($DryRun) {
  Write-Host "[dry-run] & $dshCmd plugin --profile $Profile add $Source $($FLAGS -join ' ')"
  exit 0
}

Write-Host "安装 $Source -> profile $Profile ..."
& $dshCmd plugin --profile $Profile add $Source @FLAGS
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host '安装完成 ✅ 请重启 dsh web（或硬刷新浏览器）使插件生效。'
Write-Host '功能：左侧栏文件树/会话 · 右侧边栏 · @引用文件 · 余额/花费/峰谷倒计时 · Checkpoint 快照'
