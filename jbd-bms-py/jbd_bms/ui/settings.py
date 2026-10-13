"""Вкладка «Настройки»: пороги защит, ёмкость, токи, температуры, балансировка.

Поток записи: ввод → проверка пределов и шага регистра → проверка согласованности порогов →
подтверждение (список «было → станет», пароль, галочка) → запись в заводском режиме →
повторное чтение каждого записанного параметра.
"""

from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QCheckBox, QDialog, QDialogButtonBox, QGridLayout, QHBoxLayout, QHeaderView,
                               QLabel, QLineEdit, QPushButton, QScrollArea, QStackedWidget, QTableWidget,
                               QTableWidgetItem, QVBoxLayout, QWidget)

from .. import protocol as p
from .widgets import Banner, Card, Empty, repolish

GROUP_ORDER = ["Ёмкость", "Напряжение ячейки", "Напряжение батареи", "Токи", "Температура", "Балансировка"]


def fmt_value(key: str, v: float | None) -> str:
    if v is None:
        return "нет данных"
    s = p.SETTINGS_BY_KEY[key]
    if s.kind == "temp":
        return f"{v:.1f}"
    return f"{v:g}"


def fmt_input(key: str, v: float) -> str:
    return fmt_value(key, v).replace(".", ",")


def parse_num(text: str) -> float | None:
    t = text.strip().replace(",", ".")
    if t in ("", "-", "."):
        return None
    try:
        v = float(t)
    except ValueError:
        return None
    return v if v == v and abs(v) != float("inf") else None


class SettingsView(QWidget):
    def __init__(self, run_fn, parent=None):
        super().__init__(parent)
        self._run = run_fn
        self.values: dict[str, float | None] = {}
        self.loaded = False
        self.busy = False
        self.edits: dict[str, QLineEdit] = {}
        self.err_labels: dict[str, QLabel] = {}
        self.connected = False

        outer = QVBoxLayout(self)
        outer.setContentsMargins(20, 16, 20, 16)
        outer.setSpacing(12)
        self.stack = QStackedWidget()
        self.empty = Empty("Плата не подключена",
                           "Настройки читаются и записываются только при подключённой плате.")
        self.stack.addWidget(self.empty)

        page = QWidget()
        pl = QVBoxLayout(page)
        pl.setContentsMargins(0, 0, 0, 0)
        pl.setSpacing(12)

        head = Card(parent=page)
        hrow = QHBoxLayout()
        left = QVBoxLayout()
        t = QLabel("Настройки платы")
        t.setProperty("role", "title")
        d = QLabel("Значения из памяти BMS. Изменяйте только то, что понимаете: неверные пороги могут отключить "
                   "защиту аккумулятора или вызвать ложные срабатывания. Сверяйтесь с документацией батареи и платы.")
        d.setProperty("role", "muted")
        d.setWordWrap(True)
        left.addWidget(t)
        left.addWidget(d)
        hrow.addLayout(left, 1)
        btns = QVBoxLayout()
        btns.setAlignment(Qt.AlignTop)
        self.btn_read = QPushButton("Прочитать настройки")
        self.btn_reset = QPushButton("Сбросить правки")
        self.btn_write = QPushButton("Записать в плату…")
        self.btn_write.setProperty("primary", True)
        self.btn_read.clicked.connect(self.read_all)
        self.btn_reset.clicked.connect(self.reset_draft)
        self.btn_write.clicked.connect(self.open_confirm)
        for b in (self.btn_read, self.btn_reset, self.btn_write):
            btns.addWidget(b)
        hrow.addLayout(btns)
        head.add_layout(hrow)
        pl.addWidget(head)

        self.banner = Banner(parent=page)
        pl.addWidget(self.banner)
        self.check_label = QLabel("")
        self.check_label.setProperty("role", "bad")
        self.check_label.setWordWrap(True)
        self.check_label.setVisible(False)
        pl.addWidget(self.check_label)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(scroll.Shape.NoFrame)
        self.groups_host = QWidget()
        self.groups_lay = QGridLayout(self.groups_host)
        self.groups_lay.setContentsMargins(0, 0, 4, 0)
        self.groups_lay.setSpacing(14)
        scroll.setWidget(self.groups_host)
        pl.addWidget(scroll, 1)

        self.stack.addWidget(page)
        self.page = page
        outer.addWidget(self.stack, 1)
        self._sync_buttons()

    # ---------- состояние ----------

    def set_connected(self, connected: bool) -> None:
        self.connected = connected
        self.stack.setCurrentWidget(self.page if connected else self.empty)
        if not connected:
            self.loaded = False
        self._sync_buttons()

    def set_busy(self, busy: bool) -> None:
        self.busy = busy
        self._sync_buttons()

    def _sync_buttons(self) -> None:
        dirty = bool(self.changes())
        blocked = bool(self.input_errors()) or bool(self.consistency_errors())
        self.btn_read.setEnabled(self.connected and not self.busy)
        self.btn_read.setText("Перечитать настройки" if self.loaded else "Прочитать настройки")
        self.btn_reset.setEnabled(self.loaded and dirty and not self.busy)
        self.btn_write.setEnabled(self.loaded and dirty and not blocked and not self.busy)
        self.btn_write.setText(f"Записать в плату ({len(self.changes())})…" if dirty else "Записать в плату…")

    # ---------- чтение ----------

    def read_all(self) -> None:
        if self.busy:
            return
        self.set_busy(True)
        self.banner.set_kind("info", "Читаю настройки… это займёт несколько секунд.")

        def fn(bms):
            return {s.key: bms.read_setting(s) for s in p.SETTINGS}

        def ok(vals):
            self.set_busy(False)
            self.values = vals
            self.loaded = True
            self._build_groups()
            self.banner.set_kind("info", "")
            self._sync_buttons()

        def err(e):
            self.set_busy(False)
            self.banner.set_kind("err", str(e))

        self._run(fn, ok, err)

    def _build_groups(self) -> None:
        while self.groups_lay.count():
            item = self.groups_lay.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        self.edits.clear()
        self.err_labels.clear()
        groups: dict[str, list[p.Setting]] = {}
        for s in p.SETTINGS:
            if s.key not in p.WRITE_LIMITS:
                continue
            groups.setdefault(p.WRITE_LIMITS[s.key].group, []).append(s)
        names = [g for g in GROUP_ORDER if g in groups]
        for i, name in enumerate(names):
            card = Card(name, parent=self.groups_host)
            table = QTableWidget(len(groups[name]), 4)
            table.setHorizontalHeaderLabels(["Параметр", "Сейчас в плате", "Новое значение", "Пределы"])
            table.verticalHeader().setVisible(False)
            table.setSelectionMode(QTableWidget.NoSelection)
            table.setFocusPolicy(Qt.NoFocus)
            hdr = table.horizontalHeader()
            hdr.setSectionResizeMode(0, QHeaderView.Stretch)
            hdr.setSectionResizeMode(1, QHeaderView.ResizeToContents)
            hdr.setSectionResizeMode(2, QHeaderView.ResizeToContents)
            hdr.setSectionResizeMode(3, QHeaderView.ResizeToContents)
            table.verticalHeader().setDefaultSectionSize(40)
            table.setMinimumHeight(44 + 40 * len(groups[name]) + 4)
            table.setVerticalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
            table.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
            for r, s in enumerate(groups[name]):
                lim = p.WRITE_LIMITS[s.key]
                v = self.values.get(s.key)
                name_item = QTableWidgetItem(s.label)
                table.setItem(r, 0, name_item)
                cur = QTableWidgetItem(("—" if v is None else f"{fmt_value(s.key, v)} {s.unit}"))
                cur.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                table.setItem(r, 1, cur)
                edit = QLineEdit(fmt_input(s.key, v) if v is not None else "")
                edit.setMaximumWidth(150)
                edit.setAlignment(Qt.AlignRight)
                edit.setEnabled(v is not None)
                edit.setObjectName(s.key)
                edit.textChanged.connect(lambda _t, k=s.key: self._on_edit(k))
                self.edits[s.key] = edit
                holder = QWidget()
                hl = QHBoxLayout(holder)
                hl.setContentsMargins(6, 2, 6, 2)
                hl.addWidget(edit)
                unit = QLabel(s.unit)
                unit.setProperty("role", "muted")
                hl.addWidget(unit)
                table.setCellWidget(r, 2, holder)
                lim_txt = f"{lim.min:g} … {lim.max:g} {s.unit}"
                li = QTableWidgetItem(lim_txt)
                table.setItem(r, 3, li)
                table.setToolTip(s.label)
            card.add(table)
            err_lbl = QLabel("")
            err_lbl.setProperty("role", "bad")
            err_lbl.setWordWrap(True)
            err_lbl.setVisible(False)
            card.add(err_lbl)
            self.err_labels[name] = err_lbl
            self.groups_lay.addWidget(card, i, 0)
        self.groups_lay.setRowStretch(len(names), 1)
        self._revalidate()

    # ---------- правки ----------

    def _on_edit(self, key: str) -> None:
        edit = self.edits[key]
        v = parse_num(edit.text())
        bad = bool(edit.text().strip()) and (v is None or p.check_setting_value(key, v) is not None)
        edit.setProperty("bad", bad)
        repolish(edit)
        self._revalidate()

    def draft_values(self) -> dict[str, float]:
        out: dict[str, float] = {}
        for key, edit in self.edits.items():
            v = parse_num(edit.text())
            if v is not None and self.values.get(key) is not None:
                out[key] = v
        return out

    def changes(self) -> list[tuple[p.Setting, float | None, float]]:
        out = []
        if not self.loaded:
            return out
        for key, v in self.draft_values().items():
            cur = self.values.get(key)
            if cur is None or abs(cur - v) < 1e-9:
                continue
            if p.check_setting_value(key, v) is not None:
                continue
            out.append((p.SETTINGS_BY_KEY[key], cur, v))
        return out

    def input_errors(self) -> dict[str, str]:
        errs = {}
        for key, edit in self.edits.items():
            text = edit.text()
            if not text.strip() or self.values.get(key) is None:
                continue
            v = parse_num(text)
            if v is None:
                errs[key] = "введите число"
                continue
            e = p.check_setting_value(key, v)
            if e:
                errs[key] = e
        return errs

    def consistency_errors(self) -> list[str]:
        if not self.loaded:
            return []
        merged = {k: v for k, v in self.values.items() if v is not None}
        merged.update(self.draft_values())
        return p.check_consistency(merged)

    def _revalidate(self) -> None:
        ierr = self.input_errors()
        cerr = self.consistency_errors()
        # подсказка по каждому разделу — только по ошибкам ввода
        for name, lbl in self.err_labels.items():
            msgs = []
            for s in p.SETTINGS:
                if s.key in ierr and p.WRITE_LIMITS.get(s.key) and p.WRITE_LIMITS[s.key].group == name:
                    msgs.append(f"{s.label}: {ierr[s.key]}")
            lbl.setText("\n".join(msgs))
            lbl.setVisible(bool(msgs))
        if cerr:
            self.check_label.setText("Пороги противоречат друг другу: " + " · ".join(cerr))
            self.check_label.setVisible(True)
        else:
            self.check_label.setVisible(False)
        self._sync_buttons()

    def reset_draft(self) -> None:
        for key, edit in self.edits.items():
            v = self.values.get(key)
            edit.setText(fmt_input(key, v) if v is not None else "")

    # ---------- запись ----------

    def open_confirm(self) -> None:
        changes = self.changes()
        if not changes:
            return
        dlg = ConfirmWriteDialog(changes, self)
        if dlg.exec() != QDialog.Accepted:
            return
        self._write(changes, dlg.save_checkbox.isChecked(), dlg.password.text())

    def _write(self, changes, save: bool, password: str) -> None:
        writes = [(s.reg, p.setting_to_raw(s, to)) for s, _c, to in changes]
        self.set_busy(True)
        self.banner.set_kind("info", "Записываю… не отключайте плату.")

        def fn(bms):
            bms.write_settings(writes, save=save, password=password)
            return [(s.key, s.label, to, bms.read_setting(s)) for s, _c, to in changes]

        def ok(res):
            self.set_busy(False)
            bad = [r for r in res if r[3] is None or abs(r[3] - r[2]) > 1e-9]
            lines = [f"{r[1]}: {fmt_value(r[0], r[3])} {p.SETTINGS_BY_KEY[r[0]].unit}" for r in res]
            if bad:
                self.banner.set_kind("err", "Проверка чтением не совпала для: " + ", ".join(r[1] for r in bad)
                             + ". Перечитайте настройки.")
            else:
                msg = f"Записано {len(res)} параметров" + (" и сохранено в память платы." if save
                                                             else ". Не сохранено: выход без записи в память.")
                self.banner.set_kind("ok", msg + " Проверка чтением совпала.")
            # обновить «сейчас в плате» по всем параметрам
            self.read_all()

        def err(e):
            self.set_busy(False)
            self.banner.set_kind("err", str(e))
            self.read_all()

        self._run(fn, ok, err)


class ConfirmWriteDialog(QDialog):
    def __init__(self, changes, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Записать настройки в плату")
        self.setMinimumWidth(560)
        lay = QVBoxLayout(self)
        head = QLabel(f"Будет записано {len(changes)} параметров:")
        head.setProperty("role", "section")
        lay.addWidget(head)
        table = QTableWidget(len(changes), 3)
        table.setHorizontalHeaderLabels(["Параметр", "Сейчас", "Станет"])
        table.verticalHeader().setVisible(False)
        table.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeToContents)
        table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeToContents)
        for r, (s, cur, to) in enumerate(changes):
            table.setItem(r, 0, QTableWidgetItem(s.label))
            table.setItem(r, 1, QTableWidgetItem(f"{fmt_value(s.key, cur)} {s.unit}"))
            table.setItem(r, 2, QTableWidgetItem(f"{fmt_value(s.key, to)} {s.unit}"))
        table.setMaximumHeight(min(360, 42 + 32 * len(changes)))
        lay.addWidget(table)
        self.save_checkbox = QCheckBox("Сохранить в память платы")
        self.save_checkbox.setChecked(True)
        lay.addWidget(self.save_checkbox)
        self.password = QLineEdit()
        self.password.setPlaceholderText("Пароль платы (6 символов, если задан)")
        self.password.setMaxLength(6)
        self.password.setEchoMode(QLineEdit.Password)
        lay.addWidget(self.password)
        self.understood = QCheckBox("Я проверил(а) список. Понимаю, что пороги влияют на защиту батареи.")
        lay.addWidget(self.understood)
        self.buttons = QDialogButtonBox()
        self.cancel_btn = self.buttons.addButton("Отмена", QDialogButtonBox.RejectRole)
        self.ok_btn = self.buttons.addButton("Записать", QDialogButtonBox.AcceptRole)
        self.ok_btn.setProperty("primary", True)
        self.ok_btn.setEnabled(False)
        self.understood.toggled.connect(self._check)
        self.password.textChanged.connect(self._check)
        self.buttons.accepted.connect(self._accept)
        self.buttons.rejected.connect(self.reject)
        lay.addWidget(self.buttons)

    def _check(self) -> None:
        pw = self.password.text()
        self.ok_btn.setEnabled(self.understood.isChecked() and len(pw) in (0, 6))

    def _accept(self) -> None:
        if len(self.password.text()) not in (0, 6):
            return
        self.accept()
