@echo off
title deepseek models bridge
cd /d "%~dp0app"
if not exist config.json (
  echo.
  echo config.json missing - creating defaults...
  echo {"port":8770,"host":"127.0.0.1","token":"","defaultModel":"gpt-6-astra","defaultThinking":false,"defaultSearch":true,"resendPromptEachTurn":false} > config.json
)
start "" http://127.0.0.1:8770
node server.mjs
pause