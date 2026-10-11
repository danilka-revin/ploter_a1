# Школьный бот (10 ИТ, Красноярск)

Telegram-бот, который присылает:
- расписание класса на сегодня (`/today`);
- погоду в Красноярске (`/weather`);
- курсы валют ЦБ РФ (`/rates`);
- новости (`/news`);
- всё сразу (`/daily`) и ежедневную рассылку в 07:00 (Красноярск).

## Установка

```bash
cd school_bot
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env             # и вписать BOT_TOKEN
```

## Получить токен

1. В Telegram откройте @BotFather, команда `/newbot`.
2. Скопируйте токен в `.env` → `BOT_TOKEN=...`.

## Запуск

```bash
python bot.py
```

Откройте бота в Telegram и нажмите `/start`, чтобы подписаться на рассылку.

## Расписание

Бот пытается читать расписание с сайта `raspisanie.nikasoft.ru`.
Автоматический разбор пока не настроен под реальную структуру данных. Порядок работы:

1. Запустите `python debug_schedule.py` — он сохранит данные в `data/debug/nika_raw.json`.
2. Либо заполните `data/schedule.txt` вручную (формат — в самом файле). Это надёжный запасной вариант.

## Файлы

- `bot.py` — Telegram-команды и рассылка
- `schedule.py` — расписание (сайт + ручной файл)
- `weather.py` — погода (Open-Meteo, без ключа)
- `rates.py` — курсы ЦБ РФ
- `news.py` — новости (RSS)
- `config.py` — настройки
