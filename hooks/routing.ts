// The user's gateways and roles, and how a role picks its agent. Pure: no `$`.
//
// Configuration comes from `~/.claude/polyagent/config.json` and the POLYAGENT_CONFIG
// variable (JSON, or the path of a JSON file), the variable's entries over the file's:
//
//   {
//     "gateways": {
//       "mygw": { "baseUrlEnv": "MYGW_BASE_URL", "keyEnv": "MYGW_API_KEY", "models": ["coding", "explore"] }
//     },
//     "roles": {
//       "explore": { "type": "Explore", "targets": ["agy/gemini-3.8-flash", "mygw/explore", "claude/haiku"] }
//     }
//   }
//
// A gateway is Claude Code pointed at an Anthropic-compatible endpoint; nothing secret is written
// here, only the names of the variables that hold it. A role is a list of targets, best first:
// `@explore` runs on the first usable one and fails over to the next when one cannot start.
import { BACKENDS, BACKEND_IDS, type BackendId, type Gateway, type Names, type Route, isBackendId, parseRoute } from './backends'

export type Role = {
  name: string
  // The agent type a call that names none (`subagent_type: "@explore"`) gets.
  type?: string
  // Targets, best first: `<agent>[/<model>][:<effort>]`, `<gateway>/<model>`, `claude/<model>`.
  targets: string[]
  // Told to the main agent with the role: what it is for, rules for its results.
  description?: string
}

export type Config = {
  gateways: Map<string, Gateway>
  roles: Map<string, Role>
  // What was wrong with the configuration, one line each; the rest of it still counts.
  problems: string[]
}

export type Source = { origin: string; text: string }

export const CONFIG_FILE = '.claude/polyagent/config.json'
// Where the configuration was before the project was Polyagent: read while the new file does not exist.
export const LEGACY_CONFIG_FILE = '.claude/pi-subagent/config.json'

const NAME = /^[a-z][a-z0-9_-]{0,31}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
// Names `@<name>` cannot be given: they already mean something.
const RESERVED = new Set<string>([...BACKEND_IDS, 'claude', 'default', 'native'])
// Variables the gateway's shell sets itself; a gateway's `env` may not.
const MANAGED = new Set(['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])
const SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i

export const emptyConfig = (): Config => ({ gateways: new Map(), roles: new Map(), problems: [] })

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const optString = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

function readGateway(name: string, raw: unknown, where: string, problems: string[]): Gateway | undefined {
  const bad = (why: string) => (problems.push(`${where}: gateway "${name}": ${why}`), undefined)
  if (!isRecord(raw)) return bad('must be an object')
  const baseUrl = optString(raw.baseUrl)
  const baseUrlEnv = optString(raw.baseUrlEnv)
  const keyEnv = optString(raw.keyEnv)
  if (!baseUrl && !baseUrlEnv) return bad('needs baseUrl or baseUrlEnv')
  if (baseUrl && !/^https?:\/\/[^\s/]+/.test(baseUrl)) return bad('baseUrl must be an http(s) URL')
  for (const [field, v] of [['baseUrlEnv', baseUrlEnv], ['keyEnv', keyEnv]] as const) {
    if (v && !ENV_NAME.test(v)) return bad(`${field} must be the name of an environment variable, not its value`)
  }
  const auth = raw.auth === undefined ? 'api-key' : raw.auth
  if (auth !== 'api-key' && auth !== 'bearer') return bad('auth is "api-key" (x-api-key, the default) or "bearer"')
  const env: Record<string, string> = {}
  if (raw.env !== undefined) {
    if (!isRecord(raw.env)) return bad('env must be an object of variables')
    for (const [k, v] of Object.entries(raw.env)) {
      if (!ENV_NAME.test(k) || typeof v !== 'string') return bad(`env.${k} must be a string variable`)
      if (MANAGED.has(k)) return bad(`env.${k} is set from baseUrl/baseUrlEnv/keyEnv; leave it out of env`)
      if (SECRETISH.test(k)) return bad(`env.${k} looks like a secret; put secrets in a variable and name it in keyEnv`)
      env[k] = v
    }
  }
  const model = optString(raw.model)
  const models = Array.isArray(raw.models) ? raw.models.filter((m): m is string => typeof m === 'string' && m.trim() !== '').map(m => m.trim()) : []
  return { name, baseUrl, baseUrlEnv, keyEnv, auth, model, models, env, description: optString(raw.description) }
}

function readRole(name: string, raw: unknown, where: string, problems: string[]): Role | undefined {
  const bad = (why: string) => (problems.push(`${where}: role "${name}": ${why}`), undefined)
  const targets = Array.isArray(raw) ? raw : isRecord(raw) ? raw.targets : undefined
  if (!Array.isArray(targets) || !targets.length || !targets.every(t => typeof t === 'string' && t.trim())) return bad('needs targets: a list of agents, best first')
  const r = isRecord(raw) ? raw : {}
  return { name, type: optString(r.type), targets: targets.map(t => (t as string).trim()), description: optString(r.description) }
}

// The configuration from its sources, later ones over earlier ones name by name.
export function parseConfig(sources: readonly Source[]): Config {
  const cfg = emptyConfig()
  for (const { origin, text } of sources) {
    if (!text.trim()) continue
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (err) {
      cfg.problems.push(`${origin}: not valid JSON (${(err as Error).message})`)
      continue
    }
    if (!isRecord(json)) {
      cfg.problems.push(`${origin}: must be a JSON object with "gateways" and/or "roles"`)
      continue
    }
    for (const [section, read, into] of [
      ['gateways', readGateway, cfg.gateways],
      ['roles', readRole, cfg.roles],
    ] as const) {
      const entries = json[section]
      if (entries === undefined) continue
      if (!isRecord(entries)) {
        cfg.problems.push(`${origin}: "${section}" must be an object of named entries`)
        continue
      }
      for (const [rawName, raw] of Object.entries(entries)) {
        const name = rawName.toLowerCase()
        if (!NAME.test(name)) cfg.problems.push(`${origin}: "${rawName}" is not usable as a name (a-z, 0-9, - and _, starting with a letter)`)
        else if (RESERVED.has(name)) cfg.problems.push(`${origin}: "${rawName}" already means an agent or Claude; choose another name`)
        else {
          const entry = (read as (n: string, r: unknown, w: string, p: string[]) => Gateway | Role | undefined)(name, raw, origin, cfg.problems)
          if (entry) (into as Map<string, Gateway | Role>).set(name, entry)
        }
      }
    }
  }
  for (const name of cfg.roles.keys()) {
    if (cfg.gateways.has(name)) {
      cfg.problems.push(`"${name}" is both a gateway and a role; the gateway wins`)
      cfg.roles.delete(name)
    }
  }
  return cfg
}

export const namesOf = (cfg: Config): Names => ({ gateways: new Set(cfg.gateways.keys()), roles: new Set(cfg.roles.keys()) })

// POLYAGENT_CONFIG holds JSON itself, or names a file that does.
export const configIsInline = (value: string) => value.trimStart().startsWith('{')

// The variables a gateway needs set, for `envSetArgv`.
export const gatewayVars = (g: Gateway): string[] => [g.baseUrlEnv, g.keyEnv].filter((v): v is string => Boolean(v))

// Prints the name of each variable given that is set and not empty. Values are never printed.
export const ENV_SET_SCRIPT = 'for v in "$@"; do [ -n "${!v:-}" ] && printf "%s\\n" "$v"; done; exit 0'

export const envSetArgv = (vars: readonly string[]): string[] => ['bash', '-c', ENV_SET_SCRIPT, 'polyagent', ...vars]

// ---- what a target is, and whether it can be used --------------------------------------------

// A concrete place to run: a backend (a gateway among them), or Claude with a model.
export type Target = Extract<Route, { kind: 'claude' } | { kind: 'backend' } | { kind: 'pi' }>

// The name a target is known by in health records and notes: `agy/gemini-3.8-flash`, `mygw/coding`, `claude/haiku`.
export function targetKey(t: Target): string {
  if (t.kind === 'claude') return `claude${t.model ? `/${t.model}` : ''}`
  if (t.kind === 'pi') return `pi${t.requested ? `/${t.requested}` : ''}`
  return `${t.gateway ?? t.backend}${t.model ? `/${t.model}` : ''}`
}

// Why a target cannot be used now, or nothing when it can be tried.
export type Availability = (t: Target) => string | undefined

export type Resolved = { candidates: Target[]; skipped: { target: string; why: string }[] }

// A role's targets that can be used now, best first, and why the others cannot. The level of
// `@role:<effort>` goes to each target that names none of its own.
export function resolveRole(role: Role, names: Names, usable: Availability, level?: string): Resolved {
  const out: Resolved = { candidates: [], skipped: [] }
  // Roles do not nest: a target is an agent, a gateway, or Claude.
  const flat: Names = { gateways: names.gateways, roles: new Set() }
  for (const text of role.targets) {
    const r = parseRoute(text, { kind: 'claude' }, flat)
    if (r.kind === 'error' || r.kind === 'role') {
      out.skipped.push({ target: text, why: r.kind === 'error' ? r.error : 'roles do not nest' })
      continue
    }
    const t: Target = r.kind === 'backend' && !r.level && level ? { ...r, level } : r
    const why = usable(t)
    if (why) out.skipped.push({ target: text, why })
    else out.candidates.push(t)
  }
  return out
}

// ---- health: targets that could not start are left out for a while ---------------------------

export const HEALTH_TTL_MS = 60 * 60 * 1000

export type Health = { at: number; error: string }

export const healthy = (h: Health | undefined, now: number) => !h || now - h.at >= HEALTH_TTL_MS

// Whether a run ended without ever starting work: an error, no step taken, nothing said. Only
// such a run, on an agent's first turn, moves on to the role's next target: once an agent has
// worked, its session is that backend's, and a retry belongs to the caller.
export function failedToStart(stats: { error?: string; steps: number; answer: string }, stopped: boolean): boolean {
  return !stopped && Boolean(stats.error) && stats.steps === 0 && !stats.answer.trim()
}

// ---- what the main agent is told ----------------------------------------------------------------

export type GatewayState = { gateway: Gateway; why?: string }

export function routingNote(cfg: Config, gateways: readonly GatewayState[], roles: readonly { role: Role; resolved: Resolved }[]): string {
  const lines: string[] = []
  if (gateways.length) {
    lines.push('- Gateways (Claude Code on an Anthropic-compatible API, configured by the user): `@<gateway>/<model>`, optionally `:<effort>`.')
    for (const { gateway: g, why } of gateways) {
      const models = g.models.length ? `models: ${g.models.map(m => `\`${m}\``).join(', ')}` : BACKENDS.gateway.hint
      const dflt = g.model ? `; default \`${g.model}\`` : '; a model is required'
      lines.push(`  - \`@${g.name}\`${why ? ` (unavailable: ${why})` : ''} · ${models}${dflt}${g.description ? ` · ${g.description}` : ''}`)
    }
  }
  if (roles.length) {
    lines.push(
      '- Roles: delegate through a role unless the user names an agent. `subagent_type: "@<role>"` (the role\'s agent type) or `"<type>@<role>"`, optionally `@<role>:<effort>`. The role runs on its first usable target and, when one cannot start, on the next: you need not retry by hand. Check what a delegate reports before you rely on it.',
    )
    for (const { role, resolved } of roles) {
      const chain = resolved.candidates.map(targetKey).join(' → ') || 'nothing usable now'
      const type = role.type ? ` (${role.type})` : ''
      const skipped = resolved.skipped.length ? `; skipped ${resolved.skipped.map(s => `${s.target}: ${s.why}`).join('; ')}` : ''
      lines.push(`  - \`@${role.name}\`${type}: ${chain}${skipped}${role.description ? `. ${role.description}` : ''}`)
    }
  }
  if (cfg.problems.length) lines.push(`- polyagent configuration problems: ${cfg.problems.join(' | ')}`)
  return lines.join('\n')
}

// The backend ids a role target can name, for messages.
export const AGENT_IDS: readonly BackendId[] = BACKEND_IDS.filter(id => id !== 'gateway' && isBackendId(id))
