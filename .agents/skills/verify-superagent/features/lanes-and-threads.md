# Lanes and threads

## Sub-features

- The thread list, filtered by `subscribed` (default), `evaluating`, `recent` or `all`, newest activity first.
- Per row: the lane key, its Source, its label (a chat name, an Issue number, a topic), the tickets that reach it, and
  the latest message with its actor.
- The thread detail: the messages, the triggers taken from them, the Decisions made on them, whether an Eval runs now
  and whether polling failed.
- Unsubscribing a thread stops the agent reading it (`POST threads/:key/unsubscribe`).
- Requeuing one trigger from the detail (`POST triggers/:id/requeue`).

This is the page that shows the lane design of `docs/009-lanes-and-conflicts.md`: **one thread per conversation**,
whatever its Source.

## How to get to it (user POV)

The **触发 / Trigger** tab. A ticket's detail links back to the threads it came from.

## Driving it with the HTTP API and playwright-cli

The lane-shape check, on the live host — this is the one assertion unit tests cannot make about a real database:

```bash
.agents/skills/verify-superagent/verify.sh api 'threads?filter=recent&limit=50' | python3 -c "
import json,sys
items=json.load(sys.stdin)['items']
sliced=[t['key'] for t in items if t['source']=='dingtalk' and t['key'].count(':')>1]
print('threads:', len(items))
print('dingtalk lanes:', len([t for t in items if t['source']=='dingtalk']))
print('sliced keys (schema-12 regression):', sliced or 'none')"
```

`KeyError`/empty output means the filter names changed (`THREAD_FILTERS` in `src/app/api.ts`).

One lane in detail:

```bash
key=$(... the key from the list above ...)
.agents/skills/verify-superagent/verify.sh api "threads/$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$key")?limit=30" | python3 -m json.tool
```

Assert the history window the ruling fixed: at least 30 messages when the conversation has them, extended back to the
oldest open ticket's origin trigger, never past 100, and `around`/`before` paging works.

Rendered side, preview panel (`feishu:oc_1:om_root`, one ticket, one message):

```bash
playwright-cli --raw eval "sessionStorage.setItem('dsh-superagent/route', JSON.stringify({route:{page:'trigger',query:{filter:'all'}},stack:[],group:'source'}))"
playwright-cli reload
playwright-cli --raw eval "document.body.innerText"
```

## Gotchas

- A lane is a **Thread that carries people**; a GitHub Issue is one, a Feishu topic is one, a DingTalk conversation is
  one. A slice key `dingtalk:<conv>:<root>` after the schema-12 upgrade means `mergeConversationThreads` did not run.
- The `lanes` / `lane/<key>` **tool** resources are for the main Session's `orchestrator_read`, not HTTP routes —
  `GET /orchestrator/api/lanes` 404s by design. Use `GET /api/threads` for the same view.
- The default filter is `subscribed`: a lane with activity but no open ticket will not appear until you pass
  `filter=recent` or `all`.
- `POST threads/:key/unsubscribe` and `POST triggers/:id/requeue` mutate. Preview panel, or an instance you started.
