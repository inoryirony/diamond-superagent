# Overview

## Sub-features

- The board summary: **needs you**, **in progress**, **just finished**, each a count you can click into.
- The "needs you" list: each open ticket with the reason it waits (`person/answer`, `person/returned`, `person/blocked`,
  `person/failed`, `person/delivery`, `person/held`), its Source and a one-line note, plus the action that unblocks it.
- The executor strip: running / queued / max workers, and the pause switch.
- The system-problem strip: setup problems and any Source in `error`.
- The funnel: received → filtered → triggers → judged → accepted, with the Policy version that judged them.
- The "engine views" disclosure: links into the term glossary and the raw views.

## How to get to it (user POV)

It is the landing page (`route.page === 'overview'`). From any other page, the **概览 / Overview** tab.

## Driving it with the HTTP API and playwright-cli

Authority first — the same numbers the page renders:

```bash
.agents/skills/verify-superagent/verify.sh api overview | python3 -m json.tool
```

`person`, `working`, `ended` and `problems` are all **lists**, and only `needsYou` is a number — the overview view
returns the rows, not count fields, for the other three. What to assert:

- `needsYou == len(person)` — the one count that is derived from a list.
- `problems` is a list; non-empty means setup or a Source is broken, and each entry carries `kind` and, for
  `source-error`/`runtime-error`, the `detail`.
- `flow.accepted <= flow.judged <= flow.triggers <= flow.received` — the funnel is monotonic.
- `executor.running + executor.queued <= executor.maxWorkers` when `maxWorkers > 0`.
- `len(ended) <= 10` (`ENDED_SHOWN`), newest first — the page shows the last day's finished work, not all of it.

Then the rendering, on the preview panel (fake data, deterministic) :

```bash
.agents/skills/verify-superagent/verify.sh demo-start
playwright-cli open 'http://127.0.0.1:3083/'
playwright-cli --raw eval "sessionStorage.setItem('dsh-superagent/route', JSON.stringify({route:{page:'overview'},stack:[],group:'source'}))"
playwright-cli reload
playwright-cli --raw eval "document.body.innerText"
```

The fixture defines two tickets needing a person (one `person/answer` with a **去飞书回答** link and a **停止** button,
one `person/failed` with a **重试** and **打开 Session**), one working, one ended. The rendered text must name every one
of those labels; a page that renders only headers means the route table or a component regressed.

## Gotchas

- The fixture's numbers are fixed; a live host's are not. Assert *relations* on the live host, exact strings only on the
  fixture.
- `person` here is the stage family, not the `person` action: `person/held` (a whole-ticket hold) counts under "needs
  you" too, and its note is the hold's question.
- The pause button (`POST executor/pause`) writes to the live instance. Exercise it on the preview panel only.
- A live host in `setupPending` still renders the overview, but with `problems` non-empty and no executor numbers —
  "renders" is not "works".
