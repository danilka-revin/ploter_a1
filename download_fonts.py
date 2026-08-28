#!/usr/bin/env python3
"""Скачивает шрифты Google Fonts локально для работы без интернета."""
import os
import urllib.request
import re

FONTS = [
    ("Caveat", "https://fonts.googleapis.com/css2?family=Caveat:wght@400;700&display=swap"),
    ("Marck Script", "https://fonts.googleapis.com/css2?family=Marck+Script&display=swap"),
    ("Lobster", "https://fonts.googleapis.com/css2?family=Lobster&display=swap"),
    ("Pacifico", "https://fonts.googleapis.com/css2?family=Pacifico&display=swap"),
]

os.makedirs("fonts", exist_ok=True)

for name, url in FONTS:
    try:
        print(f"Скачиваю CSS для {name}...")
        with urllib.request.urlopen(url, timeout=15) as response:
            css = response.read().decode('utf-8')
        # Извлекаем URL файлов шрифтов (.woff2)
        woff_urls = re.findall(r"url\((https://[^)]+\.woff2)\)", css)
        files_downloaded = []
        for wurl in woff_urls:
            fname = wurl.split('/')[-1]
            local_path = os.path.join("fonts", fname)
            print(f"  Скачиваю {fname}...")
            urllib.request.urlretrieve(wurl, local_path)
            files_downloaded.append(local_path)
        if files_downloaded:
            # Сохраняем локальную копию CSS
            local_css = css.replace('https://fonts.gstatic.com/', 'fonts/')
            with open(f"fonts/{name.replace(' ', '_')}.css", 'w', encoding='utf-8') as f:
                f.write(local_css)
            print(f"  {name}: скачано {len(files_downloaded)} файлов в fonts/")
        else:
            print(f"  {name}: не найдено файлов для скачивания")
    except Exception as e:
        print(f"  Ошибка при скачивании {name}: {e}")

# Генерируем простой HTML с локальными ссылками
print("Готово. Локальные шрифты в папке fonts/.")
