"""Настройки бота. Значения берутся из переменных окружения / файла .env."""
import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

BOT_TOKEN = os.getenv("BOT_TOKEN", "")

# Расписание: страница класса 10 ИТ (лицей №6 «Перспектива»)
SCHEDULE_PAGE_URL = os.getenv(
    "SCHEDULE_PAGE_URL", "https://raspisanie.nikasoft.ru/22811554.html"
)
# Файл с ручным расписанием (запасной вариант, если автопарсинг не сработал)
MANUAL_SCHEDULE_FILE = BASE_DIR / "data" / "schedule.txt"

# Погода: Красноярск
CITY_NAME = "Красноярск"
CITY_LAT = 56.0153
CITY_LON = 92.8932
TIMEZONE = "Asia/Krasnoyarsk"

# Новости
NEWS_RSS_URL = os.getenv("NEWS_RSS_URL", "https://lenta.ru/rss/news")
NEWS_COUNT = 5

# Ежедневная рассылка (локальное время TIMEZONE)
DAILY_HOUR = int(os.getenv("DAILY_HOUR", "7"))
DAILY_MINUTE = int(os.getenv("DAILY_MINUTE", "0"))

SUBSCRIBERS_FILE = BASE_DIR / "data" / "subscribers.json"
DEBUG_DIR = BASE_DIR / "data" / "debug"

HTTP_TIMEOUT = 15
