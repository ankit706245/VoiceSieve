#!/bin/sh
# Vaani dashboard lifecycle helper (NOT a process manager: no restarts, no
# supervision). Keeps the Node server alive after the terminal closes via
# nohup (macOS has no setsid): nohup makes the server ignore SIGHUP, stdin
# is detached from the terminal, and output is appended to dashboard.log.
# A pidfile guard prevents double-start (EADDRINUSE).
# Usage: ./run-dashboard.sh {start|stop|status|logs}
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$ROOT/.dashboard.pid"
LOGFILE="$ROOT/dashboard.log"
PORT="${PORT:-8787}"

is_running() {
  [ -f "$PIDFILE" ] || return 1
  kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

case "${1:-status}" in
  start)
    if is_running; then
      echo "dashboard already running (pid $(cat "$PIDFILE")) on :$PORT"
      exit 0
    fi
    if curl -sf -o /dev/null "http://localhost:$PORT/api/health"; then
      echo "port $PORT already in use by another process; not starting a second copy"
      exit 1
    fi
    rm -f "$PIDFILE"
    cd "$ROOT" || exit 1
    # nohup = immune to SIGHUP (terminal close); </dev/null detaches stdin.
    # No setsid on macOS: plain background + nohup is sufficient here.
    nohup node server.js >>"$LOGFILE" 2>&1 < /dev/null &
    # Disown when the shell supports it so shell exit never signals the server.
    disown 2>/dev/null || true
    echo $! > "$PIDFILE"
    sleep 3
    if is_running && curl -sf -o /dev/null "http://localhost:$PORT/api/health"; then
      echo "dashboard started (pid $(cat "$PIDFILE")), log: $LOGFILE"
    else
      echo "start failed; last log lines:"
      tail -n 20 "$LOGFILE"
      exit 1
    fi
    ;;
  stop)
    if is_running; then
      kill "$(cat "$PIDFILE")" && rm -f "$PIDFILE" && echo "dashboard stopped"
    else
      rm -f "$PIDFILE"; echo "dashboard not running"
    fi
    ;;
  status)
    if is_running; then
      echo "dashboard running (pid $(cat "$PIDFILE"))"
      curl -sf -o /dev/null "http://localhost:$PORT/api/health" && echo "health: ok" || echo "health: UNREACHABLE"
    else
      echo "dashboard not running"
    fi
    ;;
  logs) tail -n "${2:-50}" "$LOGFILE" ;;
  *) echo "usage: $0 {start|stop|status|logs [n]}"; exit 2 ;;
esac
