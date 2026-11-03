# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub, Feishu, DingTalk, Jira or GitLab; each Source is optional. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## How it works

Five stages, each a real boundary rather than a convention:

1. **A Source** turns raw traffic into a Trigger: a GitHub Issue comment, a Feishu or DingTalk message, a Jira ticket, a
   GitLab merge-request note. Every Source declares which Threads a Trigger belongs to.
2. **A lane** is one Thread that carries people — one conversation, one Issue, one topic. Each lane has a Session of its
   own that reads the whole conversation and assesses every message in it. Lanes never talk to each other; nothing
   crosses a lane boundary except through the board below.
3. **A Policy** decides who may ask for what, and in which mode (off, observe, auto). A request from someone the Policy
   does not cover never becomes work, and the Decision records why.
4. **A Ticket** is the work item: what was asked, what mandate the asker had, which Threads it answers in, and what it has
   been told since. All Tickets together are the *board* — the only channel between lanes, carrying a monotonic sequence
   number so that a lane committing a stale read is asked to look again instead of overwriting.
5. **An Executor Session** runs the Ticket in its own conversation and directory, and reports back when it is done,
   blocked, or needs a decision; that report (optionally reviewed) becomes the Ticket's outcome. Waiting on a person is a
   normal end state, not a failure: the Ticket sits at `person/*` until they act.

Two things a person may have to settle are first-class: an **Attention** (one concrete question, in a structured form)
and a **Hold** (a contradiction between two conversations parked on the Ticket, with the options a release may pick and a
deadline after which it escalates). Neither a lane nor the System decides a contradiction; the system only keeps it
visible until someone does.

The full domain model is [docs/001-domain.md](docs/001-domain.md); the stages in [docs/003-execution.md](docs/003-execution.md);
the lane and board design in [docs/009-lanes-and-conflicts.md](docs/009-lanes-and-conflicts.md); the module map in
[docs/007-architecture.md](docs/007-architecture.md).

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

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

## License

[MIT](LICENSE)
