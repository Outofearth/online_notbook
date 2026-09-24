# 一键干净启动: 清 miniflare 本地状态 + 用临时 D1 数据库启动 dev
# 每次运行都是全新空库，方便首次注册 / 重置用户等场景
# 用法: PowerShell 中直接执行 ./scripts/dev-clean.ps1

$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot\..

Write-Host "`n🗑️  清理 miniflare 本地状态..." -ForegroundColor Cyan

# 杀掉可能占用端口的旧进程
$old = Get-NetTCPConnection -LocalPort 7712 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
if ($old) {
    foreach ($pid in $old) {
        Write-Host "   杀掉旧进程 PID=$pid" -ForegroundColor Yellow
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
}

# 清 .wrangler 目录 (miniflare 持久化存储)
if (Test-Path '.wrangler') {
    Remove-Item -Recurse -Force '.wrangler' -ErrorAction SilentlyContinue
    if (Test-Path '.wrangler') {
        Write-Host "   ⚠️  .wrangler 被占用，尝试强制删除..." -ForegroundColor Yellow
        Get-ChildItem '.wrangler' -Recurse -Force -ErrorAction SilentlyContinue | Remove-Item -Force -Recurse -ErrorAction SilentlyContinue
        Remove-Item '.wrangler' -Force -ErrorAction SilentlyContinue
    }
}

# 设置临时 D1 模式 (persistState=false → 每次都是全新空库)
$env:INKSTONE_EPHEMERAL_DEV = '1'

Write-Host "✅ 清理完成，INKSTONE_EPHEMERAL_DEV=1" -ForegroundColor Green
Write-Host "🚀 启动 vite dev server (端口 7712, Ctrl+C 退出)...`n" -ForegroundColor Cyan

npm run dev
