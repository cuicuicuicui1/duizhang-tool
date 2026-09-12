@echo off
chcp 65001 >nul
title DuiZhang Tool - 往来对账函
cd /d "%~dp0"

echo.
echo   ==================================================
echo    往来单位对账函工具
echo   ==================================================
echo.

where node >nul 2>nul
if %errorlevel%==0 goto run

set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2\node.exe"
if exist "%NODE_EXE%" goto run_alt

echo   [!!] Node.js not found.
echo.
echo   This tool needs Node.js 22. Please install it from:
echo        https://nodejs.org/
echo   then double-click this file again.
echo.
pause
exit /b 1

:run
echo   Starting server, browser will open automatically...
node server.js
goto done

:run_alt
echo   Starting server, browser will open automatically...
"%NODE_EXE%" server.js

:done
echo.
echo   Server stopped.
pause
