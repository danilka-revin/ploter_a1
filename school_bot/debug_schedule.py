"""Диагностика расписания: скачивает данные сайта и сохраняет их в data/debug/.

Запуск: python debug_schedule.py
Полезно, чтобы понять структуру данных NIKA и доработать parse_lessons_for_day().
"""
import asyncio
import json

import httpx

import config
import schedule


async def main() -> None:
    async with httpx.AsyncClient(timeout=config.HTTP_TIMEOUT, follow_redirects=True) as client:
        try:
            data = await schedule.fetch_raw_nika_data(client)
        except Exception as e:  # noqa: BLE001
            print("Ошибка:", e)
            return
    print("Ключи верхнего уровня:", list(data.keys()))
    print("Сохранено в", config.DEBUG_DIR / "nika_raw.json")
    print(json.dumps(data, ensure_ascii=False)[:500], "...")


if __name__ == "__main__":
    asyncio.run(main())
