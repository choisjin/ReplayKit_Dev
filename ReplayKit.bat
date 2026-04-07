@echo off
cd /d "%~dp0"

:: Git PATH 확보
set "PATH=C:\Program Files\Git\cmd;C:\Program Files (x86)\Git\cmd;%PATH%"

:: Git 초기화 (최초 실행 시)
if not exist ".git" (
    if exist "git_remote.txt" (
        where git.exe >nul 2>nul
        if not errorlevel 1 (
            echo [GIT] Initializing repository...
            set /p GIT_REMOTE=<git_remote.txt
            git init -b main
            set "SAFE_DIR=%CD:\=/%"
            git config --global --add safe.directory "%SAFE_DIR%"
            call :git_setup_remote
        ) else (
            echo [GIT] Git not found - skipping repository setup.
        )
    )
)

:: Git 업데이트
if exist ".git" (
    where git.exe >nul 2>nul
    if not errorlevel 1 (
        echo [UPDATE] Fetching latest...
        git fetch origin main
        git reset --hard origin/main
        echo [UPDATE] Done.
    )
)
goto :after_git

:git_setup_remote
set /p GIT_REMOTE=<git_remote.txt
git remote add origin "%GIT_REMOTE%"
git fetch --depth 1 origin main
git branch --set-upstream-to=origin/main main
git reset origin/main
git checkout origin/main -- .gitignore
echo [GIT] Repository initialized: %GIT_REMOTE%
goto :eof

:after_git

set "ENTRY=server.py"
if exist "_launcher.py" set "ENTRY=_launcher.py"

set "PY="
set "PYW="
if exist "python\pythonw.exe" set "PYW=python\pythonw.exe"
if exist "python\python.exe" set "PY=python\python.exe"
if not defined PYW if exist "venv\Scripts\pythonw.exe" set "PYW=venv\Scripts\pythonw.exe"
if not defined PY if exist "venv\Scripts\python.exe" set "PY=venv\Scripts\python.exe"

if not defined PYW if not defined PY (
    echo [ERROR] Python not found. Run setup.bat first.
    pause
    exit /b 1
)

if defined PYW (
    echo [START] %PYW% %ENTRY%
    start "" "%PYW%" %ENTRY%
) else (
    echo [START] %PY% %ENTRY%
    start "" cmd /c ""%PY%" %ENTRY% || (echo. & echo [ERROR] Server crashed. Press any key to close. & pause >nul)"
)
