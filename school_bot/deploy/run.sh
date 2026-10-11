#!/usr/bin/env bash
# Запускает бота и обновляет его из GitHub.
# Каждые UPDATE_CHECK_SECONDS (по умолчанию 30 минут) делает git pull;
# если код изменился - ставит зависимости и перезапускает бота.
# Этот скрипт запускает systemd-сервис school-bot (см. install.sh).
set -u

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(git -C "$BOT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
VENV="$BOT_DIR/.venv"
CHECK_EVERY="${UPDATE_CHECK_SECONDS:-1800}"
PID=""

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

stop_bot() {
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        kill "$PID" 2>/dev/null
        wait "$PID" 2>/dev/null
    fi
    PID=""
}

on_exit() {
    log "Остановка бота"
    stop_bot
    exit 0
}
trap on_exit TERM INT

install_deps() {
    if [ ! -x "$VENV/bin/python" ]; then
        python3 -m venv "$VENV" || { log "Не удалось создать виртуальное окружение"; return 1; }
    fi
    if "$VENV/bin/pip" install -q -r "$BOT_DIR/requirements.txt"; then
        log "Зависимости установлены"
    else
        log "Ошибка установки зависимостей"
        return 1
    fi
}

# Возвращает 0, если код на GitHub изменился и обновлён
update_code() {
    [ -n "$REPO_DIR" ] || return 1
    local before after
    before="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null)"
    if ! git -C "$REPO_DIR" pull --ff-only --quiet; then
        log "Не удалось обновить код (нет сети или нет upstream-ветки)"
        return 1
    fi
    after="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null)"
    [ "$before" != "$after" ]
}

install_deps || exit 1
if update_code; then
    log "Код обновлён с GitHub"
    install_deps || exit 1
fi

while true; do
    log "Запуск бота"
    "$VENV/bin/python" "$BOT_DIR/bot.py" &
    PID=$!

    restart_needed=0
    while kill -0 "$PID" 2>/dev/null; do
        sleep "$CHECK_EVERY" &
        wait $! 2>/dev/null
        kill -0 "$PID" 2>/dev/null || break
        if update_code; then
            log "Найдено обновление на GitHub - перезапуск"
            restart_needed=1
            stop_bot
            install_deps || true
            break
        fi
    done

    if [ "$restart_needed" -eq 1 ]; then
        continue
    fi
    wait "$PID" 2>/dev/null
    PID=""
    log "Бот завершился, повторный запуск через 20 секунд"
    sleep 20
done
