@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-docker.ps1"
if errorlevel 1 (
  echo.
  echo Deployment failed. Review the error above.
  pause
  exit /b 1
)
echo.
echo Deployment completed successfully.
pause
