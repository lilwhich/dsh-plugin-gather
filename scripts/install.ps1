# my_better-dsh 一键安装脚本（Windows PowerShell）
#
# 用法：
#   # 从 GitHub 安装（默认）
#   irm https://raw.githubusercontent.com/lilwhich/my_better-dsh/main/scripts/install.ps1 | iex
#   # 从本地目录安装
#   powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Source file:C:\path\to\my_better-dsh
#   # 只预览
#   powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -DryRun
param(
  [string]$Source = 'https://codeload.github.com/lilwhich/my_better-dsh/tar.gz/refs/heads/main',
  [string]$Profile = 'web',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$DSH_HOME = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$PROFILE_DIR = Join-Path $DSH_HOME "profiles\$Profile"

if (-not (Test-Path $PROFILE_DIR)) { Write-Error "找不到 profile 目录：$PROFILE_DIR（请先运行过一次 dsh web）" }

# 放行原生模块构建脚本（node-pty/protobufjs），pnpm 11 默认拦截
$ws = Join-Path $PROFILE_DIR 'pnpm-workspace.yaml'
$t = Get-Content $ws -Raw
if ($t -notmatch '(?m)^\s*allowBuilds:\s*$') {
  $t += "`nallowBuilds:`n  node-pty: true`n  protobufjs: true`n"
}
if ($t -notmatch '(?m)^\s*-\s+my_better-dsh\s*$') {
  $t += "`nminimumReleaseAgeExclude:`n  - my_better-dsh`n"
}
Set-Content -Path $ws -Value $t -Encoding UTF8

if ($DryRun) {
  Write-Host "[dry-run] dsh plugin --profile $Profile add $Source"
  exit 0
}

Write-Host "安装 $Source -> profile $Profile ..."
dsh plugin --profile $Profile add $Source
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '安装完成。请重启 dsh web（或硬刷新浏览器）使插件生效。'
