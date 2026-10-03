@echo off
setlocal EnableExtensions DisableDelayedExpansion
pushd "%~dp0"
if errorlevel 1 goto failed

where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js 20 or later is required. Install it and try again.
  goto failed
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo npm was not found. Install Node.js with npm and try again.
  goto failed
)

for /f "delims=" %%V in ('node.exe -p "parseInt(process.versions.node, 10)"') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR goto failed
if %NODE_MAJOR% LSS 20 (
  echo Node.js 20 or later is required. Current major version: %NODE_MAJOR%.
  goto failed
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing project dependencies...
  call npm.cmd ci
  if errorlevel 1 goto failed
)

echo Building AIScripter for ani...
call npm.cmd run build
if errorlevel 1 goto failed

if /I "%~1"=="--check" (
  echo Launcher check passed.
  popd
  exit /b 0
)

start "" /D "%CD%" "%CD%\node_modules\electron\dist\electron.exe" .
if errorlevel 1 goto failed
popd
exit /b 0

:failed
echo AIScripter could not start. Review the message above.
pause
popd
exit /b 1
