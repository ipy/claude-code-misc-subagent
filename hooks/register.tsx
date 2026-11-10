import { update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Live } from '../types'
import {
  AUTH_RESTORE_SCRIPT,
  BACKENDS,
  type Backend,
  type BackendId,
  type Names,
  type Policy,
  type Route,
  backendsNote,
  defaultRoute,
  detectArgv,
  isBackendId,
  parseDetected,
  parseRoute,
  policyOf,
  promptFor,
  stdinOf,
} from './backends'
import {
  type Availability,
  type Config,
  type Health,
  type Source,
  type Target,
  CONFIG_FILE,
  configIsInline,
  envSetArgv,
  failedToStart,
  gatewayVars,
  healthy,
  namesOf,
  parseConfig,
  resolveRole,
  routingNote,
  targetKey,
} from './routing'
import {
  type Activity,
  type RunStats,
  DETAIL_CHARS,
  KILL_TREE,
  SUPERVISION_NOTE,
  THINKING_LEVELS,
  WATCH_DEFAULT_S,
  WATCH_MAX_S,
  WATCH_MIN_S,
  activityPage,
  clampInterval,
  clip,
  cleanStderr,
  cut,
  detailPage,
  DEFAULT_NOTE,
  findAgentWorktree,
  hasThinkingSuffix,
  missingWorktreeAdvice,
  type ModelInfo,
  parseDefault,
  parseModelList,
  parseWorktrees,
  resolveScoped,
  scopeModels,
  scopedNote,
  isReadOnlyType,
  newStats,
  pushActivity,
  resolveAgent,
  rpc,
  splitBeats,
  splitType,
  totalTokens,
  wrapArgv,
  worktreeFooter,
  worktreePreface,
  piVersionNote,
  watchSection,
} from './core'

// The subagent itself is the engine's own (tasks list, transcript, notification,
// worktree, TaskStop, resume): only its model requests are answered by another coding agent.
const AGENT_HEAD = `

Subagents here can run on other coding agents instead of Claude: the engine runs the agent as usual (tasks list, worktree, notification, resume), and only its model requests are answered by the chosen agent's CLI. A fork, a remote agent, or a call that sets the \`model\` parameter (sonnet, opus, haiku, fable) or appends \`@claude\` to subagent_type runs on Claude itself.

An agent with \`isolation: "worktree"\` that runs on another agent gets its own git worktree. Before the agent starts, the mod points it at the session's current HEAD commit (uncommitted changes in the main checkout are not in it), tells it the worktree's path and to stay inside it, and ends the answer with the worktree's path and branch. A Claude-run agent's worktree is Claude Code's own, created from origin/main.`

const AGENT_TAIL = `
- \`effort\` sets the agent's reasoning level when the \`@\` suffix carries no \`:<effort>\` (pi: thinking level).
- SendMessage to a pi agent while it works steers it (pi reads it after its current tool calls); any other agent reads it once its current run ends, in the same session. After an agent finished, SendMessage resumes it as usual. TaskStop stops it.
- Permissions: pi has none; the other agents run unattended, with their permission prompts off (set PI_SUBAGENT_PERMISSIONS=guarded in the environment to keep each CLI's own restrictions). Explore, Plan and claude-code-guide agents are always read-only.
- Supervision (opt-in; third-party models can drift or stall): mcp__pi-subagent__subagent_activity reads its recent activity without consuming anything; mcp__pi-subagent__watch_subagent sends you periodic activity evidence while it works. Do not poll by default.`

const ANY_MODEL_NOTE =
  `- Models on pi: append \`@<provider>/<model>\` to subagent_type (\`general-purpose@codebuddy/glm-5.3\`), optionally \`:<thinking>\`; omitted, pi's default. \`pi --list-models <search>\` in Bash lists models.\n- ${DEFAULT_NOTE}`

// The models subagents may use: pi's scoped models (`enabledModels`, the project's
// over the user's), with pi's own facts on each; none scoped, any model goes.
type Scope = { models: ModelInfo[]; fallback?: string }
let scope: Promise<Scope> | undefined

// pi's settings, the project's over the user's.
async function readPiSettings($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? ''
  type PiSettings = { enabledModels?: string[]; defaultProvider?: string; defaultModel?: string }
  const readJson = async (path: string): Promise<PiSettings> =>
    (await $.fs.exists(path)) ? (JSON.parse(await $.fs.read(path)) as PiSettings) : {}
  const user = await readJson(`${home}/.pi/agent/settings.json`).catch((): PiSettings => ({}))
  const project = await readJson('.pi/settings.json').catch((): PiSettings => ({}))
  return {
    enabled: project.enabledModels?.length ? project.enabledModels : (user.enabledModels ?? []),
    provider: project.defaultProvider ?? user.defaultProvider,
    name: project.defaultModel ?? user.defaultModel,
  }
}

// pi's default model among the scoped ones; the first scoped one when pi names none of them.
function defaultOf(models: readonly ModelInfo[], provider?: string, name?: string) {
  const preferred = provider && name ? resolveScoped(`${provider}/${name}`, models) : undefined
  return preferred && 'model' in preferred ? preferred.model : models[0]?.id
}

async function readScope($: EngineInterface): Promise<Scope> {
  const { enabled, provider, name } = await readPiSettings($)
  if (!enabled.length) return { models: [] }
  const listed = await $.process.run(['pi', '--list-models'], { timeoutMs: 120_000 }).then(r => parseModelList(r.stdout), () => [])
  const models = scopeModels(enabled, listed)
  return { models, fallback: defaultOf(models, provider, name) }
}

// pi's models, once pi is known to be installed: nothing is run for a pi that is not there.
async function loadScope($: EngineInterface): Promise<Scope> {
  const bins = await (detected ??= detect($))
  return bins.has('pi') ? readScope($) : { models: [] }
}

// The scoped models as pi's settings name them, without pi's facts on each.
async function scopeNames($: EngineInterface): Promise<Scope> {
  const { enabled, provider, name } = await readPiSettings($)
  const models = scopeModels(enabled, [])
  return { models, fallback: defaultOf(models, provider, name) }
}

// A cold `pi --list-models` can outlast the engine's 10s budget for tool.describe:
// past this wait the description names the scoped models without their facts.
const DESCRIBE_WAIT_MS = 3_000

// The backends installed here and the executable of each, looked up once per session.
let detected: Promise<Map<BackendId, string>> | undefined

function detect($: EngineInterface): Promise<Map<BackendId, string>> {
  return $.process.run(detectArgv(), { timeoutMs: 15_000 }).then(
    ran => (ran.exitCode === 0 ? parseDetected(ran.stdout) : new Map<BackendId, string>()),
    () => new Map<BackendId, string>(),
  )
}

// What a refused Agent call says when the backend it asked for is not here.
function notInstalled(id: BackendId, bins: ReadonlyMap<BackendId, string>) {
  const b = BACKENDS[id]
  const here = [...bins.keys()]
  const instead = here.length ? `Installed here: ${here.join(', ')}. Use one of those, or @claude to run the agent on Claude.` : 'No supported coding agent is installed here; use @claude to run the agent on Claude.'
  return `${b.title} is not installed (no ${b.bins.join(' or ')} on PATH). ${instead}`
}

// Saved CLI logins (AGY_AUTH_B64, CODEX_AUTH_B64) unpacked at session start; a run of agy or codex waits for it.
let restoring: Promise<unknown> | undefined

function restoreLogins($: EngineInterface): Promise<unknown> {
  return $.process
    .run(['bash', '-c', AUTH_RESTORE_SCRIPT, 'pi-subagent'], { timeoutMs: 30_000 })
    .then(ran => {
      const said = `${ran.stdout}${ran.stderr}`.trim()
      if (said) $.ui.log(`pi-subagent: ${said}`, { to: 'debug' })
    })
    .catch(() => undefined)
}

// The user's gateways and roles: ~/.claude/pi-subagent/config.json, then PI_SUBAGENT_CONFIG (JSON or a
// file path) over it. Read at each use, so an edit counts without a restart.
async function loadConfig($: EngineInterface): Promise<Config> {
  const home = (await $.env.get('HOME')) ?? ''
  const sources: Source[] = []
  const problems: string[] = []
  const readFile = async (path: string, origin: string, required: boolean) => {
    if (await $.fs.exists(path).catch(() => false)) sources.push({ origin, text: await $.fs.read(path).catch(() => '') })
    else if (required) problems.push(`${origin}: ${path} does not exist`)
  }
  await readFile(`${home}/${CONFIG_FILE}`, `~/${CONFIG_FILE}`, false)
  const env = (await $.env.get('PI_SUBAGENT_CONFIG'))?.trim()
  if (env) {
    if (configIsInline(env)) sources.push({ origin: 'PI_SUBAGENT_CONFIG', text: env })
    else await readFile(env.startsWith('~/') ? `${home}${env.slice(1)}` : env, 'PI_SUBAGENT_CONFIG', true)
  }
  const cfg = parseConfig(sources)
  cfg.problems.unshift(...problems)
  return cfg
}

// Targets that could not start, by targetKey: kept across sessions, left out of roles for HEALTH_TTL_MS.
const HEALTH_KEY = 'health'

async function readHealth($: EngineInterface): Promise<Record<string, Health>> {
  const h = (await $.store.get(HEALTH_KEY).catch(() => undefined)) as Record<string, Health> | undefined
  return h && typeof h === 'object' ? h : {}
}

async function noteHealth($: EngineInterface, key: string, error: string | undefined) {
  const h = await readHealth($)
  if (error === undefined) {
    if (!(key in h)) return
    delete h[key]
  } else h[key] = { at: Date.now(), error: clip(error, 300) }
  await $.store.set(HEALTH_KEY, h).catch(() => undefined)
}

// Whether each target can be used now: its CLI installed, a gateway's variables set and a model
// to ask for, and (unless asked by name) no failure to start within the last hour.
async function availability($: EngineInterface, cfg: Config, bins: ReadonlyMap<BackendId, string>) {
  const vars = unique([...cfg.gateways.values()].flatMap(gatewayVars))
  const set = vars.length
    ? new Set((await $.process.run(envSetArgv(vars), { timeoutMs: 15_000 }).catch(() => ({ stdout: '' }))).stdout.split('\n').filter(Boolean))
    : new Set<string>()
  const health = await readHealth($)
  const now = Date.now()
  const gatewayWhy = (name: string) => {
    const g = cfg.gateways.get(name)
    if (!g) return `no gateway named ${name} is configured`
    if (!bins.has('gateway')) return 'claude is not on PATH'
    if (g.baseUrlEnv && !set.has(g.baseUrlEnv)) return `${g.baseUrlEnv} is not set`
    if (g.keyEnv && !set.has(g.keyEnv)) return `${g.keyEnv} is not set`
    return undefined
  }
  const usable = (byName: boolean): Availability => t => {
    let why: string | undefined
    if (t.kind === 'claude') return undefined
    if (t.kind === 'pi') why = bins.has('pi') ? undefined : notInstalled('pi', bins)
    else if (t.gateway) why = gatewayWhy(t.gateway) ?? (t.model || cfg.gateways.get(t.gateway)?.model ? undefined : `no model: write @${t.gateway}/<model> (the gateway has no default)`)
    else why = bins.has(t.backend) ? undefined : notInstalled(t.backend, bins)
    if (why || byName) return why
    const h = health[targetKey(t)]
    return healthy(h, now) ? undefined : `could not start ${Math.round((now - h!.at) / 60_000)} min ago (${clip(h!.error, 120)})`
  }
  return { usable, gatewayWhy }
}

// Where an Agent call without `@` goes: PI_SUBAGENT_DEFAULT may also name a role or a gateway.
function defaultFor(setting: string | undefined, bins: ReadonlyMap<BackendId, string>, names: Names): Route {
  const word = (setting ?? '').trim().toLowerCase()
  if (word && (names.roles.has(word) || names.gateways.has(word))) return parseRoute(word, { kind: 'claude' }, names)
  return defaultRoute(setting, new Set(bins.keys()))
}

// How the user has set the mod up, read from the environment at each Agent call so a
// change takes effect without a restart.
async function readEnv($: EngineInterface) {
  // The engine lists the variables a module reads, so each name is written out where it is read.
  const set = (value: string | undefined) => (value ?? '').trim() || undefined
  return {
    // Set by the wrapper in every CLI it starts: a Claude Code started that way does not route its own subagents again.
    nested: set(await $.env.get('PI_SUBAGENT_NESTED')) !== undefined,
    // The engine's own switches for subagents' hand-back tool (see handbackFor).
    noHandback: set(await $.env.get('CLAUDE_CODE_DISABLE_SUBAGENT_HANDBACK')),
    handback: set(await $.env.get('CLAUDE_CODE_SENDMESSAGE_HANDBACK')),
    fallback: set(await $.env.get('PI_SUBAGENT_DEFAULT')),
    permissions: set(await $.env.get('PI_SUBAGENT_PERMISSIONS')),
  }
}

const ACTIVITY_TOOL = 'mcp__pi-subagent__subagent_activity'
const WATCH_TOOL = 'mcp__pi-subagent__watch_subagent'
const WATCH_TAG = '<pi-subagent-watch>'
const LIVE = { plugin: 'pi-subagent', key: 'live' } as const
const LIVE_LINES = 40
const LIVE_MARK: Record<string, { mark: string; color: string }> = {
  tool: { mark: '⏺', color: 'suggestion' },
  result: { mark: '⎿', color: 'subtle' },
  text: { mark: '◆', color: 'claude' },
  error: { mark: '✗', color: 'error' },
  retry: { mark: '↻', color: 'warning' },
  note: { mark: '·', color: 'subtle' },
}

type Watch = { intervalS: number; brief?: string; criteria?: string; cursor: number; timer: { cancel: () => void } }

// How a subagent's backend is configured, kept in $.store so a resume after a reload still uses it.
type Kept = {
  id: string
  name?: string
  type: string
  description: string
  // The coding agent that runs it.
  backend: BackendId
  // How its permissions were set when it was asked for; a resume keeps them.
  policy: Policy
  model?: string
  thinking?: string
  readOnly: boolean
  isolated: boolean
  // The caller's checkout, read where the Agent call was made: what an isolated
  // agent's worktree is pointed at and the agent is told to keep out of.
  repo?: string
  // The commit its worktree was pointed at: set once the agent has started in it.
  based?: string
  // The backend's own conversation, once it has said its id (not pi's: those are found by file),
  // and the directory it ran in, which a resume must run in again.
  session?: string
  cwd?: string
  // The configured gateway a `gateway` backend runs against, by name (its settings are read at each run).
  gateway?: string
  // The role it was asked for, and the targets left to try if this one cannot start.
  role?: string
  fallbacks?: Target[]
  // Set once it has done any work: from then on it stays on its backend.
  worked?: boolean
  // It moved to Claude itself (a role's last target): its steps go to this model.
  native?: string
  // Its report is delivered through the engine's SubagentHandback tool, not as its last words.
  handback?: boolean
}

// Where an agent runs now, as a role target.
function targetOf(a: Pick<Kept, 'backend' | 'gateway' | 'model' | 'thinking'>): Target {
  if (a.backend === 'pi') return { kind: 'pi', requested: a.model }
  return { kind: 'backend', backend: a.backend, gateway: a.gateway, model: a.model }
}

// Points an agent that has not started at a role's next target.
function moveTo(a: Agent, t: Exclude<Target, { kind: 'claude' }>) {
  a.session = undefined
  a.cwd = undefined
  if (t.kind === 'pi') {
    a.backend = 'pi'
    a.gateway = undefined
    a.model = t.requested && !/^default(:|$)/.test(t.requested) ? t.requested : undefined
    a.thinking = undefined
    return
  }
  a.backend = t.backend
  a.gateway = t.gateway
  a.model = t.model
  if (t.level && THINKING_LEVELS.includes(t.level)) a.thinking = t.level
}

// The name an agent's backend is shown by: a gateway by its own name.
const labelOf = (a: Pick<Kept, 'backend' | 'gateway'>) => a.gateway ?? BACKENDS[a.backend].label

type Agent = Kept & {
  status: 'idle' | 'running' | 'completed' | 'failed' | 'stopped'
  bornAt: number
  runStartedAt: number
  pid?: string
  cmdFile?: string
  lastTool?: string
  worktree?: { path: string; branch?: string }
  // This run could not start its backend (no worktree, not installed): retrying in the same session does not help.
  notStarted?: boolean
  // This run yielded a beat, so its answer's text is block 1, not 0.
  beaten?: boolean
  events: Activity[]
  seq: number
  stats: RunStats
  // What this turn already answered, and how: a later step of the same turn gives it again
  // instead of running the backend again (the engine asks again when a report did not arrive).
  answered?: { turnId: string; text: string; via: 'handback' | 'text'; tries: number }
  // User rows the engine appended to the agent's conversation since its last step.
  inbox: string[]
  watch?: Watch
  // A band write in flight, and whether another is owed after it.
  publishing?: boolean
  republish?: boolean
}

// What an Agent call asked for, until its spawn names the agent.
type Asked = Omit<Kept, 'id' | 'description'>

const asked = new Map<string, Asked>()
// Messages for agents whose spawn has not come back yet, by agent id.
const early = new Map<string, string[]>()
const EARLY_KEEP_MS = 60_000
const agents = new Map<string, Agent>()
const sections = new Map<string, { text: string; cursor: number }>()
let delivering = false
// Whether the main loop is mid-turn: a watch notice then rides on its next tool
// result. Every main model request says so again, so a reload mid-turn learns it
// at the next request.
let mainBusy = false
// The notices that rode on a tool result, by its tool_use_id, for the transcript to draw.
const rode = new Map<string, string>()

// pi keeps its sessions here (and has since this mod only ran pi).
async function subagentDir($: EngineInterface) {
  return `${(await $.env.get('HOME')) ?? '/tmp'}/.pi/claude-subagents`
}

// The other backends' prompt files, removed when a run ends.
async function promptDir($: EngineInterface) {
  return `${(await $.env.get('HOME')) ?? '/tmp'}/.claude/pi-subagent`
}

// Made before a file goes in it, so a first run does not depend on anything having made it. Private
// when new: the files hold the tasks the agents were given.
async function ensureDir($: EngineInterface, dir: string) {
  await $.process.run(['mkdir', '-p', '-m', '700', dir]).catch(() => undefined)
}

async function appendLine($: EngineInterface, file: string, text: string) {
  const ran = await $.process.run(['bash', '-c', 'printf "%s\\n" "$1" >> "$2"', 'pi-subagent', text, file])
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || 'append failed')
}

function showStatus($: EngineInterface) {
  // Grouped by backend, in the order they started: `pi: a · b · codex: c`.
  const groups = new Map<string, string[]>()
  for (const a of agents.values()) {
    if (a.status !== 'running') continue
    const label = labelOf(a)
    groups.set(label, [...(groups.get(label) ?? []), `${a.name ?? a.type}${a.lastTool ? ` ${a.lastTool}` : ''}${a.watch ? ' (watched)' : ''}`])
  }
  $.ui.status(groups.size ? [...groups].map(([label, rows]) => `${label}: ${rows.join(' · ')}`).join(' · ') : undefined)
}

async function keep($: EngineInterface, a: Agent) {
  const kept: Kept = {
    id: a.id,
    name: a.name,
    type: a.type,
    description: a.description,
    backend: a.backend,
    policy: a.policy,
    model: a.model,
    thinking: a.thinking,
    readOnly: a.readOnly,
    isolated: a.isolated,
    repo: a.repo,
    based: a.based,
    session: a.session,
    cwd: a.cwd,
    gateway: a.gateway,
    role: a.role,
    fallbacks: a.fallbacks,
    worked: a.worked,
    native: a.native,
    handback: a.handback,
  }
  await $.store.set(`agent:${a.id}`, kept)
}

async function findKept($: EngineInterface, id: string): Promise<Agent | undefined> {
  const live = agents.get(id)
  if (live) return live
  const kept = (await $.store.get(`agent:${id}`)) as (Omit<Kept, 'backend' | 'policy'> & { backend?: string; policy?: string }) | undefined
  if (!kept) return undefined
  // A backend this version does not know (kept by a newer one) is not guessed at: the engine runs the agent.
  if (kept.backend !== undefined && !isBackendId(kept.backend)) return undefined
  const now = Date.now()
  // An agent kept before there were several backends is pi's, and ran unattended like all of pi's.
  const a: Agent = {
    ...kept,
    backend: (kept.backend as BackendId | undefined) ?? 'pi',
    policy: kept.policy === 'guarded' ? 'guarded' : 'bypass',
    status: 'idle',
    bornAt: now,
    runStartedAt: now,
    events: [],
    seq: 1,
    stats: newStats(),
    inbox: [],
  }
  agents.set(id, a)
  return a
}

// The checkout the caller is working in now: the git toplevel of its live working
// directory, which follows a `cd` into another repo; `$.session.root()` stays the
// directory the session started in and is only the fallback.
async function callerRepo($: EngineInterface): Promise<string> {
  try {
    const wd = (await $.process.run(['pwd'])).stdout.trim()
    if (wd) {
      const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: wd })
      if (top.exitCode === 0 && top.stdout.trim()) return top.stdout.trim()
    }
  } catch {}
  return await $.session.root()
}

// Where the backend starts: the agent's directory, or for an isolated agent its own worktree.
// On its first run the worktree is pointed at the session's HEAD (the engine makes it
// from origin/main), when nothing in it could be lost. A worktree that cannot be found
// is an error: the backend never falls back to another checkout.
async function enterWorktree($: EngineInterface, a: Agent): Promise<{ cwd: string; preface?: string } | { error: string }> {
  // Found again on every run: a worktree of an earlier run may be gone by now.
  a.worktree = undefined
  if (!a.isolated) return { cwd: (await $.process.run(['pwd'])).stdout.trim() }
  // The checkout the Agent call was made from. Which root `$.session.root()` answers
  // inside the agent's own hook is not documented, so it is only the fallback for
  // an agent kept before the call recorded it.
  const session = a.repo ?? (await $.session.root())
  const git = async (cwd: string, ...args: string[]) => {
    const r = await $.process.run(['git', ...args], { cwd, timeoutMs: 120_000 })
    return { ok: r.exitCode === 0, out: r.stdout.trim() }
  }
  const listed = await git(session, 'worktree', 'list', '--porcelain')
  if (!listed.ok) return { error: `its isolated worktree could not be listed (git worktree list failed in ${session})` }
  const trees = parseWorktrees(listed.out)
  const found = findAgentWorktree(trees, a.id)
  if ('error' in found) return { error: `${found.error} ${missingWorktreeAdvice(Boolean(a.based), labelOf(a))}` }
  const { path, branch } = found.worktree
  a.worktree = { path, branch }
  if (a.based) return { cwd: path }

  const sessionHead = (await git(session, 'rev-parse', 'HEAD')).out
  let head = (await git(path, 'rev-parse', 'HEAD')).out
  if (!head) return { error: `its isolated worktree ${path} is not a git checkout` }
  let behind: string | undefined
  if (sessionHead && sessionHead !== head) {
    const status = await git(path, 'status', '--porcelain')
    const clean = status.ok && status.out === ''
    if (clean && (await git(path, 'reset', '--hard', sessionHead)).ok) head = sessionHead
    else behind = sessionHead
  }
  const subject = (await git(path, 'log', '-1', '--format=%h %s')).out
  a.based = head
  await keep($, a)
  return { cwd: path, preface: worktreePreface({ path, branch, repo: session, head: subject || head, sessionHead: behind }) }
}

type Section = [string, { text: string; cursor: number }]

function noticeText(secs: Section[]) {
  return [WATCH_TAG, SUPERVISION_NOTE, ...secs.map(([, s]) => s.text), '</pi-subagent-watch>'].join('\n\n')
}

function delivered(secs: Section[]) {
  for (const [id, s] of secs) {
    const w = agents.get(id)?.watch
    if (w) w.cursor = Math.max(w.cursor, s.cursor)
  }
}

function putBack(secs: Section[]) {
  for (const [id, s] of secs) if (!sections.has(id)) sections.set(id, s)
}

// The tool_result blocks of a main-loop row with the notice added to the last one,
// and that block's tool_use_id. The row is rewritten before it is stored, so the
// running turn's requests and the history later turns rebuild carry the same bytes.
// A row of its own (`$.session.append`) is filed wherever the transcript's tail is
// when it lands, which need not be where the running turn sends it: a request in
// flight or a response streaming puts it ahead of rows the turn sends before it,
// the next turn's prefix no longer matches, and the prompt cache is rebuilt from
// near the top.
function withNotice(content: readonly unknown[], text: string): { content: unknown[]; id: string } | undefined {
  const blocks = [...content] as { type: string; tool_use_id?: string; content?: unknown }[]
  let at = -1
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i]?.type === 'tool_result') { at = i; break }
  if (at < 0) return undefined
  const block = blocks[at]!
  const body = block.content
  const added = { type: 'text', text }
  blocks[at] = {
    ...block,
    content: typeof body === 'string' ? [{ type: 'text', text: body }, added] : Array.isArray(body) ? [...body, added] : [added],
  }
  return { content: blocks, id: block.tool_use_id ?? '' }
}

// The summary line of a notice: who it watched and how many events it brought.
function noticeLine(text: string) {
  const agentsIn = [...text.matchAll(/^## (\S+) \(([^,)]+)/gm)].map(m => m[2] ?? m[1])
  const events = (text.match(/^\[\d+ /gm) ?? []).length
  return `subagent watch · ${agentsIn.join(', ') || 'subagents'} · ${events} new events`
}

// Watch notices go to the main agent: on an idle session as a prompt of its own;
// mid-turn they wait in `sections` for the main loop's next tool result (the
// session.append hook). Each agent's latest section replaces its earlier undelivered one.
async function flush($: EngineInterface) {
  if (delivering || mainBusy || !sections.size) return
  const secs = [...sections.entries()]
  sections.clear()
  delivering = true
  let sent = false
  try {
    const answer = await $.prompt.submit({ text: noticeText(secs) })
    if (answer.drop !== undefined) throw new Error(answer.drop)
    sent = true
    delivered(secs)
  } catch (err) {
    $.ui.log(`pi-subagent: a watch notice was not delivered (${(err as Error).message}); retrying`, { to: 'debug' })
    putBack(secs)
  } finally {
    delivering = false
  }
  if (!sent) $.clock.after(10_000, () => void flush($))
  else if (sections.size) void flush($)
}

function stopWatch(a: Agent) {
  a.watch?.timer.cancel()
  a.watch = undefined
  sections.delete(a.id)
}

function tick($: EngineInterface, a: Agent) {
  if (!a.watch) return
  if (a.status !== 'running') return stopWatch(a)
  sections.set(
    a.id,
    watchSection(
      { id: a.id, label: `${a.name ? `${a.name}, ` : ''}${a.type}: ${a.description}`, status: a.status, brief: a.watch.brief, criteria: a.watch.criteria },
      a.events,
      a.watch.cursor,
      a.runStartedAt,
      Date.now(),
    ),
  )
  void flush($)
}

function liveOf(a: Agent): Live {
  return {
    agent: labelOf(a),
    label: `${a.name ? `${a.name} · ` : ''}${a.type}: ${a.description}`,
    status: a.status,
    model: a.stats.model ?? a.model,
    steps: a.stats.steps,
    lines: a.events
      .filter(x => x.kind !== 'user')
      .slice(-LIVE_LINES)
      .map(x => ({ seq: x.seq, kind: x.kind, text: x.summary })),
  }
}

// Writes the agent's latest activity for the band; one write at a time, the
// last one taking whatever arrived while the one before was in flight.
function publish($: EngineInterface, a: Agent) {
  if (a.publishing) {
    a.republish = true
    return
  }
  a.publishing = true
  a.republish = false
  void update($, { ...LIVE, id: a.id }, () => liveOf(a))
    .catch(() => undefined)
    .finally(() => {
      a.publishing = false
      if (a.republish) publish($, a)
    })
}

// Shows the backend's work in the subagent's own transcript, as notices the model never
// reads (ctrl+o draws them, dim), and in the band while that transcript is open.
function mirror($: EngineInterface, a: Agent, items: Omit<Activity, 'seq' | 'at'>[]) {
  if (items.some(item => item.kind !== 'user')) publish($, a)
  for (const item of items) {
    if (item.kind === 'user') continue
    const mark = item.kind === 'tool' ? '⏺' : item.kind === 'error' ? '✗' : item.kind === 'retry' ? '↻' : item.kind === 'text' ? '◆' : '⎿'
    void $.session
      .append({ agentId: a.id, message: { type: 'system', content: [{ type: 'text', text: `${mark} ${labelOf(a)} ${item.summary}` }] } })
      .catch(() => undefined)
  }
}

// A piece of "thinking" with nothing in it: the engine shows it and does not record it,
// and it counts as progress of the agent's model request, whose stream watchdog stops an
// agent after 600 s of nothing. A backend runs a long command in silence, so its output
// alone is not enough to keep the agent alive.
const BEAT = { kind: 'thinking' as const, index: 0, text: '' }
const BEAT_MIN_MS = 5_000
const QUIET_START_MS = 60_000

// A prompt longer than this is not put on a command line: one argument is limited (128 KiB
// on Linux, which 30,000 characters stay under even at 4 bytes each) and a long one fills
// `ps`. The CLI is told to read it from a file instead.
const ARG_PROMPT_MAX = 30_000

// How long a CLI that has said it is done may take to exit before its tree is killed.
const SETTLE_GRACE_MS = 15_000

const unique = (list: readonly string[]) => [...new Set(list)]

// Runs one turn for the agent on its backend: a fresh session on its first, the same one after.
// It yields BEAT while the backend shows signs of life, so a long run is not taken for a stall.
async function* runBackend($: EngineInterface, a: Agent, message: string, signal: AbortSignal): AsyncGenerator<typeof BEAT, number> {
  const b = BACKENDS[a.backend]
  a.status = 'running'
  a.pid = undefined
  a.lastTool = undefined
  a.stats = newStats()
  a.runStartedAt = Date.now()
  a.beaten = false
  a.notStarted = false
  showStatus($)
  publish($, a)

  const fail = (error: string) => {
    a.stats.error = error
    const items = [{ kind: 'error' as const, summary: clip(error, 240), detail: error }]
    a.seq = pushActivity(a.events, a.seq, Date.now(), items)
    mirror($, a, items)
  }
  let beats = 0
  // Left at a yield (the engine closed the stream), the run never reaches its end:
  // the agent is then stopped, not left "running" with its watch ticking.
  let closed = true
  try {
    const bin = (await (detected ??= detect($))).get(a.backend)
    const entered = bin ? await enterWorktree($, a) : undefined
    if (!bin) {
      a.notStarted = true
      fail(`${labelOf(a)} was not started: ${b.title} is not installed (no ${b.bins.join(' or ')} on PATH)`)
    } else if (entered && 'error' in entered) {
      a.notStarted = true
      fail(`${labelOf(a)} was not started: ${entered.error}`)
    } else if (entered) {
      beats = yield* runChild($, a, b, bin, entered.preface ? `${entered.preface}\n\n${message}` : message, entered.cwd, signal)
    }
    closed = false
  } catch (err) {
    closed = false
    if (!a.stats.error) fail(`${labelOf(a)} could not be run: ${(err as Error).message}`)
  } finally {
    const stopped = closed || signal.aborted || a.stats.aborted
    if (!stopped && !a.stats.error && !a.stats.answer) {
      a.stats.error = a.stats.denied.length
        ? `${labelOf(a)} was not allowed to use ${unique(a.stats.denied).join(', ')} and ended without an answer`
        : `${labelOf(a)} ended without an answer`
    }
    a.status = stopped ? 'stopped' : a.stats.error ? 'failed' : 'completed'
    a.lastTool = undefined
    a.pid = undefined
    stopWatch(a)
    showStatus($)
    publish($, a)
  }
  return beats
}

// Runs the backend's CLI in `cwd` until it settles; returns how many beats it yielded.
async function* runChild($: EngineInterface, a: Agent, b: Backend, bin: string, message: string, cwd: string, signal: AbortSignal): AsyncGenerator<typeof BEAT, number> {
  let argv: string[]
  // The prompt file to remove when the run ends.
  let wrote: string | undefined
  // A backend's session is continued where it began: Claude Code keeps its sessions per directory.
  let runCwd = cwd
  if (b.id === 'pi') {
    const dir = await subagentDir($)
    await ensureDir($, dir)
    const sessionFile = (await $.fs.list(dir).catch(() => [])).find(f => f.name.endsWith(`_${a.id}.jsonl`))
    const sessionArgs = sessionFile ? ['--session', `${dir}/${sessionFile.name}`] : ['--session-dir', dir, '--session-id', a.id]
    a.cmdFile = `${dir}/${a.id}.cmd.jsonl`
    if (sessionFile) a.seq = pushActivity(a.events, a.seq, a.runStartedAt, [{ kind: 'note', summary: `resumed its ${labelOf(a)} session`, detail: '' }])
    await $.fs.write(a.cmdFile, rpc.prompt(message) + '\n')
    argv = wrapArgv(stdinOf(b), a.cmdFile, b.argv({ bin, prompt: message, file: a.cmdFile, sessionArgs, model: a.model, effort: a.thinking, readOnly: a.readOnly, policy: a.policy }))
  } else {
    if (b.id === 'agy' || b.id === 'codex') await restoring
    runCwd = a.cwd ?? cwd
    const dir = await promptDir($)
    a.cmdFile = `${dir}/${a.id}.prompt.txt`
    if (a.session) a.seq = pushActivity(a.events, a.seq, a.runStartedAt, [{ kind: 'note', summary: `resumed its ${labelOf(a)} session`, detail: '' }])
    // The backend does not echo the prompt as pi does: the activity records it.
    a.seq = pushActivity(a.events, a.seq, a.runStartedAt, [{ kind: 'user', summary: clip(message, 180), detail: cut(message, DETAIL_CHARS) }])
    const prompt = promptFor(b, { prompt: message, readOnly: a.readOnly })
    const bulky = b.input === 'arg' && prompt.length > ARG_PROMPT_MAX
    if (b.input === 'stdin' || bulky) {
      await ensureDir($, dir)
      await $.fs.write(a.cmdFile, `${prompt}\n`)
      wrote = a.cmdFile
    }
    const given = bulky ? `Your task is in the file ${a.cmdFile}. Read it completely, then carry it out exactly as written.` : prompt
    const gateway = a.gateway ? (await loadConfig($)).gateways.get(a.gateway) : undefined
    if (a.gateway && !gateway) throw new Error(`no gateway named ${a.gateway} is configured any more`)
    argv = wrapArgv(stdinOf(b), a.cmdFile, b.argv({ bin, prompt: given, file: a.cmdFile, session: a.session, model: a.model, effort: a.thinking, readOnly: a.readOnly, policy: a.policy, gateway }))
  }

  const child = $.process.spawn({ argv, cwd: runCwd })
  const kill = () => {
    if (a.pid) void $.process.run(['bash', '-c', KILL_TREE, 'pi-subagent', a.pid])
  }
  signal.addEventListener('abort', kill, { once: true })
  const parse = b.parser()
  let pending = ''
  let stderr = ''
  // Whether a tool call is in flight: while one runs, the CLI's silence is the command's.
  let busy = false
  // The CLI's own output can be a burst of lines; the wrapper's beats are already 20 s apart.
  let yielded = 0
  let lastBeat = 0
  // Once stopped, nothing is yielded: the engine may have stopped reading, and the run
  // must still reach its end.
  const due = () => {
    const now = Date.now()
    if (signal.aborted || now - lastBeat < BEAT_MIN_MS) return false
    // Nothing is yielded in the first minute before the CLI has taken a step: a run that cannot
    // start leaves the step empty, so a role can still hand it to Claude. Words do not count:
    // Claude Code tells an API failure as the assistant's words before it fails.
    if (!a.stats.steps && now - a.runStartedAt < QUIET_START_MS) return false
    lastBeat = now
    return true
  }
  // Whether the loop ran to the CLI's end (or its settling); otherwise its tree is killed.
  let drained = false
  let grace: { cancel: () => void } | undefined
  try {
    for await (const { stream, text } of child) {
      if (stream === 'stderr') {
        const { beats, rest } = splitBeats(text)
        stderr = (stderr + rest).slice(-8000)
        a.pid ??= /PI_PID (\d+)/.exec(stderr)?.[1]
        if (signal.aborted) kill()
        if (beats && busy && !signal.aborted) {
          yielded += 1
          a.beaten = true
          yield BEAT
        }
        continue
      }
      if (due()) {
        yielded += 1
        a.beaten = true
        yield BEAT
      }
      pending += text
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '')
        if (!line.startsWith('{')) continue
        let ev: Record<string, unknown>
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        const seen = ev && typeof ev === 'object' ? parse(ev, a.stats) : undefined
        if (seen) {
          if (seen.reply && a.cmdFile) void appendLine($, a.cmdFile, seen.reply).catch(() => undefined)
          if (seen.items.length) {
            a.seq = pushActivity(a.events, a.seq, Date.now(), seen.items)
            mirror($, a, seen.items)
          }
          if (seen.tool) {
            a.lastTool = seen.tool
            showStatus($)
          }
          if (seen.busy !== undefined) busy = seen.busy
        }
        if (b.id !== 'pi' && a.stats.session && a.stats.session !== a.session) {
          a.session = a.stats.session
          a.cwd = runCwd
          await keep($, a)
        }
      }
      // pi stays up for more commands once its turn is over; the others exit by themselves,
      // and are given a moment to before their tree is killed.
      if (a.stats.settled) {
        if (b.persistent) break
        grace ??= $.clock.after(SETTLE_GRACE_MS, kill)
      }
    }
    drained = true
  } catch (err) {
    a.stats.error ??= `${labelOf(a)} could not run: ${(err as Error).message}`
  } finally {
    signal.removeEventListener('abort', kill)
    grace?.cancel()
    // Leaving the loop early ends only the CLI itself; the commands it runs go with the tree.
    if (!drained) kill()
    if (wrote) void $.process.run(['rm', '-f', wrote]).catch(() => undefined)
  }
  let code: number | null = null
  if (!a.stats.settled) code = await child.result.then(r => r.code, () => null)
  const stopped = signal.aborted || a.stats.aborted
  // A CLI that exits cleanly with its answer in hand is done even if it never said so (opencode,
  // with some providers, ends on its last message). Any other exit before settling is a failure.
  if (!stopped && !a.stats.settled && !a.stats.error && !b.persistent && code === 0 && a.stats.answer.trim()) a.stats.settled = true
  if (!stopped && !a.stats.settled && !a.stats.error) {
    a.stats.error = `${labelOf(a)} exited (code ${code}) before finishing: ${clip(cleanStderr(stderr), 600) || 'no output'}`
    const items = [{ kind: 'error' as const, summary: clip(a.stats.error, 240), detail: a.stats.error }]
    a.seq = pushActivity(a.events, a.seq, Date.now(), items)
    mirror($, a, items)
  }
  return yielded
}

// What the backend was refused, and what to do about it.
function deniedNote(a: Agent) {
  if (!a.stats.denied.length) return ''
  const what = unique(a.stats.denied).join(', ')
  const why = a.readOnly
    ? 'This agent type is read-only; use general-purpose for work that changes files.'
    : a.policy === 'guarded'
      ? 'PI_SUBAGENT_PERMISSIONS=guarded keeps the agent inside its CLI\'s permission rules; unset it to let agents work unattended.'
      : "The agent's own safety rules still refuse some actions."
  return `\n\n[${labelOf(a)} was refused: ${what}. ${why}]`
}

function answerOf(a: Agent, movedToClaude = false) {
  const b = BACKENDS[a.backend]
  const foot = a.worktree ? `\n${worktreeFooter(a.worktree)}` : ''
  const model = a.stats.model ?? a.model ?? `${labelOf(a)}'s default model`
  const head = `[${labelOf(a)} · ${model} · ${a.stats.steps} tool uses]`
  const refused = deniedNote(a)
  if (a.status === 'failed') {
    const where = b.id === 'pi' || a.session ? `in the same ${labelOf(a)} session` : `in a new ${labelOf(a)} session`
    const retry = a.notStarted || movedToClaude ? '' : `\n\nSendMessage to this agent retries ${where}.`
    return `${head}\n${labelOf(a)} failed: ${a.stats.error}${a.stats.answer ? `\n\nLast answer before it failed:\n${a.stats.answer}` : ''}${refused}${retry}${foot}`
  }
  if (a.status === 'stopped') return `${head}\n${labelOf(a)} was stopped.${a.stats.answer ? `\n\nLast answer:\n${a.stats.answer}` : ''}${foot}`
  const u = a.stats.usage
  return `${a.stats.answer}\n\n[${labelOf(a)} · ${model} · ${a.stats.steps} tool uses · ${totalTokens(u)} tokens: ${u.input} in, ${u.output} out, ${u.cacheRead} cache read]${refused}${foot}`
}

// What the engine is told the run cost. Other backends' model names are prefixed with
// the backend, so the engine does not price them as the Claude models they may be named for.
function usageOf(a: Agent) {
  const model = a.backend === 'pi' ? a.stats.model : totalTokens(a.stats.usage) > 0 ? `${a.gateway ?? a.backend}/${a.stats.model ?? a.model ?? 'default'}` : undefined
  if (!model) return null
  return {
    input_tokens: a.stats.usage.input,
    output_tokens: a.stats.usage.output,
    cache_creation_input_tokens: a.stats.usage.cacheWrite,
    cache_read_input_tokens: a.stats.usage.cacheRead,
    model,
  }
}

const textOf = (content: readonly { type: string; text?: string }[]) =>
  content
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim()

// The engine's tool for a subagent's report, in the permission mode that has one: a report given
// as the last words instead is not delivered, and the engine asks the agent again.
const HANDBACK = 'SubagentHandback'

const truthy = (v: string | undefined) => v !== undefined && !/^(0|false|no|off)$/i.test(v)

// Whether a subagent spawned in this permission mode reports through SubagentHandback: the engine
// arms it in auto mode unless CLAUDE_CODE_DISABLE_SUBAGENT_HANDBACK is set, and
// CLAUDE_CODE_SENDMESSAGE_HANDBACK, when set, decides.
function handbackFor(mode: string | undefined, env: { noHandback?: string; handback?: string }): boolean {
  if (mode !== 'auto' || truthy(env.noHandback)) return false
  return env.handback === undefined ? true : truthy(env.handback)
}

type StepResult = { turnId: string; index: number; answer: string; toolUses: { name: string; input: unknown }[]; stopReason: 'end_turn' | 'tool_use'; usage: ReturnType<typeof usageOf> }

// Gives the step's answer: as the agent's last words, or as its SubagentHandback call.
async function* respond(a: Agent, e: { turnId: string; index: number }, text: string, usage: ReturnType<typeof usageOf>, after: number, via: 'handback' | 'text', tries = 1) {
  a.answered = { turnId: e.turnId, text, via, tries }
  if (via === 'text') {
    yield { kind: 'text' as const, index: after, text }
    return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage } satisfies StepResult
  }
  const input = { message: text }
  yield { kind: 'tool' as const, index: after, id: `toolu_pisub_${a.id}_${e.index}_${tries}`, name: HANDBACK }
  yield { kind: 'input' as const, index: after, json: JSON.stringify(input) }
  return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: HANDBACK, input }], stopReason: 'tool_use', usage } satisfies StepResult
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    detected = detect($)
    scope = loadScope($)
    restoring = readEnv($).then(env => (env.nested ? undefined : restoreLogins($)))
    void Promise.all([detected, readEnv($), loadConfig($)]).then(async ([bins, env, cfg]) => {
      if (env.nested) return
      if (cfg.problems.length) $.ui.toast(`pi-subagent: configuration problems: ${cfg.problems.join(' | ')}`)
      if (!bins.size) {
        $.ui.toast(`pi-subagent: none of ${[...new Set(Object.values(BACKENDS).map(b => b.bins[0]))].join(', ')} is on PATH, so subagents run on Claude until one is installed.`)
        return
      }
      const fallback = defaultFor(env.fallback, bins, namesOf(cfg))
      if (fallback.kind === 'error') $.ui.toast(`pi-subagent: ${fallback.error}`)
      else if (fallback.kind === 'backend' && !bins.has(fallback.backend)) {
        $.ui.toast(`pi-subagent: PI_SUBAGENT_DEFAULT is ${fallback.backend}, which is not on PATH; Agent calls without an @ will be refused until it is.`)
      }
      const policy = policyOf(env.permissions)
      if (typeof policy === 'object') $.ui.toast(`pi-subagent: ${policy.error}`)
      if (bins.has('pi')) {
        const ran = await $.process.run(['pi', '--version'], { timeoutMs: 30_000 }).catch(() => undefined)
        const note = ran && ran.exitCode === 0 ? piVersionNote(ran.stdout) : undefined
        if (note) $.ui.toast(note)
      }
    }).catch(() => undefined)
    await $.tool.register({
      name: 'subagent_activity',
      isDeferred: false,
      description:
        "Read the recent public activity (its text, tool calls and results, model errors and retries) of a subagent that runs on another coding agent (pi, codex, agy, ...), without consuming its result. " +
        'No agent_id: lists those subagents of this session. With no cursor: a recent snapshot; pass the returned cursor for what came after. ' +
        'activity_id (an event number from a page) returns that one event in full, paged by offset/limit. Use only for supervision, not polling.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Agent id, name, or a unique id prefix of 8+ characters. Omit to list agents.' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Events per page (default 8).' },
          cursor: { type: 'string', description: 'The cursor a previous page returned.' },
          activity_id: { type: 'string', description: 'One event number to read in full.' },
          offset: { type: 'integer', minimum: 0, description: 'Character offset into the event (activity_id only).' },
        },
      },
    })
    await $.tool.register({
      name: 'watch_subagent',
      isDeferred: false,
      description:
        'Start, stop or inspect periodic supervision of a working subagent that runs on another coding agent (pi, codex, agy, ...): every interval_seconds you get a bounded notice of what it did since the last one (deferred while you are busy; several agents coalesce into one notice). ' +
        'The watch ends when the agent finishes its turn. Use it for long or risky delegated work on less reliable models. ' +
        SUPERVISION_NOTE,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'status'] },
          agent_id: { type: 'string', description: 'Agent id, name, or a unique id prefix of 8+ characters.' },
          interval_seconds: {
            type: 'integer',
            minimum: WATCH_MIN_S,
            maximum: WATCH_MAX_S,
            description: `Seconds between notices (default ${WATCH_DEFAULT_S}).`,
          },
          review_brief: { type: 'string', description: 'What to look for, repeated in each notice.' },
          criteria: { type: 'string', description: 'When to correct the agent, repeated in each notice.' },
        },
        required: ['action', 'agent_id'],
      },
    })
    return started
  })

  on('tool.describe', { tool: 'Agent' }, async ($, e, next) => {
    const described = await next(e)
    const env = await readEnv($)
    // A CLI started by this mod runs its own subagents on Claude: nothing to choose between.
    if (env.nested) return described
    detected ??= detect($)
    scope ??= loadScope($)
    let timer: { cancel: () => void } | undefined
    const waited = new Promise<undefined>(resolve => {
      timer = $.clock.after(DESCRIBE_WAIT_MS, () => resolve(undefined))
    })
    const [bins, ready] = await Promise.all([Promise.race([detected, waited]), Promise.race([scope, waited])])
    timer?.cancel()
    const { models, fallback } = ready ?? (await scopeNames($))
    const cfg = await loadConfig($)
    const names = namesOf(cfg)
    const agents = bins ? backendsNote(bins, defaultFor(env.fallback, bins, names)) : ''
    let routing = cfg.problems.length ? routingNote(cfg, [], []) : ''
    if (bins && (cfg.gateways.size || cfg.roles.size)) {
      const { usable, gatewayWhy } = await availability($, cfg, bins)
      routing = routingNote(
        cfg,
        [...cfg.gateways.values()].map(gateway => ({ gateway, why: gatewayWhy(gateway.name) })),
        [...cfg.roles.values()].map(role => ({ role, resolved: resolveRole(role, names, usable(false)) })),
      )
    }
    // pi's models are listed when pi is here, or when its settings are all there is to go on.
    const pi = !bins || bins.has('pi') ? (models.length ? scopedNote(models, fallback ?? '') : ANY_MODEL_NOTE) : ''
    return { ...described, description: `${described.description}${AGENT_HEAD}\n${[agents, routing, pi].filter(Boolean).join('\n')}${AGENT_TAIL}` }
  })

  // The engine spawns the agent; the call only leaves behind what its backend needs.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.tool !== 'Agent') return next(e)
    let { type, model: requested } = splitType(e.subagent_type)
    // Claude's own: a fork, a remote agent, a Claude model asked by name.
    if (type === 'fork' || e.isolation === 'remote' || e.model) return next({ ...e, subagent_type: type })
    const env = await readEnv($)
    // A CLI this mod started has its own subagents run by Claude, whatever they ask for.
    if (env.nested) return next({ ...e, subagent_type: type })
    let bins = await (detected ??= detect($))
    const cfg = await loadConfig($)
    const names = namesOf(cfg)
    let route = parseRoute(requested, defaultFor(env.fallback, bins, names), names)
    let fallbacks: Target[] = []
    let role: string | undefined
    if (route.kind === 'role') {
      const r = cfg.roles.get(route.role)!
      role = r.name
      // `@explore` names no type: the role's.
      if ((e.subagent_type ?? '').startsWith('@') && r.type) type = r.type
      // It may have been installed since the session began.
      bins = await (detected = detect($))
      const { usable } = await availability($, cfg, bins)
      const resolved = resolveRole(r, names, usable(false), route.level)
      const [first, ...rest] = resolved.candidates
      if (!first) return { deny: `Nothing the ${r.name} role names can be used now: ${resolved.skipped.map(x => `${x.target}: ${x.why}`).join('; ')}. Name an agent, or set model to run on Claude.` }
      route = first
      fallbacks = rest
    }
    // The Agent tool's own model parameter (opus, sonnet, haiku, fable) runs it on Claude.
    if (route.kind === 'claude') return next((route.model ? { ...e, subagent_type: type, model: route.model } : { ...e, subagent_type: type }) as typeof e)
    if (route.kind === 'error') return { deny: route.error }
    const policy = policyOf(env.permissions)
    if (typeof policy === 'object') return { deny: policy.error }
    const backend: BackendId = route.kind === 'pi' ? 'pi' : route.backend
    // It may have been installed since the session began.
    if (!bins.has(backend)) bins = await (detected = detect($))
    if (route.kind === 'backend' && route.gateway) {
      const why = (await availability($, cfg, bins)).usable(true)(route)
      if (why) return { deny: `The ${route.gateway} gateway cannot be used: ${why}.` }
    } else if (!bins.has(backend)) return { deny: notInstalled(backend, bins) }

    const base = {
      name: e.name,
      type,
      role,
      fallbacks: fallbacks.length ? fallbacks : undefined,
      gateway: route.kind === 'backend' ? route.gateway : undefined,
      backend,
      policy,
      readOnly: isReadOnlyType(type),
      isolated: e.isolation === 'worktree',
      // Read here, in the caller's own hook, where the session's root is the caller's.
      repo: e.isolation === 'worktree' ? await callerRepo($) : undefined,
    }
    let ask: Asked
    if (route.kind === 'pi') {
      scope ??= loadScope($)
      const { models, fallback } = await scope
      // `@default`, like no `@` at all, is pi's default model as it is now, not as the session began.
      const asDefault = parseDefault(route.requested)
      if (asDefault && 'error' in asDefault) return { deny: asDefault.error }
      let model = asDefault ? undefined : route.requested
      if (models.length) {
        const now = await readPiSettings($).then(s => defaultOf(models, s.provider, s.name), () => undefined)
        const named = model ? resolveScoped(model, models) : undefined
        const resolved = named ?? ((now ?? fallback) ? { model: (now ?? fallback)! } : undefined)
        if (resolved && 'error' in resolved) return { deny: resolved.error }
        model = resolved?.model
      }
      // A level written after the model name wins over `effort`; a default model carries none of its own.
      const effort = asDefault?.level ?? e.effort
      const thinking = (!asDefault && hasThinkingSuffix(model)) || !effort || !THINKING_LEVELS.includes(effort) ? undefined : effort
      ask = { ...base, model, thinking }
    } else {
      // A level written after the model name wins over `effort` here too.
      const effort = route.level ?? e.effort
      ask = { ...base, model: route.model, thinking: effort && THINKING_LEVELS.includes(effort) ? effort : undefined }
    }
    asked.set(e.tool_use_id, ask)
    try {
      return await next({ ...e, subagent_type: type })
    } finally {
      asked.delete(e.tool_use_id)
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const ask = asked.get(e.tool_use_id)
    // Read before the spawn: once the engine has made the agent it appends its prompt at once, and
    // the agent must be known by then (nothing is awaited between the spawn and keeping it).
    const env = ask ? await readEnv($) : undefined
    const spawned = await next(e)
    if (ask && env && !e.fork && spawned.agentId) {
      const now = Date.now()
      const a: Agent = {
        ...ask,
        // The subagent inherits its parent's permission mode, which decides how it must report.
        handback: handbackFor(e.permissionMode, env),
        id: spawned.agentId,
        description: e.description,
        status: 'idle',
        bornAt: now,
        runStartedAt: now,
        events: [],
        seq: 1,
        stats: newStats(),
        inbox: early.get(spawned.agentId) ?? [],
      }
      early.delete(a.id)
      agents.set(a.id, a)
      await keep($, a)
    }
    return spawned
  })

  // What the engine hands the agent to read (its prompt, a resume's message) is its backend's next input.
  on('session.append', async ($, e, next) => {
    // A main-loop tool result carries the watch notices that waited for it.
    if (!e.agentId && e.door === 'tool-result' && mainBusy && sections.size && !delivering) {
      const secs = [...sections.entries()]
      const text = noticeText(secs)
      const joined = withNotice(e.message.content, text)
      if (joined) {
        sections.clear()
        const stored = await next({ ...e, message: { ...e.message, content: joined.content } as typeof e.message })
        if (stored.deny !== undefined) putBack(secs)
        else {
          delivered(secs)
          rode.set(joined.id, text)
          $.ui.invalidate('ui.render')
        }
        return stored
      }
    }
    const stored = await next(e)
    const toAgent = e.agentId && !stored.deny && e.message.type === 'user' && e.message.role === 'user' && e.door !== 'tool-result' && e.door !== 'note'
    // A resume after a reload appends its message before the agent's step loads it from the store.
    const text = toAgent ? textOf(e.message.content as { type: string; text?: string }[]) : ''
    // Looked up again after the wait: the agent's spawn may have registered it meanwhile.
    const a = toAgent ? ((await findKept($, e.agentId!)) ?? agents.get(e.agentId!)) : undefined
    if (a && text) a.inbox.push(text)
    // The engine can append an agent's prompt before its spawn has come back to this mod: while one
    // of this mod's Agent calls is under way, it is kept for a while, and the agent takes it when
    // the spawn registers it.
    else if (toAgent && text && asked.size > 0) {
      early.set(e.agentId!, [...(early.get(e.agentId!) ?? []), text])
      $.clock.after(EARLY_KEEP_MS, () => early.delete(e.agentId!))
    }
    return stored
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) mainBusy = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      mainBusy = false
      if (sections.size) void flush($)
    }
    return done
  })

  // The agent's model request: its backend answers it, and no request is sent.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) mainBusy = true
    const a = e.agentId ? await findKept($, e.agentId) : undefined
    if (!a) return yield* next(e)
    // An agent that moved to Claude itself stays there.
    if (a.native) return yield* next({ ...e, model: a.native })
    // A later step of a turn the backend has answered: the engine asks again because the report
    // did not arrive (its nudge after plain last words, or a hand-back it could not take). The
    // answer is given again in the other form; the backend is not run again.
    const prev = a.answered
    if (prev && prev.turnId === e.turnId) {
      a.inbox.splice(0)
      const via = prev.via === 'handback' || prev.tries >= 2 || !a.handback ? 'text' : 'handback'
      return yield* respond(a, e, prev.text, null, 0, via, prev.tries + 1)
    }
    // The backend's own activity records the message as a user row.
    const message = a.inbox.splice(0).join('\n\n') || 'Continue.'
    let beats = 0
    const tried: string[] = []
    for (;;) {
      beats += yield* runBackend($, a, message, next.signal)
      const key = targetKey(targetOf(a))
      const stopped = a.status === 'stopped'
      if (!failedToStart(a.stats, stopped)) {
        if (!a.worked && (a.status === 'completed' || a.stats.steps > 0)) {
          a.worked = true
          a.fallbacks = undefined
          await keep($, a)
        }
        if (a.status === 'completed') await noteHealth($, key, undefined)
        break
      }
      // It never started: a role moves on to its next target, on the agent's first turn only.
      if (a.worked) break
      await noteHealth($, key, a.stats.error)
      const to = a.fallbacks?.shift()
      if (!to) break
      tried.push(`${key}: ${clip(a.stats.error ?? 'failed', 200)}`)
      const items = [{ kind: 'note' as const, summary: clip(`${key} could not start; trying ${targetKey(to)}`, 240), detail: a.stats.error ?? '' }]
      a.seq = pushActivity(a.events, a.seq, Date.now(), items)
      mirror($, a, items)
      if (to.kind === 'claude') {
        a.native = to.model ?? e.model
        await keep($, a)
        publish($, a)
        // A response already begun (beats) cannot be handed over: the next turn goes to Claude.
        if (beats) break
        return yield* next({ ...e, model: a.native })
      }
      moveTo(a, to)
      await keep($, a)
    }
    const failedOver = tried.length ? `\n\n[${a.role ? `role ${a.role}: ` : ''}could not start ${tried.join('; ')}]` : ''
    // Moved to Claude after a response had begun: the step could not be handed over, the next can.
    const onClaude = a.native ? `\n\n[the next message to this agent runs on Claude (${a.native})]` : ''
    const answer = `${answerOf(a, Boolean(a.native)) || `(${labelOf(a)} gave no text)`}${failedOver}${onClaude}`
    // The answer is the block after the beats' (one block holds one kind of piece).
    return yield* respond(a, e, answer, usageOf(a), beats ? BEAT.index + 1 : 0, a.handback ? 'handback' : 'text')
  }).catch(async function* ($, e, next) {
    // An agent run by another backend never falls back to a Claude request.
    if (!e.agentId || !agents.has(e.agentId)) return yield* next(e)
    const a = agents.get(e.agentId)!
    const answer = `pi-subagent failed: ${String(next.error?.message ?? 'unknown error')}`
    // The failed hook's beats stay in the response, in block 0.
    return yield* respond(a, e, answer, null, a.beaten ? BEAT.index + 1 : 0, a.handback ? 'handback' : 'text')
  })

  // A message to an agent while pi works steers pi. Any other backend reads its prompt once,
  // so the engine queues the message for the agent's next turn, which resumes the session;
  // so it does when the agent is idle.
  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    if (e.tool !== 'SendMessage' || typeof e.to !== 'string' || typeof e.message !== 'string') return next(e)
    const found = resolveAgent(agents.values(), e.to)
    const a = found.agent
    if (!a || a.status !== 'running' || !a.cmdFile || !BACKENDS[a.backend].steers) return next(e)
    await appendLine($, a.cmdFile, rpc.steer(e.message))
    return { result: { success: true, message: `Steering message queued for ${a.name ?? a.id}: pi reads it after its current tool calls, before its next model call.` } }
  }).catch(($, e, next) => (next.called ? { deny: `${$.plugin.name}: steering the pi subagent failed.` } : next(e)))

  on('tool.call', { tool: ACTIVITY_TOOL }, async ($, e) => {
    const input = e as unknown as { agent_id?: string; limit?: number; cursor?: string; activity_id?: string; offset?: number }
    if (!input.agent_id) {
      const rows = [...agents.values()].map(
        a =>
          `${a.id}${a.name ? ` (${a.name})` : ''} · ${a.type} · ${a.status} · ${labelOf(a)} · ${a.stats.model ?? a.model ?? 'default model'} · ${a.stats.steps} tool uses${a.watch ? ` · watched every ${a.watch.intervalS}s` : ''} · ${a.description}`,
      )
      return { result: rows.length ? rows.join('\n') : 'No subagents run by another coding agent in this session.' }
    }
    const found = resolveAgent(agents.values(), input.agent_id)
    const a = found.agent
    if (!a) return { deny: found.error ?? 'No such subagent.' }
    if (input.activity_id !== undefined) {
      return { result: detailPage(a.events.find(x => String(x.seq) === String(input.activity_id)), input.offset, input.limit) }
    }
    const head = `${a.id} · ${a.status} · ${labelOf(a)} · ${a.stats.model ?? a.model ?? 'default model'} · ${a.stats.steps} tool uses this run`
    return { result: `${head}\n${activityPage(a.events, a.bornAt, { limit: input.limit, cursor: input.cursor }).text}` }
  }).catch(($, e, next) => ({ deny: `${$.plugin.name}: reading the activity failed.` }))

  on('tool.call', { tool: WATCH_TOOL }, async ($, e) => {
    const input = e as unknown as { action?: string; agent_id?: string; interval_seconds?: number; review_brief?: string; criteria?: string }
    const found = resolveAgent(agents.values(), input.agent_id ?? '')
    const a = found.agent
    if (!a) return { deny: found.error ?? 'No such subagent.' }
    if (input.action === 'status') {
      return { result: a.watch ? `Watching ${a.id} every ${a.watch.intervalS}s; delivered up to event ${a.watch.cursor}.` : `${a.id} is not watched (${a.status}).` }
    }
    if (input.action === 'stop') {
      const had = Boolean(a.watch)
      stopWatch(a)
      showStatus($)
      return { result: had ? `Stopped watching ${a.id}.` : `${a.id} was not watched.` }
    }
    if (input.action !== 'start') return { deny: 'action must be start, stop or status.' }
    if (a.status !== 'running') return { deny: `${a.id} is not working (${a.status}); there is nothing to watch.` }
    const intervalS = clampInterval(input.interval_seconds)
    const updated = Boolean(a.watch)
    a.watch?.timer.cancel()
    a.watch = {
      intervalS,
      brief: input.review_brief ?? a.watch?.brief,
      criteria: input.criteria ?? a.watch?.criteria,
      cursor: a.watch?.cursor ?? 0,
      timer: $.clock.every(intervalS * 1000, () => tick($, a)),
    }
    showStatus($)
    return { result: `${updated ? 'Updated' : 'Started'} watch on ${a.id} every ${intervalS}s; it ends when the agent finishes its turn.` }
  }).catch(($, e, next) => ({ deny: `${$.plugin.name}: the watch request failed.` }))

  // While the transcript of a subagent run by another backend is open (↓, from the tasks list),
  // the band above the prompt shows its latest steps live, in the transcript's colors.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const id = e.props.view.agentId
    if (!id || e.props.hasSurvey) return next(e)
    const live = (await $.state.get({ ...LIVE, id })).value
    if (!live) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const room = Math.max(1, Math.min(LIVE_LINES, e.props.maxRows - 1))
    const color = live.status === 'running' ? 'suggestion' : live.status === 'completed' ? 'success' : live.status === 'idle' ? 'subtle' : 'error'
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold>{live.agent ?? 'pi'}</Text> · {live.model ?? `${live.agent ?? 'pi'}'s default model`} · <Text color={color}>{live.status}</Text> · {live.steps} tool uses ·{' '}
          {live.label}
        </Text>
        {live.lines.slice(-room).map(line => {
          const m = LIVE_MARK[line.kind] ?? { mark: '·', color: 'subtle' }
          return (
            <Text key={String(line.seq)} wrap="truncate-end">
              <Text color={m.color}>{m.mark}</Text> {line.text}
            </Text>
          )
        })}
      </Box>
    )
  })

  // A watch notice prompted to an idle session is drawn as one dim line; ctrl+o shows it whole.
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    if (e.props.isExpanded || e.props.origin.kind !== 'plugin' || !e.props.text.includes(WATCH_TAG)) return next(e)
    const { Text } = $.ui.resolve(e)
    return (
      <Text>
        <Text color="suggestion">⏺</Text> {noticeLine(e.props.text)} <Text dimColor>(ctrl+o to expand)</Text>
      </Text>
    )
  })

  // A notice that rode on a tool result is not in the tool's own output, which the
  // row draws: it gets a summary line under the result, or under the folded group.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const drawn = await next(e)
    const text = rode.get(e.props.tool_use_id)
    if (!text) return drawn
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {drawn}
        {e.props.isExpanded ? (
          <Text>{text}</Text>
        ) : (
          <Text>
            <Text color="suggestion">⏺</Text> {noticeLine(text)} <Text dimColor>(ctrl+o to expand)</Text>
          </Text>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const drawn = await next(e)
    const texts = e.props.calls.flatMap(c => {
      const text = c.tool_use_id ? rode.get(c.tool_use_id) : undefined
      return text ? [text] : []
    })
    if (!texts.length) return drawn
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {drawn}
        {texts.map(t => (
          <Text>
            <Text color="suggestion">⏺</Text> {noticeLine(t)}
          </Text>
        ))}
      </Box>
    )
  })
}
