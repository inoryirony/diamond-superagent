/**
 * Typed key-value store keys and key families grouped by the single component that owns and writes each family.
 * Readers and writers refer to a record by its entry here so each key is spelled once with its value type.
 */
import type { PromptVersion } from './app/prompts.ts'
import type { SettingsVersion } from './app/store.ts'
import type { SettingsSave } from './policy.ts'
import type { Retry } from './sources/github.ts'

/** Key of a KV record whose value has type `V`; a plain string represents an untyped key. */
export type Key<V> = string & { readonly __value?: V }
/** Family of KV records sharing a prefix: callable to build a key from its name parts, and exposing `prefix` for listing. */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
/** Define a single typed KV key; external Source plugins use `record` and `family` to type their own keys. */
export const record = <V>(key: string) => key as Key<V>
/** Define a KV key family whose keys join `prefix` and name parts with `:` (or a custom `format`). */
export function family<V, A extends unknown[] = [string]>(prefix: string, format = (...name: A) => name.join(':')): Family<V, A> {
  return Object.assign((...name: A) => `${prefix}${format(...name)}` as Key<V>, { prefix })
}

export const KV = {
  /** Store: current database schema version. */
  store: { schema: record<number>('schema'),
    /** The board's newest change: each ticket save takes the next one, so a lane can tell what changed since its snapshot. */
    board: record<number>('board-seq') },
  /** Settings: current revision, per-block revision, and saved settings snapshots (including the current one). */
  settings: { revision: record<number>('settings-revision'),
    block: family<number, [block: SettingsSave]>('settings-block-revision:'),
    version: family<SettingsVersion, [revision: number]>('settings-version:') },
  /** Prompts: current revision and saved prompt versions. */
  prompts: { revision: record<number>('prompt-revision'), version: family<PromptVersion, [revision: number]>('prompt-version:'),
    /** The built-in text of a prompt part an override was edited from, by its `base`, which shows what an upgrade changed. */
    builtIn: family<string, [base: string]>('prompt-built-in:') },
  /** Runtime: the main Session's ID. */
  runtime: { masterId: record<string>('master-id') },
  /** Sessions: prompt revisions each Session has worked under, ordered oldest first; the last entry (`.at(-1)`) is its active revision. */
  sessions: { prompts: family<number[], [session: string]>('session-prompts:') },
  /** Schema 11 migration: legacy main-Session queues imported into the effect table. */
  queues: { relays: record<{ id: string; text: string }[]>('relay-queue'), unsubscribed: record<string[]>('subscription-results'),
    prompts: record<number | null>('prompt-notification'), settings: record<number | null>('settings-notification') },
  /** Per-Source resolved display names mapping a named ID (such as a Feishu chat ID) to its display name. */
  sources: { labels: family<Record<string, string>, [source: string]>('source-labels:') },
  /**
   * GitHub Source: notification cursor and pending retries; per-Issue/PR read cursor shared by notification and polled reads;
   * per-stream cursor, start times by kind, and ETag; default-branch CI state; and per-PR CI fingerprint and revision (`revision`
   * counts reported CI changes so each produces a distinct Trigger ID).
   */
  github: { since: record<string>('github-since'), retries: record<Record<string, Retry>>('github-retry'),
    cursor: family<string, [number: number]>('github-cursor:'),
    stream: family<{ since: string; started: Record<string, string>; etag?: string }, [stream: string]>('github-stream:'),
    branchCi: record<{ branch?: string; failures?: string[]; revision: number }>('github-branch-ci'),
    ci: family<{ fingerprint: string; revision: number }, [number: number]>('github-ci:') },
  /**
   * Feishu Source: known chats (`true` for direct messages); per-chat history cursor and active topics mapped from topic ID
   * to last-seen timestamp; and per-polled-thread seen message IDs and initialization flag.
   */
  feishu: { chats: record<Record<string, boolean>>('feishu-chats'), history: family<string, [chat: string]>('feishu-history:'),
    topics: family<Record<string, string>, [chat: string]>('feishu-history-threads:'),
    seen: family<string[], [thread: string]>('thread-seen:'), initialized: family<boolean, [thread: string]>('thread-initialized:') },
  /**
   * DingTalk Source: known conversations with the peer's open DingTalk ID, whether they are direct and their name; per-conversation
   * history cursor; per-conversation map from message ID to the root of its thread; the conversation's latest episode (its root
   * message and the time of its last message, in milliseconds), which groups messages that follow one another closely; the messages
   * still showing the "working on it" reaction; and the streaming card an acknowledgement opened, by conversation.
   */
  dingtalk: { chats: record<Record<string, { peerOpenId: string; direct: boolean; name: string }>>('dingtalk-chats'),
    history: family<string, [conversation: string]>('dingtalk-history:'),
    roots: family<Record<string, string>, [conversation: string]>('dingtalk-roots:'),
    episodes: family<{ rootId: string; lastAt: number }, [conversation: string]>('dingtalk-episodes:'),
    reactions: family<{ messageId: string; at: number }[], [conversation: string]>('dingtalk-reactions:'),
    /** Directory contacts by the nick a message shows, as `dws contact user search` resolved them; `null` marks a nick that resolved to nobody. */
    names: family<import('./sources/dingtalk-names.ts').ContactRecord, [nick: string]>('dingtalk-names:'),
    /** The card an acknowledgement opened, with its text, waiting for the reply that finishes it. */
    cards: record<Record<string, { bizId: string; text: string; at: number }>>('dingtalk-cards') },
  /**
   * Jira Source: the `updated` cursor of the issue search, and the Trigger IDs already ingested from each issue (bounded, oldest
   * first) so a re-read of an unchanged issue or comment produces nothing.
   */
  jira: { cursor: record<string>('jira-cursor'), seen: family<string[], [issue: string]>('jira-seen:') },
  /** GitLab Source: the `updated_after` cursor of the merge request search. */
  gitlab: { cursor: record<string>('gitlab-cursor') },
}
