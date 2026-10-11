"""Telegram-бот: расписание, погода, курсы валют, новости.

Запуск: python bot.py
"""
import json
import logging
from datetime import datetime, time
from zoneinfo import ZoneInfo

import httpx
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

import config
import news
import rates
import schedule
import weather

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(name)s: %(message)s", level=logging.INFO
)
log = logging.getLogger("school_bot")
TZ = ZoneInfo(config.TIMEZONE)


def now_local() -> datetime:
    return datetime.now(TZ)


def load_subscribers() -> set[int]:
    if config.SUBSCRIBERS_FILE.exists():
        return set(json.loads(config.SUBSCRIBERS_FILE.read_text(encoding="utf-8")))
    return set()


def save_subscribers(subs: set[int]) -> None:
    config.SUBSCRIBERS_FILE.parent.mkdir(parents=True, exist_ok=True)
    config.SUBSCRIBERS_FILE.write_text(json.dumps(sorted(subs)), encoding="utf-8")


async def build_digest(client: httpx.AsyncClient) -> list[str]:
    """Собирает сообщения для рассылки. Ошибка одного блока не ломает остальные."""
    now = now_local()
    parts = []
    for builder in (
        lambda: schedule.get_today_schedule(client, now),
        lambda: weather.get_weather_text(client),
        lambda: rates.get_rates_text(client, now),
        lambda: news.get_news_text(client),
    ):
        try:
            parts.append(await builder())
        except Exception as e:  # noqa: BLE001 - показываем причину и идём дальше
            log.exception("Блок рассылки упал")
            parts.append(f"⚠️ Не удалось получить блок: {e}")
    return parts


async def send_parts(context: ContextTypes.DEFAULT_TYPE, chat_id: int, parts: list[str]) -> None:
    for part in parts:
        await context.bot.send_message(chat_id=chat_id, text=part[:4000])


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    subs = load_subscribers()
    subs.add(chat_id)
    save_subscribers(subs)
    await update.message.reply_text(
        "Привет! Я буду присылать расписание 10 ИТ, погоду в Красноярске, "
        f"курсы валют и новости каждый день в {config.DAILY_HOUR:02d}:{config.DAILY_MINUTE:02d}.\n\n"
        "Команды:\n"
        "/today — расписание на сегодня\n"
        "/weather — погода\n"
        "/rates — курсы валют\n"
        "/news — новости\n"
        "/daily — всё сразу\n"
        "/stop — отписаться от рассылки"
    )


async def cmd_stop(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    subs = load_subscribers()
    subs.discard(update.effective_chat.id)
    save_subscribers(subs)
    await update.message.reply_text("Ок, рассылка отключена. /start — включить снова.")


async def cmd_today(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    async with httpx.AsyncClient(timeout=config.HTTP_TIMEOUT, follow_redirects=True) as client:
        text = await schedule.get_today_schedule(client, now_local())
    await update.message.reply_text(text)


async def cmd_weather(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    async with httpx.AsyncClient(timeout=config.HTTP_TIMEOUT) as client:
        text = await weather.get_weather_text(client)
    await update.message.reply_text(text)


async def cmd_rates(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    async with httpx.AsyncClient(timeout=config.HTTP_TIMEOUT) as client:
        text = await rates.get_rates_text(client, now_local())
    await update.message.reply_text(text)


async def cmd_news(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    async with httpx.AsyncClient(timeout=config.HTTP_TIMEOUT, follow_redirects=True) as client:
        text = await news.get_news_text(client)
    await update.message.reply_text(text, disable_web_page_preview=True)


async def cmd_daily(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    async with httpx.AsyncClient(timeout=config.HTTP_TIMEOUT, follow_redirects=True) as client:
        parts = await build_digest(client)
    await send_parts(context, update.effective_chat.id, parts)


async def job_daily(context: ContextTypes.DEFAULT_TYPE) -> None:
    async with httpx.AsyncClient(timeout=config.HTTP_TIMEOUT, follow_redirects=True) as client:
        parts = await build_digest(client)
    for chat_id in load_subscribers():
        try:
            await send_parts(context, chat_id, parts)
        except Exception:  # noqa: BLE001
            log.exception("Не удалось отправить рассылку в чат %s", chat_id)


def main() -> None:
    if not config.BOT_TOKEN:
        raise SystemExit("Не задан BOT_TOKEN. Создайте school_bot/.env (см. .env.example).")

    app = Application.builder().token(config.BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help", cmd_start))
    app.add_handler(CommandHandler("stop", cmd_stop))
    app.add_handler(CommandHandler("today", cmd_today))
    app.add_handler(CommandHandler("weather", cmd_weather))
    app.add_handler(CommandHandler("rates", cmd_rates))
    app.add_handler(CommandHandler("news", cmd_news))
    app.add_handler(CommandHandler("daily", cmd_daily))

    app.job_queue.run_daily(
        job_daily,
        time=time(config.DAILY_HOUR, config.DAILY_MINUTE, tzinfo=TZ),
        name="daily_digest",
    )
    log.info("Бот запущен")
    app.run_polling()


if __name__ == "__main__":
    main()
