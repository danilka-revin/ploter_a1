"""Вкладка «Обзор»: напряжение, ток, заряд, ключи, балансировка, температуры, защиты."""

from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QGridLayout, QHBoxLayout, QLabel, QProgressBar, QScrollArea, QStackedWidget,
                               QVBoxLayout, QWidget)

from .. import protocol as p
from .widgets import Banner, Card, Empty, Fact, Pill, repolish

ERR_LABEL = dict(p.ERROR_COUNTERS)


class OverviewView(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(20, 16, 20, 16)
        self.banner = Banner(parent=self)
        outer.addWidget(self.banner)
        self.stack = QStackedWidget()
        self.empty = Empty("Плата не подключена",
                           "Выберите порт сверху и нажмите «Подключить». Для проверки без платы включите демо-режим.")
        self.stack.addWidget(self.empty)
        self.body = QWidget()
        self.stack.addWidget(self.body)
        outer.addWidget(self.stack, 1)
        self._errors: dict | None = None
        self._build()

    # ---------- разметка ----------

    def _build(self):
        g = QGridLayout(self.body)
        g.setContentsMargins(0, 0, 0, 0)
        g.setSpacing(14)

        # главная карточка: напряжение, ток, заряд, факты
        hero = Card(parent=self.body)
        top = QHBoxLayout()
        left = QVBoxLayout()
        cap = QLabel("Напряжение батареи".upper())
        cap.setProperty("role", "caption")
        self.voltage = QLabel("—")
        self.voltage.setProperty("role", "big")
        unit = QLabel("В")
        unit.setProperty("role", "unit")
        vrow = QHBoxLayout()
        vrow.setAlignment(Qt.AlignBottom)
        vrow.addWidget(self.voltage)
        vrow.addWidget(unit)
        vrow.addStretch(1)
        left.addWidget(cap)
        left.addLayout(vrow)
        top.addLayout(left, 1)

        right = QVBoxLayout()
        right.setAlignment(Qt.AlignRight)
        cap2 = QLabel("Ток")
        cap2.setProperty("role", "caption")
        cap2.setAlignment(Qt.AlignRight)
        self.current = QLabel("—")
        self.current.setProperty("role", "value")
        self.current.setAlignment(Qt.AlignRight)
        self.direction = QLabel("")
        self.direction.setProperty("role", "muted")
        self.direction.setAlignment(Qt.AlignRight)
        right.addWidget(cap2)
        right.addWidget(self.current)
        right.addWidget(self.direction)
        top.addLayout(right)
        hero.add_layout(top)

        soc_row = QHBoxLayout()
        self.soc = QProgressBar()
        self.soc.setProperty("soc", "true")
        self.soc.setRange(0, 100)
        self.soc.setTextVisible(False)
        self.soc_text = QLabel("")
        self.soc_text.setProperty("role", "small")
        soc_row.addWidget(self.soc, 1)
        hero.add(QLabel())  # отступ
        hero.add_layout(soc_row)
        hero.add(self.soc_text)

        facts = QGridLayout()
        facts.setHorizontalSpacing(24)
        facts.setVerticalSpacing(10)
        self.f_cells = Fact("Ячеек")
        self.f_cycles = Fact("Циклов")
        self.f_date = Fact("Дата выпуска")
        self.f_fw = Fact("Прошивка")
        self.f_dev = Fact("Устройство")
        for i, f in enumerate([self.f_cells, self.f_cycles, self.f_date, self.f_fw, self.f_dev]):
            facts.addWidget(f, i // 3, i % 3)
        hero.add_layout(facts)
        g.addWidget(hero, 0, 0)

        # ключи и балансировка
        keys = Card("Силовые ключи", parent=self.body)
        krow = QHBoxLayout()
        self.pill_chg = Pill("Заряд", "off")
        self.pill_dsg = Pill("Разряд", "off")
        krow.addWidget(self.pill_chg)
        krow.addWidget(self.pill_dsg)
        krow.addStretch(1)
        keys.add_layout(krow)
        bal_t = QLabel("Балансировка")
        bal_t.setProperty("role", "section")
        keys.add(bal_t)
        self.bal_text = QLabel("—")
        self.bal_text.setProperty("role", "muted")
        self.bal_text.setWordWrap(True)
        keys.add(self.bal_text)
        keys.lay.addStretch(1)
        g.addWidget(keys, 0, 1)

        # температуры
        temps = Card("Температуры", parent=self.body)
        self.temp_box = QVBoxLayout()
        temps.add_layout(self.temp_box)
        temps.lay.addStretch(1)
        self.temp_labels: list[QLabel] = []
        g.addWidget(temps, 0, 2)

        # защиты и счётчики
        prot = Card("Защиты", parent=self.body)
        prot_head = prot.title_row
        self.prot_pill = Pill("—", "")
        prot_head.addWidget(self.prot_pill)
        self.faults_text = QLabel("—")
        self.faults_text.setProperty("role", "muted")
        self.faults_text.setWordWrap(True)
        prot.add(self.faults_text)
        cnt_t = QLabel("Счётчики срабатываний")
        cnt_t.setProperty("role", "section")
        prot.add(cnt_t)
        self.counters_text = QLabel("—")
        self.counters_text.setProperty("role", "muted")
        self.counters_text.setWordWrap(True)
        prot.add(self.counters_text)
        prot.lay.addStretch(1)
        g.addWidget(prot, 1, 0, 1, 3)

        for c in range(3):
            g.setColumnStretch(c, 1 if c else 2)
        g.setRowStretch(2, 1)

    # ---------- состояние ----------

    def set_connected(self, connected: bool, title: str = "", text: str = "") -> None:
        if connected:
            self.stack.setCurrentWidget(self.body)
        else:
            self.empty.set_text(title or "Плата не подключена",
                                text or "Выберите порт сверху и нажмите «Подключить». "
                                        "Для проверки без платы включите демо-режим.")
            self.stack.setCurrentWidget(self.empty)

    def show_wait(self, text: str) -> None:
        self.empty.set_text("Читаю данные…", text)
        self.stack.setCurrentWidget(self.empty)

    def set_error(self, text: str) -> None:
        self.banner.set_kind("err", f"Последний опрос: {text}" if text else "")

    def update_data(self, b: p.Basic, errors: dict | None, device_name: str = "") -> None:
        self.stack.setCurrentWidget(self.body)
        if errors is not None:
            self._errors = errors
        self.voltage.setText(f"{b.pack_voltage:.2f}")
        cur = b.pack_current
        self.current.setText(f"{'+' if cur >= 0 else ''}{cur:.2f} А")
        self.current.setProperty("tone", "pos" if cur > 0.05 else "neg" if cur < -0.05 else "")
        repolish(self.current)
        if cur < -0.05:
            d = "разряд"
        elif cur > 0.05:
            d = "заряд"
        else:
            d = "ток почти нулевой"
        self.direction.setText(d)
        self.soc.setValue(max(0, min(100, b.capacity_pct)))
        self.soc_text.setText(f"{b.capacity_pct}% заряда · {b.remaining_ah:.1f} из {b.full_ah:.1f} Ач")
        self.f_cells.set(str(b.cell_count))
        self.f_cycles.set(str(b.cycles))
        d_ = b.manufacture_date
        self.f_date.set(f"{d_['day']:02d}.{d_['month']:02d}.{d_['year']}")
        self.f_fw.set(f"0x{b.firmware_version:02X}")
        self.f_dev.set(device_name or "—")

        self.pill_chg.setText(f"Заряд: {'включён' if b.charge_fet_on else 'выключен'}")
        self.pill_chg.set_kind("ok" if b.charge_fet_on else "bad")
        self.pill_dsg.setText(f"Разряд: {'включён' if b.discharge_fet_on else 'выключен'}")
        self.pill_dsg.set_kind("ok" if b.discharge_fet_on else "bad")
        self.bal_text.setText("Сейчас не балансируется." if not b.balancing_cells else
                              "Балансируются ячейки: " + ", ".join(map(str, b.balancing_cells)))

        self._set_temps(b.temperatures)

        if b.faults:
            self.prot_pill.setText(f"активно: {len(b.faults)}")
            self.prot_pill.set_kind("bad")
            self.faults_text.setText("\n".join("• " + f["label"] for f in b.faults))
        else:
            self.prot_pill.setText("защит нет")
            self.prot_pill.set_kind("ok")
            self.faults_text.setText("Плата не сообщает о срабатывании защит.")
        if self._errors is None:
            self.counters_text.setText("Счётчики ещё не получены.")
        else:
            nz = [f"{ERR_LABEL.get(k, k)}: {v}" for k, v in self._errors.items() if v > 0]
            self.counters_text.setText("\n".join(nz) if nz else "Срабатываний не было.")

    def _set_temps(self, temps: list[float]) -> None:
        while len(self.temp_labels) < len(temps):
            row = QLabel()
            row.setTextFormat(Qt.PlainText)
            self.temp_box.addWidget(row)
            self.temp_labels.append(row)
        for i, lbl in enumerate(self.temp_labels):
            if i < len(temps):
                lbl.setText(f"Датчик {i + 1}:  {temps[i]:.1f} °C")
                lbl.setVisible(True)
            else:
                lbl.setVisible(False)
        if not temps:
            if not hasattr(self, "_no_temps"):
                self._no_temps = QLabel("Датчики не сообщены платой.")
                self._no_temps.setProperty("role", "muted")
                self.temp_box.addWidget(self._no_temps)
            self._no_temps.setVisible(True)
        elif hasattr(self, "_no_temps"):
            self._no_temps.setVisible(False)
