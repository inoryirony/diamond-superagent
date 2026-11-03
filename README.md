# diamond-superagent

*Reimagining what a super agent can do for one person.*

A proactive agent for one person's actual work: it listens in the conversations where work is asked for, decides whether
a request is authorized, turns it into a ticket, executes the ticket in its own agent Session, and answers where the
question was asked. A panel shows what needs a person.

This repository is not a fresh design. It is the **merge of two earlier attempts**:

| Lineage | What it was | What diamond-superagent keeps from it |
| --- | --- | --- |
| [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | a Source → Eval → Ticket → Executor orchestrator, packaged as a DeepSeek Harness bundle | the domain model (Source, Thread, Ticket, Mandate, Assignment), the Policy gate, the review chain, the management panel, the Executor Sessions |
| [PROJECT D.I.A.M.O.N.D.](https://github.com/inoryirony/dws-chat-agent) — *DingTalk-Integrated Agent for Messaging, Orchestration & Networked Delegation* | an autonomous DingTalk front: watch an allowlist, answer direct messages, escalate implementation work to a coding agent, and stream a card that turns from "working on it" into the answer | the DingTalk Source as a first-class citizen — the operator's own account speaks, `dws` carries the history and the writes, a streaming card covers the wait, the sender's 花名（真名） is resolved from the company directory, and the operator's own messages are admitted |
| neither | the lane model below | one Session per conversation, the ticket board as the only channel between lanes, and a hold on contradictions |

The name is the D.I.A.M.O.N.D. lineage carried forward, not a marketing rename. The plugin keeps the package name
`dsh-superagent` and the profile keeps the name `superagent`, because profiles, `cordis.patch.yml` entries and the
`dsh-superagent-*` Source skills all reference those strings; renaming them would break every existing installation
without changing anything a person sees.

## Why merge them

Each solved half of the problem:

- **dsh-superagent** could gate, ticket, isolate and review work, but its DingTalk source was a thin adapter, and its
  single main Session read every conversation, so its context grew without bound and a question and the correction that
  contradicted it fell into different 10-minute slices.
- **D.I.A.M.O.N.D.** spoke perfect DingTalk — steering a live turn, streaming a card, resolving a sender, taking over
  from the operator — but had no policy, no ticket, no isolation and no review: the coding agent ran in the service's own
  process and answered unstructured text.

Merged, the DingTalk surface becomes the body and the ticket machinery becomes the skeleton: a **lane** is one
conversation, each lane has a Session that reads the whole conversation, and work that crosses a lane becomes a
**Ticket** on a shared board with a monotonic sequence number. A contradiction between two conversations is parked on the
Ticket as a **Hold**, never decided by the agent.

## How it works

Five stages, each a real boundary rather than a convention:

1. **A Source** turns raw traffic into a Trigger: a DingTalk direct message or group mention (via `dws`), a GitHub Issue
   comment, a Feishu message, a Jira ticket, a GitLab merge-request note. Every Source declares which Threads a Trigger
   belongs to.
2. **A lane** is one Thread that carries people — one conversation, one Issue, one topic. Each lane has a Session of its
   own that reads the whole conversation and assesses every message in it. Lanes never talk to each other; nothing
   crosses a lane boundary except through the board below.
3. **A Policy** decides who may ask for what, and in which mode (off, observe, auto). A request from someone the Policy
   does not cover never becomes work, and the Decision records why.
4. **A Ticket** is the work item: what was asked, what mandate the asker had, which Threads it answers in, and what it has
   been told since. All Tickets together are the *board* — the only channel between lanes, carrying a monotonic sequence
   number so that a lane committing a stale read is asked to look again instead of overwriting.
5. **An Executor Session** runs the Ticket in its own conversation and directory, and reports back when it is done,
   blocked, or needs a decision; that report is optionally reviewed (and, for a deployable change, verified on the test
   environment by the reviewer itself) before it becomes the Ticket's outcome. Waiting on a person is a normal end
   state, not a failure: the Ticket sits at `person/*` until they act.

Two things a person may have to settle are first-class: an **Attention** (one concrete question, in a structured form)
and a **Hold** (a contradiction between two conversations parked on the Ticket, with the options a release may pick and a
deadline after which it escalates). Neither a lane nor the System decides a contradiction; the system only keeps it
visible until someone does.

```text
DingTalk / GitHub / Feishu / Jira / GitLab
  -> Source (per-conversation Thread = one lane)
  -> Policy gate: who, what, which mode
  -> Ticket on the shared board (monotonic sequence)
  -> Executor Session in its own worktree
  -> Report -> [Review -> Verify] -> answer in the original conversation
```

The full domain model is [docs/001-domain.md](docs/001-domain.md); the stages in [docs/003-execution.md](docs/003-execution.md);
the lane and board design in [docs/009-lanes-and-conflicts.md](docs/009-lanes-and-conflicts.md); the module map in
[docs/007-architecture.md](docs/007-architecture.md).

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up diamond-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md)
is what it follows. DingTalk needs a working `dws` login as the operator; GitHub needs a dedicated agent account and its
own `gh`; Feishu, Jira and GitLab are optional.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source
- [009 Lanes and conflicts](docs/009-lanes-and-conflicts.md): one Session per conversation, the ticket board as the only channel between them, and holds on contradictory directions

## Development

`pnpm check` runs the typecheck, the tests and the build.

A unit test cannot show that a lane, a board or a Source actually behaves, so there is a verification skill that drives
the running app the way a person does. It reads the loopback management API (`/orchestrator/api/*`) of a running
`superagent` profile, and drives the browser preview panel — `src/client` served with the fixture server of
`tests/fixtures/panel-server.ts`:

```bash
.agents/skills/verify-superagent/verify.sh doctor     # is the live host healthy, is the preview panel up
.agents/skills/verify-superagent/verify.sh demo-start # preview panel on http://127.0.0.1:3083/
pnpm exec vite --config demo/vite.config.ts           # the same, run by hand
```

[`.agents/skills/verify-superagent/`](.agents/skills/verify-superagent/SKILL.md) holds the launch, doctor and drive
recipes and a feature map of the panel. Evidence goes to `.artifacts/verification/<timestamp>/`, which is git-ignored and
survives teardown.

## Status and honesty

The panel, the Sources, the board and the lane model run. The `Reach{source, person}` item — delivering one question to
the same person on every Source they use — is not implemented: a Hold's escalation still addresses conversations, not
people. `GET /orchestrator/api/policy/history` answers 500 on the current build. Treat this as research code shaped by
daily use, not a product.

## License

[MIT](LICENSE). Upstream `dsh-superagent` and `dws-chat-agent` are MIT; their copyright notices are kept in the history
and in this repository's licence.
