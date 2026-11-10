import { test, expect } from 'claude-code/testing'
import {
  BACKENDS,
  BACKEND_IDS,
  DETECT_SCRIPT,
  type BackendId,
  type Ev,
  type Launch,
  type Parser,
  type Gateway,
  type Route,
  AGY_READ_ONLY_SETTINGS,
  AUTH_RESTORE_SCRIPT,
  GATEWAY_SHIM,
  backendsNote,
  defaultRoute,
  detectArgv,
  isBackendId,
  modelProblem,
  parseDetected,
  parseRoute,
  policyOf,
  promptFor,
  stdinOf,
  validSession,
} from './backends'
import { READ_ONLY_NOTE, READ_ONLY_NOTE_ANY, newStats, piCli } from './core'

// ---- the registry ---------------------------------------------------------------------------

test('every backend id has an entry that names itself, with a unique label and executable', () => {
  expect([...BACKEND_IDS].sort()).toEqual(Object.keys(BACKENDS).sort())
  for (const id of BACKEND_IDS) {
    expect(BACKENDS[id].id).toBe(id)
    expect(isBackendId(id)).toBe(true)
    expect(BACKENDS[id].bins.length).toBeGreaterThan(0)
  }
  expect(new Set(BACKEND_IDS.map(id => BACKENDS[id].label)).size).toBe(BACKEND_IDS.length)
  // A gateway is Claude Code pointed elsewhere: the one backend that shares an executable.
  const own = BACKEND_IDS.filter(id => id !== 'gateway').flatMap(id => BACKENDS[id].bins)
  expect(new Set(own).size).toBe(own.length)
  expect(BACKENDS.gateway.bins).toEqual(BACKENDS['claude-code'].bins)
  expect(isBackendId('claude')).toBe(false)
  expect(isBackendId('gemini')).toBe(false)
})

test('only pi takes messages while it works and stays up between turns', () => {
  expect(BACKEND_IDS.filter(id => BACKENDS[id].steers)).toEqual(['pi'])
  expect(BACKEND_IDS.filter(id => BACKENDS[id].persistent)).toEqual(['pi'])
})

test('stdinOf: pi is fed commands, stdin backends read their prompt file, argument backends get nothing', () => {
  expect(stdinOf(BACKENDS.pi)).toBe('feed')
  for (const id of ['claude-code', 'codex', 'codebuddy-code'] as const) expect(stdinOf(BACKENDS[id])).toBe('file')
  for (const id of ['agy', 'opencode'] as const) expect(stdinOf(BACKENDS[id])).toBe('none')
})

test('validSession keeps plain ids and nothing that could pass for a flag', () => {
  expect(validSession('01a1c0e8-8971-7671-b79b-34c5d51b1572')).toBe('01a1c0e8-8971-7671-b79b-34c5d51b1572')
  expect(validSession('ses_e3f19c40fffeB6XdEWZEHfP96W')).toBe('ses_e3f19c40fffeB6XdEWZEHfP96W')
  for (const bad of ['', '-x', '--resume', 'a b', 'a;b', 'a\nb', 7, undefined, null, 'x'.repeat(201)]) expect(validSession(bad)).toBeUndefined()
})

// ---- choosing a backend ---------------------------------------------------------------------

const PI: Route = { kind: 'pi' }
const route = (requested: string | undefined, fallback: Route = PI) => parseRoute(requested, fallback)

test('parseRoute: no @ goes where the default goes, @claude to Claude', () => {
  expect(route(undefined)).toEqual(PI)
  expect(route('')).toEqual(PI)
  expect(route(undefined, { kind: 'claude' })).toEqual({ kind: 'claude' })
  expect(route('claude')).toEqual({ kind: 'claude' })
  expect(route('Claude', { kind: 'backend', backend: 'codex' })).toEqual({ kind: 'claude' })
})

test('parseRoute: a backend id, then its model, then its effort', () => {
  expect(route('codex')).toEqual({ kind: 'backend', backend: 'codex', model: undefined, level: undefined })
  expect(route('codex/gpt-5.5')).toEqual({ kind: 'backend', backend: 'codex', model: 'gpt-5.5', level: undefined })
  expect(route('codex/gpt-5.5:high')).toEqual({ kind: 'backend', backend: 'codex', model: 'gpt-5.5', level: 'high' })
  expect(route('codex:xhigh')).toEqual({ kind: 'backend', backend: 'codex', model: undefined, level: 'xhigh' })
  expect(route('claude-code/opus:max')).toEqual({ kind: 'backend', backend: 'claude-code', model: 'opus', level: 'max' })
  expect(route('codebuddy-code/glm-5.3')).toEqual({ kind: 'backend', backend: 'codebuddy-code', model: 'glm-5.3', level: undefined })
  expect(route('agy/Gemini 3.8 Flash (High)')).toEqual({ kind: 'backend', backend: 'agy', model: 'Gemini 3.8 Flash (High)', level: undefined })
  expect(route('AGY')).toEqual({ kind: 'backend', backend: 'agy', model: undefined, level: undefined })
  expect(route('Codex/GPT-5')).toEqual({ kind: 'backend', backend: 'codex', model: 'GPT-5', level: undefined })
})

test('parseRoute: a colon inside a model name is part of it unless an effort follows', () => {
  expect(route('opencode/ollama/qwen3.5:9b')).toEqual({ kind: 'backend', backend: 'opencode', model: 'ollama/qwen3.5:9b', level: undefined })
  expect(route('opencode/ollama/qwen3.5:9b:high')).toEqual({ kind: 'backend', backend: 'opencode', model: 'ollama/qwen3.5:9b', level: 'high' })
  expect(route('codex/gpt-oss:low')).toEqual({ kind: 'backend', backend: 'codex', model: 'gpt-oss', level: 'low' })
})

test('parseRoute: "backend:" must be followed by an effort, which a model name needs a slash for', () => {
  const bad = route('codex:loud')
  expect(bad.kind).toBe('error')
  expect((bad as { error: string }).error).toContain('codex/<model>')
  expect(route('agy:').kind).toBe('error')
})

test('parseRoute: pi is the default model unless one is named; the rest is pi\'s own syntax', () => {
  expect(route('pi')).toEqual({ kind: 'pi', requested: 'default' })
  expect(route('pi:high')).toEqual({ kind: 'pi', requested: 'default:high' })
  expect(route('pi/acme/model:low')).toEqual({ kind: 'pi', requested: 'acme/model:low' })
  expect(route('zai-coding-cn/glm-5.3')).toEqual({ kind: 'pi', requested: 'zai-coding-cn/glm-5.3' })
  expect(route('glm-5.3:low')).toEqual({ kind: 'pi', requested: 'glm-5.3:low' })
  expect(route('default:high')).toEqual({ kind: 'pi', requested: 'default:high' })
  // Not a backend: the head is only a provider that starts with the same letters.
  expect(route('codexa/model')).toEqual({ kind: 'pi', requested: 'codexa/model' })
})

test('parseRoute and modelProblem refuse a model that could be taken for a flag, or is not a name', () => {
  for (const bad of ['codex/--yolo', 'agy/-x', 'opencode/-m']) {
    const r = route(bad)
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toContain('starts with "-"')
  }
  expect(route(`codex/${'m'.repeat(201)}`).kind).toBe('error')
  expect(route('codex/a\nb').kind).toBe('error')
  expect(modelProblem('gpt-5.5')).toBeUndefined()
  expect(modelProblem('Gemini 3.8 Flash (High)')).toBeUndefined()
  expect(modelProblem('-m')).toContain('starts with "-"')
  expect(modelProblem('a\u0007b')).toContain('not usable')
})

test('defaultRoute: pi when it is installed, else Claude, unless the setting names one', () => {
  const none = new Set<BackendId>()
  const withPi = new Set<BackendId>(['pi', 'codex'])
  expect(defaultRoute(undefined, withPi)).toEqual({ kind: 'pi' })
  expect(defaultRoute('', withPi)).toEqual({ kind: 'pi' })
  expect(defaultRoute(undefined, none)).toEqual({ kind: 'claude' })
  expect(defaultRoute('  ', new Set<BackendId>(['codex']))).toEqual({ kind: 'claude' })
  expect(defaultRoute('claude', withPi)).toEqual({ kind: 'claude' })
  expect(defaultRoute('Native', withPi)).toEqual({ kind: 'claude' })
  expect(defaultRoute('pi', none)).toEqual({ kind: 'pi' })
  expect(defaultRoute(' Codex ', none)).toEqual({ kind: 'backend', backend: 'codex' })
  for (const id of BACKEND_IDS.filter(x => x !== 'pi' && x !== 'gateway')) expect(defaultRoute(id, none)).toEqual({ kind: 'backend', backend: id })
  // A gateway is named by its own name, which only the configuration knows.
  expect(defaultRoute('gateway', none).kind).toBe('error')
  const bad = defaultRoute('gemini', withPi)
  expect(bad.kind).toBe('error')
  expect((bad as { error: string }).error).toContain('PI_SUBAGENT_DEFAULT is "gemini"')
})

test('policyOf: unattended unless guarded is asked for; anything else is an error', () => {
  expect(policyOf(undefined)).toBe('bypass')
  expect(policyOf('')).toBe('bypass')
  expect(policyOf('bypass')).toBe('bypass')
  expect(policyOf(' Guarded ')).toBe('guarded')
  expect(policyOf('yolo')).toEqual({ error: 'PI_SUBAGENT_PERMISSIONS is "yolo"; use bypass or guarded.' })
})

// ---- what is installed ----------------------------------------------------------------------

test('detectArgv asks bash for every executable name once, parseDetected reads the answer', () => {
  const argv = detectArgv()
  expect(argv.slice(0, 4)).toEqual(['bash', '-c', DETECT_SCRIPT, 'pi-subagent'])
  // Each name once: a gateway runs the same claude as claude-code.
  expect(argv.slice(4)).toEqual(['pi', 'claude', 'codex', 'codebuddy-code', 'codebuddy', 'cbc', 'agy', 'opencode'])
  // Only absolute paths count: a shell function or alias of the same name is not an executable.
  expect(DETECT_SCRIPT).toContain('command -v')
  expect(DETECT_SCRIPT).toContain('case "$p" in /*)')
  // The loop's status would be the last name's: a missing last CLI must not void the answer.
  expect(DETECT_SCRIPT.endsWith('; exit 0')).toBe(true)
})

test('parseDetected: the first executable name of each backend that is present', () => {
  const out = parseDetected('pi\t/usr/bin/pi\ncodebuddy\t/x/codebuddy\ncbc\t/x/cbc\ncodex\t/y/codex\n')
  expect([...out.entries()]).toEqual([
    ['pi', 'pi'],
    ['codex', 'codex'],
    ['codebuddy-code', 'codebuddy'],
  ])
  expect(parseDetected('codebuddy-code\t/x\ncodebuddy\t/x\n').get('codebuddy-code')).toBe('codebuddy-code')
  expect(parseDetected('').size).toBe(0)
  expect(parseDetected('unknown\t/z\n\nnoise').size).toBe(0)
})

test('backendsNote lists what is here with how to name a model, what is missing, and where an unmarked call goes', () => {
  const here = new Map<BackendId, string>([
    ['pi', 'pi'],
    ['codex', 'codex'],
    ['agy', 'agy'],
  ])
  const note = backendsNote(here, { kind: 'pi' })
  expect(note).toContain('`@<agent>[/<model>][:<effort>]`')
  expect(note).toContain('Without an `@`, the agent runs on pi.')
  expect(note).toContain('`@pi`')
  expect(note).toContain('`@codex` · Codex CLI')
  expect(note).toContain('`@agy` · Antigravity CLI (agy)')
  expect(note).toContain('Not installed: claude-code, codebuddy-code, opencode.')
  expect(note).not.toContain('`@opencode`')
  expect(note).toContain('`Explore@codex/<model>:high`')
  expect(backendsNote(here, { kind: 'claude' })).toContain('Without an `@`, the agent runs on Claude.')
  expect(backendsNote(here, { kind: 'backend', backend: 'codex' })).toContain('runs on Codex CLI.')
  expect(backendsNote(here, { kind: 'error', error: 'x' })).toContain('PI_SUBAGENT_DEFAULT is not valid')
  const all = new Map(BACKEND_IDS.map(id => [id, BACKENDS[id].bins[0]!] as const))
  expect(backendsNote(all, PI)).not.toContain('Not installed')
  expect(backendsNote(new Map(), { kind: 'claude' })).toContain('None of the supported agent CLIs is installed here')
})

// ---- prompts --------------------------------------------------------------------------------

test('promptFor: a command-looking prompt gets a line before it; a read-only note leads when the CLI has no system prompt flag', () => {
  expect(promptFor(BACKENDS.codex, { prompt: 'fix it', readOnly: false })).toBe('fix it')
  expect(promptFor(BACKENDS.codex, { prompt: '/compact everything', readOnly: false })).toBe('Task:\n/compact everything')
  expect(promptFor(BACKENDS.codex, { prompt: 'look', readOnly: true })).toBe(`${READ_ONLY_NOTE_ANY}\n\nlook`)
  expect(promptFor(BACKENDS.agy, { prompt: 'look', readOnly: true }).startsWith(READ_ONLY_NOTE_ANY)).toBe(true)
  expect(promptFor(BACKENDS.opencode, { prompt: '/x', readOnly: true })).toBe(`${READ_ONLY_NOTE_ANY}\n\nTask:\n/x`)
  // These two take the note as an addition to their system prompt instead.
  for (const id of ['claude-code', 'codebuddy-code', 'pi'] as const) {
    expect(promptFor(BACKENDS[id], { prompt: 'look', readOnly: true })).toBe('look')
  }
})

// ---- starting each CLI ----------------------------------------------------------------------

const GW: Gateway = { name: 'mygw', baseUrlEnv: 'MYGW_BASE_URL', keyEnv: 'MYGW_API_KEY', auth: 'api-key', models: ['coding'], env: { CLAUDE_CODE_EFFORT_LEVEL: 'max' } }

const launch = (patch: Partial<Launch> = {}): Launch => ({ bin: 'x', prompt: 'the task', file: '/p', readOnly: false, policy: 'bypass', ...patch })
const argv = (id: BackendId, patch: Partial<Launch> = {}) => BACKENDS[id].argv(launch({ bin: BACKENDS[id].bins[0]!, ...patch }))
const value = (list: readonly string[], name: string) => list.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1)

test('pi: the same command line as before there were several backends', () => {
  expect(argv('pi', { sessionArgs: ['--session-dir', '/d', '--session-id', 'a1'], model: 'p/m', effort: 'high', readOnly: true })).toEqual(
    piCli({ session: ['--session-dir', '/d', '--session-id', 'a1'], readOnly: true, model: 'p/m', thinking: 'high' }),
  )
  expect(argv('pi')[0]).toBe('pi')
})

test('claude: headless stream-json, resume by id, model, effort, and the permission choice', () => {
  const fresh = argv('claude-code')
  expect(fresh).toEqual(['claude', '-p', '--output-format=stream-json', '--verbose', '--dangerously-skip-permissions'])
  // The task is never an argument: it comes from the prompt file on stdin.
  expect(fresh).not.toContain('the task')
  const full = argv('claude-code', { session: 'abc-123', model: 'opus', effort: 'max' })
  expect(value(full, '--resume')).toBe('abc-123')
  expect(value(full, '--model')).toBe('opus')
  expect(value(full, '--effort')).toBe('max')
  expect(argv('claude-code', { policy: 'guarded' })).toContain('--permission-mode=acceptEdits')
  expect(argv('claude-code', { policy: 'guarded' })).not.toContain('--dangerously-skip-permissions')
})

test('claude: read-only offers only the tools that look, whatever the policy', () => {
  for (const policy of ['bypass', 'guarded'] as const) {
    const ro = argv('claude-code', { readOnly: true, policy })
    expect(ro).toContain('--tools=Read,Grep,Glob,LS')
    expect(ro).toContain(`--append-system-prompt=${READ_ONLY_NOTE_ANY}`)
    expect(ro).not.toContain('--dangerously-skip-permissions')
    expect(ro.some(a => a.startsWith('--permission-mode'))).toBe(false)
  }
})

test('claude and codebuddy: their effort scales are mapped, not copied', () => {
  expect(BACKENDS['claude-code'].effort('minimal')).toBe('low')
  expect(BACKENDS['claude-code'].effort('off')).toBeUndefined()
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) expect(BACKENDS['claude-code'].effort(level)).toBe(level)
  expect(BACKENDS['codebuddy-code'].effort('minimal')).toBe('minimal')
  expect(BACKENDS['codebuddy-code'].effort('off')).toBeUndefined()
  expect(value(argv('claude-code', { effort: 'off' }), '--effort')).toBeUndefined()
  expect(value(argv('claude-code', { effort: 'minimal' }), '--effort')).toBe('low')
})

test('codebuddy: the same flags as Claude Code, under its own executable', () => {
  expect(BACKENDS['codebuddy-code'].bins).toEqual(['codebuddy-code', 'codebuddy', 'cbc'])
  const a = BACKENDS['codebuddy-code'].argv(launch({ bin: 'cbc', session: 's1', model: 'glm-5.3', effort: 'high' }))
  expect(a[0]).toBe('cbc')
  expect(a.slice(1, 4)).toEqual(['-p', '--output-format=stream-json', '--verbose'])
  expect(value(a, '--resume')).toBe('s1')
  expect(value(a, '--model')).toBe('glm-5.3')
  expect(value(a, '--effort')).toBe('high')
  expect(a).toContain('--dangerously-skip-permissions')
  expect(argv('codebuddy-code', { policy: 'guarded' })).toContain('--permission-mode=acceptEdits')
  expect(argv('codebuddy-code', { readOnly: true })).toContain('--tools=Read,Grep,Glob,LS')
})

test('codex: exec with JSON events, the sandbox the policy asks for, and the prompt on stdin', () => {
  const fresh = argv('codex')
  expect(fresh).toEqual([
    'codex', 'exec', '--json', '--skip-git-repo-check',
    '-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"', '-',
  ])
  expect(argv('codex', { policy: 'guarded' })).toContain('sandbox_mode="workspace-write"')
  expect(argv('codex', { readOnly: true })).toContain('sandbox_mode="read-only"')
  expect(argv('codex', { readOnly: true, policy: 'bypass' })).toContain('sandbox_mode="read-only"')
  // Never waits on an approval nobody can give.
  for (const policy of ['bypass', 'guarded'] as const) expect(argv('codex', { policy })).toContain('approval_policy="never"')
})

test('codex: a resume names the thread after the flags, a model and effort are options', () => {
  const resumed = argv('codex', { session: 'thread-1', model: 'gpt-5.5', effort: 'max' })
  expect(resumed.slice(0, 3)).toEqual(['codex', 'exec', 'resume'])
  expect(resumed.slice(-2)).toEqual(['thread-1', '-'])
  expect(value(resumed, '--model')).toBe('gpt-5.5')
  expect(resumed).toContain('model_reasoning_effort="xhigh"')
  expect(argv('codex', { effort: 'off' })).toContain('model_reasoning_effort="none"')
  expect(argv('codex', { effort: 'medium' })).toContain('model_reasoning_effort="medium"')
  expect(argv('codex').some(a => a.startsWith('model_reasoning_effort'))).toBe(false)
})

test('agy: the prompt is one argument bound to its flag, writes need the bypass flag it only gets unattended', () => {
  const fresh = argv('agy')
  expect(fresh).toEqual(['agy', '--output-format=stream-json', '--dangerously-skip-permissions', '--prompt=the task'])
  const resumed = argv('agy', { session: 'conv-1', model: 'Gemini 3.8 Flash (High)', effort: 'minimal' })
  expect(value(resumed, '--conversation')).toBe('conv-1')
  expect(value(resumed, '--model')).toBe('Gemini 3.8 Flash (High)')
  expect(value(resumed, '--effort')).toBe('low')
  // Without the flag agy's headless mode refuses what needs approval: guarded and read-only.
  expect(argv('agy', { policy: 'guarded' })).not.toContain('--dangerously-skip-permissions')
  expect(argv('agy', { readOnly: true })).not.toContain('--dangerously-skip-permissions')
  // Headless agy writes files without asking, so read-only denies writes, commands and MCP tools by rule.
  for (const policy of ['bypass', 'guarded'] as const) {
    expect(JSON.parse(value(argv('agy', { readOnly: true, policy }), '--settings')!)).toEqual({ permissions: { deny: ['write_file(*)', 'command(*)', 'mcp(*)'] } })
  }
  expect(AGY_READ_ONLY_SETTINGS).toContain('write_file(*)')
  expect(argv('agy').some(a => a.startsWith('--settings'))).toBe(false)
  // A prompt that looks like a flag is still only the value of --prompt.
  expect(argv('agy', { prompt: '--help' }).at(-1)).toBe('--prompt=--help')
})

test('opencode: run with JSON events, the prompt after "--", read-only by denying commands and edits', () => {
  const fresh = argv('opencode')
  expect(fresh).toEqual(['opencode', 'run', '--format=json', '--dangerously-skip-permissions', '--', 'the task'])
  const resumed = argv('opencode', { session: 'ses_1', model: 'ollama/qwen3.5:9b', effort: 'high', prompt: '-x', policy: 'guarded' })
  expect(value(resumed, '--session')).toBe('ses_1')
  expect(value(resumed, '--model')).toBe('ollama/qwen3.5:9b')
  expect(value(resumed, '--variant')).toBe('high')
  expect(resumed).not.toContain('--dangerously-skip-permissions')
  expect(resumed.slice(-2)).toEqual(['--', '-x'])
  const ro = argv('opencode', { readOnly: true })
  expect(ro.slice(0, 3)).toEqual(['env', 'OPENCODE_PERMISSION={"bash":"deny","edit":"deny"}', 'opencode'])
  expect(ro).not.toContain('--dangerously-skip-permissions')
})

test('a model name stays one argument for every backend that takes one', () => {
  const name = 'odd name; rm -rf / "x" $(y)'
  for (const id of BACKEND_IDS.filter(x => x !== 'pi' && x !== 'gateway')) {
    const a = argv(id, { model: name })
    expect(a.filter(x => x.includes('rm -rf')).length).toBe(1)
    expect(a.some(x => x === `--model=${name}`)).toBe(true)
  }
  // A gateway also names it in each of Claude Code's model variables, each one whole argument.
  const g = argv('gateway', { model: name, gateway: GW })
  expect(g.filter(x => x.includes('rm -rf')).every(x => x === `--model=${name}` || /^[A-Z_]+_MODEL=/.test(x))).toBe(true)
})

test('a prompt reaches only the backends that take it as an argument, and then as the value of one', () => {
  const secret = 'SECRET-TASK-TEXT'
  for (const id of ['claude-code', 'codex', 'codebuddy-code'] as const) expect(argv(id, { prompt: secret }).join(' ')).not.toContain(secret)
  expect(argv('agy', { prompt: secret }).filter(a => a.includes(secret))).toEqual([`--prompt=${secret}`])
  expect(argv('opencode', { prompt: secret }).filter(a => a.includes(secret))).toEqual([secret])
})

test('read-only notes: pi lists its tools, the others only say what they may not do', () => {
  expect(argv('pi', { readOnly: true })).toContain(READ_ONLY_NOTE)
  expect(READ_ONLY_NOTE_ANY).not.toBe(READ_ONLY_NOTE)
})

// ---- reading each CLI's output --------------------------------------------------------------

// The events of a run, as the parser reads them; what it said of each and what the stats hold after.
function read(parser: Parser, events: Ev[], stats = newStats()) {
  const seen = events.map(ev => parser(ev, stats))
  const items = seen.flatMap(s => s?.items ?? [])
  return { stats, seen, items, kinds: items.map(i => i.kind), summaries: items.map(i => i.summary) }
}

const claude = () => BACKENDS['claude-code'].parser()

test('claude: a run with a tool, its answer, its usage by model, and the session it began', () => {
  const s = 'c0ffee00-0000-4000-8000-000000000001'
  const r = read(claude(), [
    { type: 'system', subtype: 'init', session_id: s, model: 'claude-opus-5-5', cwd: '/repo' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] }, parent_tool_use_id: null },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt\nb.txt', is_error: false }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'There are 2 files.' }] }, parent_tool_use_id: null },
    {
      type: 'result', subtype: 'success', is_error: false, result: 'There are 2 files.', permission_denials: [],
      usage: { input_tokens: 99999, output_tokens: 1 },
      modelUsage: { 'claude-opus-5-5': { inputTokens: 2400, outputTokens: 84, cacheReadInputTokens: 600, cacheCreationInputTokens: 0 } },
    },
  ])
  expect(r.stats.session).toBe(s)
  expect(r.stats.model).toBe('claude-opus-5-5')
  expect(r.stats.steps).toBe(1)
  expect(r.stats.answer).toBe('There are 2 files.')
  expect(r.stats.settled).toBe(true)
  expect(r.stats.error).toBeUndefined()
  // modelUsage is what means the same for every CLI that speaks this protocol; `usage` is not read when it is there.
  expect(r.stats.usage).toEqual({ input: 2400, output: 84, cacheRead: 600, cacheWrite: 0 })
  expect(r.kinds).toEqual(['tool', 'result', 'text'])
  expect(r.summaries[0]).toBe('Bash {"command":"ls"}')
  // A tool is in flight from its call to its result, and only then.
  expect(r.seen[1]?.busy).toBe(true)
  expect(r.seen[1]?.tool).toBe('Bash')
  expect(r.seen[2]?.busy).toBe(false)
  expect(r.seen[4]?.busy).toBe(false)
})

test('claude: a refused tool is counted once, however many times it is told', () => {
  const r = read(claude(), [
    { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'touch x' } }] } },
    { type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't1', message: 'touch needs approval' },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Permission to use Bash has been denied because this tool requires approval', is_error: true }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'I could not.' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'I could not.', permission_denials: [{ tool_name: 'Bash', tool_use_id: 't1' }] },
  ])
  expect(r.stats.denied).toEqual(['Bash'])
  expect(r.kinds).toContain('error')
  expect(r.summaries.some(x => x.startsWith('permission denied: Bash'))).toBe(true)
})

test('claude: model retries are shown, a failing result is the error and not the answer', () => {
  const r = read(claude(), [
    { type: 'system', subtype: 'init', session_id: 's1', model: 'm' },
    { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 579, error_status: 401, error: 'authentication_failed' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Invalid API key' }] } },
    { type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key', api_error_status: 401 },
  ])
  expect(r.items[0]).toMatchObject({ kind: 'retry' })
  expect(r.summaries[0]).toContain('authentication_failed 401')
  expect(r.summaries[0]).toContain('retry 1/10 in 1s')
  expect(r.stats.error).toBe('Invalid API key')
  expect(r.stats.answer).toBe('')
  expect(r.stats.settled).toBe(true)
  const maxTurns = read(claude(), [{ type: 'result', subtype: 'error_max_turns', is_error: false, result: '' }])
  expect(maxTurns.stats.error).toBe('error_max_turns')
})

test('claude: what a nested agent says is not the answer, and a later success clears an earlier failure', () => {
  const r = read(claude(), [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'inner' }] }, parent_tool_use_id: 'toolu_outer' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'n1', name: 'Read', input: {} }] }, parent_tool_use_id: 'toolu_outer' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'outer' }] }, parent_tool_use_id: null },
  ])
  expect(r.stats.answer).toBe('outer')
  expect(r.summaries[1]).toContain('↳ Read')
  const failedThenFine = newStats()
  failedThenFine.error = 'earlier'
  read(claude(), [{ type: 'result', subtype: 'success', is_error: false, result: 'fine' }], failedThenFine)
  expect(failedThenFine.error).toBeUndefined()
  expect(failedThenFine.answer).toBe('fine')
})

test('claude: usage falls back to the result\'s own when no model is listed; junk events are ignored', () => {
  const r = read(claude(), [
    { type: 'result', subtype: 'success', is_error: false, result: 'x', usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } },
  ])
  expect(r.stats.usage).toEqual({ input: 10, output: 2, cacheRead: 3, cacheWrite: 4 })
  expect(read(claude(), [{ type: 'system', subtype: 'hook_started' }, { type: 'stream_event' }, { type: 'rate_limit_event' }, {}]).items).toEqual([])
  expect(read(claude(), [{ type: 'system', subtype: 'compact_boundary' }]).kinds).toEqual(['note'])
  // An id that could pass for a flag is not kept.
  expect(read(claude(), [{ type: 'system', subtype: 'init', session_id: '--dangerous' }]).stats.session).toBeUndefined()
})

test('codebuddy: a refusal is read from the tool result, as its own list of denials stays empty', () => {
  const parser = BACKENDS['codebuddy-code'].parser()
  const r = read(parser, [
    { type: 'system', subtype: 'init', session_id: 'cb1', model: 'hy4free' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'touch cb-guarded.txt .' } }] } },
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x1', is_error: true, content: [{ type: 'text', text: 'Error: Permission to use Bash has been denied because this tool requires approval but permission' }] }] },
    },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'It was blocked.' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'It was blocked.', permission_denials: [], modelUsage: { hy4free: { inputTokens: 15182, outputTokens: 631, cacheReadInputTokens: 32768, cacheCreationInputTokens: 0 } } },
  ])
  expect(r.stats.denied).toEqual(['Bash'])
  expect(r.stats.model).toBe('hy4free')
  expect(r.stats.usage.input).toBe(15182)
  expect(r.stats.usage.cacheRead).toBe(32768)
  expect(r.summaries.some(x => x.startsWith('Bash failed:'))).toBe(true)
  // Other failures of a tool are not refusals.
  const other = read(BACKENDS['codebuddy-code'].parser(), [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'y1', name: 'Bash', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'y1', is_error: true, content: 'Exit code 1' }] } },
  ])
  expect(other.stats.denied).toEqual([])
})

const codex = () => BACKENDS.codex.parser()

test('codex: a command, its output, the message, usage with cached input counted apart', () => {
  const r = read(codex(), [
    { type: 'thread.started', thread_id: '01a1c0e8-e44f-77c1-b6d8-10be11609137' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'I should list the files.' } },
    { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: '/bin/zsh -lc ls', aggregated_output: '', exit_code: null, status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: '/bin/zsh -lc ls', aggregated_output: 'a.txt\nb.txt\n', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Two files.' } },
    { type: 'turn.completed', usage: { input_tokens: 29583, cached_input_tokens: 20000, output_tokens: 61 } },
  ])
  expect(r.stats.session).toBe('01a1c0e8-e44f-77c1-b6d8-10be11609137')
  expect(r.stats.steps).toBe(1)
  expect(r.stats.answer).toBe('Two files.')
  expect(r.stats.settled).toBe(true)
  expect(r.stats.usage).toEqual({ input: 9583, output: 61, cacheRead: 20000, cacheWrite: 0 })
  expect(r.kinds).toEqual(['tool', 'result', 'text'])
  expect(r.summaries[0]).toBe('shell {"command":"ls"}')
  expect(r.summaries[1]).toBe('shell: a.txt b.txt')
  expect(r.seen[3]?.busy).toBe(true)
  expect(r.seen[4]?.busy).toBe(false)
  expect(r.seen[3]?.tool).toBe('shell')
})

test('codex: a local model that answers in its reasoning has that as the answer, unless a message came', () => {
  const answered = read(codex(), [
    { type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'The first file I saw was `a.txt`.' } },
    { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } },
  ])
  expect(answered.stats.answer).toBe('The first file I saw was `a.txt`.')
  const better = read(codex(), [
    { type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'thinking' } },
    { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'the message' } },
    { type: 'turn.completed', usage: {} },
  ])
  expect(better.stats.answer).toBe('the message')
  // A run's own reasoning is not carried over to the next run.
  const nothing = read(codex(), [{ type: 'turn.completed', usage: {} }])
  expect(nothing.stats.answer).toBe('')
})

test('codex: reconnects are retries, the failure after them is the error, once', () => {
  const r = read(codex(), [
    { type: 'thread.started', thread_id: 't1' },
    { type: 'turn.started' },
    { type: 'error', message: "Reconnecting... 1/5 (stream disconnected before completion: model 'x' not found)" },
    { type: 'error', message: "Reconnecting... 2/5 (stream disconnected before completion: model 'x' not found)" },
    { type: 'error', message: "stream disconnected before completion: model 'x' not found" },
    { type: 'turn.failed', error: { message: "stream disconnected before completion: model 'x' not found" } },
  ])
  expect(r.kinds).toEqual(['retry', 'retry', 'error'])
  expect(r.stats.error).toBe("stream disconnected before completion: model 'x' not found")
  expect(r.stats.settled).toBe(true)
  expect(r.summaries[0]).toContain('Reconnecting... 1/5')
})

test('codex: a failed command and a file change read as results; a warning is only a note', () => {
  const r = read(codex(), [
    { type: 'item.completed', item: { id: 'a', type: 'command_execution', command: 'false', aggregated_output: '', exit_code: 1, status: 'failed' } },
    { type: 'item.completed', item: { id: 'b', type: 'file_change', changes: [{ path: 'x.txt', kind: 'add' }], status: 'completed' } },
    { type: 'item.completed', item: { id: 'c', type: 'error', message: 'beta feature' } },
    { type: 'item.completed', item: { id: 'd', type: 'mcp_tool_call', server: 'fs', tool: 'read', arguments: { p: 1 }, error: { message: 'boom' }, status: 'failed' } },
    { type: 'item.completed', item: { id: 'e', type: 'web_search', query: 'q' } },
  ])
  expect(r.stats.steps).toBe(4)
  expect(r.kinds).toEqual(['tool', 'error', 'tool', 'result', 'note', 'tool', 'error', 'tool', 'result'])
  expect(r.summaries[1]).toBe('shell failed: (no output)')
  expect(r.summaries[3]).toBe('apply_patch: add x.txt')
  expect(r.summaries[5]).toBe('fs.read {"p":1}')
  expect(r.summaries[6]).toBe('fs.read failed: boom')
})

const agy = () => BACKENDS.agy.parser()

test('agy: a tool step from active to done, the answer from deltas, usage once per step', () => {
  const step = (step_update: Record<string, unknown>) => ({ event: 'step_update', step_update }) as Ev
  const r = read(agy(), [
    { event: 'init', conversation_id: '5b349ca9-aa71-4137-8169-e5053c3d40e0' },
    step({ step_index: 0, state: 'DONE', step_type: 'user_input' }),
    step({ step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 7730, output_tokens: 479, cache_read_tokens: 0 } }),
    step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_file', tool_info: { name: 'write_file', parameters: { Path: '/x/plan.md' } } }),
    step({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'write_file', tool_info: { name: 'write_file', parameters: { Path: '/x/plan.md' } } }),
    step({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'I have creat' }),
    step({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'ed it.' }),
    step({ step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '\n', usage: { input_tokens: 2638, output_tokens: 106, cache_read_tokens: 5676 } }),
    // The conversation's total, which is not added again.
    { event: 'result', result: { conversation_id: '5b349ca9-aa71-4137-8169-e5053c3d40e0', status: 'SUCCESS', response: 'I have created it.\n', usage: { input_tokens: 10368, output_tokens: 585 } } },
  ])
  expect(r.stats.session).toBe('5b349ca9-aa71-4137-8169-e5053c3d40e0')
  expect(r.stats.steps).toBe(1)
  expect(r.stats.answer).toBe('I have created it.\n')
  expect(r.stats.settled).toBe(true)
  expect(r.stats.usage).toEqual({ input: 7730 + 2638, output: 479 + 106, cacheRead: 5676, cacheWrite: 0 })
  expect(r.kinds).toEqual(['tool', 'result', 'text'])
  expect(r.summaries[0]).toBe('write_file {"Path":"/x/plan.md"}')
  expect(r.seen[3]).toMatchObject({ busy: true, tool: 'write_file' })
  expect(r.seen[4]?.busy).toBe(false)
})

test('agy: a refused action is reported and leaves no answer; an error result is the error', () => {
  const denied = read(agy(), [
    { event: 'init', conversation_id: 'c1' },
    { event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_file', tool_info: { name: 'write_file', parameters: { Path: 'x' } } } },
    { event: 'step_update', step_update: { step_index: 1, state: 'ERROR', step_type: 'tool', tool_name: 'write_file', tool_info: { name: 'write_file', parameters: { Path: 'x' } } } },
    { event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: '', denied_actions: [{ action: 'write_file', display_name: 'WriteFile' }] } },
  ])
  expect(denied.stats.denied).toEqual(['WriteFile'])
  expect(denied.stats.answer).toBe('')
  expect(denied.stats.error).toBeUndefined()
  expect(denied.kinds).toEqual(['tool', 'error'])
  const bad = read(agy(), [
    { event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: 'invalid model selection: model x is not recognized' } },
  ])
  expect(bad.stats.error).toBe('invalid model selection: model x is not recognized')
  expect(bad.stats.settled).toBe(true)
  expect(bad.stats.session).toBeUndefined()
  expect(read(agy(), [{ event: 'result', result: { status: 'ERROR' } }]).stats.error).toBe('agy reported an error')
})

const opencode = () => BACKENDS.opencode.parser()

test('opencode: a step with a tool then a step with the answer; only a step that is not a hand-off to tools ends the run', () => {
  const sid = 'ses_e3f19c40fffeB6XdEWZEHfP96W'
  const r = read(opencode(), [
    { type: 'step_start', sessionID: sid, part: { type: 'step-start' } },
    { type: 'tool_use', sessionID: sid, part: { type: 'tool', tool: 'write', state: { status: 'completed', input: { content: 'hello', filePath: '/x/created.txt' }, output: 'Wrote file successfully.' } } },
    { type: 'step_finish', sessionID: sid, part: { reason: 'tool-calls', tokens: { input: 13131, output: 75, reasoning: 0, cache: { write: 0, read: 0 } } } },
    { type: 'step_start', sessionID: sid, part: { type: 'step-start' } },
    { type: 'text', sessionID: sid, part: { type: 'text', text: 'done' } },
    { type: 'step_finish', sessionID: sid, part: { reason: 'stop', tokens: { input: 13199, output: 25, reasoning: 7, cache: { write: 3, read: 5 } } } },
  ])
  expect(r.stats.session).toBe(sid)
  expect(r.stats.steps).toBe(1)
  expect(r.stats.answer).toBe('done')
  expect(r.stats.settled).toBe(true)
  expect(r.stats.usage).toEqual({ input: 13131 + 13199, output: 75 + 25 + 7, cacheRead: 5, cacheWrite: 3 })
  expect(r.kinds).toEqual(['tool', 'result', 'text'])
  expect(r.summaries[1]).toBe('write: Wrote file successfully.')
  expect(r.seen[0]?.busy).toBe(true)
  expect(r.seen[2]?.busy).toBe(false)
  expect(r.seen[1]?.tool).toBe('write')
  // The first step hands over to tools: the run is not over there.
  expect(read(opencode(), [{ type: 'step_finish', part: { reason: 'tool-calls', tokens: {} } }]).stats.settled).toBe(false)
})

test('opencode: only the last step\'s words are the answer; a refused tool is reported', () => {
  const r = read(opencode(), [
    { type: 'step_start', sessionID: 's', part: {} },
    { type: 'text', sessionID: 's', part: { text: 'Let me look.' } },
    { type: 'tool_use', sessionID: 's', part: { tool: 'read', state: { status: 'error', input: { filePath: '/proc/self/mountinfo' }, error: 'The user rejected permission to use this specific tool call.' } } },
    { type: 'step_finish', sessionID: 's', part: { reason: 'tool-calls', tokens: {} } },
    { type: 'step_start', sessionID: 's', part: {} },
    { type: 'text', sessionID: 's', part: { text: 'I was not allowed to read it.' } },
    { type: 'step_finish', sessionID: 's', part: { reason: 'stop', tokens: {} } },
  ])
  expect(r.stats.answer).toBe('I was not allowed to read it.')
  expect(r.stats.denied).toEqual(['read'])
  expect(r.kinds).toEqual(['text', 'tool', 'error', 'text'])
  const rule = read(opencode(), [
    { type: 'tool_use', part: { tool: 'bash', state: { status: 'error', input: {}, error: 'The user has specified a rule which prevents you from using this specific tool call.' } } },
  ])
  expect(rule.stats.denied).toEqual(['bash'])
  // A tool that failed for its own reasons is not a refusal.
  expect(read(opencode(), [{ type: 'tool_use', part: { tool: 'bash', state: { status: 'error', input: {}, error: 'The bash tool was called with invalid arguments' } } }]).stats.denied).toEqual([])
})

test('opencode: a run that ends on its last message, with no closing step event, has that message as its answer', () => {
  // As opencode 1.15.10 printed it with a local Ollama model: the last event is the text, and the process then exits 0.
  const ended = read(opencode(), [
    { type: 'step_start', sessionID: 's', part: {} },
    { type: 'tool_use', sessionID: 's', part: { tool: 'write', state: { status: 'completed', input: { filePath: 'hello.txt' }, output: 'Wrote file successfully.' } } },
    { type: 'step_finish', sessionID: 's', part: { reason: 'tool-calls', tokens: {} } },
    { type: 'step_start', sessionID: 's', part: {} },
    { type: 'text', sessionID: 's', part: { text: 'DONE.' } },
  ])
  expect(ended.stats.answer).toBe('DONE.')
  // Whether that was the end is for the process's exit to say, not the parser.
  expect(ended.stats.settled).toBe(false)
  // Words before a hand-off to tools, words of a step that is over, and blank words are not an answer.
  const answerAfter = (events: object[]) => read(opencode(), events).stats.answer
  expect(answerAfter([{ type: 'text', part: { text: 'Let me look.' } }, { type: 'step_finish', part: { reason: 'tool-calls', tokens: {} } }])).toBe('')
  expect(answerAfter([{ type: 'text', part: { text: 'first' } }, { type: 'step_start', part: {} }])).toBe('')
  expect(answerAfter([{ type: 'step_start', part: {} }, { type: 'text', part: { text: '  \n' } }])).toBe('')
  // Words that arrive in pieces add up.
  expect(answerAfter([{ type: 'text', part: { text: 'DO' } }, { type: 'text', part: { text: 'NE.' } }])).toBe('DONE.')
})

test('opencode: the first error is the reason, a later one only repeats that something went wrong', () => {
  const r = read(opencode(), [
    { type: 'error', sessionID: 's', error: { name: 'UnknownError', data: { message: 'Model not found: ollama/x.' } } },
    { type: 'error', sessionID: 's', error: { name: 'UnknownError', data: { message: 'Unexpected server error. Check server logs for details.', ref: 'err_1' } } },
  ])
  expect(r.stats.error).toBe('Model not found: ollama/x.')
  expect(r.kinds).toEqual(['error', 'error'])
  expect(read(opencode(), [{ type: 'error', error: { name: 'APIError' } }]).stats.error).toBe('APIError')
})

const pi = () => BACKENDS.pi.parser()

test('pi: tools in flight keep the run beating, a turn that ends stops it, dialogs are cancelled', () => {
  const r = read(pi(), [
    { type: 'tool_execution_start', toolName: 'bash', args: { command: 'sleep 99' } },
    { type: 'tool_execution_start', toolName: 'read', args: { path: 'a' } },
    { type: 'tool_execution_end', toolName: 'read', result: { content: [{ type: 'text', text: 'x' }] }, isError: false },
    { type: 'message_update', assistantMessageEvent: {} },
    { type: 'tool_execution_update', toolName: 'bash' },
    { type: 'turn_end', message: {}, toolResults: [] },
    { type: 'extension_ui_request', id: 'q1', method: 'confirm' },
    { type: 'extension_ui_request', id: 'q2', method: 'notify' },
  ])
  expect(r.seen[0]).toMatchObject({ busy: true, tool: 'bash' })
  expect(r.seen[1]).toMatchObject({ busy: true, tool: 'read' })
  // One of the two tools is still running.
  expect(r.seen[2]?.busy).toBe(true)
  // Streaming partials are dropped.
  expect(r.seen[3]).toBeUndefined()
  expect(r.seen[4]).toBeUndefined()
  // Its end never came, but its turn did.
  expect(r.seen[5]?.busy).toBe(false)
  expect(JSON.parse(r.seen[6]?.reply ?? '{}')).toEqual({ type: 'extension_ui_response', id: 'q1', cancelled: true })
  expect(r.seen[7]?.reply).toBeUndefined()
  expect(r.stats.steps).toBe(2)
})

test('pi: the answer, usage and the end of the run come from the events as before', () => {
  const r = read(pi(), [
    { type: 'message_end', message: { role: 'assistant', provider: 'p', model: 'm', stopReason: 'stop', content: [{ type: 'text', text: 'pi says hi' }], usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0 } } },
    { type: 'agent_settled', aborted: false },
  ])
  expect(r.stats.answer).toBe('pi says hi')
  expect(r.stats.model).toBe('p/m')
  expect(r.stats.usage).toEqual({ input: 100, output: 20, cacheRead: 5, cacheWrite: 0 })
  expect(r.stats.settled).toBe(true)
})

test('every parser survives events of the wrong shape', () => {
  const junk: Ev[] = [
    {},
    { type: null },
    { type: 'assistant', message: null },
    { type: 'assistant', message: { content: 'text' } },
    { type: 'user', message: { content: [null, 3, { type: 'tool_result' }] } },
    { type: 'result', modelUsage: 5, permission_denials: 'x' },
    { type: 'item.completed', item: null },
    { type: 'item.started', item: { type: 'command_execution' } },
    { type: 'turn.completed', usage: 'many' },
    { event: 'step_update', step_update: null },
    { event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_info: 7 } },
    { event: 'result', result: { denied_actions: 'x' } },
    { type: 'tool_use', part: null },
    { type: 'step_finish', part: { tokens: { cache: 4 } } },
    { type: 'error', error: null },
  ]
  for (const id of BACKEND_IDS) {
    const parser = BACKENDS[id].parser()
    const stats = newStats()
    for (const ev of junk) expect(() => parser(ev, stats)).not.toThrow()
  }
})

// ---- gateways: Claude Code on an Anthropic-compatible API ------------------------------------

const SHIM_ARGS = 4

test('gateway: Claude Code started through the shim, which reads the URL and key from the variables the gateway names', () => {
  const a = argv('gateway', { model: 'coding', gateway: GW })
  expect(a.slice(0, 4)).toEqual(['bash', '-c', GATEWAY_SHIM, 'pi-subagent-gateway'])
  // <base url> <base url variable> <key variable> <variable for the key>
  expect(a.slice(4, 4 + SHIM_ARGS)).toEqual(['', 'MYGW_BASE_URL', 'MYGW_API_KEY', 'ANTHROPIC_API_KEY'])
  expect(a.slice(8)).toEqual([
    'env',
    'CLAUDE_CODE_EFFORT_LEVEL=max',
    'ANTHROPIC_MODEL=coding',
    'ANTHROPIC_DEFAULT_OPUS_MODEL=coding',
    'ANTHROPIC_DEFAULT_SONNET_MODEL=coding',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL=coding',
    'CLAUDE_CODE_SUBAGENT_MODEL=coding',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    'claude',
    '-p',
    '--output-format=stream-json',
    '--verbose',
    '--model=coding',
    '--dangerously-skip-permissions',
  ])
  expect(stdinOf(BACKENDS.gateway)).toBe('file')
})

test('gateway: the shim drops the session\'s own credentials and CLAUDE_CODE_REMOTE, and stops when a variable is missing', () => {
  for (const v of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_REMOTE']) expect(GATEWAY_SHIM).toContain(v)
  expect(GATEWAY_SHIM).toContain('unset ')
  expect(GATEWAY_SHIM).toContain('${!2:-}')
  expect(GATEWAY_SHIM).toContain('${!3:-}')
  expect(GATEWAY_SHIM).toContain('exit 78')
  expect(GATEWAY_SHIM.endsWith('exec "$@"')).toBe(true)
  // Only variable names are ever passed: the shim never echoes a value.
  expect(GATEWAY_SHIM).not.toMatch(/echo[^;]*\$(url|key)\b/)
})

test('gateway: a literal URL, bearer auth, no key, the default model, read-only, resume and effort', () => {
  const g: Gateway = { name: 'local', baseUrl: 'http://localhost:4000', auth: 'bearer', model: 'qwen', models: [], env: {} }
  const a = argv('gateway', { gateway: g, readOnly: true, session: 'fc0c2db6-5ae9-46df-9a0c-f4cdc67c346d', effort: 'minimal' })
  expect(a.slice(4, 8)).toEqual(['http://localhost:4000', '', '', 'ANTHROPIC_AUTH_TOKEN'])
  expect(a).toContain('ANTHROPIC_MODEL=qwen')
  expect(value(a, '--model')).toBe('qwen')
  expect(value(a, '--tools')).toBe('Read,Grep,Glob,LS')
  expect(value(a, '--resume')).toBe('fc0c2db6-5ae9-46df-9a0c-f4cdc67c346d')
  expect(value(a, '--effort')).toBe('low')
  expect(a).not.toContain('--dangerously-skip-permissions')
  // No model anywhere: Claude Code's own.
  const bare = argv('gateway', { gateway: { ...g, model: undefined } })
  expect(bare.some(x => x.startsWith('ANTHROPIC_MODEL') || x.startsWith('--model'))).toBe(false)
  expect(() => argv('gateway')).toThrow()
})

test('parseRoute: configured gateways and roles, after the agents; claude/<model> is Claude with a model', () => {
  const names = { gateways: new Set(['mygw']), roles: new Set(['explore']) }
  const r = (s: string) => parseRoute(s, PI, names)
  expect(r('mygw/coding')).toEqual({ kind: 'backend', backend: 'gateway', gateway: 'mygw', model: 'coding', level: undefined })
  expect(r('MyGW/explore:high')).toEqual({ kind: 'backend', backend: 'gateway', gateway: 'mygw', model: 'explore', level: 'high' })
  expect(r('mygw/openai/gpt-x')).toEqual({ kind: 'backend', backend: 'gateway', gateway: 'mygw', model: 'openai/gpt-x', level: undefined })
  expect(r('mygw')).toEqual({ kind: 'backend', backend: 'gateway', gateway: 'mygw', model: undefined, level: undefined })
  expect(r('mygw:fast').kind).toBe('error')
  expect(r('explore')).toEqual({ kind: 'role', role: 'explore', level: undefined })
  expect(r('explore:high')).toEqual({ kind: 'role', role: 'explore', level: 'high' })
  expect(r('explore/x').kind).toBe('error')
  expect(r('claude')).toEqual({ kind: 'claude' })
  expect(r('claude/Haiku')).toEqual({ kind: 'claude', model: 'haiku' })
  expect(r('claude/gpt').kind).toBe('error')
  expect(r('claude:high').kind).toBe('error')
  expect(r('gateway/x').kind).toBe('error')
  expect((r('gateway/x') as { error: string }).error).toContain('mygw')
  // Unknown names are still pi models; without a configuration gateways are not known.
  expect(r('acme/model')).toEqual({ kind: 'pi', requested: 'acme/model' })
  expect(parseRoute('mygw/coding', PI)).toEqual({ kind: 'pi', requested: 'mygw/coding' })
  expect(r('codex/gpt-5.5')).toEqual({ kind: 'backend', backend: 'codex', model: 'gpt-5.5', level: undefined })
})

test('backendsNote leaves gateways to the configuration\'s own note, and names a role or gateway default', () => {
  const here = new Map<BackendId, string>([['claude-code', 'claude'], ['gateway', 'claude']])
  const note = backendsNote(here, { kind: 'role', role: 'explore' })
  expect(note).toContain('Without an `@`, the agent runs on the explore role.')
  expect(note).not.toContain('`@gateway`')
  expect(note).not.toContain('gateway,')
  expect(backendsNote(here, { kind: 'backend', backend: 'gateway', gateway: 'mygw' })).toContain('runs on the mygw gateway.')
})

// `claude -p --output-format=stream-json --verbose --model explore --tools=Read,Grep,Glob,LS` against an
// Anthropic-compatible gateway (Claude Code 2.1.319), trimmed to the fields that matter; ids and the
// upstream model name replaced, thinking signatures dropped.
const GATEWAY_RUN = String.raw`{"type":"system","subtype":"init","cwd":"/tmp/cap","session_id":"fc0c2db6-5ae9-46df-9a0c-f4cdc67c346d","tools":["Glob","Grep","Read"],"model":"explore","permissionMode":"default","apiKeySource":"ANTHROPIC_API_KEY","claude_code_version":"2.1.319"}
{"type":"assistant","message":{"id":"msg_01","type":"message","role":"assistant","model":"upstream-model-1","content":[{"type":"thinking","thinking":"The user wants me to read a.txt and tell them its contents in one line.  I'll read the file."}],"stop_reason":null,"usage":{"input_tokens":4854,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}},"parent_tool_use_id":null,"session_id":"fc0c2db6-5ae9-46df-9a0c-f4cdc67c346d"}
{"type":"assistant","message":{"id":"msg_01","type":"message","role":"assistant","model":"upstream-model-1","content":[{"type":"tool_use","id":"call_wur43ro2czg8li7rvthpr9yh","name":"Read","input":{"file_path":"/tmp/cap/a.txt"}}],"stop_reason":null,"usage":{"input_tokens":4854,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}},"parent_tool_use_id":null,"session_id":"fc0c2db6-5ae9-46df-9a0c-f4cdc67c346d"}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"call_wur43ro2czg8li7rvthpr9yh","type":"tool_result","content":"1\thello world\n2\t"}]},"parent_tool_use_id":null,"session_id":"fc0c2db6-5ae9-46df-9a0c-f4cdc67c346d"}
{"type":"assistant","message":{"id":"msg_02","type":"message","role":"assistant","model":"upstream-model-1","content":[{"type":"thinking","thinking":"The file contains \"hello world\". Report it in line."}],"stop_reason":null,"usage":{"input_tokens":272,"cache_creation_input_tokens":0,"cache_read_input_tokens":4664,"output_tokens":1}},"parent_tool_use_id":null,"session_id":"fc0c2db6-5ae9-46df-9a0c-f4cdc67c346d"}
{"type":"assistant","message":{"id":"msg_02","type":"message","role":"assistant","model":"upstream-model-1","content":[{"type":"text","text":"a.txt contains: \"hello world\""}],"stop_reason":null,"usage":{"input_tokens":272,"cache_creation_input_tokens":0,"cache_read_input_tokens":4664,"output_tokens":1}},"parent_tool_use_id":null,"session_id":"fc0c2db6-5ae9-46df-9a0c-f4cdc67c346d"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":7566,"num_turns":2,"result":"a.txt contains: \"hello world\"","stop_reason":"end_turn","session_id":"fc0c2db6-5ae9-46df-9a0c-f4cdc67c346d","total_cost_usd":0.030187,"usage":{"input_tokens":5126,"cache_creation_input_tokens":0,"cache_read_input_tokens":4664,"output_tokens":89},"modelUsage":{"explore":{"inputTokens":5126,"outputTokens":89,"cacheReadInputTokens":4664,"cacheCreationInputTokens":0,"costUSD":0.030187,"contextWindow":200000}},"permission_denials":[]}`.split('\n').map(line => JSON.parse(line) as Ev)

test('gateway: a real run reads as a Claude Code run: the tool, the answer, usage under the alias, the session', () => {
  const { stats, items } = read(BACKENDS.gateway.parser(), GATEWAY_RUN)
  expect(stats.session).toBe('fc0c2db6-5ae9-46df-9a0c-f4cdc67c346d')
  expect(stats.model).toBe('explore')
  expect(stats.answer).toBe('a.txt contains: "hello world"')
  expect(stats.steps).toBe(1)
  expect(stats.settled).toBe(true)
  expect(stats.error).toBeUndefined()
  expect(stats.usage).toEqual({ input: 5126, output: 89, cacheRead: 4664, cacheWrite: 0 })
  expect(items.map(i => i.kind)).toEqual(['tool', 'result', 'text'])
})

test('the login restore unpacks saved logins once, never over existing files, and never prints a value', () => {
  expect(AUTH_RESTORE_SCRIPT).toContain('--skip-old-files')
  expect(AUTH_RESTORE_SCRIPT).toContain('restored-$kind')
  expect(AUTH_RESTORE_SCRIPT).toContain('for kind in agy codex')
  expect(AUTH_RESTORE_SCRIPT).not.toMatch(/echo[^;]*\$v\b/)
})
