"""Разбор данных расписания Ника-Софт (объект NIKA из JS-файла).

Структура (проверена на реальном файле школы):
  CLASSES[class_id]              -> название класса ("10ит")
  CLASS_SCHEDULE[period][class]  -> базовое расписание по слотам
      ключ слота: день + номер урока в 2 знака, день 1=пн ... 6=сб
      ("101" - понедельник, 1-й урок; "307" - среда, 7-й урок)
      значение: {"s": [предметы], "t": [учителя], "r": [кабинеты], "g": [группы]}
      "s" = "F" / "M" или пустой список - урока нет
  CLASS_EXCHANGE[class][dd.mm.yyyy][номер_урока] -> замена на конкретную дату
      значение "F" в "s" означает, что урок на эту дату отменён
  Списки "t", "r", "g" идут параллельно "s" (для подгрупп).
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

DAY_NAMES = [
    "понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье",
]


class NikaError(Exception):
    """Не удалось разобрать данные расписания."""


class NoScheduleForDate(Exception):
    """На выбранную дату расписания нет в загруженных данных."""


@dataclass
class Item:
    subject: str
    teacher: str
    room: str
    group: str | None  # "Группа 1", "1 группа" и т.п.


@dataclass
class Lesson:
    num: int
    items: list[Item]
    changed: bool  # урок заменён на эту дату


def extract_nika_json(js_text: str) -> dict[str, Any]:
    """Достаёт JSON-объект из `var NIKA = {...}` (остальной JS-код игнорируется)."""
    m = re.search(r"var\s+NIKA\s*=\s*", js_text)
    if not m:
        raise NikaError("В файле не найдено 'var NIKA'")
    start = js_text.find("{", m.end())
    if start == -1:
        raise NikaError("После 'var NIKA' нет объекта")
    obj, _ = json.JSONDecoder().raw_decode(js_text, start)
    return obj


def find_class_id(data: dict, class_name: str) -> str:
    wanted = class_name.strip().lower()
    for class_id, name in data.get("CLASSES", {}).items():
        if str(name).strip().lower() == wanted:
            return class_id
    raise NikaError(f"Класс '{class_name}' не найден в расписании")


def find_period_id(data: dict, class_id: str) -> str | None:
    for period_id, classes in data.get("CLASS_SCHEDULE", {}).items():
        if class_id in classes:
            return period_id
    return None


def _parse_ru_date(text: str) -> date:
    return datetime.strptime(text, "%d.%m.%Y").date()


def _lookup(dictionary: dict, key: Any) -> str:
    if key is None or key == "":
        return ""
    return str(dictionary.get(str(key), "")).strip()


def _slot_items(data: dict, entry: Any) -> list[Item]:
    if not isinstance(entry, dict):
        return []
    subjects = entry.get("s")
    if not isinstance(subjects, list):  # "F" (отмена), "M" (нет урока)
        return []
    teachers = entry.get("t") or []
    rooms = entry.get("r") or []
    groups = entry.get("g") or []

    items: list[Item] = []
    for i, subject_id in enumerate(subjects):
        if not subject_id:
            continue
        teacher_id = teachers[i] if i < len(teachers) else ""
        room_id = rooms[i] if i < len(rooms) else ""
        group_id = groups[i] if i < len(groups) else None
        group_name = _lookup(data.get("CLASSGROUPS", {}), group_id) if group_id is not None else None
        items.append(
            Item(
                subject=_lookup(data.get("SUBJECTS", {}), subject_id) or str(subject_id),
                teacher=_lookup(data.get("TEACHERS", {}), teacher_id),
                room=_lookup(data.get("ROOMS", {}), room_id),
                group=group_name or None,
            )
        )
    return items


def check_period(data: dict, period_id: str, day: date) -> None:
    period = data.get("PERIODS", {}).get(period_id, {})
    try:
        start = _parse_ru_date(period["b"])
        end = _parse_ru_date(period["e"])
    except (KeyError, ValueError):
        return  # нет границ периода - не проверяем
    if not start <= day <= end:
        raise NoScheduleForDate(
            f"Расписание загружено на период {start:%d.%m.%Y}–{end:%d.%m.%Y}, "
            f"а нужна дата {day:%d.%m.%Y}"
        )


def lessons_for_date(data: dict, class_id: str, day: date) -> list[Lesson]:
    """Уроки класса на дату с учётом замен. Пустой список - выходной/занятий нет."""
    period_id = find_period_id(data, class_id)
    if period_id is None:
        raise NoScheduleForDate("Для класса нет расписания в загруженных данных")
    check_period(data, period_id, day)

    base = data["CLASS_SCHEDULE"][period_id][class_id]
    exchanges = data.get("CLASS_EXCHANGE", {}).get(class_id, {})
    exchanges_today = exchanges.get(day.strftime("%d.%m.%Y"), {})
    weekday = day.isoweekday()  # 1 = понедельник

    lessons: list[Lesson] = []
    for num in range(1, int(data.get("LESSONSINDAY", 13)) + 1):
        key = str(num)
        if key in exchanges_today:
            entry, changed = exchanges_today[key], True
        else:
            entry, changed = base.get(f"{weekday}{num:02d}"), False
        items = _slot_items(data, entry)
        if items:
            lessons.append(Lesson(num=num, items=items, changed=changed))
    return lessons


def _place(item: Item) -> str:
    parts = []
    if item.teacher:
        parts.append(item.teacher)
    if item.room:
        parts.append(f"каб. {item.room}")
    return ", ".join(parts)


def format_lessons(data: dict, lessons: list[Lesson]) -> list[str]:
    """Строки расписания. Подгруппы выводятся отдельными строками."""
    times = data.get("LESSON_TIMES", {})
    out: list[str] = []
    for lesson in lessons:
        t = times.get(str(lesson.num))
        time_text = f"{t[0]}–{t[1]}" if t else ""
        mark = " 🔄" if lesson.changed else ""
        prefix = f"{lesson.num}. {time_text}".rstrip()

        same = len({(i.subject, i.teacher, i.room) for i in lesson.items}) == 1
        if same:
            first = lesson.items[0]
            # Если подгруппы одинаковые (один предмет/учитель/кабинет) - одна строка
            group_suffix = f" ({first.group})" if len(lesson.items) == 1 and first.group else ""
            place = _place(first)
            line = f"{prefix} · {first.subject}{group_suffix}"
            if place:
                line += f" — {place}"
            out.append(line + mark)
        else:
            out.append(f"{prefix}{mark}")
            for item in lesson.items:
                label = f"{item.group}: " if item.group else ""
                place = _place(item)
                line = f"    {label}{item.subject}"
                if place:
                    line += f" — {place}"
                out.append(line)
    return out
