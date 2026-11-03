# Tickets

## Sub-features

- The board, filtered by `open` (default), `person`, `working`, `idle`, `ended`.
- Per row: title, the stage and action that say what it waits for, its Sources and threads, its commit/PR facts, how
  many assignments and inputs it took, and the last report's note.
- **Stop** (`POST tickets/:id/stop`), **Retry** (`POST tickets/:id/retry`), **Open Session** (jumps to the Executor
  Session in the DSH workspace).
- Ticket detail: the decision that opened it, its assignments and their reports, its inputs, the threads it reaches,
  and, after a person answers, the answer trigger.
- The `person/held` stage for a whole-ticket hold, and the `person/review` chain (awaiting review, returned by review).

## How to get to it (user POV)

The **执行 / Execution** tab, or a ticket line on the overview.

## Driving it with the HTTP API and playwright-cli

The board, live:

```bash
.agents/skills/verify-superagent/verify.sh api 'tickets?state=open&limit=20' | python3 -c "
import json,sys
d=json.load(sys.stdin); print('open:', d['total'], 'next:', d.get('next_offset'))
for t in d['items']: print(t['stage'], t['action'], t['title'][:48])"
```

One ticket whole:

```bash
.agents/skills/verify-superagent/verify.sh api "tickets/<id>" | python3 -m json.tool
```

Assert the stage vocabulary: only the values in `docs/003-execution.md` appear (`person/{delivery,answer,returned,review,
blocked,failed,held}`, `working`, `working/queued`, `idle`, and the ended states), and `actions.stop|retry` match what
the stage allows.

Rendered side, preview panel:

```bash
playwright-cli --raw eval "sessionStorage.setItem('dsh-superagent/route', JSON.stringify({route:{page:'execution',query:{filter:'open'}},stack:[],group:'source'}))"
playwright-cli reload
playwright-cli --raw eval "document.body.innerText"
```

The fixture's open board has a `person/answer` ticket with a **去飞书回答** link and a **停止** button, and a
`person/failed` ticket with **重试** and **打开 Session**; each label appearing on the page is the proof that the stage
maps to the right actions. Clicking **停止** or **重试** updates the fixture's memory; reload resets it.

## Gotchas

- `open` is a *filter over states*, not a state; `person` is the whole person family including `person/held`.
- `stage` and `action` are separate fields: a page that shows only `person` hides whether the person must answer, retry,
  or is merely waiting for a review.
- `POST tickets/:id/stop` stops real work. On the operator's instance it is not a verification step; use the preview
  panel or an instance you started.
- A ticket whose worker Session no longer exists still renders `idle`; **Open Session** then fails in the DSH workspace.
  That is expected, not a panel defect.
