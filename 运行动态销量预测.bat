@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
call "%~dp0动态网页\运行动态销量预测.bat" %*
exit /b %errorlevel%
