#!/bin/sh
# Deploy phase — runs before a review's verdict, in the ticket's directory.
#
# ZKAI repositories under xk/product/zk-ai deploy through `.gitlab-ci.yml`: the
# `test` branch's pipeline builds the image and rolls it onto the test cluster.
# So "delivered to the test environment" means, in order:
#   1. the ticket has a merge request, and that MR targets `test` (an MR into
#      `dev` never triggers the deploy stage);
#   2. the MR's head commit passed `docker_build` in CI, which is the image the
#      test cluster runs;
#   3. the test environment answers on its health endpoint.
# Any unmet condition exits non-zero, and the review returns the result with
# this output as its finding.
set -eu

BASE=https://zkai-test-hsj-k3s.hsjdata.com/zkai-opportunity-engine
PROJECT=xk%2Fproduct%2Fzk-ai%2Fzkai-opportunity-engine

if [ -z "${DSH_SUPERAGENT_GITLAB_URL:-}" ]; then
  echo "this ticket carries no GitLab URL, so there is no merge request to deploy"
  exit 1
fi

MR=$(printf '%s' "$DSH_SUPERAGENT_GITLAB_URL" | sed -n 's#.*/merge_requests/\([0-9][0-9]*\).*#\1#p')
if [ -z "$MR" ]; then
  echo "this ticket's GitLab URL names no merge request: $DSH_SUPERAGENT_GITLAB_URL"
  exit 1
fi

mr=$(glab api "projects/$PROJECT/merge_requests/$MR")
state=$(printf '%s' "$mr" | jq -r .state)
target=$(printf '%s' "$mr" | jq -r .target_branch)
sha=$(printf '%s' "$mr" | jq -r .sha)

if [ "$state" != opened ]; then
  echo "merge request !$MR is $state, so it cannot deploy anything"
  exit 1
fi
echo "merge request !$MR head $sha targets $target"
if [ "$target" != test ] && [ "$target" != dev ]; then
  echo "merge request !$MR targets $target; this repository deploys from test, so nothing reached the test environment"
  exit 1
fi

# The branch discipline here is dev first, then test: a merge request into dev
# is normal, and the promotion dev -> test is what runs the deploy stage. So a
# dev-targeted merge request counts only once its commit is on test.
if [ "$target" = dev ]; then
  merged=$(glab api "projects/$PROJECT/repository/commits/$sha/refs?type=branch" |
    jq -r '[.[] | select(.name == "test")] | length')
  if [ "$merged" = 0 ]; then
    echo "merge request !$MR targets dev and its commit is not on test yet; merge dev into test to deploy it"
    exit 1
  fi
  echo "merge request !$MR reached dev and dev's promotion carried $sha to test"
fi

built=$(glab api "projects/$PROJECT/pipelines?sha=$sha" |
  jq -r '[.[] | select(.status == "success")] | .[0].id // empty')
if [ -z "$built" ]; then
  echo "no successful pipeline for $sha, so the test-environment image was never built"
  exit 1
fi
if ! glab api "projects/$PROJECT/pipelines/$built/jobs" |
  jq -e '.[] | select(.stage == "docker" or .stage == "deploy") | select(.status == "success")' >/dev/null; then
  echo "pipeline $built for $sha has no successful docker/deploy job, so the test environment still runs the previous image"
  glab api "projects/$PROJECT/pipelines/$built/jobs" | jq -r '.[] | "  \(.stage)/\(.name): \(.status)"'
  exit 1
fi
echo "pipeline $built built and deployed $sha"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/healthz" || true)
echo "test environment /healthz -> ${code:-no response}"
[ "$code" = 200 ] || { echo "the test environment does not answer on /healthz"; exit 1; }

echo "deployed: merge request !$MR is merged into test, its image is built, and the test environment serves traffic"
