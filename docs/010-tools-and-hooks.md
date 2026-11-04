# 010 Tools and hooks

每个 Session 本质是什么、因此只剩哪些工具、哪条 DSH 钩子把「提示词只能请求」的规则变成强制。

## 领域文档已经规定的原子性

`docs/001-domain.md:33` 一行定义了一个 Eval：

> **Eval** — 一批 Trigger 的判断，分两层：门禁与评估。
> **Input:** Trigger 批次、一个 Thread 快照、该 Thread 上所有开着的 Ticket 加上已结束的，以及当前 Policy。
> **Output:** 一个 Decision。**本身不持有状态；每个 Eval 在自己的 Session 里被评估。**

这是**完整输入元组、一个 decision、零状态**。它固定了三件与旧实现不同的事：

1. **输入要被交付，不是被取回。** 元组是枚举出来的。一个加载其中一部分的工具（`orchestrator_eval`）意味着输入分两批到达，而第二批是可选的——于是同一条消息的两次 Eval 可能基于不同事实被判断。
2. **每个 Eval 是自己的 Session。** 不是一条 lane 一个 Session。`docs/009-lanes-and-conflicts.md:24` 说「Lane Session 评估该 Thread 的 Eval」，与 `001` 冲突；`001` 是更早的文档，`docs/000` 规定文档按顺序阅读、每篇只建立在前面的之上，所以 `001` 那一行优先。
3. **Eval 之间不携带状态。** 评估过 Eval *n* 的 Session 会把它对看板的认知带进 Eval *n+1*；`docs/009:34` 正是点名了这个失败——「真正的危险是陈旧读取：一条 lane 评估了快照，却在另一条 lane 已改动看板后提交决定」。

**已实现**：候选卡片一次带齐元组（Trigger 全文、Thread 窗口、lane 上的 Ticket、`policy_version`、`board_seq`），`orchestrator_eval` 与 `orchestrator_eval_read` 已删除。判断本身走 `orchestrator_route kind=assess`，规则判定（`rule_assessments`）与决定在同一次调用里，不再有「第二次可选调用」。

## 每个 Session 是什么

每个 Session 是一个**读者，外加一种写者**。

| Session | 写 | 读 |
| --- | --- | --- |
| Orchestrator，每个 Eval 一个 | 关于一条消息的决定、给某个人的消息、某个 ticket 的状态 | 交付进来的元组 |
| Worker，每个 ticket 一个 | 代码（用自带的 `bash`/`edit`）、一个终态报告、一次确认 | 交付进来的 assignment，以及用 `read`/`grep`/`glob` 读代码 |
| Reviewer，每轮一个 | 一个判定 | ticket 记录、worker 的 transcript、diff |

既不是上面某种写、也不是读取 harness 没有直接交付的记录的工具，都不属于这里。

### 为什么 worker 不用 `orchestrator_read` 读代码

`prompts/worker.md` 早已写明。worker 用 harness 自带的 `read`/`grep`/`glob`/`bash` 读代码。`orchestrator_read` 给它的是 **ticket 记录**中元组没带到的部分。

而截断本身是自己造成的，已经移除：

| 截断 | 旧值 | 位置 |
| --- | --- | --- |
| assignment 文本 | 1,500 字符 | 旧 `src/executor/dsh.ts:149` |
| trigger 文本 | 600 字符 | 同上 |
| input 文本 | 1,500 字符 | 旧 `src/executor/dsh.ts:396` |

assignment 是 orchestrator 自己写的 accept——一个标题、一段范围、一句备注，本身不可能是 1,500 字符。trigger 可能很长（Jira 描述），而那正是真正的请求。截断请求、再通过读工具把剩下的卖回去，只买到一个来回。**整份交付**之后，为截断而存在的那次读取也消失了。

## 工具面（当前实测 3 / 3 / 2）

| Session | 工具数 | 各是什么 |
| --- | --- | --- |
| Orchestrator | **3** | `read`（更深的 history、看板）；`route`（关于一条消息的每种决定，`kind` 区分 `accept`/`attach`/`ignore`/`stop`/`answer`/`assess`）；`ticket`（`action` 区分 `restart`/`retry`/`note`/`status`/`hold`/`release`/`reply`） |
| Worker | **3** | `read`（ticket 记录中元组没带到的部分）；`ack`（开工前）；`report`（收工后，终态，带 `threads`、`evidence`、`work`、`mr`） |
| Reviewer | **2** | `read`（worker 的 transcript，太大不能注入）；`review` |

从 17 / 6 / 2 收到 3 / 3 / 2。

### 为什么合并成字段而不是保留独立工具

- `thread_follow` / `thread_unrelated` / `trigger_handback` → `report.threads`。三者都是对一段对话的陈述，都落进一个 disposition，都不需要单独一个来回。
- `settings_save` / `policy_sync` / `prompts_save` / `thread_unsubscribe` / `trigger_requeue` → **删除**。这五个各自重复一个面板路由；面板是人的仪器，agent 握有同一个写，就是它修改自己的准入政策，而 `docs/000` 规定那必须由人的注意力付出代价。
- `reply` / `ticket_note` / `ticket_retry` / `ticket_restart` / `ticket_hold` / `ticket_release` / `ticket_request_status` → 一个 `ticket` 的 `action`。
- `eval` / `eval_read` / `eval_decide` → 元组一次交付 + `route kind=assess`。

### 地板在哪里

orchestrator 的两种写不能合成一个：一条消息的命运和某个 ticket 的状态是不同目标、不同门禁。三个是该角色的地板。

worker 的三个是因为它的话发生在工作的两端和一个中间的读者：`ack` 在前，`report` 在后，`read` 补元组没带的记录。`dropped` 已经表示「无事可做」，不需要单独的沉默工具。

reviewer 保留 `read`，因为 worker 的 transcript 可能以兆计；注入它比工具本身更贵。

## 钩子：schema 决定不了的事

schema 拒绝形状。下面这些是关于含义的规则，实现在 `src/app/turn.ts`。

| 钩子 | Session | 规则 | 取代了什么 |
| --- | --- | --- | --- |
| `agent/turn-stopping` | worker | 本轮跑过的 Assignment 没有报告，就不能收尾。`steer()` 一次并点名缺什么；第二次照原样放行 | 事后写一条合成 `waiting`，那时结果已经丢了 |
| `agent/turn-stopping` | orchestrator | 卡片带来的每个 Trigger 都被 route 过。`steer()` 一次并列出未决的 `trigger_id` | 一个悄悄超时的 Eval |
| `agent/turn-stopping` | reviewer | 有判定。`steer()` 一次，之后按未完成处理 | 只能在事后判定的未完评审 |
| `concludesTurn` | worker / reviewer | `report` 与 `review` 成功即结束本轮 | 模型在说完了之后又花一步去找还能补什么 |
| `ctx.tools.guard` | orchestrator | 保留既有的 `noWait` 拒绝 | — |
| 工具自身的 `deny` | worker | `work: data\|verify\|docs` 但本 Session 调过 `write`/`edit`，或 ready 缺一次改动后的运行 / 缺证据 → 以 `{refused}` 作答，报告不写入 | 这是报告逃过评审的唯一路径 |

### 为什么不是 `post-execute`

原本记的「改成 `post-execute` 阻塞」是错的，实现时查了 DSH 的 `postExecute`（`dsh-tools`）：它在 body 跑完之后才执行，`block` 会把一次**已经成功**的调用改写成 `isError`。用在报告上就是：报告已经落库、评审已经被它触发，紧接着模型被告知这次调用失败——于是它再报一次，而第二次报告会顶掉刚起的那次评审。这正是 `src/app/tools/executor.ts` 注释里记过的真实故障。

正确的位置是**写入之前**，也就是工具自身的 `deny`（`src/app/tools/tool.ts`）：它在 `execute` 之前跑，返回理由就让这次调用以 `{ refused }` 作答、什么都不写，模型在同一轮里改自己的参数重试。两条拒绝（`missingEvidence`、`unclaimedWork`）因此从抛错搬到了 `deny`，抛错与 deny 的差别就是模型把答案读成「工具崩了」还是「你的参数不对」。

`concludeTurn` 只在报告真的写入之后触发：一条被拒绝的报告不会结束回合（`tests/ready-evidence.spec.ts` 断言 `concludedFor(session)` 为空）。

## 两件不是工具的事

### 自回声：靠发送记录，不靠 AI 标记

钉钉用 `messageAiSendFlag` 标记本账号发出的消息，但它不可靠：同一段对话里 dws-chat-agent 的消息带 `'DWS'`，而本项目的回复带 `null`；`backfillChat` 的历史路径根本看不到这个标记。于是回复会作为「一个人的消息」回来，被再评估一遍。

可靠的事实是发送记录（已实现）：出站发送后用 `query-send-status --open-task-id` 解出 `openMessageId`，写进 `dingtalk-sent:<conversationId>`，`dingtalkTrigger` 丢弃该集合里的任何消息，不看标记、不看内容；没有 ID 可比时比对最近十分钟的出站文本。标记只作为额外过滤，绝不作唯一依据。

### 自己发给别人 ≠ 给 agent 的指令

`addressed: 'direct'` 在你自己私聊里也成立，于是「你发给同事的话」曾被当成「给 agent 的明确请求」，建了票，票的 channel 又指向那位同事，agent 的提问全发给了他。

四处修正：

1. **Source 侧**：你自己发的私聊消息打 `meta.forPeer`——它是你写给对方的，不是写给 agent 的。
2. **门禁侧**：`forPeer` 的消息只有收件人在白名单里才准入，否则记 `operatorForUnlistedPeer`。
3. **投递侧**：`Outbox` 在真正发送前再查一次 Policy——私聊对方不在白名单，消息结算为 `channelIgnored`，不重试。已排队的历史消息同样被挡住。
4. **提示词侧**：`prompts/dispatch.md` 写明分享与指令的可判定区别——转发、链接、文档、「我做了什么」的说明都是他给对方的内容，对方没向你提任何要求；只有说出项目里具体要改什么、且上下文表明是让你去做，才授权建票。

## 提醒只能在上班时间，一晚一次

`hold` 的到期提醒会出现在某个人的对话里，所以它是唯一必须不落在下班时间的出站消息。实现在 `src/infra/hours.ts` 与 `Tickets.holdDue`：

- 只在 `Asia/Shanghai` 的 **09:00–19:00** 发出；下班时间到期的 hold，`dueAt` 顺延到下一个 09:00，卡片上能看到，而不是夜里发一条让人无视的消息。
- **一个 ticket 一晚上只问一次**：今天已经问过就等到明天，无论它显示得多逾期。计数单位是本地自然日。
- 创建 hold 时就把 `dueAt` 归一到工作时段，所以不存在「计划在夜里发」的提醒。

## 尚未做

1. 存量脏数据：那条建在你与梁协君私聊里的工单（`cf9b5c19`）需要人工清理——它已被人停掉，但其 9 条提问已发出。
2. 面板是否覆盖了人实际会让 agent 代劳的五个动作（settings / policy-sync / prompts / unsubscribe / requeue），在真实使用中再确认。
