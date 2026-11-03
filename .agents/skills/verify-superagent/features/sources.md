# Sources

## Sub-features

- One card per Source (GitHub, Feishu, DingTalk, Jira, GitLab): installed, enabled, and its live `state`.
- Per-component health rows within a Source: the listener itself, and `history` (message recovery).
- The policy-candidate list a Source publishes — whom it would serve before a person writes a Policy.
- The link into that Source's settings block (`settings › source:<id>`).
- Refreshing labels (`POST sources/:id/labels`) for Sources that own a label set.

## How to get to it (user POV)

The **来源 / Source** tab. A failing Source also appears from the overview's problem strip and from the setup card when
its credentials are missing.

## Driving it with the HTTP API and playwright-cli

```bash
.agents/skills/verify-superagent/verify.sh api sources | python3 -m json.tool
```

A Source is healthy when `state == 'ready'` and every `health[].state` is `ready`; `error` is a lasting failure a
restart does not fix, and the `detail` is the user-facing reason. On a conforming live host:

```bash
.agents/skills/verify-superagent/verify.sh api sources | python3 -c "
import json,sys
for s in json.load(sys.stdin):
    print(s['id'], s['enabled'], s['state'], [(h['name'], h['state']) for h in s.get('health') or []])"
```

Rendered side, on the preview panel:

```bash
playwright-cli --raw eval "sessionStorage.setItem('dsh-superagent/route', JSON.stringify({route:{page:'source'},stack:[],group:'source'}))"
playwright-cli reload
playwright-cli --raw eval "document.body.innerText"
```

The fixture ships a Feishu Source in `socket closed`, so the page must render a failing Source with its detail — that is
the observable end state a healthy page would never show.

## Gotchas

- `enabled: false` is normal for optional Sources (`feishu`, `jira`, `gitlab` are `disabled: true` in
  `cordis.patch.yml`). Do not report a disabled-but-installed Source as a defect.
- The DingTalk Source stays `paused` until the operator's account is set up; `paused` is a setup state, not an error.
- `POST sources/:id/labels` mutates; preview panel only.
- Source ids are the plugin ids (`dsh-superagent-dingtalk` → `dingtalk`), so a settings block is
  `source:dingtalk`; a mismatch there 404s as "Source not found".
