#!/bin/sh
# Helper for the verify-superagent skill. Read-only against the operator's running app; the only thing it starts is the
# preview panel, and `demo-stop` kills exactly the pid it recorded.
set -u

DEMO_PORT=3083
PIDFILE=/tmp/dsh-demo-vite.pid
LOG=/tmp/dsh-demo-vite.log

# Print the loopback port of the running DSH app, or nothing. The app process is `DeepSeek Harness`; `lsof` is the only
# reliable way to find it, since it also schedules a DSH runtime for other profiles on other ports.
live_port() {
  lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null \
    | grep -i 'DeepSeek' \
    | sed -nE 's/.*127\.0\.0\.1:([0-9]+) .*/\1/p' \
    | head -1
}

# Fetch a management route. `--noproxy '*'` because a local Clash proxy answers 127.0.0.1 otherwise; the header is the
# same-origin guard in src/app/http.ts.
api() {
  port=$(live_port)
  [ -n "$port" ] || { echo "no running DSH app found" >&2; return 1; }
  path=$1
  case $path in
    /orchestrator/api/*) ;;
    *) path=/orchestrator/api/$path ;;
  esac
  curl -sS --noproxy '*' -m 15 -H 'x-orchestrator-request: 1' "http://127.0.0.1:$port$path"
}

# One JSON field out of a management route without pulling in jq.
field() {
  python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"
}

doctor() {
  status=0
  say() { printf '%-28s %s\n' "$1" "$2"; }

  port=$(live_port)
  if [ -z "$port" ]; then
    say "live host" "SKIP (no DeepSeek Harness listener; live half unverifiable)"
  else
    say "live host" "port $port"

    state=$(api state 2>/dev/null) || true
    if [ -z "$state" ]; then
      say "GET /api/state" "FAIL (no answer on 127.0.0.1:$port — wrong profile, or proxy: use --noproxy)"
      status=1
    else
      say "GET /api/state" "ok"
      runtime=$(printf '%s' "$state" | field "d.get('health',{}).get('runtime',{}).get('state')" 2>/dev/null) || runtime=
      case $runtime in
        ready|paused) say "runtime" "$runtime" ;;
        *) say "runtime" "FAIL (state=${runtime:-missing})"; status=1 ;;
      esac

      problems=$(printf '%s' "$state" | field "len(d.get('setup',{}).get('problems') or [])" 2>/dev/null) || problems='?'
      if [ "$problems" = "0" ]; then
        say "setup problems" "none"
      else
        say "setup problems" "FAIL ($problems) — panel works, tickets cannot run"
        printf '%s' "$state" | python3 -c "
import json,sys
for p in (json.load(sys.stdin).get('setup') or {}).get('problems') or []:
    print('  ', p.get('place'), '—', (p.get('detail') or '')[:160])
" 2>/dev/null
        status=1
      fi

      errors=$(printf '%s' "$state" | python3 -c "
import json,sys
h=json.load(sys.stdin).get('health') or {}
for name,entry in sorted(h.items()):
    if (entry or {}).get('state')=='error':
        print(name, '—', (entry.get('detail') or '')[:160])
" 2>/dev/null) || errors=
      if [ -z "$errors" ]; then
        say "component errors" "none"
      else
        say "component errors" "FAIL"
        printf '%s\n' "$errors" | sed 's/^/  /'
        status=1
      fi
    fi
  fi

  demo=$(curl -s --noproxy '*' -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$DEMO_PORT/" 2>/dev/null || true)
  if [ "$demo" = "200" ]; then
    say "preview panel" "ok on :$DEMO_PORT"
  else
    say "preview panel" "not running (start with: verify.sh demo-start)"
  fi

  printf '\nexit %s\n' "$status"
  return $status
}

# Find the pid actually listening on :3083. `pnpm exec vite` is a wrapper: killing it leaves the node child holding the
# port, so the helper records and kills the listener, not the wrapper.
demo_pid() {
  lsof -nP -iTCP:"$DEMO_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1
}

demo_start() {
  existing=$(demo_pid)
  if [ -n "$existing" ]; then
    echo "preview panel already running on :$DEMO_PORT (pid $existing)"
    echo "$existing" >"$PIDFILE"
    return 0
  fi
  # Detached on purpose: a plain `cmd &` inside a one-shot shell dies with that shell. `nohup … </dev/null` keeps the
  # listener alive after the starting command returns; macOS has no setsid, so do not reach for it.
  ( cd "$(dirname "$0")/../../.." && nohup pnpm exec vite --config demo/vite.config.ts >"$LOG" 2>&1 </dev/null & )
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    pid=$(demo_pid)
    if [ -n "$pid" ]; then
      echo "$pid" >"$PIDFILE"
      echo "preview panel ready on http://127.0.0.1:$DEMO_PORT/ (pid $pid)"
      return 0
    fi
  done
  echo "preview panel did not answer in 10s; read $LOG" >&2
  tail -20 "$LOG" >&2 2>/dev/null
  return 1
}

demo_stop() {
  pid=$(demo_pid)
  if [ -z "$pid" ] && [ -f "$PIDFILE" ]; then pid=$(cat "$PIDFILE"); fi
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" && echo "stopped preview panel (pid $pid)"
    for _ in 1 2 3 4 5; do sleep 1; [ -z "$(demo_pid)" ] && break; done
    [ -n "$(demo_pid)" ] && { echo "port :$DEMO_PORT still held by $(demo_pid); stopping it too"; kill "$(demo_pid)" 2>/dev/null; }
  else
    echo "no preview panel on :$DEMO_PORT; nothing to stop"
  fi
  rm -f "$PIDFILE"
}

evidence() {
  root=$(cd "$(dirname "$0")/../../.." && pwd)
  dir="$root/.artifacts/verification/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$dir"
  echo "$dir"
}

case ${1:-} in
  doctor) shift; doctor ;;
  port) live_port ;;
  api) shift; [ $# -ge 1 ] || { echo "usage: verify.sh api <route>" >&2; exit 2; }; api "$@" ;;
  demo-start) demo_start ;;
  demo-stop) demo_stop ;;
  evidence) evidence ;;
  *) cat <<'EOF' >&2
usage: verify.sh <command>
  doctor        check the live host and the preview panel; exits non-zero on failure
  port          print the live management port, or nothing
  api <route>   authenticated GET, e.g. `api state` or `api /orchestrator/api/tickets?state=open`
  demo-start    start the preview panel on :3083, recording its pid
  demo-stop     stop only the panel this helper started
  evidence      create .artifacts/verification/<stamp>/ and print it
EOF
    exit 2 ;;
esac
