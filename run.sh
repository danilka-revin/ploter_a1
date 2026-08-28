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
    echo "--- 2. Скачивание зависимостей (шрифты) ---"
    python3 download_fonts.py || echo "Скачивание шрифтов пропущено (возможно, нет интернета)"
    echo "--- 3. Построение G-кода ---"
    for svg in *.svg; do
      [ -e "$svg" ] || continue
      output="${svg%.svg}.gcode"
      python3 convert_svg_to_gcode.py "$svg" "$output" || true
      echo "Построено: $output"
    done
    echo "--- 4. Запуск сервера ---"
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
    echo "Доступно: start (по умолчанию), update, build"
    exit 1
    ;;
esac
