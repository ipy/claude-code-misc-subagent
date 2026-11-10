import { test, expect } from 'claude-code/testing'
import {
  ENV_SET_SCRIPT,
  HEALTH_TTL_MS,
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

const CONFIG = JSON.stringify({
  gateways: {
    mygw: { baseUrlEnv: 'MYGW_BASE_URL', keyEnv: 'MYGW_API_KEY', models: ['coding', 'explore'], env: { CLAUDE_CODE_EFFORT_LEVEL: 'max' } },
    local: { baseUrl: 'http://localhost:4000', auth: 'bearer', model: 'qwen' },
  },
  roles: {
    explore: { type: 'Explore', targets: ['agy/gemini-3.8-flash', 'mygw/explore', 'claude/haiku'], description: 'Searching code.' },
    coding: ['mygw/coding', 'claude/sonnet'],
  },
})

const parsed = () => parseConfig([{ origin: 'file', text: CONFIG }])

test('parseConfig reads gateways and roles, with defaults filled in', () => {
  const cfg = parsed()
  expect(cfg.problems).toEqual([])
  expect(cfg.gateways.get('mygw')).toEqual({
    name: 'mygw',
    baseUrl: undefined,
    baseUrlEnv: 'MYGW_BASE_URL',
    keyEnv: 'MYGW_API_KEY',
    auth: 'api-key',
    model: undefined,
    models: ['coding', 'explore'],
    env: { CLAUDE_CODE_EFFORT_LEVEL: 'max' },
    description: undefined,
  })
  expect(cfg.gateways.get('local')).toMatchObject({ baseUrl: 'http://localhost:4000', auth: 'bearer', model: 'qwen' })
  // A role is an object with targets, or only the list.
  expect(cfg.roles.get('explore')).toEqual({ name: 'explore', type: 'Explore', targets: ['agy/gemini-3.8-flash', 'mygw/explore', 'claude/haiku'], description: 'Searching code.' })
  expect(cfg.roles.get('coding')).toEqual({ name: 'coding', type: undefined, targets: ['mygw/coding', 'claude/sonnet'], description: undefined })
  expect(namesOf(cfg)).toEqual({ gateways: new Set(['mygw', 'local']), roles: new Set(['explore', 'coding']) })
  expect(gatewayVars(cfg.gateways.get('mygw')!)).toEqual(['MYGW_BASE_URL', 'MYGW_API_KEY'])
  expect(gatewayVars(cfg.gateways.get('local')!)).toEqual([])
})

test('parseConfig: a later source wins name by name, and an empty one counts for nothing', () => {
  const cfg = parseConfig([
    { origin: 'file', text: CONFIG },
    { origin: 'env', text: JSON.stringify({ gateways: { mygw: { baseUrl: 'https://gw.example/anthropic' } } }) },
    { origin: 'blank', text: '  ' },
  ])
  expect(cfg.gateways.get('mygw')).toMatchObject({ baseUrl: 'https://gw.example/anthropic', baseUrlEnv: undefined })
  expect(cfg.gateways.has('local')).toBe(true)
  expect(cfg.problems).toEqual([])
})

test('parseConfig refuses what would leak a secret or clash with a name, and keeps the rest', () => {
  const cfg = parseConfig([
    {
      origin: 'cfg',
      text: JSON.stringify({
        gateways: {
          nourl: { keyEnv: 'K' },
          badurl: { baseUrl: 'api.example.com' },
          valuekey: { baseUrlEnv: 'U', keyEnv: 'sk-live-123' },
          leaky: { baseUrlEnv: 'U', env: { MY_API_KEY: 'sk-live-123' } },
          managed: { baseUrlEnv: 'U', env: { ANTHROPIC_BASE_URL: 'x' } },
          badauth: { baseUrlEnv: 'U', auth: 'basic' },
          codex: { baseUrlEnv: 'U' },
          'Bad Name': { baseUrlEnv: 'U' },
          shared: { baseUrlEnv: 'U' },
          fine: { baseUrlEnv: 'U' },
        },
        roles: { shared: ['fine/x'], empty: [], claude: ['fine/x'], ok: { targets: ['fine/x'] } },
      }),
    },
    { origin: 'broken', text: '{ nope' },
    { origin: 'array', text: '[]' },
  ])
  const text = cfg.problems.join('\n')
  expect(text).toContain('gateway "nourl": needs baseUrl or baseUrlEnv')
  expect(text).toContain('gateway "badurl": baseUrl must be an http(s) URL')
  expect(text).toContain('gateway "valuekey": keyEnv must be the name of an environment variable, not its value')
  expect(text).toContain('env.MY_API_KEY looks like a secret')
  expect(text).toContain('env.ANTHROPIC_BASE_URL is set from')
  expect(text).toContain('gateway "badauth": auth is')
  expect(text).toContain('"codex" already means an agent or Claude')
  expect(text).toContain('"claude" already means an agent or Claude')
  expect(text).toContain('"Bad Name" is not usable as a name')
  expect(text).toContain('"shared" is both a gateway and a role; the gateway wins')
  expect(text).toContain('role "empty": needs targets')
  expect(text).toContain('broken: not valid JSON')
  expect(text).toContain('array: must be a JSON object')
  // No problem line repeats a value it was given for a secret.
  expect(text).not.toContain('sk-live-123')
  expect([...cfg.gateways.keys()].sort()).toEqual(['fine', 'shared'])
  expect([...cfg.roles.keys()]).toEqual(['ok'])
})

test('configIsInline: JSON in the variable, otherwise a path', () => {
  expect(configIsInline('  {"roles":{}}')).toBe(true)
  expect(configIsInline('~/.config/pi-subagent.json')).toBe(false)
})

test('envSetArgv asks bash which variables are set, by name only', () => {
  expect(envSetArgv(['A', 'B'])).toEqual(['bash', '-c', ENV_SET_SCRIPT, 'pi-subagent', 'A', 'B'])
  expect(ENV_SET_SCRIPT).toContain('${!v:-}')
  expect(ENV_SET_SCRIPT).toContain('printf "%s\\n" "$v"')
  expect(ENV_SET_SCRIPT.endsWith('exit 0')).toBe(true)
})

test('resolveRole: usable targets best first, why the others are not, the role\'s effort where a target names none', () => {
  const cfg = parsed()
  const role = cfg.roles.get('explore')!
  const all = resolveRole(role, namesOf(cfg), () => undefined, 'high')
  expect(all.candidates).toEqual([
    { kind: 'backend', backend: 'agy', model: 'gemini-3.8-flash', level: 'high' },
    { kind: 'backend', backend: 'gateway', gateway: 'mygw', model: 'explore', level: 'high' },
    { kind: 'claude', model: 'haiku' },
  ])
  expect(all.candidates.map(targetKey)).toEqual(['agy/gemini-3.8-flash', 'mygw/explore', 'claude/haiku'])
  const some = resolveRole(role, namesOf(cfg), t => (t.kind === 'backend' && t.backend === 'agy' ? 'agy is not installed' : undefined))
  expect(some.candidates.map(targetKey)).toEqual(['mygw/explore', 'claude/haiku'])
  expect(some.skipped).toEqual([{ target: 'agy/gemini-3.8-flash', why: 'agy is not installed' }])
  // A target that is not one, or another role, is skipped with the reason.
  const odd = resolveRole({ name: 'x', targets: ['claude/gpt', 'explore', 'codex:high'] }, namesOf(cfg), () => undefined)
  expect(odd.skipped.map(s => s.target)).toEqual(['claude/gpt'])
  expect(odd.candidates.map(targetKey)).toEqual(['pi/explore', 'codex'])
  // A target's own effort stays.
  expect(resolveRole({ name: 'y', targets: ['codex:low'] }, namesOf(cfg), () => undefined, 'high').candidates).toEqual([{ kind: 'backend', backend: 'codex', model: undefined, level: 'low' }])
})

test('health: a failure to start keeps a target out for an hour', () => {
  expect(healthy(undefined, 5)).toBe(true)
  expect(healthy({ at: 0, error: 'x' }, HEALTH_TTL_MS - 1)).toBe(false)
  expect(healthy({ at: 0, error: 'x' }, HEALTH_TTL_MS)).toBe(true)
})

test('failedToStart: an error with no step and nothing said, unless it was stopped', () => {
  expect(failedToStart({ error: '401', steps: 0, answer: '' }, false)).toBe(true)
  expect(failedToStart({ error: '401', steps: 0, answer: '  ' }, false)).toBe(true)
  expect(failedToStart({ error: '401', steps: 0, answer: '' }, true)).toBe(false)
  expect(failedToStart({ error: 'later', steps: 2, answer: '' }, false)).toBe(false)
  expect(failedToStart({ error: 'later', steps: 0, answer: 'partial' }, false)).toBe(false)
  expect(failedToStart({ steps: 0, answer: 'done' }, false)).toBe(false)
})

test('routingNote tells the main agent the gateways, the roles with their chains, and the problems', () => {
  const cfg = parsed()
  cfg.problems.push('cfg: something')
  const names = namesOf(cfg)
  const note = routingNote(
    cfg,
    [
      { gateway: cfg.gateways.get('mygw')! },
      { gateway: cfg.gateways.get('local')!, why: 'claude is not on PATH' },
    ],
    [...cfg.roles.values()].map(role => ({ role, resolved: resolveRole(role, names, t => (t.kind === 'backend' && t.backend === 'agy' ? 'agy is not installed' : undefined)) })),
  )
  expect(note).toContain('`@mygw` · models: `coding`, `explore`; a model is required')
  expect(note).toContain('`@local` (unavailable: claude is not on PATH)')
  expect(note).toContain('default `qwen`')
  expect(note).toContain('`subagent_type: "@<role>"`')
  expect(note).toContain('`@explore` (Explore): mygw/explore → claude/haiku; skipped agy/gemini-3.8-flash: agy is not installed. Searching code.')
  expect(note).toContain('`@coding`: mygw/coding → claude/sonnet')
  expect(note).toContain('configuration problems: cfg: something')
  expect(routingNote(parseConfig([]), [], [])).toBe('')
})
