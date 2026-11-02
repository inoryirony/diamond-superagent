/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** The operator's DingTalk account: the `dws` CLI and the operator's own open DingTalk ID, which no API returns and so is entered by hand. */
export const DingtalkAccountSchema = z.object({ cli: z.string().trim().default(''), openDingtalkId: z.string().trim().default('') })
/** The Jira Server account: its base URL and the name of the environment variable that holds a Personal Access Token; the token itself is never stored. */
export const JiraAccountSchema = z.object({ baseUrl: z.string().trim().regex(/^(https?:[/][/][^ ]+)?$/, 'http(s) URL').default(''), patEnv: z.string().trim().regex(/^([A-Za-z_][A-Za-z0-9_]*)?$/, 'environment variable name').default('') })
/** The operator's GitLab account: the `glab` CLI and the group whose merge requests the Source follows. */
export const GitlabAccountSchema = z.object({ cli: z.string().trim().default(''), group: z.string().trim().default('') })
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: Object.keys(GithubAccountsSchema.shape), feishu: Object.keys(FeishuBotSchema.shape), dingtalk: Object.keys(DingtalkAccountSchema.shape),
  jira: Object.keys(JiraAccountSchema.shape), gitlab: Object.keys(GitlabAccountSchema.shape) }

export interface GithubAccount { cli: string; login: string; noreply: string; repository: string }
export interface Deployment extends Machine { github?: GithubAccount; feishu?: FeishuBot; dingtalk?: DingtalkAccount; jira?: JiraAccount; gitlab?: GitlabAccount }
/** The Jira account a Personal Access Token (read from the environment variable `patEnv`, never stored) acts as. */
export interface JiraAccount { baseUrl: string; patEnv: string; name: string; displayName: string }
/** The signed-in GitLab account `glab` acts as, the instance it is signed in to, and the group whose merge requests the Source follows. */
export interface GitlabAccount { cli: string; host: string; group: string; username: string }
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }
/** The signed-in DingTalk account `dws` acts as; `openDingtalkId` is the operator-entered ID that tells the account's own messages apart. */
export interface DingtalkAccount { cli: string; openDingtalkId: string; userId: string; name: string; corpId: string }

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Verify the agent's GitHub CLI identity and push access to the configured repository; with both fields empty the Source is not configured, which is not a problem. */
export async function resolveGithub(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<GithubAccount | undefined> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote && !accounts.cli) return undefined
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com`, repository }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}

const DingtalkAuth = z.object({ authenticated: z.boolean() })
const DingtalkSelf = z.object({ result: z.array(z.object({ orgEmployeeModel: z.object({ userId: z.string().min(1), corpId: z.string().default(''), orgUserName: z.string().default('') }) })).min(1) })
/**
 * Verify the operator's DingTalk CLI is signed in and read the account it acts as; with both fields empty the Source is not configured, which is not a problem.
 * The open DingTalk ID is entered by hand because no API returns it.
 */
export async function resolveDingtalk(machine: Machine, dingtalk: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<DingtalkAccount | undefined> {
  const account = DingtalkAccountSchema.parse(dingtalk ?? {})
  if (!account.cli && !account.openDingtalkId) return undefined
  if (!account.cli) throw new SetupError('dingtalkCliUnset')
  if (!account.openDingtalkId) throw new SetupError('dingtalkSelfUnset')
  let cli: string
  try { cli = executable(account.cli, path, workerBin(machine.stateDir)) } catch (error) { throw new SetupError('dingtalkCliMissing', { output: reason(error) }) }
  const run = (...args: string[]): Promise<string> => probe([cli, ...args]).catch((error: unknown) => { throw new SetupError('dingtalkSignedOut', { output: reason(error) }) })
  // `dws` may print a warning line before its JSON.
  const json = (text: string): string => text.slice(text.indexOf('{'))
  if (!parsed(DingtalkAuth, json(await run('auth', 'status')))?.authenticated) throw new SetupError('dingtalkSignedOut')
  const me = parsed(DingtalkSelf, json(await run('contact', 'user', 'me', '--format', 'json')))?.result[0]?.orgEmployeeModel
  if (!me) throw new SetupError('dingtalkSignedOut')
  return { cli, openDingtalkId: account.openDingtalkId, userId: me.userId, name: me.orgUserName, corpId: me.corpId }
}

const JiraSelf = z.looseObject({ name: z.string().min(1), displayName: z.string().default('') })
/** Reads a Jira URL with a Bearer token and returns its body; a status outside 2xx throws. */
export type JiraProbe = (url: string, token: string) => Promise<string>
/**
 * The `Authorization` header for a Jira token. A Personal Access Token goes as a Bearer token; a value written as
 * `user:password` (Jira Server's basic authentication, which some installations still use) goes as Basic.
 */
export const jiraAuthorization = (token: string): string =>
  token.includes(':') ? `Basic ${Buffer.from(token).toString('base64')}` : `Bearer ${token}`
export const jiraProbe: JiraProbe = async (url, token) => {
  const response = await fetch(url, { headers: { Authorization: jiraAuthorization(token), Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Jira answered HTTP ${response.status}`)
  return response.text()
}
/**
 * Verify the Jira Personal Access Token named by `patEnv` against `/rest/api/2/myself` and read the account it acts as; with both fields empty
 * the Source is not configured, which is not a problem. The token is read from `env` only here and is never stored.
 */
export async function resolveJira(_machine: Machine, jira: unknown, probe: JiraProbe = jiraProbe, env: Record<string, string | undefined> = process.env): Promise<JiraAccount | undefined> {
  const account = JiraAccountSchema.parse(jira ?? {})
  if (!account.baseUrl && !account.patEnv) return undefined
  if (!account.baseUrl) throw new SetupError('jiraBaseUrlUnset')
  if (!account.patEnv) throw new SetupError('jiraPatUnset')
  const token = env[account.patEnv]
  if (!token) throw new SetupError('jiraPatMissing', { name: account.patEnv })
  const baseUrl = account.baseUrl.replace(/[/]+$/, '')
  const text = await probe(`${baseUrl}/rest/api/2/myself`, token).catch((error: unknown) => { throw new SetupError('jiraSignedOut', { output: reason(error) }) })
  const me = parsed(JiraSelf, text)
  if (!me) throw new SetupError('jiraSignedOut')
  return { baseUrl, patEnv: account.patEnv, name: me.name, displayName: me.displayName }
}

const GitlabUser = z.looseObject({ username: z.string().min(1) })
/** Verify the operator's `glab` is signed in and read the account it acts as; with both fields empty the Source is not configured, which is not a problem. */
export async function resolveGitlab(machine: Machine, gitlab: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<GitlabAccount | undefined> {
  const account = GitlabAccountSchema.parse(gitlab ?? {})
  if (!account.cli && !account.group) return undefined
  if (!account.cli) throw new SetupError('gitlabCliUnset')
  if (!account.group) throw new SetupError('gitlabGroupUnset')
  let cli: string
  try { cli = executable(account.cli, path, workerBin(machine.stateDir)) } catch (error) { throw new SetupError('gitlabCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('gitlabSignedOut', { output: reason(error) }) })
  const me = parsed(GitlabUser, text)
  if (!me) throw new SetupError('gitlabSignedOut')
  const host = (await probe([cli, 'config', 'get', 'host']).catch(() => '')).trim()
  if (!host) throw new SetupError('gitlabSignedOut')
  return { cli, host, group: account.group.replace(/^[/]+|[/]+$/g, ''), username: me.username }
}
