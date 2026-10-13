#!/usr/bin/env bash
# Запуск JBD BMS. Программа выходит с кодом 10 после обновления из GitHub —
# тогда перезапускаем её в том же окне (как в linux_pcb_app).
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
PY=".venv/bin/python"
[ -x "$PY" ] || PY="python3"
while true; do
  "$PY" -m jbd_bms "$@"
  code=$?
  [ "$code" -eq 10 ] || exit "$code"
  echo "Перезапуск после обновления…"
done
