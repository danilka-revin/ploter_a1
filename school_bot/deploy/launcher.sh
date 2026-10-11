#!/usr/bin/env bash
# Действия ярлыков рабочего стола: start | restart | stop | status | logs
SERVICE=school-bot

notify() {
    if command -v notify-send >/dev/null 2>&1; then
        notify-send "Школьный бот" "$1"
    else
        echo "$1"
    fi
}

case "${1:-start}" in
    start)
        systemctl --user start "$SERVICE" && notify "Бот запущен"
        ;;
    restart)
        systemctl --user restart "$SERVICE" && notify "Бот перезапущен, код проверен на GitHub"
        ;;
    stop)
        systemctl --user stop "$SERVICE" && notify "Бот остановлен"
        ;;
    status)
        notify "Состояние: $(systemctl --user is-active "$SERVICE")"
        ;;
    logs)
        CMD="journalctl --user -u $SERVICE -f -n 100; exec bash"
        for term in x-terminal-emulator gnome-terminal konsole xfce4-terminal xterm; do
            if command -v "$term" >/dev/null 2>&1; then
                if [ "$term" = "gnome-terminal" ]; then
                    gnome-terminal -- bash -c "$CMD"
                else
                    "$term" -e bash -c "$CMD"
                fi
                exit 0
            fi
        done
        notify "Не найден терминал. Выполните: journalctl --user -u $SERVICE -f"
        ;;
    *)
        echo "Использование: $0 start|restart|stop|status|logs"
        exit 1
        ;;
esac
