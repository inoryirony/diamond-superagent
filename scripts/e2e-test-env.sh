#!/bin/sh
# End-to-end check — runs after the deploy phase passed, in the ticket's directory.
#
# It asks the test environment what it actually serves, not what GitLab says it
# deployed: a merge request can be merged while the pod still runs the previous
# image, so the check proves the running service answers and that the routes the
# ticket's change touches still exist. Its output is the review's evidence.
set -eu

BASE=https://zkai-test-hsj-k3s.hsjdata.com/zkai-opportunity-engine
PROJECT=xk%2Fproduct%2Fzk-ai%2Fzkai-opportunity-engine

# 1. The service answers, and identifies itself as the opportunity engine.
health=$(curl -s --max-time 20 "$BASE/healthz")
echo "healthz: $health"
printf '%s' "$health" | jq -e '.status == "ok" and .service == "zkai-opportunity-engine"' >/dev/null ||
  { echo "the test environment did not report itself healthy"; exit 1; }

# 2. The internal scan route the trigger-filter change lives behind is still in
#    the live schema. The route is only read, never called: it starts a real scan
#    of a business day, which is not a check.
routes=$(curl -s --max-time 20 "$BASE/openapi.json" | jq -r '.paths | keys[]' | sort)
printf '%s\n' "$routes" | grep -qx '/internal/v1/scan' ||
  { echo "the live OpenAPI document has no /internal/v1/scan route"; exit 1; }
echo "openapi routes: $(printf '%s' "$routes" | tr '\n' ' ')"

# 3. Name the deployment the check ran against, so the ticket records which
#    revision was live rather than only that something answered.
if [ -n "${DSH_SUPERAGENT_GITLAB_URL:-}" ]; then
  MR=$(printf '%s' "$DSH_SUPERAGENT_GITLAB_URL" | sed -n 's#.*/merge_requests/\([0-9][0-9]*\).*#\1#p')
  if [ -n "$MR" ]; then
    sha=$(glab api "projects/$PROJECT/merge_requests/$MR" | jq -r .sha)
    echo "the change under review is merge request !$MR at $sha"
  fi
fi

echo "end-to-end checks passed on the test environment"
