"""Главное окно и запуск приложения.

Фоновые потоки (опрос, команды, обновление) передают результаты в UI через Bridge:
сигнал в очереди Qt выполняется в главном потоке.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

from PySide6.QtCore import QObject, QSettings, Qt, QTimer, Signal, Slot
from PySide6.QtWidgets import (QApplication, QButtonGroup, QComboBox, QHBoxLayout, QLabel, QMainWindow,
                               QPushButton, QStackedWidget, QVBoxLayout, QWidget)

from .. import protocol as p
from ..client import SerialTransport, list_serial_ports
from ..fake import FakeBms, FakeTransport
from ..service import BmsService, LinkStatus, Sample
from ..updater import CHECK_INTERVAL_S, RESTART_EXIT_CODE, UpdateState, Updater
from .cells import CellsView
from .control import ControlView
from .journal import JournalView
from .overview import OverviewView
from .settings import SettingsView
from .theme import stylesheet
from .update_dialog import UpdateDialog
from .widgets import Pill, repolish

APP_DIR = Path(__file__).resolve().parents[2]
DEMO = "__demo__"
TABS = ("Обзор", "Ячейки", "Управление", "Настройки", "Журнал")
STATUS_KIND = {"connected": "ok", "connecting": "warn", "error": "bad", "disconnected": "off"}


class Bridge(QObject):
    """Выполняет переданные функции в главном потоке."""

    _post = Signal(object)

    def __init__(self):
        super().__init__()
        self._post.connect(self._run, Qt.QueuedConnection)

    def post(self, fn) -> None:
        self._post.emit(fn)

    @Slot(object)
    def _run(self, fn) -> None:
        try:
            fn()
        except Exception as e:  # ошибки обработчиков не должны гасить интерфейс
            import logging
            logging.getLogger("jbd_bms").exception("обработчик UI: %s", e)


class MainWindow(QMainWindow):
    def __init__(self, bridge: Bridge, *, demo: bool = False, port: str | None = None):
        super().__init__()
        self.bridge = bridge
        self.settings = QSettings("jbd-bms", "jbd-bms")
        self.theme = self.settings.value("theme", "dark")
        self.service: BmsService | None = None
        self._last_service: BmsService | None = None
        self.demo_device = FakeBms()
        self.device_name = ""
        self.last_errors: dict | None = None
        self.link = LinkStatus()
        self.updater = Updater(APP_DIR, on_change=lambda st: bridge.post(lambda: self._update_changed(st)))
        self.update_dialog: UpdateDialog | None = None
        self.restart_requested = False

        self.setWindowTitle("JBD BMS — чтение и настройка BMS")
        self.resize(1240, 820)
        root = QWidget()
        root.setObjectName("root")
        self.setCentralWidget(root)
        outer = QVBoxLayout(root)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)

        outer.addWidget(self._header())
        outer.addWidget(self._tabbar())

        self.stack = QStackedWidget()
        self.overview = OverviewView()
        self.cells = CellsView()
        self.control = ControlView(self._run_command)
        self.settings_view = SettingsView(self._run_command)
        self.journal = JournalView(self._export_csv)
        for w in (self.overview, self.cells, self.control, self.settings_view, self.journal):
            self.stack.addWidget(w)
        outer.addWidget(self.stack, 1)

        self.statusBar().showMessage("Не подключено")
        self._apply_theme()  # стиль на уровне приложения, чтобы переключение темы работало
        self._refresh_port_list()
        self._set_tab(0)
        self._apply_link(self.link)

        self.update_timer = QTimer(self)
        self.update_timer.timeout.connect(self.check_updates)
        self.update_timer.start(CHECK_INTERVAL_S * 1000)
        QTimer.singleShot(4000, self.check_updates)

        if demo:
            self.port_box.setCurrentIndex(self.port_box.findData(DEMO))
            self.connect_link()
        elif port:
            idx = self.port_box.findData(port)
            if idx >= 0:
                self.port_box.setCurrentIndex(idx)
                self.connect_link()

    # ---------- разметка ----------

    def _header(self) -> QWidget:
        bar = QWidget()
        bar.setObjectName("header")
        h = QHBoxLayout(bar)
        h.setContentsMargins(20, 12, 20, 12)
        h.setSpacing(10)
        app = QLabel("JBD BMS")
        app.setProperty("role", "app")
        h.addWidget(app)
        self.port_box = QComboBox()
        self.port_box.setMinimumWidth(260)
        h.addWidget(self.port_box)
        self.btn_ports = QPushButton("Обновить порты")
        self.btn_ports.clicked.connect(self._refresh_port_list)
        h.addWidget(self.btn_ports)
        self.btn_connect = QPushButton("Подключить")
        self.btn_connect.setProperty("primary", True)
        self.btn_connect.clicked.connect(self.toggle_link)
        h.addWidget(self.btn_connect)
        self.status_pill = Pill("Не подключено", "off")
        h.addWidget(self.status_pill)
        h.addStretch(1)
        self.btn_update = QPushButton("Обновить программу")
        self.btn_update.setVisible(False)
        self.btn_update.clicked.connect(self.open_update)
        h.addWidget(self.btn_update)
        self.btn_theme = QPushButton()
        self.btn_theme.clicked.connect(self.toggle_theme)
        h.addWidget(self.btn_theme)
        return bar

    def _tabbar(self) -> QWidget:
        bar = QWidget()
        h = QHBoxLayout(bar)
        h.setContentsMargins(14, 0, 14, 0)
        h.setSpacing(0)
        self.tab_group = QButtonGroup(self)
        self.tab_buttons = []
        for i, name in enumerate(TABS):
            b = QPushButton(name)
            b.setProperty("tab", True)
            b.setCheckable(True)
            b.clicked.connect(lambda _c=False, i=i: self._set_tab(i))
            self.tab_group.addButton(b, i)
            self.tab_buttons.append(b)
            h.addWidget(b)
        h.addStretch(1)
        return bar

    def _set_tab(self, i: int) -> None:
        self.stack.setCurrentIndex(i)
        self.tab_buttons[i].setChecked(True)

    def _apply_theme(self) -> None:
        self.btn_theme.setText("Светлая тема" if self.theme == "dark" else "Тёмная тема")
        QApplication.instance().setStyleSheet(stylesheet(self.theme))

    def toggle_theme(self) -> None:
        self.theme = "light" if self.theme == "dark" else "dark"
        self.settings.setValue("theme", self.theme)
        self._apply_theme()

    # ---------- порт и подключение ----------

    def _refresh_port_list(self) -> None:
        current = self.port_box.currentData()
        self.port_box.blockSignals(True)
        self.port_box.clear()
        for path in list_serial_ports():
            self.port_box.addItem(f"{path} (USB-UART)", path)
        self.port_box.addItem("Демо-режим (без платы)", DEMO)
        idx = self.port_box.findData(current) if current else -1
        if idx < 0 and self.port_box.count() > 1:
            idx = 0
        self.port_box.setCurrentIndex(max(0, idx))
        self.port_box.blockSignals(False)

    def toggle_link(self) -> None:
        if self.service is not None:
            self.disconnect_link()
        else:
            self.connect_link()

    def connect_link(self) -> None:
        if self.service is not None:
            self.disconnect_link()
        path = self.port_box.currentData()
        if not path:
            self.statusBar().showMessage("Выберите порт или демо-режим")
            return
        if path == DEMO:
            def opener():
                return FakeTransport(self.demo_device, latency=0.002)
            label = "демо-режим"
        else:
            def opener(path=path):
                return SerialTransport(path)
            label = path
        svc = BmsService(
            opener,
            interval=1.0,
            on_update=lambda s, b, e: self.bridge.post(lambda: self._on_sample(svc, s, b, e)),
            on_status=lambda st: self.bridge.post(lambda: self._on_status(svc, st)),
            on_event=lambda t: self.bridge.post(lambda: self._on_event(svc, t)),
        )
        self.service = svc
        self._last_service = svc
        self.device_name = ""
        self.journal.add_event(f"Подключение: {label}")
        svc.start()
        self.btn_connect.setText("Отключить")
        self.port_box.setEnabled(False)
        self.btn_ports.setEnabled(False)

    def disconnect_link(self) -> None:
        svc, self.service = self.service, None
        if svc is None:
            return
        self.journal.add_event("Отключение")
        threading.Thread(target=svc.stop, daemon=True).start()
        self.link = LinkStatus()
        self._apply_link(self.link)
        self.btn_connect.setText("Подключить")
        self.port_box.setEnabled(True)
        self.btn_ports.setEnabled(True)
        self.overview.set_connected(False)
        self.cells.set_connected(False)
        self.control.set_connected(False)
        self.settings_view.set_connected(False)
        self.statusBar().showMessage("Не подключено")

    def _on_status(self, svc, st: LinkStatus) -> None:
        if svc is not self.service:
            return
        self.link = st
        self._apply_link(st)

    def _on_event(self, svc, text: str) -> None:
        if svc is not self.service:
            return
        self.journal.add_event(text)

    def _apply_link(self, st: LinkStatus) -> None:
        kind = STATUS_KIND.get(st.state, "off")
        text = {"connected": st.message, "connecting": st.message, "error": st.message,
                "disconnected": "Не подключено"}.get(st.state, st.message)
        self.status_pill.setText(text)
        self.status_pill.set_kind({"ok": "ok", "warn": "warn", "bad": "bad"}.get(kind, ""))
        connected = st.state == "connected"
        if not connected and self.service is not None:
            if st.state == "connecting":
                self.overview.show_wait(st.message)
            else:
                self.overview.set_connected(False, "Связь с платой потеряна", st.message + ". Переподключаюсь…")
            self.cells.set_connected(False, "Связь с платой потеряна", st.message)
            self.control.set_connected(False)
            self.settings_view.set_connected(False)
        if connected:
            self.overview.set_error("")
            self.control.set_connected(True)
            self.settings_view.set_connected(True)
            self.cells.set_connected(True)
        self.statusBar().showMessage(text)

    def _on_sample(self, svc, s: Sample, b: p.Basic, errors: dict | None) -> None:
        if svc is not self.service:
            return
        if errors is not None:
            self.last_errors = errors
        if not self.device_name and svc.device_name:
            self.device_name = svc.device_name
        self.overview.update_data(b, self.last_errors, self.device_name)
        self.cells.update_data(s.cells, s.balancing)
        self.control.update_data(b, self.last_errors)
        self.journal.set_count(len(svc.history))
        self.statusBar().showMessage(
            f"Обновлено {time.strftime('%H:%M:%S', time.localtime(s.at))} · "
            f"{s.pack_voltage:.2f} В · {s.pack_current:+.2f} А · {b.capacity_pct}%")

    # ---------- команды (фоновый поток) ----------

    def _run_command(self, fn, ok, err) -> None:
        svc = self.service
        if svc is None or not svc.connected:
            err(p.ProtocolError("плата не подключена"))
            return
        fut = svc.run(fn)

        def done(f):
            if f.cancelled():
                self.bridge.post(lambda: err(p.ProtocolError("отменено")))
                return
            exc = f.exception()
            if exc is not None:
                self.bridge.post(lambda: err(exc))
            else:
                res = f.result()
                self.bridge.post(lambda: ok(res))

        fut.add_done_callback(done)

    def _export_csv(self, path: str) -> int:
        svc = self.service or self._last_service
        if svc is None:
            raise OSError("история пуста: сначала подключите плату")
        return svc.export_csv(path)

    # ---------- обновление ----------

    def check_updates(self) -> None:
        threading.Thread(target=self.updater.check, daemon=True).start()

    def _update_changed(self, st: UpdateState) -> None:
        if st.phase == "done" and st.restart_required:
            self.btn_update.setText("Перезапустить программу")
            self.btn_update.setVisible(True)
        elif st.update_available:
            self.btn_update.setText(f"Обновить программу ({st.latest_sha[:7]})")
            self.btn_update.setVisible(True)
        else:
            self.btn_update.setVisible(False)
        if self.update_dialog is not None:
            self.update_dialog.refresh(st)

    def open_update(self) -> None:
        if self.updater.state.phase == "done" and self.updater.state.restart_required:
            self.restart_app()
            return
        if self.update_dialog is None:
            self.update_dialog = UpdateDialog(self.updater, self.restart_app, self)
            self.update_dialog.finished.connect(lambda _r: setattr(self, "update_dialog", None))
        self.update_dialog.show()
        self.update_dialog.raise_()
        self.update_dialog.refresh(self.updater.state)

    def restart_app(self) -> None:
        self.restart_requested = True
        self.shutdown()
        QApplication.instance().exit(RESTART_EXIT_CODE)

    def shutdown(self) -> None:
        svc, self.service = self.service, None
        if svc is not None:
            svc.stop()

    def closeEvent(self, event) -> None:
        self.shutdown()
        super().closeEvent(event)


def run(argv: list[str]) -> int:
    import argparse
    import logging
    import sys

    ap = argparse.ArgumentParser(prog="jbd-bms", description="JBD BMS — чтение и настройка BMS по UART")
    ap.add_argument("--demo", action="store_true", help="сразу открыть демо-режим (без платы)")
    ap.add_argument("--port", help="порт платы, например COM3 или /dev/ttyUSB0 — подключиться сразу")
    ap.add_argument("--debug", action="store_true", help="подробный журнал в консоли")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.debug else logging.WARNING)

    app = QApplication.instance() or QApplication(sys.argv)
    app.setApplicationName("JBD BMS")
    app.setStyle("Fusion")
    bridge = Bridge()
    win = MainWindow(bridge, demo=args.demo, port=args.port)
    win.show()
    code = app.exec()
    win.shutdown()
    return RESTART_EXIT_CODE if win.restart_requested else code
