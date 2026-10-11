"""Сквозная проверка: check-страница -> JS-файл -> текст для Telegram (без сети)."""
import asyncio
import json
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import config  # noqa: E402
import schedule  # noqa: E402
from fixture_10it import NIKA_FIXTURE  # noqa: E402

JS_NAME = "22811554_20261011140856.js"
JS_TEXT = "// nika_data.js\nvar NIKA=\n" + json.dumps(NIKA_FIXTURE, ensure_ascii=False) + ";\n"


class _Resp:
    def __init__(self, text):
        self.text = text

    def raise_for_status(self):
        pass


class _FakeClient:
    def __init__(self):
        self.urls = []

    async def get(self, url, **kwargs):
        self.urls.append(url)
        if url == config.SCHEDULE_CHECK_URL:
            return _Resp(JS_NAME)
        if url == config.SCHEDULE_STATIC_URL + JS_NAME:
            return _Resp(JS_TEXT)
        raise AssertionError(f"неожиданный URL {url}")


class FlowTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._old_debug = config.DEBUG_DIR
        config.DEBUG_DIR = Path(self._tmp.name)
        schedule._cache.update(ts=0.0, data=None)

    def tearDown(self):
        config.DEBUG_DIR = self._old_debug
        self._tmp.cleanup()

    def test_sunday_shows_monday_schedule(self):
        tz = ZoneInfo(config.TIMEZONE)
        now = datetime(2026, 10, 11, 9, 0, tzinfo=tz)  # воскресенье
        client = _FakeClient()
        text = asyncio.run(schedule.get_today_schedule(client, now))
        self.assertIn("Сегодня — воскресенье, занятий нет", text)
        self.assertIn("понедельник, 12.10.2026", text)
        self.assertIn("1. 8:00–8:40 · История — Гоголева СМ, каб. 208 🔄", text)
        self.assertIn("🔄 — урок изменён заменой", text)
        self.assertEqual(client.urls[0], config.SCHEDULE_CHECK_URL)

    def test_cache_avoids_second_download(self):
        tz = ZoneInfo(config.TIMEZONE)
        now = datetime(2026, 10, 13, 9, 0, tzinfo=tz)
        client = _FakeClient()
        asyncio.run(schedule.get_today_schedule(client, now))
        n = len(client.urls)
        asyncio.run(schedule.get_today_schedule(client, now))
        self.assertEqual(len(client.urls), n)


if __name__ == "__main__":
    unittest.main()
