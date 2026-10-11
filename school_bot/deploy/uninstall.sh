#!/usr/bin/env bash
# Удаляет автозапуск и ярлыки школьного бота. Файлы проекта и .env не трогает.
SERVICE=school-bot
systemctl --user disable --now "$SERVICE.service" 2>/dev/null
rm -f "$HOME/.config/systemd/user/$SERVICE.service"
systemctl --user daemon-reload 2>/dev/null
rm -f "$HOME/.local/share/applications/$SERVICE.desktop"
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
rm -f "$HOME/Desktop/$SERVICE.desktop"
[ -n "$DESKTOP_DIR" ] && rm -f "$DESKTOP_DIR/$SERVICE.desktop"
echo "Автозапуск и ярлыки удалены. Папку проекта и .env можно удалить вручную."
