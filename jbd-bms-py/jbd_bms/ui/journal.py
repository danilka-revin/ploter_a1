"""Вкладка «Журнал»: события подключения, ошибки опроса, записи; экспорт истории в CSV."""

from __future__ import annotations

import time

from PySide6.QtGui import QFont
from PySide6.QtWidgets import QHBoxLayout, QLabel, QPlainTextEdit, QPushButton, QVBoxLayout, QWidget, QFileDialog

from .widgets import Banner, Card


class JournalView(QWidget):
    def __init__(self, export_fn, parent=None):
        """export_fn(path) -> число строк; вызывается из UI-потока."""
        super().__init__(parent)
        self._export = export_fn
        outer = QVBoxLayout(self)
        outer.setContentsMargins(20, 16, 20, 16)
        card = Card("Журнал событий", parent=self)
        row = QHBoxLayout()
        self.count = QLabel("Точек в истории: 0 (около часа при опросе раз в секунду)")
        self.count.setProperty("role", "muted")
        row.addWidget(self.count)
        row.addStretch(1)
        self.btn_csv = QPushButton("Сохранить историю в CSV…")
        self.btn_csv.setProperty("primary", True)
        self.btn_csv.clicked.connect(self._save)
        self.btn_clear = QPushButton("Очистить журнал")
        self.btn_clear.clicked.connect(self.clear)
        row.addWidget(self.btn_clear)
        row.addWidget(self.btn_csv)
        card.add_layout(row)
        self.banner = Banner(parent=self)
        card.add(self.banner)
        self.text = QPlainTextEdit()
        self.text.setReadOnly(True)
        self.text.setMaximumBlockCount(2000)
        mono = QFont("DejaVu Sans Mono")
        mono.setStyleHint(QFont.Monospace)
        self.text.setFont(mono)
        card.add(self.text, 1)
        outer.addWidget(card, 1)

    def add_event(self, text: str, at: float | None = None) -> None:
        ts = time.strftime("%H:%M:%S", time.localtime(at or time.time()))
        self.text.appendPlainText(f"{ts}  {text}")

    def clear(self) -> None:
        self.text.clear()
        self.banner.set_kind("info", "")

    def set_count(self, n: int) -> None:
        self.count.setText(f"Точек в истории: {n} (около часа при опросе раз в секунду)")

    def _save(self) -> None:
        default = f"jbd-history-{time.strftime('%Y-%m-%d_%H-%M')}.csv"
        path, _ = QFileDialog.getSaveFileName(self, "Сохранить историю", default, "CSV (*.csv)")
        if not path:
            return
        try:
            n = self._export(path)
        except OSError as e:
            self.banner.set_kind("err", f"Не удалось сохранить: {e}")
            return
        if n == 0:
            self.banner.set_kind("info", f"Файл сохранён, но истории ещё нет: {path}")
        else:
            self.banner.set_kind("ok", f"Сохранено {n} строк: {path}")
