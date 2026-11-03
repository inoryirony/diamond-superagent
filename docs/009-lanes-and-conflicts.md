# 009 Lanes, the board, and conflicts

A lane is one conversation. Each lane has a Session of its own that reads every message in it; everything that crosses
lanes goes through the ticket board, and nothing else does. This document states what a lane is, how two lanes avoid
opening the same work twice, how a contradiction is parked, and what a lane reads.

## What changed and why

The earlier design had one main Session. It read the ticket list and was woken only for triggers no ticket decided, so

- its context grew without bound, measured at 3.6 MB after a few weeks, and
- a conversation was sliced into episodes (`dingtalk:<conversation>:<root>`), 10 minutes apart, so a question and the
  correction that contradicted it fell in different slices and neither slice saw the other.

Both are gone. A DingTalk conversation is now one Thread (`dingtalkThreadId(conversationId)`), a Feishu topic and a
GitHub Issue already were, and every person's message is queued for Eval on its Thread. The `EPISODE_GAP_MS` gap no
longer decides a Thread: it only names the root a `root` or `parent` read opens.

## Lane

| Term | Definition | Invariant |
| --- | --- | --- |
| Lane | A Thread that carries people: a conversation, a topic, an Issue, or whatever a new Source declares as one Thread | One Eval runs on it at a time. It never waits on another lane and never messages one |
| Lane Session | The Session that assesses that Thread's Evals | Reads only its own lane's context, plus the board |
| Board | The ticket table: every open ticket with a revision, and one board sequence number | The only channel between lanes |

A new lane needs no code: any Source that produces a Thread produces a lane, so a production-monitoring Source that
files its alerts as Threads is one, and `lanes` and `lane/<key>` list and read it without knowing what it is.

## The board's sequence

`Thread` used to be the only consistency boundary and the "single writer" was thought to be a problem. It is not: Node is
single-threaded and SQLite is synchronous, so writes never interleave. The real hazard is a **stale read** — a lane
assessing a snapshot and committing a decision after another lane already changed the board.

- Every `ticket.save` takes the next board sequence number, stored on the row (`ticket.revision`) and in `KV.store.board`.
- A Candidate carries `board_seq`, the sequence when it was formed.
- `orchestrator_route` (accept, attach) and `orchestrator_eval_decide` (accept) check `changedSince(board_seq)` before
  committing: open tickets that changed after the snapshot and were not in the Candidate.
- On a hit, nothing is committed. The tool result carries those tickets as cards plus the new `board_seq`, and the lane
  routes the item again with `ack_seq` once it has read them.
- A lane that never calls a write tool in those seconds costs nothing: the check is at the commit point, not at the read.

Writes stay atomic the way they were: `Engine` puts a Decision, the ticket it creates, its Assignment and the delivery
effect in one transaction, so an effect row is already the outbox and is delivered after the commit.

## Conflicts

Two conversations can give one ticket opposite directions. Neither lane chooses.

| Concept | Definition | Rules |
| --- | --- | --- |
| Hold | A contradiction parked on a ticket | Names both directions, who gave each and its words; lists `options` a release may pick. Locks only the Inputs in dispute (`holdsInput`), not the ticket: other work carries on. Carries `dueAt`; a hold due with nobody answering emits `ticket.holdDue` so the main Session asks again or escalates. Only a release lifts it |
| Release | Which direction stands | Reaches the worker as an Input ahead of what waited, and unlocks the Inputs the hold locked. Anyone who reads the hold may release: either lane, or a person |

Tools: `orchestrator_ticket_hold` and `orchestrator_ticket_release`. The stage `person/held` shows a ticket whose whole
work waits on a conflict, which happens only when a hold names no Input.

Who may settle it: the ticket's original requester, the operator, or one of the conflicting parties giving way. When
both stand firm the hold escalates to the operator; the system never decides. Delivering the question to both
conversations by person, rather than by conversation, is a separate item: `Ticket.channels` are addresses inside a
Source, and there is no cross-Source person identity yet.

## A lane reads

| Read | Content |
| --- | --- |
| The candidate card | The trigger as its workers read it, `lane` (the Thread key), `lane_tickets` (the tickets this lane already reaches), `delivered_to`, `related_tickets`, `board_seq` |
| `trigger/<id>` | The trigger's text, the messages around it, and its live conversation history |
| `lanes`, `lane/<key>` | Every lane with activity, or one lane by key, whatever its Source — main Session only, so it reads across conversations |
| `desk`, `tickets`, `ticket/<id>` | The board |

The history window: at least 30 messages, extended back to the lane's latest Decision and to the origin message of every
open ticket on it, capped at 100. A day boundary is not an anchor — it would cut work open across it, as the episode gap
did. Earlier history is paged with the Source's own command, and the compressed view of older work is the board itself:
ended tickets, and open tickets' mandates and reports.

## What a lane decides

Every person's message becomes a candidate. The lane's default is to leave it where it is: `ignore` with the reason the
card shows, which records that it looked. It acts only when the card shows the message is not the ticket's business:

- stop the work, on a person's explicit stop;
- attach it to a different ticket, only on evidence in the message itself;
- accept it as new work, only when no ticket's worker decides it — an accept while one does is refused;
- hold the ticket when two conversations contradict each other.

A worker that finds a message beyond its ticket hands it back with a reason (`handed_back`); the lane then decides it on
the next Eval. A bot's or CI's message reaches Eval only while no ticket decides it.

## Migration (schema 12)

`mergeConversationThreads` folds every `dingtalk:<conversation>:<root>` Thread into `dingtalk:<conversation>`: it
rewrites each trigger's Threads and the `trigger_thread` index, merges subscriptions, context marks, correlations and
queued Triggers, keeps the earliest creation and the latest activity, and renames the decisions and followed Threads that
named a slice. The `ticket.revision` column is added with `addColumns`, and `boardSequence()` falls back to the table's
newest revision, so a database written before the counter existed continues from it.
