"""Расписание класса.

Сайт Ника-Софт строит страницу из JavaScript-файла с данными (вида 20261013_12345.js).
Здесь:
  1. скачиваем HTML страницы и ищем имя этого файла;
  2. скачиваем файл и достаём из него JSON (после `var NIKA = `);
  3. если автопарсинг не сработал, используем ручной файл data/schedule.txt.

Сырой JSON сохраняется в data/debug/, чтобы можно было доработать разбор
под реальную структуру данных (см. debug_schedule.py).
"""
import json
import logging
import re
from datetime import datetime
from urllib.parse import urljoin

import httpx

import config

log = logging.getLogger(__name__)

DAYS_RU = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"]


class ScheduleError(Exception):
    pass


async def fetch_raw_nika_data(client: httpx.AsyncClient) -> dict:
    """Возвращает JSON-объект из JS-файла расписания."""
    page = await client.get(config.SCHEDULE_PAGE_URL)
    page.raise_for_status()
    html = page.text

    match = re.search(r"(\d+_\d+\.js)", html)
    if not match:
        raise ScheduleError("В HTML страницы не найден JS-файл с данными расписания")
    js_url = urljoin(config.SCHEDULE_PAGE_URL, match.group(1))

    js = await client.get(js_url)
    js.raise_for_status()

    m = re.search(r"var\s+NIKA\s*=\s*(\{.*\})\s*;?", js.text, re.DOTALL)
    if not m:
        raise ScheduleError("В JS-файле не найден объект NIKA")
    data = json.loads(m.group(1))

    config.DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    (config.DEBUG_DIR / "nika_raw.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return data


def parse_lessons_for_day(data: dict, weekday: int) -> list[str]:
    """Разбор уроков на нужный день недели (0 = понедельник).

    TODO: подогнать под реальную структуру NIKA (см. data/debug/nika_raw.json).
    Пока возвращает пустой список, и бот использует ручной файл.
    """
    raise ScheduleError("Парсер структуры NIKA ещё не настроен")


def read_manual_schedule() -> str | None:
    """Ручное расписание из data/schedule.txt (блоки по дням недели)."""
    path = config.MANUAL_SCHEDULE_FILE
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8").strip()
    return text or None


def manual_day_text(weekday: int) -> str | None:
    """Достаёт из schedule.txt блок нужного дня.

    Формат файла: строка-заголовок дня (например, «Понедельник»), под ней уроки.
    Блок заканчивается, когда начинается следующий день.
    """
    text = read_manual_schedule()
    if not text:
        return None
    day_name = DAYS_RU[weekday].lower()
    lines = text.splitlines()
    out: list[str] = []
    capturing = False
    for line in lines:
        stripped = line.strip()
        head = stripped.rstrip(":").lower()
        if head in [d.lower() for d in DAYS_RU]:
            if capturing:
                break
            capturing = head == day_name
            continue
        if capturing and stripped:
            out.append(stripped)
    return "\n".join(out) if out else None


async def get_today_schedule(client: httpx.AsyncClient, now: datetime) -> str:
    """Расписание на сегодня: сначала пробуем сайт, затем ручной файл."""
    weekday = now.weekday()
    header = f"📚 Расписание 10 ИТ, {DAYS_RU[weekday]}, {now:%d.%m.%Y}"
    if weekday == 6:
        return f"{header}\n\nВоскресенье — выходной 🎉"

    try:
        data = await fetch_raw_nika_data(client)
        lessons = parse_lessons_for_day(data, weekday)
        if lessons:
            return header + "\n\n" + "\n".join(lessons)
    except (ScheduleError, httpx.HTTPError, json.JSONDecodeError) as e:
        log.warning("Автопарсинг расписания не сработал: %s", e)

    manual = manual_day_text(weekday)
    if manual:
        return header + "\n\n" + manual
    return (
        header
        + "\n\nРасписание не удалось получить. Добавьте его в файл "
        "school_bot/data/schedule.txt (см. README)."
    )
