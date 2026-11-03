#!/bin/sh
# Production log lookup for a worker investigating a question a person asked on
# DingTalk or Jira: "does production have this bug", "what did the error say",
# "can you reproduce it".
#
# It reads the operator's Grafana credentials from the local env file the
# repository documents, queries the 4.0 production Loki source and prints the
# matching lines. Credentials never leave this process: they are not printed, not
# written into the ticket, and not passed to any other command.
#
# Usage:
#   prod-logs.sh search '<logql>' [minutes]   raw lines, newest first
#   prod-logs.sh count  '<logql>' [minutes]   how many lines match
#   prod-logs.sh groups '<logql>' [minutes]   error events grouped by shape
#
# Examples:
#   prod-logs.sh search '{namespace="zk-ai-application", app="lxs-v2"} |= "Traceback"' 30
#   prod-logs.sh count  '{namespace="zk-ai-application"} |~ "500"' 1440
#   prod-logs.sh groups '{namespace="zk-ai-application"} |~ "(?i)error"' 360
#
# Namespaces: zk-ai-application is the business layer that serves users;
# zk-ai-prod is the data layer, which also holds an old business copy — a quiet
# lxs there is normal and not an outage. Never conclude a service is down from
# the data-layer namespace alone.
set -eu

ENV_FILE=${GRAFANA_ENV_FILE:-${DSH_SUPERAGENT_GRAFANA_ENV:-$HOME/Documents/work/sql-tools/playwright.env}}
GRAFANA=${GRAFANA_URL:-https://prod-logging.hsjdata.com}
# The 4.0 production Loki source. The default "日志查询 - 产品/项目" datasource holds
# only the retired zhike3-prod stream, so querying it returns nothing useful.
DATASOURCE=${GRAFANA_DATASOURCE:-f8cbadad-92f6-479c-9f86-e573ac254672}

mode=${1:-search}
query=${2:-}
minutes=${3:-60}

if [ -z "$query" ]; then
  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi
if [ ! -r "$ENV_FILE" ]; then
  echo "no readable Grafana credential file at $ENV_FILE"
  echo "Set GRAFANA_ENV_FILE (or DSH_SUPERAGENT_GRAFANA_ENV) to the file holding user=/password= for the internal Grafana, then retry."
  exit 1
fi

user=$(sed -n 's/^user=//p' "$ENV_FILE" | head -1)
pass=$(sed -n 's/^password=//p' "$ENV_FILE" | head -1)
if [ -z "$user" ] || [ -z "$pass" ]; then
  echo "the Grafana credential file has no user/password pair"
  exit 1
fi

# The internal Grafana is not reachable through the operator's proxy, and it
# redirects, so both must be handled for the query to reach Loki.
loki() { curl -s -m 60 --noproxy '*' -u "$user:$pass" -L -G "$@"; }

end=$(( $(date +%s) ))
# Minutes rather than hours: a live investigation looks at the last twenty minutes,
# and POSIX shell arithmetic has no fractions.
start=$(( end - minutes * 60 ))

case "$mode" in
  count)
    out=$(loki "$GRAFANA/api/datasources/proxy/uid/$DATASOURCE/loki/api/v1/query" \
      --data-urlencode "query=sum(count_over_time($query [${minutes}m]))" 2>&1) || {
      echo "the Loki query failed"; printf '%s\n' "$out" | head -5; exit 1; }
    printf '%s' "$out" | jq -r '.data.result[0].value[1] // "0"' 2>/dev/null ||
      { echo "unexpected answer from Loki:"; printf '%s\n' "$out" | head -c 500; exit 1; }
    ;;
  groups)
    out=$(loki "$GRAFANA/api/datasources/proxy/uid/$DATASOURCE/loki/api/v1/query_range" \
      --data-urlencode "query=$query" --data-urlencode "limit=2000" \
      --data-urlencode "start=$(( start * 1000000000 ))" --data-urlencode "end=$(( end * 1000000000 ))" 2>&1) || {
      echo "the Loki query failed"; printf '%s\n' "$out" | head -5; exit 1; }
    # Group lines by their leading shape: timestamps, ids and numbers replaced, so
    # a thousand identical failures read as one row with a count.
    printf '%s' "$out" | jq -r '.data.result[]?.values[]?[1]' 2>/dev/null |
      sed -E 's/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/<uuid>/g; s/\b[0-9]+\b/<n>/g' |
      cut -c1-220 | sort | uniq -c | sort -rn | head -30
    ;;
  search)
    out=$(loki "$GRAFANA/api/datasources/proxy/uid/$DATASOURCE/loki/api/v1/query_range" \
      --data-urlencode "query=$query" --data-urlencode "limit=50" --data-urlencode "direction=backward" \
      --data-urlencode "start=$(( start * 1000000000 ))" --data-urlencode "end=$(( end * 1000000000 ))" 2>&1) || {
      echo "the Loki query failed"; printf '%s\n' "$out" | head -5; exit 1; }
    printf '%s' "$out" | jq -r '
      .data.result[]? as $s
      | $s.values[]?
      | "\(.[0]) \($s.stream.namespace // "-")/\($s.stream.app // "-")/\($s.stream.container // "-") \(.[1])"
    ' 2>/dev/null | head -50
    ;;
  *)
    echo "unknown mode $mode: use search, count or groups"
    exit 2
    ;;
esac
