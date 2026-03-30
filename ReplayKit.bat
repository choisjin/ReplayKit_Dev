@echo off
cd /d "%~dp0"

if exist ".git" (
    where git.exe >nul 2>nul
    if not errorlevel 1 (
        echo [UPDATE] Fetching latest...
        git fetch origin main
        git reset --hard origin/main
        echo [UPDATE] Done.
    )
)

set "ENTRY=server.py"
if exist "_launcher.py" set "ENTRY=_launcher.py"

if exist "python\pythonw.exe" (
    start "" "python\pythonw.exe" %ENTRY%
) else if exist "python\python.exe" (
    start "" "python\python.exe" %ENTRY%
) else if exist "venv\Scripts\pythonw.exe" (
    start "" "venv\Scripts\pythonw.exe" %ENTRY%
) else if exist "venv\Scripts\python.exe" (
    start "" "venv\Scripts\python.exe" %ENTRY%
) else (
    echo [ERROR] Python not found. Run setup.bat first.
    pause
)
