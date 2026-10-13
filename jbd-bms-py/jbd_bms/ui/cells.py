"""Вкладка «Ячейки»: компактная плитка на каждую банку, сводка и балансировка."""

from __future__ import annotations

from PySide6.QtWidgets import QGridLayout, QLabel, QScrollArea, QStackedWidget, QVBoxLayout, QWidget, QHBoxLayout

from .widgets import Banner, Card, CellTile, Empty, Fact, repolish

# шкала заряда ячейки LiFePO4 для полоски на плитке (мВ)
CELL_MIN_MV = 2500
CELL_MAX_MV = 3650
DEV_WARN_MV = 20      # отклонение от среднего, с которого плитка подсвечивается
SPREAD_WARN_MV = 30   # разброс, при котором сводка предупреждает
COLUMNS = 6


class CellsView(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(20, 16, 20, 16)
        outer.setSpacing(12)
        self.banner = Banner(parent=self)
        outer.addWidget(self.banner)
        self.stack = QStackedWidget()
        self.empty = Empty("Плата не подключена", "Данные ячеек появятся после подключения.")
        self.stack.addWidget(self.empty)

        body = QWidget()
        bl = QVBoxLayout(body)
        bl.setContentsMargins(0, 0, 0, 0)
        bl.setSpacing(12)

        summary = Card(parent=body)
        row = QHBoxLayout()
        row.setSpacing(28)
        self.f_min = Fact("Минимум")
        self.f_max = Fact("Максимум")
        self.f_spread = Fact("Разброс")
        self.f_avg = Fact("Среднее")
        self.f_sum = Fact("Сумма ячеек")
        for f in (self.f_min, self.f_max, self.f_spread, self.f_avg, self.f_sum):
            row.addWidget(f)
        row.addStretch(1)
        summary.add_layout(row)
        self.bal_text = QLabel("—")
        self.bal_text.setProperty("role", "muted")
        self.bal_text.setWordWrap(True)
        summary.add(self.bal_text)
        bl.addWidget(summary)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(scroll.Shape.NoFrame)
        self.grid_host = QWidget()
        self.grid = QGridLayout(self.grid_host)
        self.grid.setContentsMargins(0, 0, 0, 0)
        self.grid.setSpacing(10)
        scroll.setWidget(self.grid_host)
        bl.addWidget(scroll, 1)

        self.stack.addWidget(body)
        self.body = body
        outer.addWidget(self.stack, 1)
        self.tiles: list[CellTile] = []

    def set_connected(self, connected: bool, title: str = "", text: str = "") -> None:
        if connected:
            self.stack.setCurrentWidget(self.body)
        else:
            self.empty.set_text(title or "Плата не подключена",
                                text or "Данные ячеек появятся после подключения.")
            self.stack.setCurrentWidget(self.empty)

    def set_error(self, text: str) -> None:
        self.banner.set_kind("err", f"Последний опрос: {text}" if text else "")

    def _ensure_tiles(self, n: int) -> None:
        if len(self.tiles) == n:
            return
        while self.grid.count():
            item = self.grid.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        self.tiles = []
        for i in range(n):
            t = CellTile(i + 1)
            self.tiles.append(t)
            self.grid.addWidget(t, i // COLUMNS, i % COLUMNS)
        for c in range(COLUMNS):
            self.grid.setColumnStretch(c, 1)
        self.grid.setRowStretch(self.grid.rowCount(), 1)

    def update_data(self, cells: list[int], balancing: list[int]) -> None:
        self.stack.setCurrentWidget(self.body)
        n = len(cells)
        if n == 0:
            self.stack.setCurrentWidget(self.empty)
            return
        self._ensure_tiles(n)
        avg = sum(cells) / n
        lo, hi = min(cells), max(cells)
        imin, imax = cells.index(lo) + 1, cells.index(hi) + 1
        self.f_min.set(f"{lo} мВ · #{imin}")
        self.f_max.set(f"{hi} мВ · #{imax}")
        spread = hi - lo
        self.f_spread.set(f"{spread} мВ")
        self.f_spread.val.setProperty("tone", "warn" if spread > SPREAD_WARN_MV else "")
        repolish(self.f_spread.val)
        self.f_avg.set(f"{avg:.0f} мВ")
        self.f_sum.set(f"{sum(cells) / 1000:.2f} В")
        self.bal_text.setText("Сейчас не балансируется." if not balancing else
                              "Балансируются ячейки: " + ", ".join(f"#{i}" for i in balancing))
        bal = set(balancing)
        for i, (t, mv) in enumerate(zip(self.tiles, cells)):
            dev = round(mv - avg)
            state = "balance" if (i + 1) in bal else ""
            if not state and dev <= -DEV_WARN_MV:
                state = "low"
            elif not state and dev >= DEV_WARN_MV:
                state = "high"
            fill = (mv - CELL_MIN_MV) / (CELL_MAX_MV - CELL_MIN_MV)
            t.set_data(mv, dev, fill, state, (i + 1) in bal)
