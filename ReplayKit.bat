@echo off
cd /d "%~dp0"

if exist ".git" (
    where git.exe >nul 2>nul
    if not errorlevel 1 (
        echo [UPDATE] Fetching latest...
        git remote get-url deploy >nul 2>nul
        if not errorlevel 1 (
            git fetch deploy main
            git reset --hard deploy/main
        ) else (
            git fetch origin main
            git reset --hard origin/main
        )
        echo [UPDATE] Done.
    )
)

set "ENTRY=server.py"
if exist "_launcher.py" set "ENTRY=_launcher.py"

set "PY="
if exist "python\python.exe" set "PY=python\python.exe"
if not defined PY if exist "venv\Scripts\python.exe" set "PY=venv\Scripts\python.exe"

if not defined PY (
    echo [ERROR] Python not found. Run setup.bat first.
    pause
    exit /b 1
)

echo [START] %PY% %ENTRY%
start "" cmd /c ""%PY%" %ENTRY% || (echo. & echo [ERROR] Server crashed. Press any key to close. & pause >nul)"
