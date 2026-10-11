"""Погода через Open-Meteo (бесплатно, без ключа)."""
import httpx

import config

WMO_CODES = {
    0: "ясно ☀️",
    1: "в основном ясно 🌤",
    2: "переменная облачность ⛅",
    3: "пасмурно ☁️",
    45: "туман 🌫",
    48: "туман с инеем 🌫",
    51: "слабая морось 🌦",
    53: "морось 🌦",
    55: "сильная морось 🌧",
    61: "слабый дождь 🌦",
    63: "дождь 🌧",
    65: "сильный дождь 🌧",
    71: "слабый снег 🌨",
    73: "снег ❄️",
    75: "сильный снег ❄️",
    77: "снежные зёрна ❄️",
    80: "ливень 🌦",
    81: "ливень 🌧",
    82: "сильный ливень ⛈",
    85: "снегопад 🌨",
    86: "сильный снегопад 🌨",
    95: "гроза ⛈",
    96: "гроза с градом ⛈",
    99: "сильная гроза с градом ⛈",
}


async def get_weather_text(client: httpx.AsyncClient) -> str:
    params = {
        "latitude": config.CITY_LAT,
        "longitude": config.CITY_LON,
        "current": "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
        "timezone": config.TIMEZONE,
        "forecast_days": 1,
    }
    r = await client.get("https://api.open-meteo.com/v1/forecast", params=params)
    r.raise_for_status()
    data = r.json()

    cur = data["current"]
    day = data["daily"]
    code_now = WMO_CODES.get(cur["weather_code"], "—")
    code_day = WMO_CODES.get(day["weather_code"][0], "—")
    rain = day["precipitation_probability_max"][0]

    return (
        f"🌡 Погода в {config.CITY_NAME}\n"
        f"Сейчас: {cur['temperature_2m']:+.0f}°C "
        f"(ощущается как {cur['apparent_temperature']:+.0f}°C), {code_now}\n"
        f"Ветер: {cur['wind_speed_10m']:.0f} км/ч\n"
        f"Сегодня: от {day['temperature_2m_min'][0]:+.0f}°C до "
        f"{day['temperature_2m_max'][0]:+.0f}°C, {code_day}\n"
        f"Вероятность осадков: {rain}%"
    )
