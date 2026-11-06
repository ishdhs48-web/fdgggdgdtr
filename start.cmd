@echo off
chcp 65001 >nul
echo ============================================
echo  AI AGENT - Full PC Control System
echo ============================================
echo.
echo  Working directory: %cd%
echo.

cd /d "%~dp0app"

echo  Starting server...
echo.

node server.mjs

echo.
echo ============================================
echo  Server started!
echo  Open in browser: http://localhost:8770
echo ============================================
echo.
