# Decisions

## Sub-features

- The decision list, filtered by `work` (accept/reopen), `stop`, `ignore`, `unavailable`, or `all`, newest first.
- A 24-hour window (`window=24h`) for "what did the agent decide today".
- Per decision: its kind and outcome, the triggers it answered, the reason codes with their values, the strength
  (explicit / inferred), and the ticket it opened when it accepted.
- Dismissing a decision (`POST decisions/:id/dismiss`) — the panel's way of clearing an `unavailable` the operator
  accepts as lost work.

## How to get to it (user POV)

The **评估 / Eval** tab. A ticket's detail shows the decision that opened it; a thread detail shows the decisions made
on that lane.

## Driving it with the HTTP API and playwright-cli

```bash
.agents/skills/verify-superagent/verify.sh api 'decisions?limit=10' | python3 -c "
import json,sys
for d in json.load(sys.stdin)['items']:
    print(d['list'][:19], d['kind'], [r['code'] for r in d['reason']], len(d.get('triggerIds') or []))" 2>/dev/null \
 || .agents/skills/verify-superagent/verify.sh api 'decisions?limit=10' | python3 -m json.tool
```

The second form is the safe one; the first assumes the row shape and is only there to make the fields obvious. Assert
the field set from `DecisionListView` in `src/app/views/threads.ts`, not from memory.

The `ignore` reason code is the interesting one for the lane work: a lane that read a message and left it with its
ticket records `ignore` with a `said` reason citing the ticket it is `delivered_to`. On a live host after the lane
change, `decisions?kind=ignore` should show messages that are *not* in `not_a_member` — a `not_a_member` reason is the
Policy gate refusing the sender, an unrelated thing.

Rendered side, preview panel:

```bash
playwright-cli --raw eval "sessionStorage.setItem('dsh-superagent/route', JSON.stringify({route:{page:'eval',query:{filter:'all'}},stack:[],group:'source'}))"
playwright-cli reload
playwright-cli --raw eval "document.body.innerText"
```

The fixture includes one `unavailable` decision (`timeout`) whose dismiss only works for id `u1`; `POST decisions/:id/dismiss`
on any other id is a 404 by design, and that is worth asserting — a panel that treats every dismiss as success hides the
lost work.

## Gotchas

- `GET policy/history` currently answers **500 with a JSON parse error** on a live host. That is a real defect in the
  running build; the eval page does not call it, the settings page does.
- Decisions are append-only in the domain but `dismiss` writes a flag; dismissing an `unavailable` does not rerun the
  trigger. Requeue from the thread detail is the rerun path.
- `window=24h` uses the server's clock, not the browser's.
