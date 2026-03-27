"""서버 관리 GUI — 동기화 + 백엔드 + 프론트엔드 동시 관리.

PyInstaller exe로 컴파일 가능:
  pyinstaller --onefile --noconsole --name ReplayKit server.py
"""

import re
import subprocess
import sys
import os
import threading
import time
import webbrowser
import tkinter as tk
from tkinter import scrolledtext, ttk
from datetime import datetime

import psutil

# PyInstaller exe: use exe's directory; normal script: use __file__'s directory
if getattr(sys, "frozen", False):
    PROJECT_ROOT = os.path.dirname(sys.executable)
else:
    PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(PROJECT_ROOT, "frontend")
RESTART_FLAG = os.path.join(PROJECT_ROOT, ".restart")

# Backend Python: embedded > venv > system (self)
_embed_python = os.path.join(PROJECT_ROOT, "python", "python.exe")
_venv_python = os.path.join(PROJECT_ROOT, "venv", "Scripts", "python.exe")
if not os.path.exists(_venv_python):
    _venv_python = os.path.join(PROJECT_ROOT, "venv", "bin", "python")
if os.path.exists(_embed_python):
    VENV_PYTHON = _embed_python
elif os.path.exists(_venv_python):
    VENV_PYTHON = _venv_python
elif not getattr(sys, "frozen", False):
    VENV_PYTHON = sys.executable
else:
    VENV_PYTHON = None

NPM_CMD = "npm.cmd" if sys.platform == "win32" else "npm"

# ── 색상 테마 (설정 파일에서 읽기) ──
_SETTINGS_FILE = os.path.join(PROJECT_ROOT, "backend", "settings.json")


def _read_theme() -> str:
    """backend/settings.json에서 theme 읽기. 기본값 dark."""
    try:
        import json
        with open(_SETTINGS_FILE, encoding="utf-8") as f:
            return json.load(f).get("theme", "dark")
    except Exception:
        return "dark"


_THEME = _read_theme()

# 다크 모드
_DARK = {
    "BG": "#1e1e2e", "BG_CARD": "#2a2a3d", "FG": "#cdd6f4", "FG_DIM": "#6c7086",
    "GREEN": "#a6e3a1", "RED": "#f38ba8", "YELLOW": "#f9e2af", "BLUE": "#89b4fa",
    "ACCENT": "#cba6f7", "LOG_BG": "#181825",
}
# 라이트 모드
_LIGHT = {
    "BG": "#f5f5f5", "BG_CARD": "#ffffff", "FG": "#1f1f1f", "FG_DIM": "#888888",
    "GREEN": "#389e0d", "RED": "#cf1322", "YELLOW": "#d48806", "BLUE": "#1677ff",
    "ACCENT": "#722ed1", "LOG_BG": "#fafafa",
}
_C = _DARK if _THEME == "dark" else _LIGHT
BG = _C["BG"]
BG_CARD = _C["BG_CARD"]
FG = _C["FG"]
FG_DIM = _C["FG_DIM"]
GREEN = _C["GREEN"]
RED = _C["RED"]
YELLOW = _C["YELLOW"]
BLUE = _C["BLUE"]
ACCENT = _C["ACCENT"]
LOG_BG = _C["LOG_BG"]

# 로그에서 필터링할 패턴
_LOG_FILTER_RE = re.compile(
    r'"GET /api/device/screenshot/|'
    r'"GET /api/device/info/'
)


def _run_cmd(cmd, cwd=PROJECT_ROOT, timeout=120):
    """subprocess 실행 후 (returncode, stdout) 반환."""
    try:
        r = subprocess.run(
            cmd, cwd=cwd, capture_output=True, timeout=timeout,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        stdout = r.stdout.decode("utf-8", errors="replace").strip() if r.stdout else ""
        stderr = r.stderr.decode("utf-8", errors="replace").strip() if r.stderr else ""
        return r.returncode, (stdout + "\n" + stderr).strip()
    except subprocess.TimeoutExpired:
        return -1, "Timeout"
    except FileNotFoundError:
        return -1, f"Command not found: {cmd[0]}"
    except Exception as e:
        return -1, str(e)


class ServerProcess:
    """하나의 서버 프로세스를 관리."""

    def __init__(self, name: str, cmd: list[str], cwd: str, url: str):
        self.name = name
        self.cmd = cmd
        self.cwd = cwd
        self.url = url
        self.port = int(url.rsplit(":", 1)[-1].split("/")[0])
        self.proc: subprocess.Popen | None = None
        self._reader_thread: threading.Thread | None = None

    @property
    def running(self) -> bool:
        if self.proc is None:
            return False
        return self.proc.poll() is None

    def start(self, log_callback) -> bool:
        if self.running:
            log_callback(f"[{self.name}] 이미 실행 중입니다")
            return False
        if not self.cmd or self.cmd[0] is None:
            log_callback(f"[{self.name}] venv가 없어 시작할 수 없습니다. setup.bat을 먼저 실행하세요")
            return False
        env = os.environ.copy()
        env["RECORDING_PROJECT_ROOT"] = PROJECT_ROOT
        try:
            self.proc = subprocess.Popen(
                self.cmd,
                cwd=self.cwd,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                creationflags=(subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW) if sys.platform == "win32" else 0,
                bufsize=0,
            )
            log_callback(f"[{self.name}] 시작됨 (PID {self.proc.pid}) — {self.url}")
            self._reader_thread = threading.Thread(
                target=self._read_output, args=(log_callback,), daemon=True,
            )
            self._reader_thread.start()
            return True
        except Exception as e:
            log_callback(f"[{self.name}] 시작 실패: {e}")
            return False

    def stop(self, log_callback) -> None:
        if not self.running or self.proc is None:
            log_callback(f"[{self.name}] 실행 중이 아닙니다")
            return
        pid = self.proc.pid
        try:
            parent = psutil.Process(pid)
            children = parent.children(recursive=True)
            for child in children:
                child.terminate()
            parent.terminate()
            gone, alive = psutil.wait_procs([parent] + children, timeout=5)
            for p in alive:
                p.kill()
            log_callback(f"[{self.name}] 정지 완료 (PID {pid})")
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            log_callback(f"[{self.name}] 이미 정지됨")
        self.proc = None
        self._kill_port_listeners(log_callback)

    def _kill_port_listeners(self, log_callback) -> None:
        for conn in psutil.net_connections(kind="tcp"):
            if conn.laddr.port == self.port and conn.status == "LISTEN" and conn.pid:
                try:
                    p = psutil.Process(conn.pid)
                    for child in p.children(recursive=True):
                        child.kill()
                    p.kill()
                    log_callback(f"[{self.name}] 포트 {self.port} 고아 프로세스 정리 (PID {conn.pid})")
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass

    def _read_output(self, log_callback) -> None:
        try:
            assert self.proc and self.proc.stdout
            for raw_line in self.proc.stdout:
                line = raw_line.decode(errors="replace").rstrip()
                if line:
                    log_callback(f"[{self.name}] {line}")
        except Exception:
            pass


class ServerManagerApp:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("ReplayKit — 서버 관리")
        self.root.geometry("780x560")
        self.root.configure(bg=BG)
        self.root.resizable(True, True)

        # 배포 모드: frontend/dist 존재하면 백엔드가 정적 파일 서빙 (프론트엔드 서버 불필요)
        fe_dist = os.path.join(FRONTEND_DIR, "dist", "index.html")
        self._production = os.path.exists(fe_dist)

        reload_flag = [] if self._production else ["--reload"]
        self.backend = ServerProcess(
            "백엔드",
            [VENV_PYTHON, "-m", "uvicorn", "backend.app.main:app",
             "--host", "0.0.0.0", "--port", "8000"] + reload_flag,
            PROJECT_ROOT,
            "http://localhost:8000",
        )
        self.frontend = ServerProcess(
            "프론트엔드",
            [NPM_CMD, "run", "dev"],
            FRONTEND_DIR,
            "http://localhost:5173",
        )

        self._build_ui()
        self._update_status()
        self._check_restart_flag()
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    # ── UI 구성 ──

    def _build_ui(self):
        title = tk.Label(
            self.root, text="ReplayKit — Server",
            bg=BG, fg=ACCENT, font=("Segoe UI", 16, "bold"),
        )
        title.pack(pady=(16, 8))

        cards_frame = tk.Frame(self.root, bg=BG)
        cards_frame.pack(fill="x", padx=20, pady=(0, 8))
        cards_frame.columnconfigure(0, weight=1)
        cards_frame.columnconfigure(1, weight=1)

        self.be_card = self._build_server_card(cards_frame, "백엔드", "FastAPI · :8000", 0)
        if self._production:
            # 프로덕션 모드: 프론트엔드 카드 대신 안내 표시
            fe_info = tk.Frame(cards_frame, bg=BG_CARD, relief="flat", bd=0, padx=16, pady=12)
            fe_info.grid(row=0, column=1, sticky="nsew", padx=(4, 0), pady=4)
            tk.Label(fe_info, text="프론트엔드", bg=BG_CARD, fg=FG, font=("Segoe UI", 13, "bold")).pack(anchor="w")
            tk.Label(fe_info, text="빌드 모드 — 백엔드가 정적 파일 서빙", bg=BG_CARD, fg=FG_DIM, font=("Segoe UI", 9)).pack(anchor="w", pady=(2, 0))
            self.fe_card = {"indicator": tk.Label(), "status_lbl": tk.Label(), "start_btn": tk.Button(), "stop_btn": tk.Button()}
        else:
            self.fe_card = self._build_server_card(cards_frame, "프론트엔드", "Vite · :5173", 1)

        btn_frame = tk.Frame(self.root, bg=BG)
        btn_frame.pack(fill="x", padx=20, pady=(0, 8))

        self._make_btn(btn_frame, "▶  모두 시작", GREEN, self._start_all).pack(side="left", expand=True, fill="x", padx=(0, 4))
        self._make_btn(btn_frame, "■  모두 정지", RED, self._stop_all).pack(side="left", expand=True, fill="x", padx=4)
        self._make_btn(btn_frame, "↻  모두 재시작", YELLOW, self._restart_all).pack(side="left", expand=True, fill="x", padx=4)
        self._make_btn(btn_frame, "⟳  동기화+시작", BLUE, self._sync_and_start).pack(side="left", expand=True, fill="x", padx=4)
        self._make_btn(btn_frame, "🌐  웹 열기", ACCENT, self._open_web).pack(side="left", expand=True, fill="x", padx=(4, 0))

        # 로그 탭
        style = ttk.Style()
        style.theme_use("default")
        style.configure("Dark.TNotebook", background=BG, borderwidth=0)
        style.configure("Dark.TNotebook.Tab",
                        background=BG_CARD, foreground=FG_DIM,
                        font=("Segoe UI", 10, "bold"), padding=(12, 6))
        style.map("Dark.TNotebook.Tab",
                  background=[("selected", "#e0e0e0" if _THEME == "light" else "#363650")],
                  foreground=[("selected", FG)])

        self.log_notebook = ttk.Notebook(self.root, style="Dark.TNotebook")
        self.log_notebook.pack(fill="both", expand=True, padx=20, pady=(8, 12))

        self.log_tabs: dict[str, scrolledtext.ScrolledText] = {}
        log_tab_list = [("전체", FG), ("백엔드", BLUE)]
        if not self._production:
            log_tab_list.append(("프론트엔드", ACCENT))
        for tab_name, tab_color in log_tab_list:
            frame = tk.Frame(self.log_notebook, bg=LOG_BG)
            log_widget = scrolledtext.ScrolledText(
                frame,
                bg=LOG_BG, fg=tab_color, font=("Consolas", 9),
                insertbackground=FG, relief="flat", bd=0,
                wrap="word", state="disabled", height=14,
            )
            log_widget.pack(fill="both", expand=True)
            log_widget.tag_config("ts", foreground=FG_DIM)
            log_widget.tag_config("backend", foreground=BLUE)
            log_widget.tag_config("frontend", foreground=ACCENT)
            log_widget.tag_config("error", foreground=RED)
            log_widget.tag_config("system", foreground=GREEN)

            self.log_notebook.add(frame, text=tab_name)
            self.log_tabs[tab_name] = log_widget

        self.statusbar = tk.Label(
            self.root, text="준비", bg=BG_CARD, fg=FG_DIM,
            font=("Segoe UI", 9), anchor="w", padx=12, pady=4,
        )
        self.statusbar.pack(fill="x", side="bottom")

    def _build_server_card(self, parent, name: str, subtitle: str, col: int) -> dict:
        card = tk.Frame(parent, bg=BG_CARD, relief="flat", bd=0, padx=16, pady=12)
        card.grid(row=0, column=col, sticky="nsew", padx=(0 if col == 0 else 4, 4 if col == 0 else 0), pady=4)

        top = tk.Frame(card, bg=BG_CARD)
        top.pack(fill="x")

        indicator = tk.Label(top, text="●", bg=BG_CARD, fg=RED, font=("Segoe UI", 14))
        indicator.pack(side="left")

        lbl = tk.Label(top, text=name, bg=BG_CARD, fg=FG, font=("Segoe UI", 13, "bold"))
        lbl.pack(side="left", padx=(6, 0))

        status_lbl = tk.Label(top, text="정지됨", bg=BG_CARD, fg=FG_DIM, font=("Segoe UI", 10))
        status_lbl.pack(side="right")

        sub = tk.Label(card, text=subtitle, bg=BG_CARD, fg=FG_DIM, font=("Segoe UI", 9))
        sub.pack(anchor="w", pady=(2, 8))

        btn_row = tk.Frame(card, bg=BG_CARD)
        btn_row.pack(fill="x")

        start_btn = self._make_btn(btn_row, "시작", GREEN, lambda n=name: self._start_one(n))
        start_btn.pack(side="left", expand=True, fill="x", padx=(0, 3))
        stop_btn = self._make_btn(btn_row, "정지", RED, lambda n=name: self._stop_one(n))
        stop_btn.pack(side="left", expand=True, fill="x", padx=(3, 3))
        restart_btn = self._make_btn(btn_row, "재시작", YELLOW, lambda n=name: self._restart_one(n))
        restart_btn.pack(side="left", expand=True, fill="x", padx=(3, 0))

        return {"indicator": indicator, "status_lbl": status_lbl, "start_btn": start_btn, "stop_btn": stop_btn}

    def _make_btn(self, parent, text: str, color: str, command) -> tk.Button:
        btn = tk.Button(
            parent, text=text, bg=BG_CARD, fg=color,
            activebackground=BG, activeforeground=color,
            font=("Segoe UI", 10, "bold"), relief="flat", bd=0,
            cursor="hand2", command=command, padx=10, pady=6,
        )
        btn.bind("<Enter>", lambda e, b=btn, c=color: b.configure(bg="#e0e0e0" if _THEME == "light" else "#363650"))
        btn.bind("<Leave>", lambda e, b=btn: b.configure(bg=BG_CARD))
        return btn

    # ── 로그 ──

    def _log(self, msg: str):
        self.root.after(0, self._append_log, msg)

    def _set_status(self, text: str):
        self.root.after(0, lambda: self.statusbar.configure(text=text))

    def _append_log(self, msg: str):
        ts = datetime.now().strftime("%H:%M:%S")
        is_backend = "[백엔드]" in msg
        is_frontend = "[프론트엔드]" in msg
        is_error = "error" in msg.lower() or "실패" in msg

        if is_backend and _LOG_FILTER_RE.search(msg):
            return

        if is_error:
            tag = "error"
        elif is_backend:
            tag = "backend"
        elif is_frontend:
            tag = "frontend"
        else:
            tag = "system"

        targets = ["전체"]
        if is_backend:
            targets.append("백엔드")
        elif is_frontend:
            targets.append("프론트엔드")

        for tab_name in targets:
            widget = self.log_tabs[tab_name]
            widget.configure(state="normal")
            widget.insert("end", f"[{ts}] ", "ts")
            widget.insert("end", msg + "\n", tag)
            widget.see("end")
            widget.configure(state="disabled")

    # ── 동기화 (git pull + 의존성) ──

    def _sync(self, log_callback):
        """git pull + pip install + npm install. 메인 스레드가 아닌 곳에서 호출."""
        self._set_status("동기화 중...")

        # 1) 로컬 변경 초기화 + git pull (git 저장소인 경우만)
        git_dir = os.path.join(PROJECT_ROOT, ".git")
        if os.path.isdir(git_dir):
            # 관리자 권한 설치 → 일반 사용자 실행 시 dubious ownership 방지
            safe_dir = PROJECT_ROOT.replace("\\", "/")
            git = ["git", "-c", f"safe.directory={safe_dir}"]

            # 이전 빌드 .pyd 캐시 삭제 (구 컴파일 코드가 새 .py 로딩 방해)
            import glob as _glob
            for _pyd in _glob.glob(os.path.join(PROJECT_ROOT, "**", "*.pyd"), recursive=True):
                if "python" not in _pyd and "site-packages" not in _pyd:
                    try:
                        os.remove(_pyd)
                    except Exception:
                        pass

            # git 명령 사용 가능 여부 먼저 확인
            git_available = _run_cmd(["git", "--version"], timeout=5)[0] == 0
            if git_available:
                # 원격 최신 상태로 강제 동기화 (배포 PC는 수신 전용)
                log_callback("[동기화] 원격 최신 상태 가져오는 중...")
                _run_cmd(git + ["fetch", "origin", "main"], timeout=30)
                code, out = _run_cmd(git + ["reset", "--hard", "origin/main"], timeout=15)
                if out:
                    log_callback(f"[동기화] {out}")
                if code != 0:
                    log_callback("[동기화] git pull 실패 — 의존성 설치는 계속합니다")
            else:
                log_callback("[동기화] git 미설치 — git pull 건너뜀")
        else:
            log_callback("[동기화] git 저장소 없음 — git pull 건너뜀")

        # 2) pip install (requirements.txt 변경 시에만)
        req_file = os.path.join(BASE_DIR, "requirements.txt")
        req_hash_file = os.path.join(BASE_DIR, ".req_hash")
        import hashlib
        req_hash = ""
        if os.path.exists(req_file):
            req_hash = hashlib.md5(open(req_file, "rb").read()).hexdigest()
        old_hash = open(req_hash_file).read().strip() if os.path.exists(req_hash_file) else ""
        if req_hash != old_hash:
            log_callback("[동기화] Python 의존성 설치 중...")
            code, out = _run_cmd([VENV_PYTHON, "-m", "pip", "install", "-r", "requirements.txt", "-q"], timeout=120)
            if out and code == 0:
                log_callback(f"[동기화] pip: {out[:200]}")
            elif code != 0:
                log_callback(f"[동기화] pip install 실패: {out[:200]}")
            try:
                with open(req_hash_file, "w") as f:
                    f.write(req_hash)
            except Exception:
                pass
        else:
            log_callback("[동기화] Python 의존성 변경 없음 — 건너뜀")

        # 3) npm install (개발 모드 + package.json 변경 시에만)
        if not self._production:
            pkg_file = os.path.join(FRONTEND_DIR, "package.json")
            pkg_hash_file = os.path.join(FRONTEND_DIR, ".pkg_hash")
            pkg_hash = ""
            if os.path.exists(pkg_file):
                pkg_hash = hashlib.md5(open(pkg_file, "rb").read()).hexdigest()
            old_pkg_hash = open(pkg_hash_file).read().strip() if os.path.exists(pkg_hash_file) else ""
            if pkg_hash != old_pkg_hash:
                log_callback("[동기화] Node 의존성 설치 중...")
                code, out = _run_cmd([NPM_CMD, "install", "--silent"], cwd=FRONTEND_DIR, timeout=120)
                if out and code == 0:
                    log_callback(f"[동기화] npm: {out[:200]}")
                elif code != 0:
                    log_callback(f"[동기화] npm install 실패: {out[:200]}")
                try:
                    with open(pkg_hash_file, "w") as f:
                        f.write(pkg_hash)
                except Exception:
                    pass
            else:
                log_callback("[동기화] Node 의존성 변경 없음 — 건너뜀")

        log_callback("[동기화] 완료")
        self._set_status("동기화 완료")
        return True

    # ── 재시작 플래그 감시 ──

    def _check_restart_flag(self):
        """백엔드가 .restart 파일을 생성하면 서버를 재시작."""
        if os.path.exists(RESTART_FLAG):
            try:
                os.remove(RESTART_FLAG)
            except Exception:
                pass
            self._log("[시스템] 재시작 요청 감지됨")
            self._full_restart()
        self.root.after(2000, self._check_restart_flag)

    def _full_restart(self):
        """기존 프로세스 + 포트 점유까지 완전 정리 후 재시작."""
        def _do():
            self.backend.stop(self._log)
            if not self._production:
                self.frontend.stop(self._log)
            time.sleep(1)
            _kill_existing_servers()
            time.sleep(1)
            self.backend.start(self._log)
            if not self._production:
                self.frontend.start(self._log)
        threading.Thread(target=_do, daemon=True).start()

    # ── 상태 업데이트 (주기적) ──

    def _update_status(self):
        servers = [(self.backend, self.be_card)]
        if not self._production:
            servers.append((self.frontend, self.fe_card))
        for server, card in servers:
            if server.running:
                card["indicator"].configure(fg=GREEN)
                card["status_lbl"].configure(text="실행 중", fg=GREEN)
            else:
                card["indicator"].configure(fg=RED)
                card["status_lbl"].configure(text="정지됨", fg=FG_DIM)

        be_run = self.backend.running
        fe_run = self.frontend.running if not self._production else False
        status = self.statusbar.cget("text")
        if "동기화" not in status:
            if self._production:
                self.statusbar.configure(text="서버 실행 중" if be_run else ("모든 서버 정지됨" if "완료" not in status and "준비" not in status else status))
            elif be_run and fe_run:
                self.statusbar.configure(text="백엔드 + 프론트엔드 실행 중")
            elif be_run:
                self.statusbar.configure(text="백엔드만 실행 중")
            elif fe_run:
                self.statusbar.configure(text="프론트엔드만 실행 중")
            else:
                if "완료" not in status and "준비" not in status:
                    self.statusbar.configure(text="모든 서버 정지됨")

        self.root.after(1000, self._update_status)

    # ── 명령 ──

    def _get_server(self, name: str) -> ServerProcess:
        return self.backend if name == "백엔드" else self.frontend

    def _start_one(self, name: str):
        threading.Thread(target=self._get_server(name).start, args=(self._log,), daemon=True).start()

    def _stop_one(self, name: str):
        threading.Thread(target=self._get_server(name).stop, args=(self._log,), daemon=True).start()

    def _restart_one(self, name: str):
        def _do():
            srv = self._get_server(name)
            srv.stop(self._log)
            time.sleep(1)
            srv.start(self._log)
        threading.Thread(target=_do, daemon=True).start()

    def _start_all_sync(self, auto_open_web=False):
        """서버 시작 (현재 스레드에서 실행, 다른 스레드에서 호출할 때 사용)."""
        self.backend.start(self._log)
        if not self._production:
            self.frontend.start(self._log)
        else:
            self._log("[시스템] 프로덕션 모드 — 프론트엔드는 백엔드가 서빙합니다")
        if auto_open_web:
            self._wait_and_open_web()

    def _start_all(self):
        threading.Thread(target=lambda: self._start_all_sync(auto_open_web=True), daemon=True).start()

    def _open_web(self):
        url = self.backend.url if self._production else self.frontend.url
        webbrowser.open(url)

    def _wait_and_open_web(self):
        """백엔드 HTTP 응답이 올 때까지 대기 후 브라우저 자동 오픈."""
        import urllib.request
        url = self.backend.url if self._production else self.frontend.url
        check_url = self.backend.url + "/api/device/list"
        for _ in range(30):  # 최대 30초 대기
            time.sleep(1)
            if not self.backend.running:
                return
            try:
                urllib.request.urlopen(check_url, timeout=2)
                self._log(f"[시스템] 백엔드 준비 완료 — 브라우저를 엽니다")
                webbrowser.open(url)
                return
            except Exception:
                pass
        self._log("[시스템] 백엔드 응답 대기 시간 초과 — 수동으로 웹을 열어주세요")

    def _stop_all(self):
        def _do():
            self.backend.stop(self._log)
            if not self._production:
                self.frontend.stop(self._log)
        threading.Thread(target=_do, daemon=True).start()

    def _restart_all(self):
        def _do():
            self.backend.stop(self._log)
            if not self._production:
                self.frontend.stop(self._log)
            time.sleep(1)
            self._start_all_sync(auto_open_web=True)
        threading.Thread(target=_do, daemon=True).start()

    def _sync_and_start(self):
        """동기화 후 서버 시작."""
        def _do():
            self.backend.stop(self._log)
            if not self._production:
                self.frontend.stop(self._log)
            time.sleep(1)
            if self._sync(self._log):
                self._start_all_sync(auto_open_web=True)
        threading.Thread(target=_do, daemon=True).start()

    def _on_close(self):
        if self.backend.running or self.frontend.running:
            self.backend.stop(self._log)
            if not self._production:
                self.frontend.stop(self._log)
        # adb.exe 프로세스 종료
        self._kill_adb()
        self.root.destroy()

    @staticmethod
    def _kill_adb():
        """시스템에서 실행 중인 adb.exe 프로세스를 모두 종료."""
        for proc in psutil.process_iter(["name"]):
            try:
                if proc.info["name"] and proc.info["name"].lower() == "adb.exe":
                    proc.kill()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass

    def run(self):
        self.root.mainloop()


def _hide_console():
    """콘솔 창 숨기기 (Windows)."""
    if sys.platform == "win32":
        try:
            import ctypes
            hwnd = ctypes.windll.kernel32.GetConsoleWindow()
            if hwnd:
                ctypes.windll.user32.ShowWindow(hwnd, 0)  # SW_HIDE
        except Exception:
            pass


def _kill_existing_servers():
    """기존 백엔드/프론트엔드 포트를 점유한 프로세스 종료."""
    fe_dist = os.path.join(PROJECT_ROOT, "frontend", "dist", "index.html")
    ports = [8000] if os.path.exists(fe_dist) else [8000, 5173]
    for port in ports:
        for conn in psutil.net_connections(kind="tcp"):
            if conn.laddr.port == port and conn.status == "LISTEN" and conn.pid:
                try:
                    p = psutil.Process(conn.pid)
                    for child in p.children(recursive=True):
                        child.kill()
                    p.kill()
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass


if __name__ == "__main__":
    _hide_console()

    is_restart = "--restart" in sys.argv
    do_sync = "--no-sync" not in sys.argv and not is_restart

    if is_restart:
        time.sleep(2)
        _kill_existing_servers()
        time.sleep(1)

    app = ServerManagerApp()

    if do_sync:
        # 일반 시작: 동기화 후 자동 시작 + 웹 오픈
        def _auto_sync_and_start():
            if app._sync(app._log):
                app._start_all_sync(auto_open_web=True)
            else:
                app._log("[시스템] 동기화 실패 — 수동으로 시작하세요")
        threading.Thread(target=_auto_sync_and_start, daemon=True).start()
    elif is_restart:
        # 재시작: 동기화 없이 바로 시작 + 웹 오픈
        def _restart_and_open():
            app._start_all_sync(auto_open_web=True)
        threading.Thread(target=_restart_and_open, daemon=True).start()

    app.run()
