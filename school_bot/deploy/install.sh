#!/usr/bin/env bash
# Установка школьного бота на Ubuntu:
#   - виртуальное окружение и зависимости;
#   - файл .env с токеном (спросит токен, в Git не попадает);
#   - автозапуск при входе в систему (systemd user service);
#   - ярлыки в меню приложений и на рабочем столе.
# Запуск: bash school_bot/deploy/install.sh
set -euo pipefail

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$BOT_DIR/deploy"
SERVICE=school-bot
UNIT_DIR="$HOME/.config/systemd/user"
APPS_DIR="$HOME/.local/share/applications"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "Проверка окружения"
command -v git >/dev/null || { echo "Установите git: sudo apt install git"; exit 1; }
command -v python3 >/dev/null || { echo "Установите Python: sudo apt install python3 python3-venv"; exit 1; }
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' \
    || { echo "Нужен Python 3.10+ (сейчас: $(python3 --version))"; exit 1; }
python3 -m venv --help >/dev/null 2>&1 \
    || { echo "Установите venv: sudo apt install python3-venv"; exit 1; }
if ! git -C "$BOT_DIR" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    echo "ВНИМАНИЕ: у текущей ветки нет upstream - автообновление не будет работать."
    echo "Выполните: git -C \"$BOT_DIR\" branch --set-upstream-to=origin/<ветка>"
fi

say "Виртуальное окружение и зависимости"
python3 -m venv "$BOT_DIR/.venv"
"$BOT_DIR/.venv/bin/pip" install -q --upgrade pip
"$BOT_DIR/.venv/bin/pip" install -q -r "$BOT_DIR/requirements.txt"

say "Настройка токена"
ENV_FILE="$BOT_DIR/.env"
if [ -f "$ENV_FILE" ] && grep -q '^BOT_TOKEN=.\+' "$ENV_FILE"; then
    echo "Токен уже есть в $ENV_FILE - оставляю."
else
    read -rsp "Вставьте токен бота из @BotFather и нажмите Enter: " TOKEN; echo
    [ -n "$TOKEN" ] || { echo "Токен пустой"; exit 1; }
    printf 'BOT_TOKEN=%s\nDAILY_HOUR=7\nDAILY_MINUTE=0\n' "$TOKEN" > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    unset TOKEN
    echo "Токен сохранён в $ENV_FILE (файл не попадает в Git)."
fi

say "Автозапуск (systemd, пользовательский сервис)"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/$SERVICE.service" <<UNIT
[Unit]
Description=Школьный Telegram-бот (расписание, погода, курсы, новости)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$BOT_DIR
ExecStart=/bin/bash $DEPLOY_DIR/run.sh
Restart=always
RestartSec=20

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE.service"

# Запуск без входа в систему: бот стартует сам после включения ПК
if loginctl enable-linger "$USER" 2>/dev/null; then
    echo "Включён автозапуск после перезагрузки (linger)."
else
    echo "Чтобы бот стартовал сразу после включения ПК, выполните один раз:"
    echo "    sudo loginctl enable-linger $USER"
fi

say "Ярлыки"
chmod +x "$DEPLOY_DIR/run.sh" "$DEPLOY_DIR/launcher.sh" "$DEPLOY_DIR/install.sh" "$DEPLOY_DIR/uninstall.sh"
mkdir -p "$APPS_DIR"

make_desktop() {
    cat > "$1" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Школьный бот
Comment=Расписание, погода, курсы валют и новости
Exec=$DEPLOY_DIR/launcher.sh start
Icon=x-office-calendar
Terminal=false
Categories=Utility;
Actions=Restart;Logs;Status;Stop;

[Desktop Action Restart]
Name=Перезапустить и обновить с GitHub
Exec=$DEPLOY_DIR/launcher.sh restart

[Desktop Action Logs]
Name=Показать логи
Exec=$DEPLOY_DIR/launcher.sh logs

[Desktop Action Status]
Name=Проверить состояние
Exec=$DEPLOY_DIR/launcher.sh status

[Desktop Action Stop]
Name=Остановить бота
Exec=$DEPLOY_DIR/launcher.sh stop
DESKTOP
    chmod +x "$1"
}

make_desktop "$APPS_DIR/$SERVICE.desktop"
echo "Ярлык добавлен в меню приложений."

DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
if [ -z "$DESKTOP_DIR" ] || [ ! -d "$DESKTOP_DIR" ]; then
    DESKTOP_DIR="$HOME/Desktop"
fi
if [ -d "$DESKTOP_DIR" ]; then
    make_desktop "$DESKTOP_DIR/$SERVICE.desktop"
    gio set "$DESKTOP_DIR/$SERVICE.desktop" metadata::trusted true 2>/dev/null || true
    echo "Ярлык добавлен на рабочий стол: $DESKTOP_DIR"
fi

say "Готово"
systemctl --user --no-pager status "$SERVICE.service" | head -n 5 || true
echo
echo "Логи:        journalctl --user -u $SERVICE -f"
echo "Обновление:  автоматически при запуске и каждые 30 минут (git pull)"
echo "Удаление:    bash $DEPLOY_DIR/uninstall.sh"
