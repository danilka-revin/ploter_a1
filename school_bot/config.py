"""Настройки бота. Значения берутся из переменных окружения / файла .env."""
import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

BOT_TOKEN = os.getenv("BOT_TOKEN", "")

# Расписание: класс 10ит (лицей №6 «Перспектива», Красноярск)
SCHOOL_ID = os.getenv("SCHOOL_ID", "22811554")
CLASS_NAME = os.getenv("CLASS_NAME", "10ит")
SCHEDULE_PAGE_URL = f"https://raspisanie.nikasoft.ru/{SCHOOL_ID}.html"
# check-страница отдаёт имя актуального JS-файла с расписанием
SCHEDULE_CHECK_URL = f"https://raspisanie.nikasoft.ru/check/{SCHOOL_ID}.html"
SCHEDULE_STATIC_URL = "https://raspisanie.nikasoft.ru/static/public/"
# Запасной файл с ручным расписанием (не попадает в Git)
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
