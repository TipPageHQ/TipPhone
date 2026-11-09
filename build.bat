@echo off
setlocal
cd /d "%~dp0"

where bun >nul 2>nul
if errorlevel 1 (
  echo Bun isn't installed. Install it, open a new window and run this again:
  echo   powershell -c "irm bun.sh/install.ps1 | iex"
  pause
  exit /b 1
)

if not exist src\ring.wav (
  echo src\ring.wav is missing. Put a ring sound there first, it gets built into the exe.
  pause
  exit /b 1
)

echo Building TipPhone.exe...
bun run build
if errorlevel 1 (
  echo.
  echo Build failed, see above.
  pause
  exit /b 1
)

echo.
echo Done: dist\TipPhone.exe
pause
