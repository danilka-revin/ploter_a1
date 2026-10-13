#!/usr/bin/env bash
# Установка JBD BMS (Python, PySide6) на Ubuntu / Debian / Mint.
#   • системные библиотеки для Qt (xcb, GL, dbus, fontconfig);
#   • виртуальное окружение .venv рядом с программой и библиотеки из requirements.txt;
#   • доступ к последовательным портам: пользователь в группе dialout;
#   • ярлык в меню приложений и команда jbd-bms в терминале.
# Запуск без sudo:  bash install-ubuntu.sh   (пароль спросит только там, где нужно).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
APP_DIR="$(pwd)"
USER_NAME="$(id -un)"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
err() { printf '\033[1;31mОшибка:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || err "не запускайте установщик через sudo. Выполните просто:  bash install-ubuntu.sh"
command -v apt-get >/dev/null 2>&1 || err "этот установщик рассчитан на Ubuntu/Debian (нет apt-get)."
[ -f requirements.txt ] && [ -d jbd_bms ] || err "запустите установщик из папки jbd-bms-py клона репозитория."

say "системные библиотеки (понадобится пароль администратора)"
sudo apt-get update
sudo apt-get install -y python3 python3-venv python3-pip git \
  libxcb-cursor0 libgl1 libegl1 libxkbcommon0 libdbus-1-3 libfontconfig1 libxkbcommon-x11-0 \
  libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-randr0 libxcb-render-util0 libxcb-shape0 libxcb-xinerama0

say "окружение Python и библиотеки проекта"
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip --quiet
.venv/bin/python -m pip install -r requirements.txt

if id -nG "$USER_NAME" | grep -qw dialout; then
  say "доступ к последовательным портам уже настроен (группа dialout)"
  NEED_RELOGIN=0
else
  say "добавляю $USER_NAME в группу dialout — нужен доступ к /dev/ttyUSB* (понадобится пароль администратора)"
  sudo usermod -aG dialout "$USER_NAME"
  NEED_RELOGIN=1
fi

say "проверка: тесты протокола и клиента"
.venv/bin/python -m unittest discover -s tests -q 2>&1 | tail -3 || true

BIN_DIR="$HOME/.local/bin"
APPS_DIR="$HOME/.local/share/applications"
mkdir -p "$BIN_DIR" "$APPS_DIR"
cat > "$BIN_DIR/jbd-bms" <<EOF2
#!/usr/bin/env bash
exec bash "$APP_DIR/run.sh" "\$@"
EOF2
chmod +x "$BIN_DIR/jbd-bms"

cat > "$APPS_DIR/jbd-bms.desktop" <<EOF2
[Desktop Entry]
Type=Application
Name=JBD BMS
Comment=Чтение и настройка BMS JBD по UART (12S)
Exec=bash "$APP_DIR/run.sh"
Terminal=false
Categories=Utility;Electronics;
StartupNotify=true
EOF2
chmod +x "$APPS_DIR/jbd-bms.desktop"

say "готово"
echo "  запуск из меню приложений или командой:  jbd-bms        (демо без платы: jbd-bms --demo)"
[ "$NEED_RELOGIN" -eq 1 ] && echo "  ВАЖНО: выйдите из сессии и войдите снова — тогда заработает доступ к портам."
exit 0
