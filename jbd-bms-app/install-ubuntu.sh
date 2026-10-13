#!/usr/bin/env bash
# Установка JBD BMS на Ubuntu (и совместимые Debian/Mint/Pop!_OS):
#   • Node.js 20+ и npm (если их нет — NodeSource, Node 24 LTS);
#   • библиотеки проекта и сборка интерфейса;
#   • доступ к последовательным портам: пользователь добавляется в группу dialout;
#   • ярлык в меню приложений и команда jbd-bms в терминале.
# Запускать без sudo:  bash install-ubuntu.sh   (пароль спросит только там, где нужно).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
APP_DIR="$(pwd)"
USER_NAME="$(id -un)"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
err() { printf '\033[1;31mОшибка:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || err "не запускайте установщик через sudo. Выполните просто:  bash install-ubuntu.sh"
command -v apt-get >/dev/null 2>&1 || err "этот установщик рассчитан на Ubuntu/Debian (нет apt-get)."
[ -f package.json ] && [ -f run.sh ] || err "запустите установщик из папки jbd-bms-app клона репозитория."

# ---------------- git ----------------
if ! command -v git >/dev/null 2>&1; then
  say "устанавливаю git (понадобится пароль администратора)"
  sudo apt-get update
  sudo apt-get install -y git
fi

# ---------------- Node.js ----------------
node_ok() {
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 \
    && [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -ge 20 ]
}
if ! node_ok; then
  say "устанавливаю Node.js 24 LTS (понадобится пароль администратора)"
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node_ok || err "Node.js 20+ не установлен. Установите вручную и повторите: https://nodejs.org"
say "Node.js $(node -v), npm $(npm -v)"

# ---------------- библиотеки и сборка ----------------
say "загружаю библиотеки проекта (npm ci)"
npm ci --no-audit --no-fund --no-update-notifier --loglevel=error
mkdir -p node_modules && sha256sum package-lock.json | cut -d' ' -f1 > node_modules/.lock.sha256

say "собираю программу"
npm run build --no-update-notifier

# ---------------- порты ----------------
if id -nG "$USER_NAME" | grep -qw dialout; then
  say "доступ к последовательным портам уже настроен (группа dialout)"
  NEED_RELOGIN=0
else
  say "добавляю $USER_NAME в группу dialout — нужен доступ к /dev/ttyUSB* (понадобится пароль администратора)"
  sudo usermod -aG dialout "$USER_NAME"
  NEED_RELOGIN=1
fi

# ---------------- ярлыки ----------------
BIN_DIR="$HOME/.local/bin"
APPS_DIR="$HOME/.local/share/applications"
mkdir -p "$BIN_DIR" "$APPS_DIR"
cat > "$BIN_DIR/jbd-bms" <<EOF
#!/usr/bin/env bash
exec bash "$APP_DIR/run.sh" "\$@"
EOF
chmod +x "$BIN_DIR/jbd-bms"

DESKTOP_FILE="$APPS_DIR/jbd-bms.desktop"
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=JBD BMS — чтение и прошивка
Comment=Монитор и прошивка BMS JBD по UART
Exec=bash "$APP_DIR/run.sh"
Icon=$APP_DIR/public/logo.png
Terminal=false
Categories=Utility;Electronics;
StartupNotify=true
EOF
chmod +x "$DESKTOP_FILE"

DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
if [ -n "$DESKTOP_DIR" ] && [ -d "$DESKTOP_DIR" ]; then
  cp "$DESKTOP_FILE" "$DESKTOP_DIR/jbd-bms.desktop"
  chmod +x "$DESKTOP_DIR/jbd-bms.desktop"
  gio set "$DESKTOP_DIR/jbd-bms.desktop" metadata::trusted true >/dev/null 2>&1 || true
fi
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true

echo
say "Готово!"
echo "  • Ярлык «JBD BMS — чтение и прошивка» появился в меню приложений:"
echo "    нажмите клавишу Super и наберите «JBD»."
echo "  • Из терминала:  jbd-bms   (если команда не найдена — откройте новый терминал)"
echo "  • Адрес в браузере:  http://127.0.0.1:8585"
if [ "$NEED_RELOGIN" -eq 1 ]; then
  echo
  echo "  ВАЖНО: доступ к портам появится после выхода из системы и входа снова"
  echo "  (или перезагрузки). Без этого порт /dev/ttyUSB0 будет недоступен."
fi
