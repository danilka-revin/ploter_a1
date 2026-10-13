"""Окно обновления: проверка, шаги установки и перезапуск."""

from __future__ import annotations

from PySide6.QtWidgets import QDialog, QHBoxLayout, QLabel, QPushButton, QVBoxLayout

from ..updater import Updater, UpdateState
from .widgets import Banner, Card

STATE_TEXT = {"wait": "ожидание", "run": "выполняется…", "done": "готово", "skip": "пропущено", "error": "ошибка"}
STATE_PILL = {"wait": "", "run": "accent", "done": "ok", "skip": "", "error": "bad"}


class UpdateDialog(QDialog):
    def __init__(self, updater: Updater, on_restart, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Обновление программы")
        self.setMinimumWidth(520)
        self._updater = updater
        self._on_restart = on_restart
        self._busy = False
        lay = QVBoxLayout(self)
        lay.setContentsMargins(20, 18, 20, 18)
        lay.setSpacing(12)
        self.title = QLabel("Обновление программы")
        self.title.setProperty("role", "title")
        lay.addWidget(self.title)
        self.info = QLabel("")
        self.info.setProperty("role", "muted")
        self.info.setWordWrap(True)
        lay.addWidget(self.info)
        self.banner = Banner(parent=self)
        lay.addWidget(self.banner)
        self.card = Card("Шаги установки", parent=self)
        self.step_labels = []
        for st in updater.state.steps:
            row = QHBoxLayout()
            name = QLabel(st.title)
            name.setMinimumWidth(260)
            status = QLabel(STATE_TEXT.get(st.state, st.state))
            status.setProperty("pill", "true")
            row.addWidget(name)
            row.addStretch(1)
            row.addWidget(status)
            self.card.add_layout(row)
            self.step_labels.append((st.id, name, status))
        lay.addWidget(self.card)
        btns = QHBoxLayout()
        btns.addStretch(1)
        self.btn_check = QPushButton("Проверить снова")
        self.btn_apply = QPushButton("Установить обновление")
        self.btn_apply.setProperty("primary", True)
        self.btn_restart = QPushButton("Перезапустить программу")
        self.btn_restart.setProperty("primary", True)
        self.btn_close = QPushButton("Закрыть")
        self.btn_check.clicked.connect(self._check)
        self.btn_apply.clicked.connect(self._apply)
        self.btn_restart.clicked.connect(self._on_restart)
        self.btn_close.clicked.connect(self.reject)
        for b in (self.btn_check, self.btn_apply, self.btn_restart, self.btn_close):
            btns.addWidget(b)
        lay.addLayout(btns)
        self.refresh(updater.state)

    # ---------- действия (фоновые потоки) ----------

    def _check(self) -> None:
        self._start(self._updater.check)

    def _apply(self) -> None:
        self._start(self._updater.apply)

    def _start(self, fn) -> None:
        import threading
        if self._busy:
            return
        self._busy = True
        self.refresh(self._updater.state)

        def work():
            try:
                fn()
            finally:
                self._busy = False
        threading.Thread(target=work, daemon=True).start()

    # ---------- отображение ----------

    def refresh(self, st: UpdateState) -> None:
        busy = self._busy or st.phase in ("checking", "running")
        self.btn_check.setEnabled(not busy)
        self.btn_apply.setEnabled(not busy and st.update_available)
        self.btn_restart.setVisible(st.phase == "done" and st.restart_required)
        self.btn_close.setEnabled(not busy)
        if st.phase == "unsupported":
            self.info.setText("Автообновление недоступно для этой установки.")
        elif st.latest_sha:
            self.info.setText(f"Текущая версия: {st.current_sha[:7] or '—'} · на GitHub: {st.latest_sha[:7]}"
                              + (f" · {st.latest_message}" if st.latest_message else ""))
        else:
            self.info.setText(f"Текущая версия: {st.current_sha[:7] or '—'}")
        kind = {"error": "err", "unsupported": "err", "done": "ok", "ready": "info"}.get(st.phase, "info")
        self.banner.set_kind(kind, st.message)
        by_id = {s.id: s for s in st.steps}
        for sid, name, status in self.step_labels:
            s = by_id.get(sid)
            if not s:
                continue
            status.setText(STATE_TEXT.get(s.state, s.state) + (f": {s.detail}" if s.detail else ""))
            status.setProperty("pill", STATE_PILL.get(s.state) or "true")
            status.style().unpolish(status)
            status.style().polish(status)
