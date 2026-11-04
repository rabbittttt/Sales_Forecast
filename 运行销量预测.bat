@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title 销量预测
cd /d "%~dp0"

rem Explicit paths are resolved from this project, never from the caller's cwd.
set "forecastPython=%SALES_FORECAST_PYTHON%"
if defined forecastPython (
    for %%I in ("%forecastPython%") do set "forecastPython=%%~fI"
) else if exist ".venv\" (
    set "forecastPython=%~dp0.venv\Scripts\python.exe"
) else (
    for %%I in (python.exe) do set "forecastPython=%%~$PATH:I"
)
if not defined forecastPython goto missing_python
if not exist "%forecastPython%" goto missing_python
if exist "%forecastPython%\" goto missing_python

echo Python: "%forecastPython%"
"%forecastPython%" -c "import importlib.util, sys; sys.exit(1 if sys.version_info < (3, 10) or any(importlib.util.find_spec(n) is None for n in ('openpyxl',)) else 0)" >nul 2>nul
if errorlevel 1 goto missing_dependencies

"%forecastPython%" main.py %*
set "launcherExitCode=%errorlevel%"
if not "%launcherExitCode%"=="0" pause
exit /b %launcherExitCode%

:missing_python
echo [ERROR] 找不到 Python。请安装 Python 3.10 或更新版本，并按 README.md 在本项目创建 .venv。
if defined forecastPython echo 所选的路径："%forecastPython%"
echo 也可通过 SALES_FORECAST_PYTHON 指定有效的 Python 文件路径。
pause
exit /b 1

:missing_dependencies
echo [ERROR] 所选 Python 需要 3.10 或更新版本，并安装本项目 requirements.txt 中的依赖。
echo 请执行："%forecastPython%" -m pip install -r requirements.txt
pause
exit /b 1
