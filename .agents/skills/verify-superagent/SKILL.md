---
name: verify-superagent
description: "Drive dsh-superagent the way a person does and prove the behaviour changed: the DSH panel (nine pages of a real host via the loopback management API) and the browser preview panel with its fake server. Use when a change touches src/core, src/app, src/sources, src/client, prompts/ or the lane/board work, and you need evidence from a running app rather than a passing unit test."
---

# Verify dsh-superagent

dsh-superagent is a **DSH bundle**: a Source watches GitHub/Feishu/DingTalk/Jira/GitLab, each conversation is a **lane**
(one Session), a Policy gates who may ask for what, an authorized request becomes a **Ticket**, and the Ticket runs in
its own Executor Session. Nothing about that is visible in `vitest` output. This skill drives the two surfaces a person
actually touches and captures proof for the rest.

The two surfaces:

| Surface | What it is | What it proves |
| --- | --- | --- |
| **Live host** (`:52320` or whatever the running app listens on) | The real `superagent` profile: real Sources, real SQLite at `~/.dsh/state/superagent/orchestrator.sqlite`, real Sessions | the runtime, the board and the Sources are healthy, real lanes and tickets exist, and the management API the panel reads answers correctly |
| **Preview panel** (`http://127.0.0.1:3083`) | `src/client` served by `demo/vite.config.ts`; `/orchestrator/api/*` answered by `tests/fixtures/panel-server.ts` | every page renders, states read correctly, and buttons map to the routes the panel calls — no credentials, deterministic |

Use both. The live host is the authority on "does the system work"; the preview panel is the authority on "can a person
see and act on it" without depending on what happens to be in the SQLite that day.

Neither surface is safely rewritable during verification: the live host is the operator's working instance, and the
preview panel resets from fixtures on Vite restart. **Verification is read-only** except for the preview panel's own
in-memory buttons, which you exercise on purpose and then discard by restarting Vite.

## Launch

### Live host (already running, usually)

The operator normally runs the app from `/Applications/DeepSeek Harness.app` under the `superagent` profile. Find its
port; it changes every restart:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -i 'DeepSeek' | awk '{print $9}' | sed 's/.*://' | sort -u
```

Every management route is `http://127.0.0.1:<port>/orchestrator/api/<route>` and requires the header
`x-orchestrator-request: 1` (the same-origin guard fails 403 without it). `curl --noproxy '*'` is mandatory on this
machine — a local Clash proxy intercepts 127.0.0.1 otherwise.

**Do not restart the operator's app to get a fresh instance.** If it is not running and you need a live instance you
started yourself, do it under a different profile so you do not touch `superagent`'s SQLite:

```bash
pnpm build
/Applications/DeepSeek\ Harness.app/Contents/Resources/runtime/cli/bin/dsh \
  --profile verify-superagent --no-open >>/tmp/verify-superagent.log 2>&1 &
rg -o 'http://127\.0\.0\.1:\d+/\?token=\S+' /tmp/verify-superagent.log | head -1
```

A new profile starts in `setupPending`: `setup.problems` names what is missing, the main Session is not created, and no
trigger is accepted. That is enough to prove the panel and the API read paths; it cannot prove ticket execution.

Cleanup: `kill` **the PID you started** (`$!`). Never `pkill -f dsh`; the operator's app is a `dsh` process too.

### Preview panel (started per run)

```bash
pnpm exec vite --config demo/vite.config.ts >/tmp/dsh-demo-vite.log 2>&1 &
echo $! > /tmp/dsh-demo-vite.pid
sleep 4
curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3083/   # expect 200
```

`strictPort: true` means a second run fails rather than silently serving 3084 — treat "port in use" as "one is already
running, reuse or stop it first", not as a reason to change the port.

Start it **detached**: a plain `cmd &` inside a tool call dies when that call returns. Use the harness's own background
mode for the server, or `nohup pnpm exec vite … >/tmp/dsh-demo-vite.log 2>&1 </dev/null &` together with a pid file.
(`setsid` does not exist on macOS; do not reach for it.)

Cleanup: `kill "$(cat /tmp/dsh-demo-vite.pid)"`. Vite keeps no state worth saving; every fixture edit is lost by design.

## Doctor

Run before driving anything, and again whenever a page looks wrong.

```bash
.agents/skills/verify-superagent/verify.sh doctor
```

It prints one line per check and exits non-zero when a check fails. What it asserts, and what each failure means:

| Check | Passing | Failing means |
| --- | --- | --- |
| live host found | a `DeepSeek Harness` listener exists | the app is not running; either start a `verify-*` profile or skip the live half |
| `/api/state` answers | HTTP 200 with `health.runtime.state == "ready"` | wrong port, wrong profile, or the runtime failed to start — read `/tmp/verify-superagent.log` or the DSH log |
| `setup.problems` | `[]` | the deployment is incomplete (`place: deployment` → Settings › deployment; `place: <source>` → that Source's card). The panel works, tickets do not |
| no component error | no `health.*.state == "error"` | a Source or an Executor component is broken and a restart will not fix it; report the `detail` |
| preview panel answers | HTTP 200 at `:3083` | not started, or `strictPort` collided |

A `503`/`Connection refused` from the API almost always means proxy: check `--noproxy '*'` before concluding the service
is down.

## Drive

### The management API is the panel's real interface

The React panel calls exactly the routes in `src/app/api.ts`; curl them and you are testing what the panel tests, minus
the rendering. Every call needs both headers:

```bash
api() { curl -s --noproxy '*' -m 10 -H 'x-orchestrator-request: 1' "http://127.0.0.1:$PORT$1"; }
PORT=$(lsof -nP -iTCP -sTCP:LISTEN | grep -i DeepSeek | sed -E 's/.*:([0-9]+) .*/\1/' | head -1)
api /orchestrator/api/state
api '/orchestrator/api/tickets?state=open&limit=5'
api '/orchestrator/api/threads?filter=recent&limit=3'
api '/orchestrator/api/decisions?limit=5'
api '/orchestrator/api/sources'
api /orchestrator/api/overview
api '/orchestrator/api/search?q=zkai'
```

The shapes are in `src/app/api.ts` (`Api`), and the live host is the ground truth for what they look like. Two
conventions that trip up readers:

- **`GET policy/history` can return a raw 500 with a JSON parse error.** That is a real defect, not your curl. Report it;
  do not retry.
- Routes taking `POST` mutate the live instance. `POST tickets/:id/retry`, `POST triggers/:id/requeue`,
  `POST decisions/:id/dismiss`, `POST executor/pause`, `PUT settings/:block`, `PUT prompts` are **out of scope** on the
  operator's instance. Use the preview panel for buttons.

### Preview panel: sessionStorage is the router

The panel has no hash routes (`#/execution` does nothing). It reads its location from
`sessionStorage['dsh-superagent/route']` on mount (`src/client/route.ts`). Drive it with playwright-cli:

```bash
playwright-cli open 'http://127.0.0.1:3083/'
playwright-cli --raw eval "sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'execution', query: { filter: 'open' } }, stack: [], group: 'source' }))"
playwright-cli reload
playwright-cli --raw eval "document.title + '\n---\n' + document.body.innerText"
```

Valid `page` values: `overview`, `source`, `trigger`, `eval`, `execution`, `settings` (with `query.group` one of
`source|eval|execution|prompts|deployment`). A ticket or thread detail is `{ page: 'execution', id: '<ticket-id>' }` or
`{ page: 'trigger', id: '<thread-key>' }`.

Prefer `innerText` over screenshots for the assertion and take the screenshot for the record; text is what an agent
reads and what the page really renders.

Buttons are reachable two ways. By text works when the label is unambiguous in the accessibility tree; otherwise drive
by DOM:

```bash
playwright-cli --raw eval "Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() == '暂停处理')?.click()"
```

### Live lanes in the running host

The lane work (docs/009) is only observable here. `orchestrator_read 'lanes'` and `orchestrator_read 'lane/<key>'` are
main-Session **tools**, so the HTTP API does not expose them; the nearest equivalent is `GET /api/threads`, whose keys are
lane keys (`dingtalk:<conversationId>`, `feishu:<chat>:<root>`, `github:…`):

```bash
api '/orchestrator/api/threads?filter=recent&limit=20' | python3 -c "
import json,sys; d=json.load(sys.stdin)
for t in d['items']: print(t['key'], t['source'], t['stage'], t.get('subscriptions'), (t.get('latest') or {}).get('at'))"
```

A conforming instance shows **one key per conversation** — no `dingtalk:<conv>:<root>` slices. A sliced key after a
schema-12 upgrade means the migration did not run; check `/api/state` for `health.runtime` and the SQLite's
`PRAGMA user_version`.

## Evidence

Put every artefact under `.artifacts/verification/<YYYYMMDD-HHMMSS>/` (git-ignored, survives teardown):

| File | How |
| --- | --- |
| `doctor.txt` | `.agents/skills/verify-superagent/verify.sh doctor` output, including the exit code |
| `<route>.json` | `api` output per route you asserted on, pretty-printed with `python3 -m json.tool` |
| `<page>.png` | `playwright-cli screenshot --filename <path> --full-page` — the path is the `--filename` value, not a positional selector |
| `<page>.txt` | the same page's `document.body.innerText`, saved — the assertion, not just the picture |
| `summary.md` | what you drove, what proved it, what you could not prove and why |

Proof standards for this repo:

- A **read** proves the system served it; a **write** proves the system acted. Say which one your evidence is.
- An assertion on `GET /api/overview` proves the panel's counts; an assertion on a rendered page proves the person sees
  those counts. When a change touches `src/client/**`, you need the rendered page.
- Never claim ticket execution works from a `setupPending` profile — there is no main Session to execute anything.
- A `board_seq` or a `lane` field in a card is only evidence if you read it from the running host, not from
  `tests/fixtures/panel-server.ts`.

## Cleanup

```bash
kill "$(cat /tmp/dsh-demo-vite.pid)" 2>/dev/null; rm -f /tmp/dsh-demo-vite.pid
playwright-cli close
```

Only if you started a live profile yourself: `kill $STARTED_PID` (the one `$!` printed). Never `pkill` by name. Do not
touch the operator's `superagent` app, its SQLite, or its Sessions.

Cleanup removes processes and scratch logs. It never removes `.artifacts/verification/` — after cleanup, re-`ls` that
directory and confirm the evidence is still there. A cleanup that eats the proof fails the run.

## Helpers

`verify.sh` (executable, next to this file):

```bash
.agents/skills/verify-superagent/verify.sh doctor        # every check, exits non-zero on failure
.agents/skills/verify-superagent/verify.sh port          # just prints the live port, or nothing
.agents/skills/verify-superagent/verify.sh api <route>   # authenticated GET against the live host
.agents/skills/verify-superagent/verify.sh demo-start    # start the preview panel, pid in /tmp
.agents/skills/verify-superagent/verify.sh demo-stop     # stop only the one it started
.agents/skills/verify-superagent/verify.sh evidence      # make .artifacts/verification/<stamp>/ and print the path
```
