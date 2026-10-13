"""Вкладка «Управление»: ключи заряда/разряда, остаток ёмкости, счётчики, резервная копия.

Каждое действие с платой требует подтверждения. Команды выполняет BmsService в рабочем потоке;
результат приходит через callback в UI-поток.
"""

from __future__ import annotations

import json
import time

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QCheckBox, QDoubleSpinBox, QFileDialog, QGridLayout, QHBoxLayout, QLabel,
                               QLineEdit, QMessageBox, QPushButton, QScrollArea, QStackedWidget, QVBoxLayout,
                               QWidget)

from .. import protocol as p
from .widgets import Banner, Card, Empty, Pill

ERR_LABEL = dict(p.ERROR_COUNTERS)

NOT_IN_APP = [
    "Калибровка напряжения, токов и температур — нужны эталонные приборы; ошибка калибровки искажает все показания.",
    "Тест балансировки — подаёт команды на балансиры напрямую, может перегреть ячейки.",
    "Смена и сброс пароля платы — ошибка может закрыть доступ к плате.",
    "Число ячеек — от него зависят все пороги; задаётся при первичной настройке.",
    "Прошивка — нет подтверждённого протокола загрузки.",
]


class ControlView(QWidget):
    """Вызывает колбэки контроллера: run_fn(fn, ok, err) — выполнить fn(bms) в рабочем потоке."""

    def __init__(self, run_fn, parent=None):
        super().__init__(parent)
        self._run = run_fn
        self._busy = False
        outer = QVBoxLayout(self)
        outer.setContentsMargins(20, 16, 20, 16)
        self.stack = QStackedWidget()
        self.empty = Empty("Плата не подключена", "Управление доступно только при подключённой плате.")
        self.stack.addWidget(self.empty)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(scroll.Shape.NoFrame)
        body = QWidget()
        scroll.setWidget(body)
        self.stack.addWidget(scroll)
        outer.addWidget(self.stack, 1)

        self.snap_basic: p.Basic | None = None
        self.snap_errors: dict | None = None

        g = QGridLayout(body)
        g.setContentsMargins(0, 0, 4, 0)
        g.setSpacing(14)

        # ключи
        fet = Card("Ключи заряда и разряда", parent=body)
        self.pill_chg = Pill("", "off")
        self.pill_dsg = Pill("", "off")
        r = QHBoxLayout()
        r.addWidget(self.pill_chg)
        r.addWidget(self.pill_dsg)
        r.addStretch(1)
        fet.add_layout(r)
        r2 = QHBoxLayout()
        self.btn_chg = QPushButton()
        self.btn_dsg = QPushButton()
        self.btn_chg.clicked.connect(self._toggle_charge)
        self.btn_dsg.clicked.connect(self._toggle_discharge)
        r2.addWidget(self.btn_chg)
        r2.addWidget(self.btn_dsg)
        r2.addStretch(1)
        fet.add_layout(r2)
        note = QLabel("Не сохраняется в память платы: после выключения платы ключи снова включаются.")
        note.setProperty("role", "tiny")
        note.setWordWrap(True)
        fet.add(note)
        self.fet_banner = Banner(parent=body)
        fet.add(self.fet_banner)
        fet.lay.addStretch(1)
        g.addWidget(fet, 0, 0)

        # остаток ёмкости
        cap = Card("Остаток ёмкости", parent=body)
        self.cap_now = QLabel("—")
        self.cap_now.setProperty("role", "muted")
        cap.add(self.cap_now)
        r3 = QHBoxLayout()
        self.cap_in = QDoubleSpinBox()
        self.cap_in.setDecimals(1)
        self.cap_in.setRange(0, 655.35)
        self.cap_in.setSuffix(" Ач")
        self.cap_in.setSpecialValueText("—")
        self.cap_in.setValue(0)
        self.cap_in.setMinimumWidth(140)
        self.btn_cap = QPushButton("Установить…")
        self.btn_cap.setProperty("primary", True)
        self.btn_cap.clicked.connect(self._set_capacity)
        r3.addWidget(self.cap_in)
        r3.addWidget(self.btn_cap)
        r3.addStretch(1)
        cap.add_layout(r3)
        hint = QLabel("Используйте после полной зарядки или разрядки, когда остаток известен точно.")
        hint.setProperty("role", "tiny")
        hint.setWordWrap(True)
        cap.add(hint)
        self.cap_banner = Banner(parent=body)
        cap.add(self.cap_banner)
        cap.lay.addStretch(1)
        g.addWidget(cap, 0, 1)

        # счётчики
        cnt = Card("Счётчики ошибок", parent=body)
        self.cnt_text = QLabel("—")
        self.cnt_text.setProperty("role", "muted")
        self.cnt_text.setWordWrap(True)
        cnt.add(self.cnt_text)
        self.btn_clear = QPushButton("Сбросить счётчики…")
        self.btn_clear.setProperty("danger", True)
        self.btn_clear.clicked.connect(self._clear_errors)
        cnt.add(self.btn_clear)
        self.cnt_banner = Banner(parent=body)
        cnt.add(self.cnt_banner)
        cnt.lay.addStretch(1)
        g.addWidget(cnt, 1, 0)

        # резервная копия
        self.backup = BackupCard(run_fn, self, parent=body)
        g.addWidget(self.backup, 1, 1)

        # что не делается
        na = Card("Не делается в приложении", parent=body)
        for t in NOT_IN_APP:
            lbl = QLabel("• " + t)
            lbl.setWordWrap(True)
            lbl.setProperty("role", "muted")
            na.add(lbl)
        na.lay.addStretch(1)
        g.addWidget(na, 2, 0, 1, 2)
        g.setColumnStretch(0, 1)
        g.setColumnStretch(1, 1)
        g.setRowStretch(3, 1)

    # ---------- состояние ----------

    def set_connected(self, connected: bool) -> None:
        self.stack.setCurrentWidget(self.stack.widget(1) if connected else self.empty)

    def set_busy(self, busy: bool) -> None:
        self._busy = busy
        self._refresh_buttons()

    def update_data(self, b: p.Basic, errors: dict | None) -> None:
        self.stack.setCurrentIndex(1)
        self.snap_basic = b
        if errors is not None:
            self.snap_errors = errors
        self.pill_chg.setText(f"Заряд: {'включён' if b.charge_fet_on else 'выключен'}")
        self.pill_chg.set_kind("ok" if b.charge_fet_on else "bad")
        self.pill_dsg.setText(f"Разряд: {'включён' if b.discharge_fet_on else 'выключен'}")
        self.pill_dsg.set_kind("ok" if b.discharge_fet_on else "bad")
        self.cap_now.setText(f"Сейчас: {b.remaining_ah:.1f} Ач из {b.full_ah:.1f} Ач ({b.capacity_pct}%)")
        if self.snap_errors is None:
            self.cnt_text.setText("Счётчики ещё не получены.")
        else:
            nz = [f"{ERR_LABEL.get(k, k)}: {v}" for k, v in self.snap_errors.items() if v > 0]
            self.cnt_text.setText("\n".join(nz) if nz else "Все счётчики нулевые.")
        self._refresh_buttons()

    def _refresh_buttons(self) -> None:
        b = self.snap_basic
        enabled = b is not None and not self._busy
        self.btn_chg.setEnabled(enabled)
        self.btn_dsg.setEnabled(enabled)
        self.btn_cap.setEnabled(enabled)
        self.btn_clear.setEnabled(enabled and self.snap_errors is not None)
        self.backup.set_actions_enabled(enabled)
        if b is not None:
            self.btn_chg.setText("Выключить заряд" if b.charge_fet_on else "Включить заряд")
            self.btn_dsg.setText("Выключить разряд" if b.discharge_fet_on else "Включить разряд")

    # ---------- действия ----------

    def _confirm(self, title: str, text: str) -> bool:
        box = QMessageBox(self)
        box.setWindowTitle(title)
        box.setIcon(QMessageBox.Warning)
        box.setText(title)
        box.setInformativeText(text)
        ok = box.addButton("Выполнить", QMessageBox.AcceptRole)
        box.addButton("Отмена", QMessageBox.RejectRole)
        box.exec()
        return box.clickedButton() is ok

    def _set_fet(self, charge: bool, discharge: bool, title: str, text: str, banner: Banner) -> None:
        if not self._confirm(title, text):
            return
        self.set_busy(True)

        def ok(_):
            self.set_busy(False)
            banner.set_kind("ok", "Выполнено. Состояние обновится при следующем опросе.")

        def err(e):
            self.set_busy(False)
            banner.set_kind("err", str(e))

        self._run(lambda bms: bms.set_fet(charge, discharge), ok, err)

    def _toggle_charge(self) -> None:
        b = self.snap_basic
        if not b:
            return
        on = not b.charge_fet_on
        self._set_fet(on, b.discharge_fet_on,
                      "Включить заряд" if on else "Выключить заряд",
                      "Зарядка батареи разрешится." if on else
                      "Зарядка батареи остановится. Нагрузка будет питаться от батареи.",
                      self.fet_banner)

    def _toggle_discharge(self) -> None:
        b = self.snap_basic
        if not b:
            return
        on = not b.discharge_fet_on
        self._set_fet(b.charge_fet_on, on,
                      "Включить разряд" if on else "Выключить разряд",
                      "Разряд батареи разрешится." if on else
                      "Батарея перестанет отдавать ток. Нагрузка отключится от батареи.",
                      self.fet_banner)

    def _set_capacity(self) -> None:
        v = round(self.cap_in.value(), 1)
        if not self._confirm("Установить остаток ёмкости",
                             f"Остаток станет {v:.1f} Ач. Оценка заряда (SOC) будет пересчитываться от этого значения."):
            return
        self.set_busy(True)

        def ok(res):
            self.set_busy(False)
            self.cap_banner.set_kind("ok", f"Остаток установлен: {res:.1f} Ач.")

        def err(e):
            self.set_busy(False)
            self.cap_banner.set_kind("err", str(e))

        def fn(bms):
            bms.set_capacity(v)
            return bms.basic().remaining_ah

        self._run(fn, ok, err)

    def _clear_errors(self) -> None:
        if not self._confirm("Сбросить счётчики ошибок",
                             "Все счётчики срабатываний защит будут обнулены и сохранены в память платы."):
            return
        self.set_busy(True)

        def ok(_):
            self.set_busy(False)
            self.cnt_banner.set_kind("ok", "Счётчики сброшены.")

        def err(e):
            self.set_busy(False)
            self.cnt_banner.set_kind("err", str(e))

        self._run(lambda bms: bms.clear_errors(), ok, err)


class BackupCard(Card):
    """Резервная копия настроек: файл JSON. Восстановление сначала показывает список изменений."""

    FORMAT = "jbd-bms-backup"

    def __init__(self, run_fn, owner: ControlView, parent=None):
        super().__init__("Резервная копия настроек", parent)
        self._run = run_fn
        self._owner = owner
        hint = QLabel("Копия — файл JSON со всеми параметрами из раздела «Настройки». "
                      "Восстановление покажет список изменений до записи.")
        hint.setProperty("role", "tiny")
        hint.setWordWrap(True)
        self.add(hint)
        row = QHBoxLayout()
        self.btn_save = QPushButton("Сохранить копию…")
        self.btn_load = QPushButton("Восстановить из файла…")
        self.btn_save.clicked.connect(self._save)
        self.btn_load.clicked.connect(self._load)
        row.addWidget(self.btn_save)
        row.addWidget(self.btn_load)
        row.addStretch(1)
        self.add_layout(row)
        self.banner = Banner(parent=self)
        self.add(self.banner)
        self.plan_box = QVBoxLayout()
        self.add_layout(self.plan_box)
        self._plan = None
        self.lay.addStretch(1)

    def set_actions_enabled(self, enabled: bool) -> None:
        self.btn_save.setEnabled(enabled)
        self.btn_load.setEnabled(enabled)

    def _save(self) -> None:
        default = f"jbd-settings-{time.strftime('%Y-%m-%d')}.json"
        path, _ = QFileDialog.getSaveFileName(self, "Сохранить копию настроек", default, "JSON (*.json)")
        if not path:
            return
        self._owner.set_busy(True)

        def fn(bms):
            return {s.key: bms.read_setting(s) for s in p.SETTINGS}

        def ok(values):
            self._owner.set_busy(False)
            data = {
                "format": self.FORMAT, "version": 1,
                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "settings": values,
            }
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            self.banner.set_kind("ok", f"Копия сохранена: {path}")

        def err(e):
            self._owner.set_busy(False)
            self.banner.set_kind("err", str(e))

        self._run(fn, ok, err)

    def _load(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "Восстановить настройки из файла", "", "JSON (*.json)")
        if not path:
            return
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            if data.get("format") != self.FORMAT or not isinstance(data.get("settings"), dict):
                raise ValueError("файл не похож на копию настроек JBD BMS")
            values = {k: float(v) for k, v in data["settings"].items() if k in p.WRITE_LIMITS and v is not None}
            skipped = [k for k in data["settings"] if k not in p.WRITE_LIMITS]
        except Exception as e:
            self.banner.set_kind("err", f"Не удалось прочитать файл: {e}")
            return
        self._owner.set_busy(True)

        def fn(bms):
            current = {s.key: bms.read_setting(s) for s in p.SETTINGS}
            changes = []
            for key, to in values.items():
                s = p.SETTINGS_BY_KEY[key]
                err = p.check_setting_value(key, to)
                if err:
                    raise p.ProtocolError(f"{s.label}: {err}")
                frm = current.get(key)
                if frm is None or abs(frm - to) > 1e-9:
                    changes.append((s, frm, to))
            merged = {k: (values[k] if k in values else v) for k, v in current.items() if v is not None}
            problems = p.check_consistency(merged)
            return changes, problems

        def ok(res):
            self._owner.set_busy(False)
            changes, problems = res
            self._show_plan(changes, problems, values, skipped)

        def err(e):
            self._owner.set_busy(False)
            self.banner.set_kind("err", str(e))

        self._run(fn, ok, err)

    def _show_plan(self, changes, problems, values, skipped) -> None:
        while self.plan_box.count():
            item = self.plan_box.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        if not changes:
            self.banner.set_kind("ok", "Копия совпадает с платой — восстанавливать нечего.")
            return
        head = QLabel(f"Будет записано {len(changes)}:")
        head.setProperty("role", "section")
        self.plan_box.addWidget(head)
        for s, frm, to in changes:
            lbl = QLabel(f"{s.label}:  {'—' if frm is None else frm} → {to} {s.unit}")
            self.plan_box.addWidget(lbl)
        if skipped:
            n = QLabel("Пропущено (нельзя записать из приложения): " + ", ".join(skipped))
            n.setProperty("role", "tiny")
            n.setWordWrap(True)
            self.plan_box.addWidget(n)
        if problems:
            self.banner.set_kind("err", "Нельзя записать: " + " · ".join(problems))
            return
        self._plan = (changes, values)
        self.banner.set_kind("info", "Проверьте список. Запись начнётся после подтверждения.")
        row = QHBoxLayout()
        cb_save = QCheckBox("Сохранить в память платы")
        cb_save.setChecked(True)
        pwd = QLineEdit()
        pwd.setPlaceholderText("Пароль платы (6 символов, если задан)")
        pwd.setMaxLength(6)
        pwd.setEchoMode(QLineEdit.Password)
        row.addWidget(cb_save)
        row.addWidget(pwd, 1)
        self.plan_box.addLayout(row)
        cb_ok = QCheckBox("Я проверил(а) список. Понимаю, что пороги влияют на защиту батареи.")
        self.plan_box.addWidget(cb_ok)
        btns = QHBoxLayout()
        bcancel = QPushButton("Отмена")
        bgo = QPushButton("Восстановить")
        bgo.setProperty("primary", True)
        bgo.setEnabled(False)
        cb_ok.toggled.connect(bgo.setEnabled)
        bcancel.clicked.connect(lambda: self._clear_plan())
        bgo.clicked.connect(lambda: self._apply(cb_save.isChecked(), pwd.text()))
        btns.addStretch(1)
        btns.addWidget(bcancel)
        btns.addWidget(bgo)
        self.plan_box.addLayout(btns)

    def _clear_plan(self) -> None:
        self._plan = None
        while self.plan_box.count():
            item = self.plan_box.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
            elif item.layout():
                while item.layout().count():
                    sub = item.layout().takeAt(0)
                    if sub.widget():
                        sub.widget().deleteLater()
        self.banner.set_kind("info", "")

    def _apply(self, save: bool, password: str) -> None:
        if not self._plan:
            return
        changes, values = self._plan
        if len(password) not in (0, 6):
            self.banner.set_kind("err", "Пароль платы — ровно 6 символов или пусто.")
            return
        writes = [(s.reg, p.setting_to_raw(s, to)) for s, _frm, to in changes]
        self._owner.set_busy(True)

        def fn(bms):
            bms.write_settings(writes, save=save, password=password)
            return [(s.label, bms.read_setting(s), to) for s, _f, to in changes]

        def ok(res):
            self._owner.set_busy(False)
            bad = [r for r in res if r[1] is None or abs(r[1] - r[2]) > 1e-9]
            if bad:
                self.banner.set_kind("err", "Проверка чтением не совпала: " + ", ".join(b[0] for b in bad))
            else:
                self.banner.set_kind("ok", f"Записано {len(res)} параметров. Проверка чтением совпала.")
            self._clear_plan()

        def err(e):
            self._owner.set_busy(False)
            self.banner.set_kind("err", str(e))

        self._run(fn, ok, err)
