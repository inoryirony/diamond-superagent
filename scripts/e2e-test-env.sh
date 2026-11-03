#!/bin/sh
# End-to-end check — runs after the deploy phase passed, in the ticket's directory.
#
# What delivery means here: the change is live on the test environment and a person
# can actually use it. A passing HTTP probe proves a pod answers, not that the
# feature works, so this script does what a real user would do and fails when that
# is impossible.
#
# Set DSH_SUPERAGENT_E2E_URL to the page a user opens for this ticket (for the
# opportunity engine that is the H5 entry, not the service's own /healthz). The
# script opens it in a real browser, reads the rendered text and takes a
# screenshot. A person who could not open that page is the failure this catches.
# Usage: e2e-test-env.sh [page-url] [health-url]
# Both may instead come from DSH_SUPERAGENT_E2E_URL and DSH_SUPERAGENT_E2E_HEALTH_URL,
# or from the deploy and end-to-end commands the panel holds.
set -eu

E2E_URL=${1:-${DSH_SUPERAGENT_E2E_URL:-}}
HEALTH_URL=${2:-${DSH_SUPERAGENT_E2E_HEALTH_URL:-}}

if [ -z "$E2E_URL" ]; then
  echo "DSH_SUPERAGENT_E2E_URL names no page a user opens, so nothing can be checked the way a person would."
  echo "Set it in the ticket's execution environment to the page this ticket changes (the H5 entry, not a health endpoint)."
  exit 1
fi

# 1. The service behind the page is up. A user sees a broken page when this fails,
#    so it is a fact to report, not a substitute for opening the page.
if [ -n "$HEALTH_URL" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$HEALTH_URL" || true)
  echo "service health: $HEALTH_URL -> ${code:-no response}"
  [ "$code" = 200 ] || { echo "the service behind the page does not answer, so no user could use it"; exit 1; }
fi

if ! command -v playwright-cli >/dev/null 2>&1; then
  echo "playwright-cli is not installed here, so the page cannot be opened the way a user opens it."
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# 2. A real browser opens the page and its rendered text is read back. That is the
#    check curl cannot make: it proves the document rendered, its script ran, and
#    the screen is neither an error page nor an empty shell.
playwright-cli open "$E2E_URL" >"$work/open.log" 2>&1 || {
  echo "the browser could not open $E2E_URL"
  sed -n '1,40p' "$work/open.log"
  exit 1
}
sleep 3
playwright-cli --raw eval "document.title + '\n---\n' + document.body.innerText" >"$work/text.log" 2>&1 || true
shot="/tmp/dsh-e2e-$(date +%Y%m%d-%H%M%S).png"
playwright-cli --raw screenshot "$shot" >/dev/null 2>&1 || playwright-cli screenshot "$shot" >/dev/null 2>&1 || true
playwright-cli close >/dev/null 2>&1 || true

text=$(cat "$work/text.log" 2>/dev/null || echo '')
echo "page: $E2E_URL"
echo "rendered text (first 800 characters):"
printf '%s\n' "$text" | head -c 800
echo
[ -f "$shot" ] && echo "screenshot: $shot"

# 3. A page a user can use renders words. A blank shell, a JSON blob or a login
#    wall is not the feature, so it fails here rather than passing silently. The
#    threshold is low on purpose: a real login page renders a phone field and one
#    button, which is a handful of words, and a stricter count would fail working
#    pages. What it rules out is an empty document and a raw error payload.
words=$(printf '%s' "$text" | tr -cs '[:alnum:]' '\n' | grep -c . || true)
if [ "${words:-0}" -lt 5 ]; then
  echo "the page rendered almost no text (${words:-0} words), so it is a blank shell or an error page, not something a user can use"
  exit 1
fi
if printf '%s' "$text" | grep -qiE '"error"|"stack"|Internal Server Error|Cannot GET'; then
  echo "the page rendered an error, not the product"
  exit 1
fi

echo "end-to-end check passed: a browser opened the page a user opens, rendered $words words, and it is not an error page"
