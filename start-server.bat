@echo off
chcp 65001 >nul 2>&1
title DS Bridge Server (headless)

rem ===================================================================
rem  无头常驻模式：给「挂服务器 / 手机远程用」准备的启动器。
rem
rem  和 start.bat 的区别：
rem    - DS_HEADLESS=1  浏览器无头运行，不弹任何窗口
rem    - DS_BRIDGE_HOST=0.0.0.0  允许手机/局域网访问
rem    - 认证强制开启（无 key 时拒绝启动，防止把账号暴露给局域网）
rem
rem  登录方式：第一次先在桌面模式（start.bat）里登录一次，
rem  登录态存在 profile 目录里，无头模式直接复用，不用重新登录。
rem ===================================================================

pushd "%~dp0"
set "APP_DIR=%CD%"
set "DS_HEADLESS=1"
set "DS_BRIDGE_HOST=0.0.0.0"

rem ---------- 确保有 API key ----------
node -e "const c=JSON.parse(require('fs').readFileSync('config.json','utf8'));const k=(c.apiKeys||[]).length;if(!k){console.log('[错误] config.json 里没有 apiKeys。先跑一次 node scripts\\init-config.mjs 生成 key，再启动无头模式。');process.exit(1)}" 2>nul
if errorlevel 1 goto fail

echo.
echo  ============================================
echo    DS Bridge - 无头常驻模式
echo  ============================================
echo   局域网地址: http://%COMPUTERNAME%:8788/v1   (手机上填这个)
echo   本机地址:   http://127.0.0.1:8788/v1
echo   认证:       必须带 Authorization: Bearer ^<key^>
echo.
echo   浏览器无头运行，不弹窗口。登录态用 profile 里已保存的。
echo   关闭本窗口 = 停止服务。
echo  ============================================
echo.

node server.mjs

:fail
pause
popd
