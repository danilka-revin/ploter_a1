"""Обмен с платой BMS: кадры запроса/ответа поверх транспорта.

Транспорт — любой объект с методами:
    write(data: bytes)                 — отправить байты
    read(timeout: float) -> bytes      — байты, пришедшие за timeout секунд (может быть b"")
    close()

Все операции выполняются под блокировкой: один кадр за раз. Запись настроек
выполняется целиком внутри одной блокировки, чтобы опрос не попал в заводской режим.
"""

from __future__ import annotations

import threading
import time
from typing import Iterable

from . import protocol as p


class Bms:
    def __init__(self, transport, timeout: float = 0.8, retries: int = 1):
        self.transport = transport
        self.timeout = timeout
        self.retries = retries
        self._lock = threading.RLock()
        self._rx = b""
        self.closed = False

    # ---------- низкий уровень ----------

    def _exchange(self, reg: int, frame: bytes) -> p.Response:
        self._rx = b""
        self.transport.write(frame)
        deadline = time.monotonic() + self.timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise p.ProtocolError("BMS не ответил")
            self._rx += self.transport.read(min(remaining, 0.05))
            frames, self._rx = p.extract_responses(self._rx)
            for f in frames:
                if f.reg == reg:
                    return f

    def _read_now(self, reg: int) -> bytes:
        if self.closed:
            raise p.ProtocolError("соединение закрыто")
        last: Exception | None = None
        for _ in range(self.retries + 1):
            try:
                f = self._exchange(reg, p.build_read(reg))
            except p.ProtocolError as e:
                last = e
                continue
            if f.status != 0x00:
                raise p.ProtocolError(f"BMS вернул статус 0x{f.status:02X} для регистра 0x{reg:02X}")
            return f.data
        raise last or p.ProtocolError("BMS не ответил")

    def _write_now(self, reg: int, data: bytes = b"") -> None:
        if self.closed:
            raise p.ProtocolError("соединение закрыто")
        f = self._exchange(reg, p.build_write(reg, data))
        if f.status != 0x00:
            raise p.ProtocolError(f"BMS отклонил запись в регистр 0x{reg:02X}")

    # ---------- публичные операции чтения ----------

    def read(self, reg: int) -> bytes:
        with self._lock:
            return self._read_now(reg)

    def basic(self) -> p.Basic:
        return p.parse_basic(self.read(p.REG_BASIC))

    def cells(self) -> list[int]:
        return p.parse_cells(self.read(p.REG_CELLS))

    def device_name(self) -> str:
        return p.parse_device_name(self.read(p.REG_DEVICE_NAME))

    def error_counters(self) -> dict[str, int]:
        return p.parse_error_counters(self.read(p.REG_ERRORS))

    def read_setting(self, s: p.Setting) -> float | None:
        return p.decode_setting(s, self.read(s.reg))

    def read_raw(self, reg: int) -> int:
        with self._lock:
            data = self._read_now(reg)
        if len(data) < 2:
            raise p.ProtocolError(f"регистр 0x{reg:02X}: короткий ответ")
        return (data[0] << 8) | data[1]

    # ---------- запись ----------

    def write_settings(self, entries: Iterable[tuple[int, int]], save: bool = True, password: str = "") -> int:
        """Запись в заводском режиме: пароль → вход → регистры → выход.

        entries — пары (регистр, сырое значение). При сбое выход делается БЕЗ сохранения.
        Возвращает число записанных регистров.
        """
        pwd = p.password_bytes(password)
        entries = list(entries)
        with self._lock:
            if self.closed:
                raise p.ProtocolError("соединение закрыто")
            try:
                self._write_now(p.WRITE_PASSWORD, bytes([6]) + pwd)
            except p.ProtocolError as e:
                raise p.ProtocolError(f"BMS отклонил пароль: проверьте пароль платы ({e})") from e
            self._enter_factory()
            ok = False
            try:
                for reg, raw in entries:
                    self._write_now(reg, bytes([(raw >> 8) & 0xFF, raw & 0xFF]))
                ok = True
            finally:
                exit_data = bytes(p.FACTORY_EXIT_SAVE if (ok and save) else p.FACTORY_EXIT_DISCARD)
                try:
                    self._write_now(p.WRITE_EXIT, exit_data)
                except p.ProtocolError:
                    if ok:
                        raise
            return len(entries)

    def _enter_factory(self) -> None:
        last: Exception | None = None
        for _ in range(3):
            try:
                self._write_now(p.WRITE_FACTORY, bytes(p.FACTORY_ENTER))
                return
            except p.ProtocolError as e:
                last = e
                time.sleep(0.3)
        raise p.ProtocolError(f"BMS не вошёл в заводской режим: {last}")

    def set_fet(self, charge: bool, discharge: bool) -> None:
        self.write_settings([(p.REG_CHG_DSG_EN, p.fet_raw(charge, discharge))], save=False)

    def set_capacity(self, ah: float) -> None:
        self.write_settings([(p.REG_CAP_REM, p.cap_rem_raw(ah))], save=False)

    def clear_errors(self) -> None:
        # выход из заводского режима с сохранением — так bms-tools сбрасывает счётчики
        self.write_settings([], save=True)

    def close(self) -> None:
        with self._lock:
            self.closed = True
            self.transport.close()


# ---------- транспорт UART ----------

class SerialTransport:
    """Последовательный порт 9600 8N1 без управления потоком."""

    BAUD = 9600

    def __init__(self, path: str, baud: int = BAUD):
        import serial  # pyserial

        self._ser = serial.Serial(
            port=path, baudrate=baud, bytesize=serial.EIGHTBITS,
            parity=serial.PARITY_NONE, stopbits=serial.STOPBITS_ONE,
            timeout=0, xonxoff=False, rtscts=False, dsrdtr=False,
        )

    def write(self, data: bytes) -> None:
        self._ser.reset_input_buffer()
        self._ser.write(data)
        self._ser.flush()

    def read(self, timeout: float) -> bytes:
        deadline = time.monotonic() + timeout
        while True:
            n = self._ser.in_waiting
            if n:
                return self._ser.read(n)
            if time.monotonic() >= deadline:
                return b""
            time.sleep(0.005)

    def close(self) -> None:
        self._ser.close()


def list_serial_ports() -> list[str]:
    """Порты USB-UART, которые могут быть подключены к плате BMS."""
    from serial.tools import list_ports

    out = []
    for info in list_ports.comports():
        dev = info.device
        if dev.startswith(("/dev/ttyUSB", "/dev/ttyACM")) or dev.startswith("COM"):
            out.append(dev)
    return sorted(set(out))
