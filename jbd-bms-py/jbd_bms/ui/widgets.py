"""Общие виджеты: карточка, пилюля-статус, факт, плитка ячейки, пустое состояние, баннер."""

from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QFrame, QHBoxLayout, QLabel, QProgressBar, QVBoxLayout, QWidget)


def repolish(w: QWidget) -> None:
    st = w.style()
    st.unpolish(w)
    st.polish(w)
    w.update()


class Card(QFrame):
    def __init__(self, title: str = "", parent=None, *, wide: bool = False):
        super().__init__(parent)
        self.setProperty("card", True)
        self.lay = QVBoxLayout(self)
        self.lay.setContentsMargins(18, 16, 18, 16)
        self.lay.setSpacing(10)
        self.title_row = QHBoxLayout()
        self.title_row.setSpacing(8)
        self.lay.addLayout(self.title_row)
        if title:
            t = QLabel(title)
            t.setProperty("role", "section")
            self.title_row.addWidget(t)
            self.title_row.addStretch(1)
        self.wide = wide

    def add(self, w, stretch: int = 0):
        self.lay.addWidget(w, stretch)
        return w

    def add_layout(self, layout):
        self.lay.addLayout(layout)
        return layout


class Pill(QLabel):
    def __init__(self, text: str = "", kind: str = "", parent=None):
        super().__init__(text, parent)
        self.setProperty("pill", "true")
        self.set_kind(kind)

    def set_kind(self, kind: str) -> None:
        self.setProperty("pill", kind or "true")
        repolish(self)


class Fact(QWidget):
    def __init__(self, label: str, value: str = "—", parent=None):
        super().__init__(parent)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(2)
        self.cap = QLabel(label.upper())
        self.cap.setProperty("role", "caption")
        self.val = QLabel(value)
        self.val.setProperty("role", "value")
        self.val.setWordWrap(True)
        lay.addWidget(self.cap)
        lay.addWidget(self.val)

    def set(self, value: str) -> None:
        self.val.setText(value)


class Banner(QLabel):
    def __init__(self, text: str = "", kind: str = "info", parent=None):
        super().__init__(text, parent)
        self.setWordWrap(True)
        self.set_kind(kind, text)
        self.setVisible(bool(text))

    def set_kind(self, kind: str, text: str | None = None) -> None:
        self.setProperty("banner", kind)
        if text is not None:
            self.setText(text)
            self.setVisible(bool(text))
        repolish(self)


class Empty(QWidget):
    def __init__(self, title: str, text: str = "", parent=None):
        super().__init__(parent)
        lay = QVBoxLayout(self)
        lay.addStretch(1)
        t = QLabel(title)
        t.setProperty("role", "title")
        t.setAlignment(Qt.AlignCenter)
        d = QLabel(text)
        d.setProperty("role", "muted")
        d.setAlignment(Qt.AlignCenter)
        d.setWordWrap(True)
        lay.addWidget(t)
        lay.addWidget(d)
        lay.addStretch(1)

    def set_text(self, title: str, text: str = "") -> None:
        lbls = self.findChildren(QLabel)
        lbls[0].setText(title)
        lbls[1].setText(text)


class CellTile(QFrame):
    """Плитка одной ячейки: номер, напряжение, отклонение от среднего и полоса."""

    def __init__(self, number: int, parent=None):
        super().__init__(parent)
        self.setProperty("tile", True)
        self.setProperty("state", "")
        self.setMinimumWidth(112)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(10, 8, 10, 8)
        lay.setSpacing(2)
        top = QHBoxLayout()
        self.num = QLabel(f"#{number}")
        self.num.setProperty("role", "tiny")
        self.badge = QLabel("баланс")
        self.badge.setProperty("pill", "accent")
        self.badge.setVisible(False)
        top.addWidget(self.num)
        top.addStretch(1)
        top.addWidget(self.badge)
        self.mv = QLabel("—")
        self.mv.setProperty("role", "value")
        self.dev = QLabel("")
        self.dev.setProperty("role", "tiny")
        self.bar = QProgressBar()
        self.bar.setProperty("tile", "true")
        self.bar.setRange(0, 1000)
        self.bar.setValue(0)
        self.bar.setTextVisible(False)
        lay.addLayout(top)
        lay.addWidget(self.mv)
        lay.addWidget(self.dev)
        lay.addWidget(self.bar)

    def set_data(self, mv: int | None, dev: int | None, fill: float, state: str, balancing: bool) -> None:
        self.mv.setText("—" if mv is None else f"{mv:,}".replace(",", " ") + " мВ")
        self.dev.setText("" if dev is None else ("среднее" if dev == 0 else f"{dev:+d} мВ к среднему"))
        self.bar.setValue(int(max(0, min(1, fill)) * 1000))
        self.badge.setVisible(balancing)
        for w in (self, self.bar):
            w.setProperty("state", state)
            repolish(w)
