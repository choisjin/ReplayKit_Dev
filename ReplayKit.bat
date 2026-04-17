@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

:: Git PATH 확보
set "PATH=C:\Program Files\Git\cmd;C:\Program Files (x86)\Git\cmd;%PATH%"

:: --home 옵션: git_remote_home.txt 사용
set "GIT_REMOTE_FILE=git_remote.txt"
if "%~1"=="--home" (
    if exist "git_remote_home.txt" (
        set "GIT_REMOTE_FILE=git_remote_home.txt"
        echo [GIT] Using home remote: git_remote_home.txt
    ) else (
        echo [GIT] git_remote_home.txt not found - using default.
    )
)

:: 정식 remote URL — 이 주소가 아니면 자동 교정
set "CANONICAL_REMOTE=http://mod.lge.com/hub/dqa_replay_kit/replay_kit.git"

:: Git 초기화 또는 업데이트
if not exist ".git" (
    if exist "%GIT_REMOTE_FILE%" (
        where git.exe >nul 2>nul
        if not errorlevel 1 (
            call :git_init
        ) else (
            echo [GIT] Git not found - skipping.
        )
    )
) else (
    where git.exe >nul 2>nul
    if not errorlevel 1 (
        call :fix_remote
        call :git_pull
    )
)
goto :after_git

:git_init
echo [GIT] Initializing repository...
set /p GIT_REMOTE=<%GIT_REMOTE_FILE%
set "SAFE_DIR=%CD:\=/%"
git init -b main
git config --global --add safe.directory "%SAFE_DIR%"
git remote add origin "%GIT_REMOTE%"
git fetch --depth 1 origin main
if errorlevel 1 (
    echo [GIT] Fetch failed - check network.
    goto :eof
)
git branch --set-upstream-to=origin/main main
git reset origin/main
git checkout origin/main -- .gitignore
echo [GIT] Initialized: %GIT_REMOTE%
goto :eof

:fix_remote
:: 현재 origin URL이 정식 주소가 아니면 교정
set "SAFE_DIR=%CD:\=/%"
for /f "delims=" %%u in ('git -c safe.directory="%SAFE_DIR%" remote get-url origin 2^>nul') do set "CUR_REMOTE=%%u"
if not "!CUR_REMOTE!"=="!CANONICAL_REMOTE!" (
    git -c safe.directory="%SAFE_DIR%" remote set-url origin "!CANONICAL_REMOTE!"
    echo [GIT] Remote corrected: !CUR_REMOTE! -^> !CANONICAL_REMOTE!
)
goto :eof

:git_pull
set "SAFE_DIR=%CD:\=/%"
:: --home 시 remote URL 갱신
if "%~1"=="--home" (
    set /p GIT_REMOTE=<%GIT_REMOTE_FILE%
    for /f "delims=" %%u in ('git -c safe.directory="%SAFE_DIR%" remote get-url origin') do set "CUR_REMOTE=%%u"
    if not "!CUR_REMOTE!"=="!GIT_REMOTE!" (
        git -c safe.directory="%SAFE_DIR%" remote set-url origin "!GIT_REMOTE!"
        echo [GIT] Remote updated to: !GIT_REMOTE!
    )
)
git -c safe.directory="%SAFE_DIR%" fetch origin main
git -c safe.directory="%SAFE_DIR%" reset --hard origin/main
echo [GIT] Updated.
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
