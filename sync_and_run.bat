@echo off
:: sync_and_run.bat — git pull + 의존성 업데이트 + 서버 시작
:: server.py 기본 모드가 동기화 후 시작이므로, 단순히 server.py를 실행합니다.
cd /d "%~dp0"

if exist "python\pythonw.exe" (
    start "" "python\pythonw.exe" server.py
) else if exist "python\python.exe" (
    start "" "python\python.exe" server.py
) else if exist "venv\Scripts\pythonw.exe" (
    start "" "venv\Scripts\pythonw.exe" server.py
) else if exist "venv\Scripts\python.exe" (
    start "" "venv\Scripts\python.exe" server.py
) else (
    echo [ERROR] Python not found. Run setup.bat first.
    pause
)
