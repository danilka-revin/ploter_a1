"""Расписание класса: загрузка с raspisanie.nikasoft.ru и формирование текста.

Порядок:
  1. check-страница класса -> имя актуального JS-файла (меняется при обновлении расписания);
  2. JS-файл в static/public -> объект NIKA (см. schedule_parser.py);
  3. если сайт недоступен - запасной файл data/schedule.txt.
"""
from __future__ import annotations

import json
import logging
import re
import time
from datetime import datetime, timedelta
from urllib.parse import urljoin

import httpx

import config
from schedule_parser import (
    DAY_NAMES,
    NikaError,
    NoScheduleForDate,
    extract_nika_json,
    find_class_id,
    format_lessons,
    lessons_for_date,
)

log = logging.getLogger(__name__)

CACHE_SECONDS = 600
_cache: dict = {"ts": 0.0, "data": None}


async def fetch_nika(client: httpx.AsyncClient) -> dict:
    """Скачивает и разбирает расписание. Результат кэшируется на CACHE_SECONDS."""
    if _cache["data"] is not None and time.time() - _cache["ts"] < CACHE_SECONDS:
        return _cache["data"]

    check = await client.get(config.SCHEDULE_CHECK_URL)
    check.raise_for_status()
    match = re.search(r"(\d+_\d+\.js)", check.text)
    if not match:
        raise NikaError("На check-странице не найдено имя JS-файла")

    js_url = urljoin(config.SCHEDULE_STATIC_URL, match.group(1))
    js = await client.get(js_url)
    js.raise_for_status()
    data = extract_nika_json(js.text)

    config.DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    (config.DEBUG_DIR / "nika_raw.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    _cache.update(ts=time.time(), data=data)
    return data


def _manual_schedule_text(now: datetime) -> str | None:
    """Запасной вариант: блоки по дням недели из data/schedule.txt."""
    path = config.MANUAL_SCHEDULE_FILE
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return None
    day_name = DAY_NAMES[now.weekday()]
    out: list[str] = []
    capturing = False
    for line in text.splitlines():
        stripped = line.strip()
        head = stripped.rstrip(":").lower()
        if head in DAY_NAMES:
            if capturing:
                break
            capturing = head == day_name
            continue
        if capturing and stripped and not stripped.startswith("#"):
            out.append(stripped)
    return "\n".join(out) if out else None


def _format_day(data: dict, class_name: str, day: datetime, offset: int) -> str:
    class_id = find_class_id(data, class_name)
    lessons = lessons_for_date(data, class_id, day.date())
    weekday = DAY_NAMES[day.weekday()]
    date_text = day.strftime("%d.%m.%Y")

    if offset == 0:
        head = f"📚 Расписание {class_name}, {weekday}, {date_text}"
    elif offset == 1:
        head = f"📚 Расписание {class_name} на завтра — {weekday}, {date_text}"
    else:
        head = f"📚 Ближайшие занятия {class_name} — {weekday}, {date_text}"

    body = "\n".join(format_lessons(data, lessons))
    notes = []
    if any(lesson.changed for lesson in lessons):
        notes.append("🔄 — урок изменён заменой на эту дату")
    return "\n\n".join(p for p in (head, body, "\n".join(notes)) if p)


async def get_today_schedule(client: httpx.AsyncClient, now: datetime) -> str:
    """Текст расписания на сегодня. Если сегодня занятий нет - ближайший учебный день."""
    try:
        data = await fetch_nika(client)
    except (httpx.HTTPError, NikaError, ValueError) as e:
        log.warning("Не удалось загрузить расписание с сайта: %s", e)
        manual = _manual_schedule_text(now)
        if manual:
            return f"📚 Расписание {config.CLASS_NAME}, {DAY_NAMES[now.weekday()]} "\
                   f"(из запасного файла)\n\n{manual}"
        return (
            f"⚠️ Не удалось получить расписание с сайта ({e}).\n"
            "Можно заполнить school_bot/data/schedule.txt вручную."
        )

    try:
        class_id = find_class_id(data, config.CLASS_NAME)
        for offset in range(0, 8):
            day = now + timedelta(days=offset)
            if lessons_for_date(data, class_id, day.date()):
                text = _format_day(data, config.CLASS_NAME, day, offset)
                if offset > 0:
                    text = (
                        f"Сегодня — {DAY_NAMES[now.weekday()]}, занятий нет.\n\n" + text
                    )
                return text
        return f"Занятий на ближайшие дни нет ({config.CLASS_NAME})."
    except NoScheduleForDate as e:
        return f"📚 Расписание {config.CLASS_NAME}: {e}."
    except NikaError as e:
        return f"⚠️ Ошибка разбора расписания: {e}"
