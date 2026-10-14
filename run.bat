@echo off
:: 运行脚本：先切到本文件所在目录，再启动
chcp 65001 >nul
cd /d "%~dp0"
call npm start