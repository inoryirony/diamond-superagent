# Feature map

The panel is the whole user-facing surface: `src/client` rendered by DSH, speaking to `/orchestrator/api/*` on the
loopback port. The lane/board behaviour underneath is proved through the same routes plus `GET /api/threads`.

Each file answers: what it is, how a person reaches it, how to drive it here, what observable end state proves it works.

| Feature | Panel route | What the person is doing |
| --- | --- | --- |
| [Overview](overview.md) | `overview` | seeing what needs them and whether the runtime is healthy |
| [Sources](sources.md) | `source` | checking a Source is listening, and fixing one that is not |
| [Lanes and threads](lanes-and-threads.md) | `trigger` | reading what a conversation said and what the agent decided about it |
| [Decisions](decisions.md) | `eval` | auditing why a message was accepted, ignored or found unavailable |
| [Tickets](tickets.md) | `execution` | stopping, retrying, answering — the board of open work |
| [Settings and prompts](settings.md) | `settings` | changing the Policy, the review rules, the executor or the prompts |
