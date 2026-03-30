@echo off
cd /d "%~dp0"

:: git pull은 server.py 동기화에서 수행 (중복 방지)

:: Detect entry point
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
