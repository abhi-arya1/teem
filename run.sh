#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_DIR="$ROOT_DIR/.agentslack"
PID_DIR="$RUNTIME_DIR/pids"
LOG_DIR="$RUNTIME_DIR/logs"

mkdir -p "$PID_DIR" "$LOG_DIR"

is_running() {
  local pid_file="$1"
  [[ -f "$pid_file" ]] || return 1
  local pid
  pid="$(cat "$pid_file")"
  kill -0 "$pid" 2>/dev/null
}

start_proc() {
  local name="$1"
  shift
  local pid_file="$PID_DIR/$name.pid"

  if is_running "$pid_file"; then
    echo "$name already running (pid $(cat "$pid_file"))"
    return 0
  fi

  echo "Starting $name..."
  (
    cd "$ROOT_DIR"
    "$@" >"$LOG_DIR/$name.log" 2>&1
  ) &

  echo $! >"$pid_file"
  echo "$name started (pid $!)"
}

stop_proc() {
  local name="$1"
  local pid_file="$PID_DIR/$name.pid"

  if ! is_running "$pid_file"; then
    rm -f "$pid_file"
    echo "$name not running"
    return 0
  fi

  local pid
  pid="$(cat "$pid_file")"
  echo "Stopping $name (pid $pid)..."
  kill "$pid" 2>/dev/null || true
  rm -f "$pid_file"
}

status_proc() {
  local name="$1"
  local pid_file="$PID_DIR/$name.pid"

  if is_running "$pid_file"; then
    echo "$name: running (pid $(cat "$pid_file"))"
  else
    echo "$name: stopped"
  fi
}

case "${1:-}" in
  up)
    start_proc orchestrator bun run orchestrator
    sleep 1
    start_proc agent-runner bun run agent-runner
    start_proc ui bun run ui
    ;;
  headless)
    start_proc orchestrator bun run orchestrator
    sleep 1
    start_proc agent-runner bun run agent-runner
    ;;
  down)
    stop_proc ui
    stop_proc agent-runner
    stop_proc orchestrator
    ;;
  status)
    status_proc orchestrator
    status_proc agent-runner
    status_proc ui
    ;;
  logs|log|tail)
    name="${2:-orchestrator}"
    tail -n 200 -f "$LOG_DIR/$name.log"
    ;;
  *)
    cat <<USAGE
Usage:
  ./run.sh up        # start orchestrator + agent-runner + ui
  ./run.sh headless  # start orchestrator + agent-runner
  ./run.sh down      # stop all services
  ./run.sh status    # show service status
  ./run.sh logs [name] # tail logs (orchestrator|agent-runner|ui)
  ./run.sh log [name]  # alias for logs
  ./run.sh tail [name] # alias for logs
USAGE
    exit 1
    ;;
esac
