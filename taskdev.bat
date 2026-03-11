@echo off
echo.
echo [taskdev] Killing all node processes...
powershell -Command "Stop-Process -Name node -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1"
echo [taskdev] Starting dev server...
echo.
npm run dev
