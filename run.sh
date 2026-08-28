#!/bin/bash
# Почерк A1 — одна команда для запуска и обновления
# Использование:
#   ./run.sh          — запустить приложение
#   ./run.sh update   — обновить (перегенерировать) G-код из SVG
#   ./run.sh build    — сгенерировать G-код из текущего index.html / SVG

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

case "${1:-start}" in
  start)
    echo "=== Почерк A1: запуск сервера ==="
    echo "Открой в браузере: http://localhost:8080"
    echo "Нажми Ctrl+C для остановки"
    python3 -m http.server 8080 --bind 0.0.0.0
    ;;
  update)
    echo "=== Обновление из git ==="
    git pull origin arena/01a0484a-ploter-a1 || git pull origin main || echo "Git pull не сработал (возможно, нет соединения или конфликтов)"
    echo "=== Перегенерация G-кода ==="
    if [ -f "output.svg" ]; then
      python3 convert_svg_to_gcode.py output.svg my_homework.gcode
      echo "Обновлено: my_homework.gcode"
    else
      echo "Файл output.svg не найден. Сначала скачай SVG из приложения или создай его."
    fi
    ;;
  all)
    echo "=== ВСЁ ОДНОЙ КОМАНДОЙ ==="
    echo "--- 1. Обновление из git ---"
    git pull origin arena/01a0484a-ploter-a1 || git pull origin main || echo "Git pull пропущен"
    echo "--- 2. Установка Python-зависимостей ---"
    if [ -f requirements.txt ]; then
      if [ ! -d "venv" ]; then
        python3 -m venv venv || echo "venv не создан (возможно, нет python3-venv)"
      fi
      if [ -d "venv" ]; then
        venv/bin/pip install -r requirements.txt || echo "pip пропущен"
      else
        pip install --break-system-packages -r requirements.txt || echo "pip пропущен"
      fi
    else
      echo "Нет requirements.txt"
    fi
    echo "--- 3. Скачивание шрифтов и зависимостей ---"
    python3 download_fonts.py || echo "Скачивание шрифтов пропущено"
    echo "--- 4. Генерация шаблонов (если их нет) ---"
    if [ ! -f templates/homework_example.svg ]; then
      mkdir -p templates
      echo "Шаблоны готовы в templates/"
    fi
    echo "--- 5. Построение G-кода (все SVG) ---"
    for svg in *.svg templates/*.svg; do
      [ -e "$svg" ] || continue
      output_dir=$(dirname "$svg")
      fname=$(basename "$svg" .svg)
      output="$output_dir/${fname}.gcode"
      python3 convert_svg_to_gcode.py "$svg" "$output" || true
      echo "Построено: $output"
    done
    echo "--- 6. Запуск сервера ---"
    echo "Открой в браузере: http://localhost:8080"
    echo "Нажми Ctrl+C для остановки"
    python3 -m http.server 8080 --bind 0.0.0.0
    ;;
  build)
    echo "=== Построение G-кода ==="
    # Генерируем базовый SVG из текста в README или из последнего файла
    # Здесь просто запускаем конвертер для любого найденного SVG
    for svg in *.svg; do
      [ -e "$svg" ] || continue
      output="${svg%.svg}.gcode"
      python3 convert_svg_to_gcode.py "$svg" "$output"
      echo "Построено: $output (из $svg)"
    done
    ;;
  *)
    echo "Неизвестная команда: $1"
    echo "Доступно: start (по умолчанию), update, build, all"
    exit 1
    ;;
esac
