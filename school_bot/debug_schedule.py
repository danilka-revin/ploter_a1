"""Проверка расписания: скачивает данные сайта и печатает расписание класса на неделю.

Запуск: python debug_schedule.py
Сырой JSON сохраняется в data/debug/nika_raw.json.
"""
import asyncio
from datetime import date, timedelta

import httpx

import config
import schedule
from schedule_parser import DAY_NAMES, find_class_id, format_lessons, lessons_for_date


async def main() -> None:
    async with httpx.AsyncClient(timeout=config.HTTP_TIMEOUT, follow_redirects=True) as client:
        data = await schedule.fetch_nika(client)

    class_id = find_class_id(data, config.CLASS_NAME)
    print(f"Класс {config.CLASS_NAME} -> код {class_id}")
    print(f"Период: {data['PERIODS']}")
    print(f"Сырые данные: {config.DEBUG_DIR / 'nika_raw.json'}\n")

    start = date.today()
    for offset in range(7):
        day = start + timedelta(days=offset)
        print(f"== {DAY_NAMES[day.weekday()]}, {day:%d.%m.%Y}")
        try:
            lessons = lessons_for_date(data, class_id, day)
            print("\n".join(format_lessons(data, lessons)) or "  занятий нет")
        except Exception as e:  # noqa: BLE001
            print(f"  {e}")
        print()


if __name__ == "__main__":
    asyncio.run(main())
