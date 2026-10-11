"""Новости из RSS-ленты."""
import xml.etree.ElementTree as ET

import httpx

import config


async def get_news_text(client: httpx.AsyncClient) -> str:
    r = await client.get(config.NEWS_RSS_URL)
    r.raise_for_status()
    root = ET.fromstring(r.content)

    items = root.findall("./channel/item")[: config.NEWS_COUNT]
    if not items:
        return "📰 Новости сейчас недоступны"

    lines = ["📰 Главные новости:"]
    for i, item in enumerate(items, 1):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        lines.append(f"{i}. {title}\n{link}")
    return "\n".join(lines)
