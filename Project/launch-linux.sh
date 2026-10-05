#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_URL="http://127.0.0.1:4173"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
APP_DATA_DIR="$DATA_HOME/salone-register"
APP_STATE_DIR="$STATE_HOME/salone-register"
LOG_FILE="$APP_STATE_DIR/server.log"
PID_FILE="$APP_STATE_DIR/server.pid"

if [[ "${1:-}" == "--stop" ]]; then
	if [[ -f "$PID_FILE" ]]; then
		server_pid="$(<"$PID_FILE")"
		if kill -0 "$server_pid" 2>/dev/null; then
			kill "$server_pid"
			printf 'Salone Register server stopped.\n'
		else
			printf 'No running Salone Register server found.\n'
		fi
		rm -f "$PID_FILE"
	else
		printf 'No launcher-managed server found.\n'
	fi
	exit 0
fi

if ! command -v node >/dev/null 2>&1; then
	printf 'Node.js 24 or later is required. Install it, then run this launcher again.\n' >&2
	exit 1
fi

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 24 )); then
	printf 'Node.js 24 or later is required; found Node.js %s.\n' "$(node --version)" >&2
	exit 1
fi

if ! command -v curl >/dev/null 2>&1 || ! command -v xdg-open >/dev/null 2>&1; then
	printf 'Install curl and xdg-utils to use the Linux desktop launcher.\n' >&2
	exit 1
fi

if curl --silent --fail "$APP_URL/api/setup-status" >/dev/null 2>&1; then
	xdg-open "$APP_URL" >/dev/null 2>&1 &
	exit 0
fi

mkdir -p "$APP_DATA_DIR" "$APP_STATE_DIR"
SALONE_DB_PATH="$APP_DATA_DIR/salone.sqlite" HOST=127.0.0.1 PORT=4173 nohup node "$APP_DIR/server.mjs" >>"$LOG_FILE" 2>&1 </dev/null &
server_pid=$!
printf '%s\n' "$server_pid" >"$PID_FILE"

APP_URL="$APP_URL" node --input-type=module -e '
const url = `${process.env.APP_URL}/api/setup-status`;
for (let attempt = 0; attempt < 40; attempt++) {
  try {
    const response = await fetch(url);
    if (response.ok) process.exit(0);
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 250));
}
process.exit(1);
' || {
	rm -f "$PID_FILE"
	printf 'Salone Register did not start. See %s for details.\n' "$LOG_FILE" >&2
	exit 1
}

xdg-open "$APP_URL" >/dev/null 2>&1 &