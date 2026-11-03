# Settings and prompts

## Sub-features

- Five settings groups: **Source** (per-Source credentials and options), **Eval** (how Evals are formed), **Execution**
  (review rounds, executor limits), **Prompts** (the prompt revision every role reads, with built-in parts and overrides),
  **Deployment** (the deployment record: accounts, state dir, limits).
- Every block carries the `revision` it was read at; saving sends that revision and a stale one is a **409**, not a
  silent overwrite.
- Source instances have their own blocks (`source:<id>`); an unknown one 404s.
- Prompt edits compose from built-in parts by key (`base`), so an override records what it edited and `defaultChanged`
  says when the built-in text moved under it.
- A prompt save and a settings save both push their result into the main Session's context after the commit
  (`context_delivery: injected | pending`).

## How to get to it (user POV)

The **设置 / Settings** tab, or the setup card on the overview when `setup.problems` is non-empty. A Source card links
into `settings › source:<id>`.

## Driving it with the HTTP API and playwright-cli

Read every block, live (read-only; no writes on the operator's instance):

```bash
.agents/skills/verify-superagent/verify.sh api settings | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('policy version:', d['policyVersion'])
print('blocks:', d['blocks'])
print('sources:', [s.get('id') for s in d['sources']])"
```

The revision contract is the one thing worth proving by write, and it must be proved on the preview panel or an
instance you started:

```bash
# 1. read the current revision of the eval block
rev=$(...)
# 2. save with a revision one behind -> expect 409
curl -s -o /dev/null -w '%{http_code}\n' --noproxy '*' -X PUT \
  -H 'x-orchestrator-request: 1' -H 'content-type: application/json' \
  --data '{"value":{...},"revision":'$((rev-1))'}' "http://127.0.0.1:$PORT/orchestrator/api/settings/eval"
# expect 409
# 3. save with the current revision -> expect 200 and revision+1
```

Prompts side: `GET prompts` returns `current`, `defaults`, `sections`, `builtin` keys, `parts` (each with `key`, text and
`base`) and history. `PUT prompts` takes `{config, baseRevision}`; a stale `baseRevision` is a 409 like settings.
`POST prompts/preview` composes without saving.

Rendered side, preview panel:

```bash
playwright-cli --raw eval "sessionStorage.setItem('dsh-superagent/route', JSON.stringify({route:{page:'settings',query:{group:'execution'}},stack:[],group:'execution'}))"
playwright-cli reload
playwright-cli --raw eval "document.body.innerText"
```

Five groups are five different query values; a group that renders an empty page is a routing gap, not a missing block.

## Gotchas

- `PUT settings/:block` and `PUT prompts` mutate the live instance. Preview panel only.
- `POST setup/check` reports `{ restarting: true }` and the next checks run after a restart; it is not a synchronous
  validation.
- `GET policy/history` answers **500** on the current live build (`Unexpected non-whitespace character after JSON`).
  Report it; do not treat it as a blocker for the rest of the page.
- The deployment group is read from `SETUP_FIELDS`; a field it shows but the Source does not accept is a real mismatch
  between `src/deployment.ts` and the Source plugin's config schema — worth flagging.
