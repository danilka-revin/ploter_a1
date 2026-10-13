"""Эмулятор платы BMS 12S: отвечает на кадры протокола как настоящая плата.

Нужен для демо-режима и тестов. Запись настроек и управление принимаются только
в заводском режиме (как у платы); неизвестные регистры отвечают ошибкой 0x80.
"""

from __future__ import annotations

import math
import struct
import time

from . import protocol as p

DEMO_VALUES = {
    "covp": 3650, "covp_rel": 3350, "cuvp": 2500, "cuvp_rel": 2900,
    "povp": 43800, "povp_rel": 40200, "puvp": 30000, "puvp_rel": 33600,
    "chgoc": 40000, "dsgoc": 80000,
    "chgot": 45, "chgot_rel": 40, "chgut": 0, "chgut_rel": 5,
    "dsgot": 60, "dsgot_rel": 55, "dsgut": -20, "dsgut_rel": -15,
    "bal_start": 3400, "bal_window": 10, "design_cap": 100000,
}


def _frame(reg: int, status: int, data: bytes) -> bytes:
    body = bytes([status, len(data)]) + data
    cs = p.checksum(body)
    return bytes([p.START, reg]) + body + bytes([cs >> 8, cs & 0xFF, p.END])


class FakeBms:
    def __init__(self, cell_count: int = 12, name: str = "DEMO JBD 12S", password: str = ""):
        self.cell_count = cell_count
        self.name = name
        self.tick = 0
        self.rx = b""
        self.error_counts = [0] * len(p.ERROR_COUNTERS)
        self.password = password.encode("ascii") if password else bytes(6)
        self.factory = False
        self.saves = 0
        self.fet_ctrl = 0                 # 0xE1: бит0 заряд выкл., бит1 разряд выкл.
        self.rem_override_mah: float | None = None
        self.eeprom: dict[int, int] = {}
        self.pending: dict[int, int] = {}   # записи в ОЗУ до выхода из заводского режима
        for s in p.SETTINGS:
            value = cell_count if s.key == "cell_cnt" else DEMO_VALUES.get(s.key)
            if value is not None:
                self.eeprom[s.reg] = p.setting_to_raw(s, value)

    # ----- состояние батареи -----

    def state(self) -> dict:
        t = self.tick
        cells = [3310 + round(12 * math.sin(t / 7 + i)) + (4 if i == 2 else 0) for i in range(self.cell_count)]
        return {
            "cells": cells,
            "pack_mv": sum(cells),
            "current_ma": round(-2400 + 2000 * math.sin(t / 5)),
            "remaining_mah": self.rem_override_mah if self.rem_override_mah is not None
            else 62000 + round(200 * math.sin(t / 30)),
            "full_mah": 100000,
            "cycles": 127,
            "temps": [25.4, 26.1],
            "charge_on": not (self.fet_ctrl & 1),
            "discharge_on": not (self.fet_ctrl & 2),
            "balance": [3] if t % 9 < 3 else [],
        }

    # ----- обработка запросов -----

    def receive(self, data: bytes) -> bytes:
        self.rx += data
        out = b""
        i = 0
        while i < len(self.rx):
            if self.rx[i] != p.START:
                i += 1
                continue
            if len(self.rx) - i < 7:
                break
            ln = self.rx[i + 3]
            total = ln + 7
            if len(self.rx) - i < total:
                break
            frame = self.rx[i:i + total]
            i += total
            if frame[-1] != p.END:
                continue
            op, reg, payload = frame[1], frame[2], frame[4:4 + ln]
            out += self._answer(op, reg, payload)
        self.rx = self.rx[i:]
        self.tick += 1
        return out

    def _answer(self, op: int, reg: int, payload: bytes) -> bytes:
        if op == p.OP_WRITE:
            return self._write(reg, payload)
        if op != p.OP_READ:
            return b""
        s = self.state()
        if reg == p.REG_BASIC:
            return _frame(reg, 0, self._basic_payload(s))
        if reg == p.REG_CELLS:
            return _frame(reg, 0, b"".join(struct.pack(">H", v) for v in s["cells"]))
        if reg == p.REG_DEVICE_NAME:
            return _frame(reg, 0, self.name.encode("utf-8"))
        if reg == p.REG_ERRORS:
            return _frame(reg, 0, b"".join(struct.pack(">H", v) for v in self.error_counts))
        for st in p.SETTINGS:
            if st.reg == reg and reg in self.eeprom:
                return _frame(reg, 0, struct.pack(">H", self.pending.get(reg, self.eeprom[reg])))
        return _frame(reg, 0x80, b"")

    def _write(self, reg: int, data: bytes) -> bytes:
        if reg == p.WRITE_PASSWORD:
            ok = len(data) == 7 and data[0] == 6 and data[1:] == self.password
            return _frame(reg, 0 if ok else 0x80, b"")
        if reg == p.WRITE_FACTORY:
            if data == bytes(p.FACTORY_ENTER):
                self.factory = True
            return _frame(reg, 0, b"")
        if reg == p.WRITE_EXIT:
            if self.factory and data == bytes(p.FACTORY_EXIT_SAVE):
                self.eeprom.update(self.pending)
                self.saves += 1
                self.error_counts = [0] * len(self.error_counts)
            self.pending.clear()
            self.factory = False
            return _frame(reg, 0, b"")
        if not self.factory or len(data) != 2:
            return _frame(reg, 0x80, b"")
        raw = struct.unpack(">H", data)[0]
        if reg == p.REG_CHG_DSG_EN:
            self.fet_ctrl = raw & 0x03
            return _frame(reg, 0, b"")
        if reg == p.REG_CAP_REM:
            self.rem_override_mah = raw * 10
            return _frame(reg, 0, b"")
        if reg in self.eeprom:
            self.pending[reg] = raw
            return _frame(reg, 0, b"")
        return _frame(reg, 0x80, b"")

    def _basic_payload(self, s: dict) -> bytes:
        b = bytearray(23 + 2 * len(s["temps"]))
        struct.pack_into(">H", b, 0, round(s["pack_mv"] / 10))
        struct.pack_into(">h", b, 2, round(s["current_ma"] / 10))
        struct.pack_into(">H", b, 4, round(s["remaining_mah"] / 10))
        struct.pack_into(">H", b, 6, round(s["full_mah"] / 10))
        struct.pack_into(">H", b, 8, s["cycles"])
        struct.pack_into(">H", b, 10, ((2024 - 2000) << 9) | (5 << 5) | 17)
        bal = 0
        for cell in s["balance"]:
            bal |= 1 << (cell - 1)
        struct.pack_into(">H", b, 12, bal & 0xFFFF)
        struct.pack_into(">H", b, 14, (bal >> 16) & 0xFFFF)
        struct.pack_into(">H", b, 16, 0)
        b[18] = 0x10
        b[19] = 62
        b[20] = (1 if s["charge_on"] else 0) | (2 if s["discharge_on"] else 0)
        b[21] = len(s["cells"])
        b[22] = len(s["temps"])
        for i, t in enumerate(s["temps"]):
            struct.pack_into(">H", b, 23 + i * 2, p.encode_temp(t))
        return bytes(b)


class FakeTransport:
    """Транспорт в памяти: write() → эмулятор → очередь ответов для read()."""

    def __init__(self, device: FakeBms | None = None, latency: float = 0.002):
        self.device = device or FakeBms()
        self.latency = latency
        self._queue = bytearray()
        self.closed = False

    def write(self, data: bytes) -> None:
        if self.closed:
            raise OSError("порт закрыт")
        self._queue += self.device.receive(data)

    def read(self, timeout: float) -> bytes:
        if self._queue:
            time.sleep(self.latency)
            out = bytes(self._queue)
            self._queue.clear()
            return out
        time.sleep(min(timeout, 0.01))
        return b""

    def close(self) -> None:
        self.closed = True
