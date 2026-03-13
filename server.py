"""서버 관리 GUI — 백엔드 + 프론트엔드 동시 시작/정지/재시작."""

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

# Always use the venv Python for backend (not the system Python running this script)
_venv_python = os.path.join(PROJECT_ROOT, "venv", "Scripts", "python.exe")
if not os.path.exists(_venv_python):
    _venv_python = os.path.join(PROJECT_ROOT, "venv", "bin", "python")
VENV_PYTHON = _venv_python if os.path.exists(_venv_python) else sys.executable

# ── 색상 테마 ──
BG = "#1e1e2e"
BG_CARD = "#2a2a3d"
FG = "#cdd6f4"
FG_DIM = "#6c7086"
GREEN = "#a6e3a1"
RED = "#f38ba8"
YELLOW = "#f9e2af"
BLUE = "#89b4fa"
ACCENT = "#cba6f7"

# 로그에서 필터링할 패턴 (스크린샷 폴링 등 너무 빈번한 로그)
_LOG_FILTER_RE = re.compile(
    r'"GET /api/device/screenshot/|'
    r'"GET /api/device/info/'
)


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
        try:
            self.proc = subprocess.Popen(
                self.cmd,
                cwd=self.cwd,
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
        # Kill any orphaned processes still listening on the port
        self._kill_port_listeners(log_callback)

    def _kill_port_listeners(self, log_callback) -> None:
        """Kill any orphaned processes still listening on this server's port."""
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
        """stdout/stderr를 읽어서 로그에 출력."""
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
        self.root.title("Auto Test — 서버 관리")
        self.root.geometry("780x560")
        self.root.configure(bg=BG)
        self.root.resizable(True, True)

        npm_cmd = "npm.cmd" if sys.platform == "win32" else "npm"
        self.backend = ServerProcess(
            "백엔드",
            [VENV_PYTHON, "-m", "uvicorn", "backend.app.main:app",
             "--host", "0.0.0.0", "--port", "8000", "--reload"],
            PROJECT_ROOT,
            "http://localhost:8000",
        )
        self.frontend = ServerProcess(
            "프론트엔드",
            [npm_cmd, "run", "dev"],
            FRONTEND_DIR,
            "http://localhost:5173",
        )

        self._build_ui()
        self._update_status()
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    # ── UI 구성 ──

    def _build_ui(self):
        # 상단 제목
        title = tk.Label(
            self.root, text="Recording Test Macro — Server",
            bg=BG, fg=ACCENT, font=("Segoe UI", 16, "bold"),
        )
        title.pack(pady=(16, 8))

        # 서버 카드 프레임
        cards_frame = tk.Frame(self.root, bg=BG)
        cards_frame.pack(fill="x", padx=20, pady=(0, 8))
        cards_frame.columnconfigure(0, weight=1)
        cards_frame.columnconfigure(1, weight=1)

        self.be_card = self._build_server_card(cards_frame, "백엔드", "FastAPI · :8000", 0)
        self.fe_card = self._build_server_card(cards_frame, "프론트엔드", "Vite · :5173", 1)

        # 전체 제어 버튼
        btn_frame = tk.Frame(self.root, bg=BG)
        btn_frame.pack(fill="x", padx=20, pady=(0, 8))

        self._make_btn(btn_frame, "▶  모두 시작", GREEN, self._start_all).pack(side="left", expand=True, fill="x", padx=(0, 4))
        self._make_btn(btn_frame, "■  모두 정지", RED, self._stop_all).pack(side="left", expand=True, fill="x", padx=4)
        self._make_btn(btn_frame, "↻  모두 재시작", YELLOW, self._restart_all).pack(side="left", expand=True, fill="x", padx=4)
        self._make_btn(btn_frame, "🌐  웹 열기", BLUE, self._open_web).pack(side="left", expand=True, fill="x", padx=(4, 0))

        # ── 로그 탭 영역 ──
        # ttk 스타일 설정 (다크 테마)
        style = ttk.Style()
        style.theme_use("default")
        style.configure("Dark.TNotebook", background=BG, borderwidth=0)
        style.configure("Dark.TNotebook.Tab",
                        background=BG_CARD, foreground=FG_DIM,
                        font=("Segoe UI", 10, "bold"), padding=(12, 6))
        style.map("Dark.TNotebook.Tab",
                  background=[("selected", "#363650")],
                  foreground=[("selected", FG)])

        self.log_notebook = ttk.Notebook(self.root, style="Dark.TNotebook")
        self.log_notebook.pack(fill="both", expand=True, padx=20, pady=(8, 12))

        # 탭별 로그 위젯 생성
        self.log_tabs: dict[str, scrolledtext.ScrolledText] = {}
        for tab_name, tab_color in [("전체", FG), ("백엔드", BLUE), ("프론트엔드", ACCENT)]:
            frame = tk.Frame(self.log_notebook, bg="#181825")
            log_widget = scrolledtext.ScrolledText(
                frame,
                bg="#181825", fg=tab_color, font=("Consolas", 9),
                insertbackground=FG, relief="flat", bd=0,
                wrap="word", state="disabled", height=14,
            )
            log_widget.pack(fill="both", expand=True)
            # 색상 태그
            log_widget.tag_config("ts", foreground=FG_DIM)
            log_widget.tag_config("backend", foreground=BLUE)
            log_widget.tag_config("frontend", foreground=ACCENT)
            log_widget.tag_config("error", foreground=RED)
            log_widget.tag_config("system", foreground=GREEN)

            self.log_notebook.add(frame, text=tab_name)
            self.log_tabs[tab_name] = log_widget

        # 하단 상태바
        self.statusbar = tk.Label(
            self.root, text="준비", bg=BG_CARD, fg=FG_DIM,
            font=("Segoe UI", 9), anchor="w", padx=12, pady=4,
        )
        self.statusbar.pack(fill="x", side="bottom")

    def _build_server_card(self, parent, name: str, subtitle: str, col: int) -> dict:
        card = tk.Frame(parent, bg=BG_CARD, relief="flat", bd=0, padx=16, pady=12)
        card.grid(row=0, column=col, sticky="nsew", padx=(0 if col == 0 else 4, 4 if col == 0 else 0), pady=4)

        # 상태 표시등 + 이름
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

        # 개별 버튼
        btn_row = tk.Frame(card, bg=BG_CARD)
        btn_row.pack(fill="x")

        start_btn = self._make_btn(btn_row, "시작", GREEN,
                                   lambda n=name: self._start_one(n))
        start_btn.pack(side="left", expand=True, fill="x", padx=(0, 3))
        stop_btn = self._make_btn(btn_row, "정지", RED,
                                  lambda n=name: self._stop_one(n))
        stop_btn.pack(side="left", expand=True, fill="x", padx=(3, 3))
        restart_btn = self._make_btn(btn_row, "재시작", YELLOW,
                                     lambda n=name: self._restart_one(n))
        restart_btn.pack(side="left", expand=True, fill="x", padx=(3, 0))

        return {
            "indicator": indicator,
            "status_lbl": status_lbl,
            "start_btn": start_btn,
            "stop_btn": stop_btn,
        }

    def _make_btn(self, parent, text: str, color: str, command) -> tk.Button:
        btn = tk.Button(
            parent, text=text, bg=BG_CARD, fg=color,
            activebackground=BG, activeforeground=color,
            font=("Segoe UI", 10, "bold"), relief="flat", bd=0,
            cursor="hand2", command=command, padx=10, pady=6,
        )
        btn.bind("<Enter>", lambda e, b=btn, c=color: b.configure(bg="#363650"))
        btn.bind("<Leave>", lambda e, b=btn: b.configure(bg=BG_CARD))
        return btn

    # ── 로그 ──

    def _log(self, msg: str):
        """스레드 안전하게 로그 추가."""
        self.root.after(0, self._append_log, msg)

    def _append_log(self, msg: str):
        ts = datetime.now().strftime("%H:%M:%S")

        # 로그 출처 판별
        is_backend = "[백엔드]" in msg
        is_frontend = "[프론트엔드]" in msg
        is_error = "error" in msg.lower() or "실패" in msg

        # 백엔드 스크린샷 폴링 로그 필터링
        if is_backend and _LOG_FILTER_RE.search(msg):
            return

        # 색상 태그 결정
        if is_error:
            tag = "error"
        elif is_backend:
            tag = "backend"
        elif is_frontend:
            tag = "frontend"
        else:
            tag = "system"

        # 대상 탭 결정
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

    # ── 상태 업데이트 (주기적) ──

    def _update_status(self):
        for server, card in [(self.backend, self.be_card), (self.frontend, self.fe_card)]:
            if server.running:
                card["indicator"].configure(fg=GREEN)
                card["status_lbl"].configure(text="실행 중", fg=GREEN)
            else:
                card["indicator"].configure(fg=RED)
                card["status_lbl"].configure(text="정지됨", fg=FG_DIM)

        be_run = self.backend.running
        fe_run = self.frontend.running
        if be_run and fe_run:
            self.statusbar.configure(text="백엔드 + 프론트엔드 실행 중")
        elif be_run:
            self.statusbar.configure(text="백엔드만 실행 중")
        elif fe_run:
            self.statusbar.configure(text="프론트엔드만 실행 중")
        else:
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

    def _start_all(self):
        def _do():
            self.backend.start(self._log)
            self.frontend.start(self._log)
        threading.Thread(target=_do, daemon=True).start()

    def _open_web(self):
        webbrowser.open(self.frontend.url)

    def _stop_all(self):
        def _do():
            self.backend.stop(self._log)
            self.frontend.stop(self._log)
        threading.Thread(target=_do, daemon=True).start()

    def _restart_all(self):
        def _do():
            self.backend.stop(self._log)
            self.frontend.stop(self._log)
            time.sleep(1)
            self.backend.start(self._log)
            self.frontend.start(self._log)
        threading.Thread(target=_do, daemon=True).start()

    def _on_close(self):
        """종료 시 서버도 같이 정지."""
        if self.backend.running or self.frontend.running:
            self.backend.stop(self._log)
            self.frontend.stop(self._log)
        self.root.destroy()

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    app = ServerManagerApp()
    app.run()
