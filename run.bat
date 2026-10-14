@echo off
:: 运行脚本：先切到本文件所在目录（%~dp0 = 本文件自己的盘符和路径），再启动
chcp 65001 >nul
cd /d "%~dp0"

:: npm 没装就把话说清楚，别让窗口一闪就没了
where npm >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ===================================
    echo 找不到 npm，程序启动不了。
    echo 请先双击运行 setup.bat 装好环境，然后再运行本脚本。
    echo ===================================
    pause
    exit /b 1
)

call npm start