"""Фоновый опрос платы BMS без зависимости от Qt.

BmsService владеет соединением: поток опроса читает базовые данные и ячейки раз
в interval секунд, переподключается при потере связи и складывает историю.
Команды (запись настроек, управление) выполняются в отдельном рабочем потоке
через run(), поэтому интерфейс не блокируется. Обратные вызовы on_update и
on_event вызываются из фоновых потоков — UI должен передавать их дальше через сигналы.
"""

from __future__ import annotations

import csv
import logging
import threading
import time
from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable

from . import protocol as p
from .client import Bms

log = logging.getLogger("jbd_bms")

HISTORY_LIMIT = 3600          # ~1 час при опросе раз в секунду
ERROR_EVERY = 10              # счётчики ошибок читаем реже, чем основные данные
FAIL_LIMIT = 3                # столько подряд неудачных опросов — переподключение

STATES = ("disconnected", "connecting", "connected", "error")


@dataclass
class LinkStatus:
    state: str = "disconnected"
    message: str = "Не подключено"
    since: float = field(default_factory=time.time)


@dataclass
class Sample:
    at: float
    pack_voltage: float
    pack_current: float
    remaining_ah: float
    full_ah: float
    soc_pct: int
    temperatures: list[float]
    cells: list[int]
    charge_on: bool
    discharge_on: bool
    balancing: list[int]
    faults: list[str]


class BmsService:
    def __init__(
        self,
        opener: Callable[[], object],
        interval: float = 1.0,
        on_update: Callable[[Sample, p.Basic, dict | None], None] | None = None,
        on_status: Callable[[LinkStatus], None] | None = None,
        on_event: Callable[[str], None] | None = None,
    ):
        self._opener = opener
        self.interval = interval
        self.on_update = on_update
        self.on_status = on_status
        self.on_event = on_event
        self.status = LinkStatus()
        self.history: deque[Sample] = deque(maxlen=HISTORY_LIMIT)
        self.latest: Sample | None = None
        self.latest_basic: p.Basic | None = None
        self.latest_errors: dict | None = None
        self.device_name: str = ""
        self.events: deque[tuple[float, str]] = deque(maxlen=500)
        self._bms: Bms | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="bms-cmd")
        self._lock = threading.Lock()
        self._tick = 0

    # ---------- жизненный цикл ----------

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="bms-poll", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        self._close_link()
        self._worker.shutdown(wait=False, cancel_futures=True)

    @property
    def connected(self) -> bool:
        return self.status.state == "connected"

    def reconnect(self) -> None:
        """Сбросить соединение: поток опроса откроет порт заново."""
        self._close_link()
        self._set_status("connecting", "Переподключение…")

    # ---------- команды ----------

    def run(self, fn: Callable[[Bms], object]) -> Future:
        """Выполнить fn(bms) в рабочем потоке. Future вернёт результат или исключение."""
        return self._worker.submit(self._run_command, fn)

    def _run_command(self, fn):
        bms = self._bms
        if bms is None or not self.connected:
            raise p.ProtocolError("плата не подключена")
        try:
            return fn(bms)
        except p.ProtocolError:
            raise
        except OSError as e:
            self._fail(f"порт: {e}")
            raise p.ProtocolError(f"ошибка порта: {e}") from e

    def read_all_settings(self, bms: Bms) -> dict[str, float | None]:
        out: dict[str, float | None] = {}
        for s in p.SETTINGS:
            try:
                out[s.key] = bms.read_setting(s)
            except p.ProtocolError:
                out[s.key] = None
        return out

    # ---------- журнал и экспорт ----------

    def event(self, text: str) -> None:
        now = time.time()
        self.events.append((now, text))
        log.info(text)
        if self.on_event:
            self.on_event(text)

    def export_csv(self, path: str) -> int:
        """Сохранить историю в CSV. Возвращает число строк."""
        samples = list(self.history)
        cells_n = max((len(s.cells) for s in samples), default=0)
        temps_n = max((len(s.temperatures) for s in samples), default=0)
        with open(path, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f, delimiter=";")
            head = ["время", "напряжение_В", "ток_А", "остаток_Ач", "полная_Ач", "заряд_%",
                    "заряд_ключ", "разряд_ключ", "балансировка", "неисправности"]
            head += [f"темп_{i + 1}_C" for i in range(temps_n)]
            head += [f"ячейка_{i + 1}_мВ" for i in range(cells_n)]
            w.writerow(head)
            for s in samples:
                row = [time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(s.at)),
                       f"{s.pack_voltage:.2f}", f"{s.pack_current:.2f}", f"{s.remaining_ah:.1f}",
                       f"{s.full_ah:.1f}", s.soc_pct, int(s.charge_on), int(s.discharge_on),
                       " ".join(map(str, s.balancing)), " ".join(s.faults)]
                row += [f"{t:.1f}" for t in s.temperatures] + [""] * (temps_n - len(s.temperatures))
                row += [str(c) for c in s.cells] + [""] * (cells_n - len(s.cells))
                w.writerow(row)
        return len(samples)

    # ---------- внутреннее ----------

    def _set_status(self, state: str, message: str) -> None:
        if state == self.status.state and message == self.status.message:
            return
        self.status = LinkStatus(state, message, time.time())
        if self.on_status:
            self.on_status(self.status)

    def _fail(self, reason: str) -> None:
        self._close_link()
        self._set_status("error", reason)
        self.event(f"Связь потеряна: {reason}")

    def _close_link(self) -> None:
        with self._lock:
            bms, self._bms = self._bms, None
        if bms is not None:
            try:
                bms.close()
            except Exception:  # порт уже мог быть закрыт
                pass
            if self.status.state == "connected":
                self._set_status("disconnected", "Не подключено")

    def _open(self) -> None:
        self._set_status("connecting", "Подключение…")
        transport = self._opener()
        bms = Bms(transport)
        try:
            name = bms.device_name()
        except Exception:
            bms.close()
            raise
        with self._lock:
            self._bms = bms
        self.device_name = name
        self._set_status("connected", f"Подключено: {name or 'BMS'}")
        self.event(f"Подключено: {name or 'BMS'}")

    def _loop(self) -> None:
        fails = 0
        while not self._stop.is_set():
            if self._bms is None:
                try:
                    self._open()
                    fails = 0
                except Exception as e:  # порт занят, нет устройства, нет ответа
                    self._close_link()
                    self._set_status("error", f"Нет связи: {e}")
                    self._stop.wait(2.0)
                    continue
            bms = self._bms
            try:
                basic = bms.basic()
                cells = bms.cells()
                errors = None
                if self._tick % ERROR_EVERY == 0:
                    errors = bms.error_counters()
                self._tick += 1
            except p.ProtocolError as e:
                fails += 1
                self.event(f"Нет ответа ({fails}/{FAIL_LIMIT}): {e}")
                if fails >= FAIL_LIMIT:
                    self._fail(str(e))
                    fails = 0
                self._stop.wait(self.interval)
                continue
            except Exception as e:
                self._fail(str(e))
                fails = 0
                self._stop.wait(2.0)
                continue
            fails = 0
            sample = self._make_sample(basic, cells)
            self.latest = sample
            self.latest_basic = basic
            if errors is not None:
                self.latest_errors = errors
            self.history.append(sample)
            if self.on_update:
                try:
                    self.on_update(sample, basic, errors)
                except Exception:
                    log.exception("on_update")
            self._stop.wait(self.interval)

    @staticmethod
    def _make_sample(b: p.Basic, cells: list[int]) -> Sample:
        return Sample(
            at=time.time(),
            pack_voltage=b.pack_voltage,
            pack_current=b.pack_current,
            remaining_ah=b.remaining_ah,
            full_ah=b.full_ah,
            soc_pct=b.capacity_pct,
            temperatures=list(b.temperatures),
            cells=list(cells),
            charge_on=b.charge_fet_on,
            discharge_on=b.discharge_fet_on,
            balancing=list(b.balancing_cells),
            faults=[f["label"] for f in b.faults],
        )
