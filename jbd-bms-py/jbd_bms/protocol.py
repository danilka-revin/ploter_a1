"""Протокол JBD (Jiabaida / Xiaoxiang / Overkill Solar) по UART: 9600 8N1.

Кадр запроса:  DD | op (A5 чтение / 5A запись) | reg | len | data… | CS_H CS_L | 77
Кадр ответа:   DD | reg | status (00 ок, 80 ошибка) | len | data… | CS_H CS_L | 77
Контрольная сумма = 0x10000 − сумма байтов (mod 2^16).

Регистры и масштабы сверены с открытой библиотекой bms-tools (MrSurly, GPL-3.0).
Модуль без ввода-вывода: его можно тестировать отдельно.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

START = 0xDD
END = 0x77
OP_READ = 0xA5
OP_WRITE = 0x5A


class ProtocolError(Exception):
    """Ошибка обмена или недопустимое значение."""


# ---------- регистры ----------

REG_BASIC = 0x03
REG_CELLS = 0x04
REG_DEVICE_NAME = 0x05
REG_ERRORS = 0xAA

# управление заводским режимом
WRITE_PASSWORD = 0x06
WRITE_FACTORY = 0x00
WRITE_EXIT = 0x01
FACTORY_ENTER = (0x56, 0x78)
FACTORY_EXIT_SAVE = (0x28, 0x28)
FACTORY_EXIT_DISCARD = (0x00, 0x00)

# ключи заряда/разряда и остаток ёмкости
REG_CAP_REM = 0xE0
REG_CHG_DSG_EN = 0xE1


@dataclass(frozen=True)
class Setting:
    key: str
    reg: int
    label: str
    unit: str
    kind: str          # mv | ma | mah | temp | count
    scale: float = 1


SETTINGS: tuple[Setting, ...] = (
    Setting("covp", 0x24, "Перенапряжение ячейки (OVP)", "мВ", "mv", 1),
    Setting("covp_rel", 0x25, "Возврат после перенапряжения", "мВ", "mv", 1),
    Setting("cuvp", 0x26, "Понижение напряжения ячейки (UVP)", "мВ", "mv", 1),
    Setting("cuvp_rel", 0x27, "Возврат после понижения", "мВ", "mv", 1),
    Setting("povp", 0x20, "Перенапряжение батареи", "мВ", "mv", 10),
    Setting("povp_rel", 0x21, "Возврат после перенапряжения батареи", "мВ", "mv", 10),
    Setting("puvp", 0x22, "Понижение напряжения батареи", "мВ", "mv", 10),
    Setting("puvp_rel", 0x23, "Возврат после понижения батареи", "мВ", "mv", 10),
    Setting("chgoc", 0x28, "Перегрузка по заряду", "мА", "ma", 10),
    Setting("dsgoc", 0x29, "Перегрузка по разряду", "мА", "ma", 10),
    Setting("chgot", 0x18, "Перегрев при заряде", "°C", "temp"),
    Setting("chgot_rel", 0x19, "Возврат после перегрева при заряде", "°C", "temp"),
    Setting("chgut", 0x1A, "Переохлаждение при заряде", "°C", "temp"),
    Setting("chgut_rel", 0x1B, "Возврат после переохлаждения при заряде", "°C", "temp"),
    Setting("dsgot", 0x1C, "Перегрев при разряде", "°C", "temp"),
    Setting("dsgot_rel", 0x1D, "Возврат после перегрева при разряде", "°C", "temp"),
    Setting("dsgut", 0x1E, "Переохлаждение при разряде", "°C", "temp"),
    Setting("dsgut_rel", 0x1F, "Возврат после переохлаждения при разряде", "°C", "temp"),
    Setting("bal_start", 0x2A, "Старт балансировки", "мВ", "mv", 1),
    Setting("bal_window", 0x2B, "Окно балансировки", "мВ", "mv", 1),
    Setting("design_cap", 0x10, "Номинальная ёмкость", "мАч", "mah", 10),
    Setting("cell_cnt", 0x2F, "Число ячеек (настройка)", "шт", "count", 1),
)
SETTINGS_BY_KEY = {s.key: s for s in SETTINGS}


@dataclass(frozen=True)
class Limits:
    group: str
    min: float
    max: float
    step: float


# Пределы записываемых настроек (в единицах интерфейса). cell_cnt намеренно не записывается.
WRITE_LIMITS: dict[str, Limits] = {
    "design_cap": Limits("Ёмкость", 1000, 500000, 10),
    "covp": Limits("Напряжение ячейки", 2500, 4250, 1),
    "covp_rel": Limits("Напряжение ячейки", 2500, 4250, 1),
    "cuvp": Limits("Напряжение ячейки", 1500, 3650, 1),
    "cuvp_rel": Limits("Напряжение ячейки", 1500, 3800, 1),
    "povp": Limits("Напряжение батареи", 5000, 60000, 10),
    "povp_rel": Limits("Напряжение батареи", 5000, 60000, 10),
    "puvp": Limits("Напряжение батареи", 5000, 60000, 10),
    "puvp_rel": Limits("Напряжение батареи", 5000, 60000, 10),
    "chgoc": Limits("Токи", 1000, 200000, 10),
    "dsgoc": Limits("Токи", 1000, 300000, 10),
    "chgot": Limits("Температура", -20, 80, 0.1),
    "chgot_rel": Limits("Температура", -20, 80, 0.1),
    "chgut": Limits("Температура", -30, 60, 0.1),
    "chgut_rel": Limits("Температура", -30, 60, 0.1),
    "dsgot": Limits("Температура", -20, 90, 0.1),
    "dsgot_rel": Limits("Температура", -20, 90, 0.1),
    "dsgut": Limits("Температура", -30, 60, 0.1),
    "dsgut_rel": Limits("Температура", -30, 60, 0.1),
    "bal_start": Limits("Балансировка", 1000, 4250, 1),
    "bal_window": Limits("Балансировка", 1, 500, 1),
}

# связи порогов: (a, оператор, b, пояснение) — a должно быть > b (или < для оператора "<")
CONSISTENCY_RULES: tuple[tuple[str, str, str, str], ...] = (
    ("covp", ">", "covp_rel", "перенапряжение ячейки должно быть выше возврата"),
    ("cuvp_rel", ">", "cuvp", "возврат после понижения ячейки должен быть выше порога"),
    ("covp", ">", "cuvp", "перенапряжение ячейки должно быть выше понижения"),
    ("povp", ">", "povp_rel", "перенапряжение батареи должно быть выше возврата"),
    ("puvp_rel", ">", "puvp", "возврат после понижения батареи должен быть выше порога"),
    ("povp", ">", "puvp", "перенапряжение батареи должно быть выше понижения"),
    ("chgot", ">", "chgot_rel", "перегрев при заряде должен быть выше возврата"),
    ("chgut_rel", ">", "chgut", "возврат после переохлаждения при заряде должен быть выше порога"),
    ("dsgot", ">", "dsgot_rel", "перегрев при разряде должен быть выше возврата"),
    ("dsgut_rel", ">", "dsgut", "возврат после переохлаждения при разряде должен быть выше порога"),
    ("chgot", ">", "chgut", "перегрев при заряде должен быть выше переохлаждения"),
    ("dsgot", ">", "dsgut", "перегрев при разряде должен быть выше переохлаждения"),
    ("bal_start", ">", "bal_window", "старт балансировки должен быть выше окна"),
)

FAULT_BITS: tuple[tuple[int, str, str], ...] = (
    (0, "covp", "Перенапряжение ячейки"),
    (1, "cuvp", "Понижение напряжения ячейки"),
    (2, "povp", "Перенапряжение батареи"),
    (3, "puvp", "Понижение напряжения батареи"),
    (4, "chgot", "Перегрев при заряде"),
    (5, "chgut", "Переохлаждение при заряде"),
    (6, "dsgot", "Перегрев при разряде"),
    (7, "dsgut", "Переохлаждение при разряде"),
    (8, "chgoc", "Перегрузка по заряду"),
    (9, "dsgoc", "Перегрузка по разряду"),
    (10, "sc", "Короткое замыкание"),
    (11, "afe", "Ошибка измерительной микросхемы (AFE)"),
    (12, "software", "Программная защита"),
)

ERROR_COUNTERS: tuple[tuple[str, str], ...] = (
    ("sc", "Короткое замыкание"),
    ("chgoc", "Перегрузка заряда"),
    ("dsgoc", "Перегрузка разряда"),
    ("covp", "Перенапряжение ячейки"),
    ("cuvp", "Понижение ячейки"),
    ("chgot", "Перегрев заряда"),
    ("chgut", "Переохлаждение заряда"),
    ("dsgot", "Перегрев разряда"),
    ("dsgut", "Переохлаждение разряда"),
    ("povp", "Перенапряжение батареи"),
    ("puvp", "Понижение батареи"),
)


# ---------- кадры ----------

def checksum(payload: Iterable[int]) -> int:
    return (0x10000 - sum(payload)) & 0xFFFF


def build_frame(op: int, reg: int, data: bytes = b"") -> bytes:
    if len(data) > 0xFF:
        raise ProtocolError("слишком длинные данные кадра")
    payload = bytes([reg, len(data)]) + bytes(data)
    cs = checksum(payload)
    return bytes([START, op]) + payload + bytes([cs >> 8, cs & 0xFF, END])


def build_read(reg: int) -> bytes:
    return build_frame(OP_READ, reg)


def build_write(reg: int, data: bytes = b"") -> bytes:
    return build_frame(OP_WRITE, reg, data)


@dataclass
class Response:
    reg: int
    status: int
    data: bytes


def extract_responses(buf: bytes) -> tuple[list[Response], bytes]:
    """Достаёт полные кадры ответа; мусор и кадры с неверной суммой пропускаются."""
    frames: list[Response] = []
    i = 0
    n = len(buf)
    while i < n:
        if buf[i] != START:
            i += 1
            continue
        if n - i < 7:
            break
        ln = buf[i + 3]
        total = ln + 7
        if n - i < total:
            break
        frame = buf[i:i + total]
        if frame[-1] != END:
            i += 1
            continue
        got = (frame[total - 3] << 8) | frame[total - 2]
        data_end = total - 3
        with_status = checksum(frame[2:data_end])
        without_status = checksum(frame[3:data_end])
        if got not in (with_status, without_status):
            i += 1
            continue
        frames.append(Response(reg=frame[1], status=frame[2], data=bytes(frame[4:4 + ln])))
        i += total
    return frames, buf[i:]


# ---------- разбор данных ----------

def decode_temp(raw: int) -> float:
    """Температура в регистре: десятые кельвина. (raw − 2731) / 10 → °C."""
    return round((raw - 2731) / 10, 1)


def encode_temp(celsius: float) -> int:
    return round(celsius * 10 + 2731)


def decode_date(raw: int) -> dict:
    return {"year": ((raw >> 9) & 0x7F) + 2000, "month": (raw >> 5) & 0x0F, "day": raw & 0x1F}


def _u16(data: bytes, off: int) -> int:
    return (data[off] << 8) | data[off + 1]


def _s16(data: bytes, off: int) -> int:
    v = _u16(data, off)
    return v - 0x10000 if v & 0x8000 else v


@dataclass
class Basic:
    pack_voltage: float        # В
    pack_current: float        # А (минус — разряд)
    remaining_ah: float        # Ач
    full_ah: float             # Ач
    capacity_pct: int
    cycles: int
    manufacture_date: dict
    cell_count: int
    ntc_count: int
    temperatures: list[float]
    charge_fet_on: bool
    discharge_fet_on: bool
    balancing_cells: list[int]
    faults: list[dict]
    fault_raw: int
    firmware_version: int

    @property
    def power_w(self) -> float:
        return self.pack_voltage * self.pack_current


def parse_basic(data: bytes) -> Basic:
    if len(data) < 23:
        raise ProtocolError(f"базовая информация короче ожидаемого: {len(data)} байт")
    fet = data[20]
    bal = _u16(data, 12) | (_u16(data, 14) << 16)
    balancing = [i + 1 for i in range(32) if bal & (1 << i)]
    ntc_count = data[22]
    temps = []
    for i in range(ntc_count):
        off = 23 + i * 2
        if off + 2 > len(data):
            break
        temps.append(decode_temp(_u16(data, off)))
    fault_raw = _u16(data, 16)
    faults = [{"key": k, "label": label} for bit, k, label in FAULT_BITS if fault_raw & (1 << bit)]
    return Basic(
        pack_voltage=_u16(data, 0) * 10 / 1000,
        pack_current=_s16(data, 2) * 10 / 1000,
        remaining_ah=_u16(data, 4) * 10 / 1000,
        full_ah=_u16(data, 6) * 10 / 1000,
        capacity_pct=data[19],
        cycles=_u16(data, 8),
        manufacture_date=decode_date(_u16(data, 10)),
        cell_count=data[21],
        ntc_count=ntc_count,
        temperatures=temps,
        charge_fet_on=bool(fet & 0x01),
        discharge_fet_on=bool(fet & 0x02),
        balancing_cells=balancing,
        faults=faults,
        fault_raw=fault_raw,
        firmware_version=data[18],
    )


def parse_cells(data: bytes) -> list[int]:
    return [_u16(data, i) for i in range(0, len(data) - 1, 2)]


def parse_device_name(data: bytes) -> str:
    return data.decode("utf-8", errors="replace").replace("\x00", "").strip()


def parse_error_counters(data: bytes) -> dict[str, int]:
    out = {}
    for i, (key, _label) in enumerate(ERROR_COUNTERS):
        out[key] = _u16(data, i * 2) if i * 2 + 2 <= len(data) else 0
    return out


def decode_setting(s: Setting, data: bytes) -> float | None:
    if len(data) < 2:
        return None
    raw = _u16(data, 0)
    if s.kind == "temp":
        return decode_temp(raw)
    return raw * s.scale


def setting_to_raw(s: Setting, value: float) -> int:
    """Значение в единицах интерфейса → 16-битный регистр. Ошибка, если не кратно шагу регистра."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise ProtocolError(f"{s.label}: значение не число")
    if s.kind == "temp":
        exact = v * 10 + 2731
    elif s.kind == "count":
        exact = v
    else:
        exact = v / s.scale
    raw = round(exact)
    if abs(exact - raw) > 1e-6:
        res = "0,1 °C" if s.kind == "temp" else f"{s.scale:g} {s.unit}"
        raise ProtocolError(f"{s.label}: шаг регистра — {res}")
    if raw < 0 or raw > 0xFFFF:
        raise ProtocolError(f"{s.label}: значение не помещается в регистр")
    return raw


def check_setting_value(key: str, value: float) -> str | None:
    s = SETTINGS_BY_KEY.get(key)
    lim = WRITE_LIMITS.get(key)
    if s is None or lim is None:
        return f"параметр «{key}» нельзя записать"
    try:
        v = float(value)
    except (TypeError, ValueError):
        return f"{s.label}: введите число"
    if v != v:  # NaN
        return f"{s.label}: введите число"
    if v < lim.min or v > lim.max:
        return f"{s.label}: допустимо от {lim.min:g} до {lim.max:g} {s.unit}"
    try:
        setting_to_raw(s, v)
    except ProtocolError as e:
        return str(e)
    return None


def check_consistency(values: dict[str, float]) -> list[str]:
    errors = []
    for a, op, b, text in CONSISTENCY_RULES:
        if a not in values or b not in values:
            continue
        ok = values[a] > values[b] if op == ">" else values[a] < values[b]
        if not ok:
            la = SETTINGS_BY_KEY[a].label
            lb = SETTINGS_BY_KEY[b].label
            errors.append(f"{la} ({values[a]:g}) и {lb} ({values[b]:g}): {text}")
    return errors


def writable_settings() -> list[Setting]:
    return [s for s in SETTINGS if s.key in WRITE_LIMITS]


def password_bytes(password: str = "") -> bytes:
    if not password:
        return bytes(6)
    if len(password) != 6 or not all(0x20 <= ord(c) <= 0x7E for c in password):
        raise ProtocolError("пароль платы — ровно 6 символов ASCII")
    return password.encode("ascii")


def fet_raw(charge: bool, discharge: bool) -> int:
    """Регистр 0xE1: бит 0 = заряд выключен, бит 1 = разряд выключен."""
    return (0 if charge else 1) | (0 if discharge else 2)


def cap_rem_raw(ah: float) -> int:
    """Остаток ёмкости, Ач → регистр 0xE0 (единица — 10 мАч)."""
    raw = round(float(ah) * 100)
    if raw < 0 or raw > 0xFFFF:
        raise ProtocolError("остаток ёмкости вне диапазона регистра")
    return raw


@dataclass
class Snapshot:
    at: float
    basic: Basic
    cells: list[int]
    errors: dict[str, int] | None
    extra: dict = field(default_factory=dict)
