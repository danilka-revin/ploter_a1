#!/usr/bin/env bash
# Быстрый запуск JBD BMS одной командой:
#   • проверяет GitHub — если в ветке появился новый коммит с программой, обновляет её
#     (та же схема, что в PSBees: git fetch + merge --ff-only, npm ci при изменении
#     библиотек, сборка);
#   • собирает программу, если нужно, поднимает локальный сервер и открывает браузер.
# Сервер слушает только 127.0.0.1 — плата подключена к этому компьютеру.
# После обновления из интерфейса сервер завершается с кодом 10, и цикл ниже
# запускает его заново с новой версией.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
PORT="${BMS_APP_PORT:-8585}"
URL="http://127.0.0.1:$PORT"
LOG="node_modules/.cache/jbd-bms.log"

err() { printf '\033[1;31mОшибка:\033[0m %s\n' "$*" >&2; exit 1; }

if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
  err "не запускайте через sudo: файлы сборки станут недоступны вашему пользователю. Выполните просто:  bash run.sh"
fi
command -v node >/dev/null 2>&1 || err "Node.js не найден. Установите Node.js 20 или новее — см. README.md, раздел «Установка на Ubuntu»"
command -v npm  >/dev/null 2>&1 || err "npm не найден. Установите его вместе с Node.js"
[ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -ge 20 ] \
  || err "нужен Node.js 20 или новее, а установлен $(node -v)"

# Node с системными сертификатами (нужно для связи с GitHub за корпоративным прокси)
NODE_FLAGS=()
if node --use-system-ca -e 0 >/dev/null 2>&1; then NODE_FLAGS=(--use-system-ca); fi

# ---------------- проверка обновлений на GitHub ----------------
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "==> проверка обновлений на GitHub…"
  node ${NODE_FLAGS[@]+"${NODE_FLAGS[@]}"} scripts/server.mjs --update-now || echo "    (обновление пропущено — запускаем текущую версию)"
fi

# ---------------- зависимости и сборка ----------------
if [ ! -f node_modules/.lock.sha256 ] || [ "$(sha256sum package-lock.json | cut -d' ' -f1)" != "$(cat node_modules/.lock.sha256 2>/dev/null)" ]; then
  echo "==> npm ci"
  npm ci --no-audit --no-fund --no-update-notifier --loglevel=error
  mkdir -p node_modules && sha256sum package-lock.json | cut -d' ' -f1 > node_modules/.lock.sha256
fi
if [ ! -f dist/index.html ] || [ -n "$(find src index.html vite.config.ts tsconfig.json -newer dist/index.html -print -quit 2>/dev/null)" ]; then
  echo "==> сборка интерфейса"
  npm run build --no-update-notifier
fi

# ---------------- сервер ----------------
alive() {
  node -e 'fetch(process.argv[1], { signal: AbortSignal.timeout(1000) })
    .then((r) => r.text()).then((t) => process.exit(t.includes("\"ok\":true") ? 0 : 1), () => process.exit(1))' \
    "$URL/healthz" >/dev/null 2>&1
}

if ! alive; then
  mkdir -p "$(dirname "$LOG")"
  nohup bash -c '
    while :; do
      node '"${NODE_FLAGS[*]:-}"' scripts/server.mjs '"$PORT"'
      rc=$?
      [ "$rc" -eq 10 ] || break
      echo "--- перезапуск после обновления ---"
    done' >>"$LOG" 2>&1 &
  for _ in $(seq 1 40); do
    alive && break
    sleep 0.25
  done
  alive || { tail -20 "$LOG" >&2; err "сервер не запустился (причина выше). Если порт $PORT занят, выберите другой: BMS_APP_PORT=8590 bash run.sh"; }
  echo "Сервер работает в фоне. Журнал: $LOG"
else
  echo "Уже запущен: $URL"
fi

echo "Открываю $URL"
xdg-open "$URL" >/dev/null 2>&1 || echo "Откройте в браузере: $URL"
