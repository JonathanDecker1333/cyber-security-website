#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 24 ]]; then
	printf 'Node.js 24 or later is required to install Salone Register.\n' >&2
	exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
	printf 'npm is required to install Salone Register dependencies.\n' >&2
	exit 1
fi
npm ci --omit=dev --prefix "$APP_DIR"

BIN_DIR="${HOME}/.local/bin"
APP_DIRS="${HOME}/.local/share/applications"
ICON_DIR="${HOME}/.local/share/icons/hicolor/scalable/apps"
DESKTOP_FILE="$APP_DIRS/salone-register.desktop"
DESKTOP_EXEC="$BIN_DIR/salone-register"

mkdir -p "$BIN_DIR" "$APP_DIRS" "$ICON_DIR"
chmod +x "$APP_DIR/launch-linux.sh"
ln -sfn "$APP_DIR/launch-linux.sh" "$DESKTOP_EXEC"
install -m 644 "$APP_DIR/icon.svg" "$ICON_DIR/salone-register.svg"

escaped_exec="${DESKTOP_EXEC//\\/\\\\}"
escaped_exec="${escaped_exec// /\\ }"
printf '%s\n' \
	'[Desktop Entry]' \
	'Version=1.0' \
	'Type=Application' \
	'Name=Salone Register' \
	'Comment=School enrollment and report cards' \
	"Exec=$escaped_exec" \
	'Icon=salone-register' \
	'Terminal=false' \
	'Categories=Office;Education;' \
	'StartupNotify=true' >"$DESKTOP_FILE"

chmod 644 "$DESKTOP_FILE"
printf 'Installed Salone Register in your application menu.\n'
printf 'Database location: %s/.local/share/salone-register/salone.sqlite\n' "${XDG_DATA_HOME:-$HOME}"
printf 'Choose Salone Register from the Applications menu to start it.\n'