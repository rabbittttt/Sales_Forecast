@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
call "%~dp0静态网页\运行静态销量预测.bat" %*
exit /b %errorlevel%
