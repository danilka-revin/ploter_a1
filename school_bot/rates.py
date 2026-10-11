"""Официальные курсы валют ЦБ РФ."""
import xml.etree.ElementTree as ET
from datetime import datetime

import httpx

CBR_URL = "https://www.cbr.ru/scripts/XML_daily.asp"
SHOW = {"USD": "🇺🇸 Доллар", "EUR": "🇪🇺 Евро", "CNY": "🇨🇳 Юань"}


async def get_rates_text(client: httpx.AsyncClient, now: datetime) -> str:
    r = await client.get(CBR_URL, params={"date_req": now.strftime("%d/%m/%Y")})
    r.raise_for_status()
    root = ET.fromstring(r.content)

    lines = []
    for valute in root.findall("Valute"):
        code = valute.findtext("CharCode")
        if code not in SHOW:
            continue
        nominal = int(valute.findtext("Nominal", "1"))
        value = float(valute.findtext("Value", "0").replace(",", "."))
        per_unit = value / nominal
        lines.append(f"{SHOW[code]}: {per_unit:.2f} ₽")

    if not lines:
        return "💱 Курсы ЦБ сейчас недоступны"
    return "💱 Курс ЦБ РФ:\n" + "\n".join(lines)
