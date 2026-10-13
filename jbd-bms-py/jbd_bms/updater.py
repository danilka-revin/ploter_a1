"""Обновление программы из GitHub по новым коммитам ветки main.

Схема та же, что у linux_pcb_app:
  1. check(): git fetch origin main; ищем коммиты main, затрагивающие папку программы;
  2. apply(): проверка чистого дерева и ветки → fetch → merge --ff-only → pip install
     (если изменился requirements.txt) → программа перезапускается (код выхода 10,
     его поднимает run.sh).

Ничего не меняем, если папка не git-клон, есть локальные правки, выбрана другая
ветка или обновление нельзя применить без слияния. Причину показываем честно.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

RESTART_EXIT_CODE = 10
CHECK_INTERVAL_S = 30 * 60
BRANCH = "main"

APPLY_STEPS = (
    ("check", "Проверка папки и ветки"),
    ("fetch", "Загрузка изменений с GitHub"),
    ("merge", "Установка новой версии"),
    ("deps", "Библиотеки (pip)"),
    ("restart", "Перезапуск программы"),
)


@dataclass
class Step:
    id: str
    title: str
    state: str = "wait"      # wait | run | done | skip | error
    detail: str = ""


@dataclass
class UpdateState:
    phase: str = "idle"      # idle | checking | ready | running | done | error | unsupported
    message: str = ""
    current_sha: str = ""
    latest_sha: str = ""
    latest_message: str = ""
    latest_date: str = ""
    update_available: bool = False
    checked_at: float = 0.0
    restart_required: bool = False
    steps: list[Step] = field(default_factory=lambda: [Step(i, t) for i, t in APPLY_STEPS])


class Updater:
    def __init__(
        self,
        app_dir: str | Path,
        branch: str = BRANCH,
        on_change: Callable[[UpdateState], None] | None = None,
        pip_install: Callable[[Path], tuple[int, str]] | None = None,
        timeout_fetch: int = 120,
    ):
        self.app_dir = Path(app_dir).resolve()
        self.branch = branch
        self.on_change = on_change
        self._pip_install = pip_install or self._default_pip
        self.timeout_fetch = timeout_fetch
        self.state = UpdateState()
        self._git_root: str | None = None
        self._app_rel = ""
        self._busy = False

    # ---------- внешние команды ----------

    def _git(self, *args: str, timeout: int = 30) -> tuple[int, str]:
        env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
        try:
            r = subprocess.run(["git", *args], cwd=self._git_root or self.app_dir, capture_output=True,
                               text=True, timeout=timeout, env=env)
        except FileNotFoundError:
            return -1, "git не установлен"
        except subprocess.TimeoutExpired:
            return -1, "превышено время ожидания"
        return r.returncode, (r.stdout + r.stderr).strip()

    @staticmethod
    def _default_pip(app_dir: Path) -> tuple[int, str]:
        req = app_dir / "requirements.txt"
        try:
            r = subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
                                "-r", str(req)], capture_output=True, text=True, timeout=900)
        except subprocess.TimeoutExpired:
            return -1, "pip: превышено время ожидания"
        return r.returncode, (r.stdout + r.stderr).strip()

    # ---------- состояние ----------

    def _emit(self) -> UpdateState:
        if self.on_change:
            self.on_change(self.state)
        return self.state

    def _step(self, sid: str, st: str, detail: str = "") -> None:
        for s in self.state.steps:
            if s.id == sid:
                s.state, s.detail = st, detail
        self._emit()

    def _reset_steps(self) -> None:
        self.state.steps = [Step(i, t) for i, t in APPLY_STEPS]

    def _detect(self) -> bool:
        if self._git_root is not None:
            return bool(self._git_root)
        code, out = self._git("rev-parse", "--show-toplevel", timeout=10)
        if code != 0 or not out:
            self._git_root = ""
            return False
        self._git_root = out.strip()
        rel = os.path.relpath(self.app_dir, self._git_root).replace(os.sep, "/")
        self._app_rel = "" if rel == "." else rel
        return True

    def _pathspec(self) -> list[str]:
        return ["--", self._app_rel] if self._app_rel else []

    def _local_head(self) -> str:
        code, out = self._git("rev-parse", "HEAD")
        return out if code == 0 else ""

    def _dirty(self) -> bool:
        args = ["status", "--porcelain", *self._pathspec()]
        code, out = self._git(*args, timeout=15)
        return code == 0 and out.strip() != ""

    def _current_branch(self) -> str:
        code, out = self._git("rev-parse", "--abbrev-ref", "HEAD")
        return out if code == 0 else ""

    def _unsupported(self, text: str) -> None:
        self.state.phase = "unsupported"
        self.state.message = text
        self.state.update_available = False

    # ---------- проверка ----------

    def check(self) -> UpdateState:
        """Проверка новых коммитов. Файлы программы не меняются."""
        if self._busy:
            return self.state
        self._busy = True
        self.state.phase = "checking"
        self._emit()
        try:
            if not self._detect():
                self._unsupported("Программа установлена не из git-клона, поэтому автообновление недоступно. "
                                  "Переустановите её через install-windows.cmd или install-ubuntu.sh (см. README).")
                return self._emit()
            code, out = self._git("fetch", "--quiet", "origin", self.branch, timeout=self.timeout_fetch)
            if code != 0:
                self.state.phase = "error"
                self.state.message = f"Нет связи с GitHub: {out.splitlines()[-1] if out else 'ошибка git fetch'}. " \
                                     "Продолжаем работать на текущей версии."
                return self._emit()
            self.state.checked_at = time.time()
            local = self._local_head()
            self.state.current_sha = local
            code, remote = self._git("rev-parse", f"origin/{self.branch}")
            if code != 0:
                self.state.phase = "error"
                self.state.message = f"В ветке «{self.branch}» на GitHub не найдено."
                return self._emit()
            # коммиты, которых нет локально и которые затрагивают папку программы
            code, pending = self._git("log", "--format=%H%x1f%cI%x1f%s", f"HEAD..origin/{self.branch}",
                                      *self._pathspec())
            commits = [line.split("\x1f") for line in pending.splitlines() if line.strip()] if code == 0 else []
            self.state.update_available = bool(commits)
            if commits:
                sha, date, msg = commits[0]
                self.state.latest_sha, self.state.latest_date, self.state.latest_message = sha, date, msg
                self.state.phase = "ready"
                self.state.message = f"Доступна новая версия ({sha[:7]}), коммитов: {len(commits)}."
            else:
                self.state.latest_sha = remote
                self.state.phase = "idle"
                self.state.message = "Установлена актуальная версия."
        finally:
            self._busy = False
        return self._emit()

    # ---------- установка ----------

    def apply(self) -> UpdateState:
        """Установить обновление. Вызывать из фонового потока: команды git и pip синхронные."""
        if self._busy:
            return self.state
        self._busy = True
        self._reset_steps()
        self.state.phase = "running"
        self.state.restart_required = False
        self.state.message = "Обновление запущено…"
        self._emit()
        try:
            self._apply()
        finally:
            self._busy = False
        return self._emit()

    def _fail(self, sid: str, text: str) -> None:
        self._step(sid, "error", text)
        self.state.phase = "error"
        self.state.message = text

    def _apply(self) -> None:
        self._step("check", "run")
        if not self._detect():
            return self._fail("check", "Программа не из git-клона — автообновление недоступно.")
        if self._dirty():
            return self._fail("check", "В папке программы есть локальные изменения. "
                                       "Сохраните или откатите их и повторите.")
        branch = self._current_branch()
        if branch != self.branch:
            return self._fail("check", f"Сейчас выбрана ветка «{branch}», а обновляем «{self.branch}». "
                                       "Переключитесь на неё или обновитесь вручную.")
        self._step("check", "done")

        self._step("fetch", "run")
        code, out = self._git("fetch", "--quiet", "origin", self.branch, timeout=self.timeout_fetch)
        if code != 0:
            return self._fail("fetch", f"Не удалось загрузить изменения: {out.splitlines()[-1] if out else 'ошибка'}")
        self._step("fetch", "done")

        self._step("merge", "run")
        before = self._local_head()
        code, target = self._git("rev-parse", f"origin/{self.branch}")
        if code != 0:
            return self._fail("merge", f"В ветке «{self.branch}» на GitHub не найдено.")
        if before == target:
            self._step("merge", "skip", "уже последняя версия")
        else:
            code, out = self._git("merge", "--ff-only", f"origin/{self.branch}", timeout=60)
            if code != 0:
                return self._fail("merge", "Нельзя применить обновление без слияния: в ветке есть свои коммиты. "
                                           "Обновитесь вручную: git pull.")
            self._step("merge", "done", target[:7])

        self._step("deps", "run")
        req = f"{self._app_rel}/requirements.txt" if self._app_rel else "requirements.txt"
        _, changed = self._git("diff", "--name-only", before, "HEAD", "--", req)
        if before != target and changed.strip():
            code, out = self._pip_install(self.app_dir)
            if code != 0:
                return self._fail("deps", f"pip: {out.splitlines()[-1] if out else 'ошибка установки'}. "
                                          "Код обновлён; перезапустите программу после исправления.")
            self._step("deps", "done")
        else:
            self._step("deps", "skip", "не менялись")

        self._step("restart", "run", "перезапуск…")
        self.state.phase = "done"
        self.state.restart_required = True
        self.state.current_sha = self._local_head()
        self.state.update_available = False
        self.state.message = "Обновление установлено. Программа перезапустится."
        self._step("restart", "done")
