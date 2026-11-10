import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { AUTH_RESTORE_SCRIPT, DETECT_SCRIPT, GATEWAY_SHIM } from './backends'
import { ENV_SET_SCRIPT } from './routing'
import { READ_ONLY_NOTE_ANY } from './core'

// The test runtime has timers; the module's own types do not declare them.
declare const setTimeout: (fn: (v?: unknown) => void, ms: number) => unknown

// The engine and the host beneath the plugin: a fake pi (and a scripted stand-in for each other
// coding agent), a fake git, pi's settings, and an Agent tool that spawns the way the engine does.

const HOME = '/home/t'
const SETTINGS = JSON.stringify({
  defaultProvider: 'acme',
  defaultModel: 'deepseek-ai/DeepSeek-V4.1-Flash',
  enabledModels: ['acme/deepseek-ai/DeepSeek-V4.1-Flash', 'codebuddy/deepseek-v4.1-flash (x0.11)', 'zai-coding-cn/glm-5.3'],
})
const MODELS = `provider     model                              context  max-out  thinking  images
acme         deepseek-ai/DeepSeek-V4.1-Flash    1.0M     384K     yes       yes
codebuddy    deepseek-v4.1-flash (x0.11)        1M       128K     yes       yes
zai-coding-cn glm-5.3                           1M       131.1K   yes       no
openrouter   openai/gpt-6-sol                   1.1M     128K     yes       yes
`

// `beats`: PI_BEAT lines the wrapper prints while a tool runs; `earlyBeats`: before pi has started one;
// `lostEnd`: the tool's end event never comes, its turn ends, and `lateBeats` follow;
// `noSettle`: pi exits cleanly after its last message, without the event that says it is settled.
type PiScript = { answer?: string; fail?: string; gate?: Promise<void>; beats?: number; earlyBeats?: number; lostEnd?: boolean; lateBeats?: number; noSettle?: boolean }

type Chunk = { stream: 'stdout' | 'stderr'; text: string }
// What a CLI other than pi prints, in order; a promise in the list holds the run until it settles.
type CliScript = (Chunk | Promise<unknown>)[] | ((argv: readonly string[]) => (Chunk | Promise<unknown>)[])

// The repo the fake git answers for: the session's checkout and the engine's worktree of agent a1.
type Git = { sessionHead: string; worktreeHead: string; dirty: boolean; resetFails: boolean; worktrees: boolean }

type World = {
  // What `$.session.root()` answers; a test may change it once the Agent call is made.
  root: string
  // The caller's live working directory, what `pwd` answers.
  cwd: string
  spawns: { argv: readonly string[]; cwd?: string }[]
  runs: (readonly string[])[]
  gitRuns: { argv: readonly string[]; cwd?: string }[]
  git: Git
  writes: Map<string, string>
  submitted: string[]
  claudeSteps: number
  // The engine appends the prompt from inside its spawn (see agent.spawn below), through this `$`.
  promptOnSpawn?: any
  // Agent ids are `<prefix><n>`: the plugin's own state outlives a test, so a test that must not meet
  // an earlier test's agent of the same id uses another prefix.
  idPrefix?: string
  // The model each step sent to Claude named.
  claudeModels: string[]
  spawned: string[]
  // Holds `pi --list-models` until it settles, like a cold pi.
  listGate?: Promise<void>
  agentCalls: (Record<string, unknown> & { done?: () => void })[]
  pi: PiScript
  // The executables `command -v` finds: pi, claude, codex, codebuddy, agy, opencode.
  installed: Set<string>
  // What each other CLI prints when it is started, by executable name, and the code it exits with.
  cli: Record<string, CliScript>
  cliCode: number
  toasts: string[]
  // The tools the plugin registered at session start.
  registered: string[]
  // What the status line said, in order; undefined when it was cleared.
  statuses: (string | undefined)[]
  // The plugin's key-value store, as the tests may read it.
  store: Map<string, unknown>
  clock: ReturnType<typeof mock.clock>
}

// pi's settings file as the fake host answers it; a test may change it mid-session.
let settings = SETTINGS

const ok = (stdout = '', exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

function world(on: On, stored?: Record<string, unknown>, opts: { env?: Record<string, string>; installed?: string[]; files?: Record<string, string> } = {}): World {
  const w: World = {
    root: '/repo',
    cwd: '/repo',
    spawns: [],
    runs: [],
    gitRuns: [],
    git: { sessionHead: 'aaa1111', worktreeHead: 'bbb2222', dirty: false, resetFails: false, worktrees: true },
    writes: new Map(),
    submitted: [],
    claudeSteps: 0,
    claudeModels: [],
    spawned: [],
    agentCalls: [],
    pi: {},
    installed: new Set(opts.installed ?? ['pi']),
    cli: {},
    cliCode: 0,
    toasts: [],
    registered: [],
    statuses: [],
    store: new Map(Object.entries(stored ?? {})),
    clock: mock.clock(on),
  }
  const sessionFiles = new Set<string>()
  let agents = 0
  mock.env(on, { HOME, ...opts.env })
  on('store.get', ($, e) => ({ value: w.store.get((e as unknown as { key: string }).key) }) as never)
  on('store.set', ($, e) => {
    const { key, value } = e as unknown as { key: string; value: unknown }
    w.store.set(key, value)
    return { value: undefined } as never
  })

  on('session.root', () => ({ value: w.root }))
  on('ui.status', ($, e) => {
    w.statuses.push((e as unknown as { text?: string }).text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })
  on('tool.register', ($, e) => {
    w.registered.push((e as unknown as { name: string }).name)
    return { value: undefined }
  })
  on('session.start', () => ({ cwd: '/repo' }) as never)
  on('ui.log', () => ({ value: undefined }))
  on('fs.exists', ($, e) => ({ value: e.path === `${HOME}/.pi/agent/settings.json` || e.path in (opts.files ?? {}) }))
  settings = SETTINGS
  on('fs.read', ($, e) => ({ value: e.path === `${HOME}/.pi/agent/settings.json` ? settings : (opts.files ?? {})[e.path] ?? '' }))
  on('fs.write', ($, e) => {
    w.writes.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [...sessionFiles].map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }))
  on('process.run', async ($, e) => {
    w.runs.push(e.argv)
    const [cmd, ...rest] = e.argv
    if (cmd === 'pwd') return ok(`${w.cwd}\n`)
    if (cmd === 'bash' && rest[0] === '-c' && rest[1] === DETECT_SCRIPT) {
      return ok(rest.slice(3).filter(name => w.installed.has(name)).map(name => `${name}\t/usr/local/bin/${name}\n`).join(''))
    }
    // Which of the named variables are set, as bash would answer from the environment.
    if (cmd === 'bash' && rest[0] === '-c' && rest[1] === ENV_SET_SCRIPT) {
      return ok(rest.slice(3).filter(v => (opts.env ?? {})[v]).map(v => `${v}\n`).join(''))
    }
    if (cmd === 'pi' && rest[0] === '--list-models') {
      await w.listGate
      return ok(MODELS)
    }
    if (cmd === 'pi' && rest[0] === '--version') return ok('1.2.0\n')
    if (cmd === 'git') {
      const cwd = e.init?.cwd
      w.gitRuns.push({ argv: rest, cwd })
      const inWorktree = cwd !== undefined && cwd !== '/repo'
      if (rest[0] === 'worktree') {
        const linked = w.git.worktrees
          ? w.spawned.map(id => `\nworktree /repo/.claude/worktrees/agent-${id}\nHEAD ${w.git.worktreeHead}\nbranch refs/heads/worktree-agent-${id}\n`).join('')
          : ''
        return ok(`worktree /repo\nHEAD ${w.git.sessionHead}\nbranch refs/heads/work\n${linked}`)
      }
      if (rest[0] === 'rev-parse' && rest[1] === '--show-toplevel') {
        const top = /^\/repo\/\.claude\/worktrees\/[^/]+/.exec(cwd ?? '')?.[0] ?? (cwd?.startsWith('/repo') ? '/repo' : undefined)
        return top ? ok(`${top}\n`) : ok('', 128)
      }
      if (rest[0] === 'rev-parse') return ok(`${inWorktree ? w.git.worktreeHead : w.git.sessionHead}\n`)
      if (rest[0] === 'status') return ok(w.git.dirty ? ' M file.c\n' : '')
      if (rest[0] === 'reset') {
        if (w.git.resetFails) return ok('', 1)
        w.git.worktreeHead = rest[2] ?? w.git.worktreeHead
        return ok()
      }
      if (rest[0] === 'log') return ok(`${w.git.worktreeHead} the session's commit\n`)
    }
    return ok()
  })
  on('process.spawn', async function* ($, e) {
    w.spawns.push({ argv: e.argv, cwd: e.cwd })
    // The wrapper's arguments end at the CLI's own: bash -c <script> pi-subagent <mode> <file> <cli...>.
    const script = w.cli[e.argv[6] ?? '']
    if (script) {
      yield { stream: 'stderr' as const, text: 'PI_PID 4242\n' }
      for (const part of typeof script === 'function' ? script(e.argv) : script) {
        if (part instanceof Promise) await part
        else yield part
      }
      return { value: { code: w.cliCode, signal: null } }
    }
    const id = e.argv[e.argv.indexOf('--session-id') + 1]
    if (e.argv.includes('--session-id') && id) sessionFiles.add(`2026-01-01_${id}.jsonl`)
    yield { stream: 'stderr' as const, text: 'PI_PID 4242\n' }
    for (let i = 0; i < (w.pi.earlyBeats ?? 0); i++) yield { stream: 'stderr' as const, text: 'PI_BEAT\n' }
    if (w.pi.fail) {
      yield { stream: 'stderr' as const, text: `${w.pi.fail}\n` }
      return { value: { code: 1, signal: null } }
    }
    const line = (ev: object) => ({ stream: 'stdout' as const, text: JSON.stringify(ev) + '\n' })
    yield line({ type: 'session', cwd: e.cwd })
    yield line({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'task' }] } })
    yield line({ type: 'tool_execution_start', toolName: 'read', args: { path: 'a.txt' } })
    for (let i = 0; i < (w.pi.beats ?? 0); i++) yield { stream: 'stderr' as const, text: 'PI_BEAT\n' }
    if (w.pi.lostEnd) {
      yield line({ type: 'turn_end', message: {}, toolResults: [] })
      for (let i = 0; i < (w.pi.lateBeats ?? 0); i++) yield { stream: 'stderr' as const, text: 'PI_BEAT\n' }
    } else {
      yield line({ type: 'tool_execution_end', toolName: 'read', result: { content: [{ type: 'text', text: 'hello' }] }, isError: false })
    }
    if (w.pi.gate) await w.pi.gate
    yield line({
      type: 'message_end',
      message: { role: 'assistant', provider: 'p', model: 'm', stopReason: 'stop', content: [{ type: 'text', text: w.pi.answer ?? 'pi says hi' }], usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0 } },
    })
    if (!w.pi.noSettle) yield line({ type: 'agent_settled', aborted: false })
    return { value: { code: 0, signal: null } }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
  on('prompt.submit', ($, e) => {
    w.submitted.push(e.text)
    return { text: e.text }
  })
  on('tool.describe', ($, e) => ({ description: e.description }))
  on('agent.spawn', ($, e) => {
    const agentId = `${w.idPrefix ?? 'a'}${++agents}`
    w.spawned.push(agentId)
    // As the engine does: the prompt is appended once the agent exists, not after the hooks above return.
    if (w.promptOnSpawn) {
      void w.promptOnSpawn.session.append({
        message: { type: 'user', role: 'user', content: [{ type: 'text', text: e.prompt }] },
        door: 'prompt',
        origin: { kind: 'coordinator' },
        uuid: `u-spawn-${agentId}`,
        agentId,
      } as never)
    }
    return { model: 'claude-x', agentId }
  })
  // The engine's Agent tool: held open while the test body spawns the agent for it.
  on('tool.call', { tool: 'Agent' }, async ($, e) => {
    let done = () => {}
    const spawnedHere = new Promise<void>(r => (done = r))
    w.agentCalls.push({ ...e, done })
    await spawnedHere
    return { result: { status: 'async_launched' } } as never
  })
  on('tool.call', { tool: 'SendMessage' }, () => ({ result: { success: true, message: 'engine delivered' } }) as never)
  on('turn.step', async function* ($, e) {
    w.claudeSteps += 1
    w.claudeModels.push(e.model)
    yield { kind: 'text' as const, index: 0, text: 'CLAUDE' }
    return { turnId: e.turnId, index: e.index, answer: 'CLAUDE', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return w
}

let calls = 0
const agentCall = (input: Record<string, unknown>) =>
  ({ tool: 'Agent', tool_use_id: `tu${++calls}`, description: 'd', prompt: 'do the task', ...input }) as never

// Calls the Agent tool and, while the engine's call is open, spawns the agent and
// hands it its prompt, as the engine does; a call the plugin refused spawns nothing.
async function launch($: any, w: World, input: Record<string, unknown>, spawnExtra: Record<string, unknown> = {}) {
  const seen = w.agentCalls.length
  const e = agentCall(input) as unknown as { tool_use_id: string; prompt: string; description: string }
  const call = $.tool.call(e)
  let refused = false
  call.then(
    () => (refused = true),
    () => (refused = true),
  )
  while (w.agentCalls.length === seen) {
    if (refused) return call
    await new Promise(r => setTimeout(r, 2))
  }
  const below = w.agentCalls[seen]!
  const spawned = await $.agent.spawn({
    tool_use_id: e.tool_use_id,
    prompt: e.prompt,
    description: e.description,
    subagentType: below.subagent_type ?? 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-x',
    background: true,
    fork: below.subagent_type === 'fork',
    ...spawnExtra,
  })
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: e.prompt }] },
    door: 'prompt',
    origin: { kind: 'tool', tool: 'Agent' },
    uuid: `u-${e.tool_use_id}`,
    agentId: spawned.agentId,
  })
  below.done?.()
  return call
}

async function step($: any, agentId: string, turn?: { turnId: string; index: number }) {
  const stream = $.turn.step({ turnId: turn?.turnId ?? `T${++calls}`, index: turn?.index ?? 0, model: 'claude-x', messageCount: 1, ...(agentId ? { agentId } : {}) })
  const texts: string[] = []
  const tools: { name: string; id: string; json: string }[] = []
  let beats = 0
  for (;;) {
    const r = await stream.next()
    if (r.done) return { texts, beats, tools, result: r.value }
    if (r.value.kind === 'text') texts.push(r.value.text)
    if (r.value.kind === 'tool') tools.push({ name: r.value.name, id: r.value.id, json: '' })
    if (r.value.kind === 'input') tools.at(-1)!.json += r.value.json
    if (r.value.kind === 'thinking') beats += 1
  }
}

const argvOf = (w: World, i = -1) => w.spawns.at(i)?.argv ?? []
const after = (argv: readonly string[], flag: string) => argv[argv.indexOf(flag) + 1]

test('describe lists the scoped models with the default marked', async ($, on) => {
  world(on)
  const d = await $.tool.describe({ tool: 'Agent', description: 'BASE', provider: { plugin: 'engine', tier: 'core' } } as never)
  expect(d.description.startsWith('BASE')).toBe(true)
  expect(d.description).toContain('acme/deepseek-ai/DeepSeek-V4.1-Flash (default)')
  expect(d.description).toContain('codebuddy/deepseek-v4.1-flash (x0.11)')
  expect(d.description).not.toContain('openrouter')
})

test('a slow pi --list-models: describe names the scoped models, then adds their facts', async ($, on) => {
  const w = world(on)
  const clock = w.clock
  let release = () => {}
  w.listGate = new Promise<void>(r => (release = r))
  const describe = () => $.tool.describe({ tool: 'Agent', description: 'BASE', provider: { plugin: 'engine', tier: 'core' } } as never)
  const pending = describe()
  await new Promise(r => setTimeout(r, 20))
  await clock.advance(3_000)
  const named = await pending
  expect(named.description).toContain('- acme/deepseek-ai/DeepSeek-V4.1-Flash (default)\n')
  expect(named.description).toContain('- codebuddy/deepseek-v4.1-flash (x0.11)\n')
  expect(named.description).not.toContain('ctx')
  release()
  await new Promise(r => setTimeout(r, 20))
  const full = await describe()
  expect(full.description).toContain('acme/deepseek-ai/DeepSeek-V4.1-Flash (default) · ctx 1.0M · out 384K')
})

test('a scoped model: pi answers the step, read-only tools for Explore, usage in the answer', async ($, on) => {
  const w = world(on)
  const session = mock.session(on)
  await launch($, w, ({ subagent_type: 'Explore@codebuddy/deepseek-v4.1-flash' }))
  expect(w.agentCalls[0]?.subagent_type).toBe('Explore')
  const { texts, result } = await step($, 'a1')
  const argv = argvOf(w)
  expect(after(argv, '--model')).toBe('codebuddy/deepseek-v4.1-flash (x0.11)')
  expect(after(argv, '--tools')).toBe('read,grep,find,ls')
  expect(after(argv, '--session-id')).toBe('a1')
  expect(w.spawns[0]?.cwd).toBe('/repo')
  expect(w.claudeSteps).toBe(0)
  expect(texts.join('')).toBe(result.answer)
  expect(result.answer).toContain('pi says hi')
  expect(result.answer).toContain('125 tokens: 100 in, 20 out, 5 cache read')
  expect(result.usage?.input_tokens).toBe(100)
  expect([...w.writes.values()].some(t => t.includes('"message":"do the task"'))).toBe(true)
  expect(session.appended().some(r => r.agentId === 'a1' && r.message.type === 'system')).toBe(true)
})

const BAND = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 } }

test('the band above the prompt shows the open subagent\'s pi activity, not dimmed', async ($, on) => {
  const w = world(on)
  await launch($, w, { subagent_type: 'Explore@codebuddy/deepseek-v4.1-flash' })
  await step($, 'a1')
  const ui = await $.ui.mount({ plugin: 'pi-subagent', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, view: { agentId: 'a1' } } })
  const drawn = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(drawn).toContain('completed')
  expect(drawn).toContain('read {"path":"a.txt"}')
  expect(drawn).toContain('pi says hi')
  expect(drawn).not.toContain('do the task')
  expect((await ui.findAll({ type: 'Text' })).some(t => t.props.dimColor)).toBe(false)
})

test('the band leaves the main conversation and unknown agents to the engine', async ($, on) => {
  const w = world(on)
  await launch($, w, { subagent_type: 'Explore' })
  await step($, 'a1')
  for (const view of [{}, { agentId: 'zz' }]) {
    const ui = await $.ui.mount({ plugin: 'pi-subagent', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, view } }).catch(() => undefined)
    expect(await ui?.find({ text: 'pi' })).toBeUndefined()
  }
})

test('no model named: the default model; effort becomes thinking', async ($, on) => {
  const w = world(on)
  await launch($, w, ({ subagent_type: 'general-purpose', effort: 'high' }))
  await step($, 'a1')
  expect(after(argvOf(w), '--model')).toBe('acme/deepseek-ai/DeepSeek-V4.1-Flash')
  expect(after(argvOf(w), '--thinking')).toBe('high')
  expect(argvOf(w)).not.toContain('--tools')
})

test('@default is pi\'s default model, with or without a thinking level', async ($, on) => {
  const w = world(on)
  await launch($, w, { subagent_type: 'general-purpose@default' })
  await launch($, w, { subagent_type: 'Explore@DEFAULT:high' })
  await launch($, w, { subagent_type: 'general-purpose@default', effort: 'low' })
  await step($, 'a1')
  await step($, 'a2')
  await step($, 'a3')
  expect(w.agentCalls.map(c => c.subagent_type)).toEqual(['general-purpose', 'Explore', 'general-purpose'])
  const [one, two, three] = w.spawns.map(s => s.argv)
  expect(after(one!, '--model')).toBe('acme/deepseek-ai/DeepSeek-V4.1-Flash')
  expect(one).not.toContain('--thinking')
  expect(after(two!, '--model')).toBe('acme/deepseek-ai/DeepSeek-V4.1-Flash')
  expect(after(two!, '--thinking')).toBe('high')
  expect(after(three!, '--thinking')).toBe('low')
  expect(w.claudeSteps).toBe(0)
})

test('@default follows pi\'s default model as it is now, not as the session began', async ($, on) => {
  const w = world(on)
  await launch($, w, { subagent_type: 'general-purpose@default' })
  settings = JSON.stringify({ ...JSON.parse(SETTINGS), defaultProvider: 'zai-coding-cn', defaultModel: 'glm-5.3' })
  await launch($, w, { subagent_type: 'general-purpose@default' })
  await step($, 'a1')
  await step($, 'a2')
  expect(after(w.spawns[0]!.argv, '--model')).toBe('acme/deepseek-ai/DeepSeek-V4.1-Flash')
  expect(after(w.spawns[1]!.argv, '--model')).toBe('zai-coding-cn/glm-5.3')
})

test('@default with a bad thinking level is refused before anything spawns', async ($, on) => {
  const w = world(on)
  const r = await launch($, w, { subagent_type: 'general-purpose@default:loud' })
  expect((r as { deny?: string }).deny).toContain('not a thinking level')
  expect(w.spawned.length).toBe(0)
})

test('the Agent description tells the main agent to use @default unless the user names a model', async ($, on) => {
  world(on)
  const d = await $.tool.describe({ tool: 'Agent', description: 'BASE', provider: { plugin: 'engine', tier: 'core' } } as never)
  expect(d.description).toContain('`@default`')
  expect(d.description).toContain('unless the user names a model')
  expect(d.description).toContain('It is acme/deepseek-ai/DeepSeek-V4.1-Flash now.')
})

test('no scoped models: a `:` in a model id is not a thinking level, and @default leaves the model to pi', async ($, on) => {
  const w = world(on)
  settings = JSON.stringify({ defaultProvider: 'acme', defaultModel: 'deepseek-ai/DeepSeek-V4.1-Flash' })
  await launch($, w, { subagent_type: 'general-purpose@openrouter/x:free', effort: 'high' })
  await launch($, w, { subagent_type: 'general-purpose@openrouter/x:low', effort: 'high' })
  await launch($, w, { subagent_type: 'general-purpose@default:max', effort: 'low' })
  await step($, 'a1')
  await step($, 'a2')
  await step($, 'a3')
  const [one, two, three] = w.spawns.map(s => s.argv)
  expect(after(one!, '--model')).toBe('openrouter/x:free')
  expect(after(one!, '--thinking')).toBe('high')
  expect(after(two!, '--model')).toBe('openrouter/x:low')
  expect(two).not.toContain('--thinking')
  expect(three).not.toContain('--model')
  expect(after(three!, '--thinking')).toBe('max')
})

test('a :thinking suffix wins over effort', async ($, on) => {
  const w = world(on)
  await launch($, w, ({ subagent_type: 'general-purpose@glm-5.3:low', effort: 'high' }))
  await step($, 'a1')
  expect(after(argvOf(w), '--model')).toBe('zai-coding-cn/glm-5.3:low')
  expect(argvOf(w)).not.toContain('--thinking')
})

test('a model outside the scope is refused before anything spawns', async ($, on) => {
  const w = world(on)
  const r = await launch($, w, ({ subagent_type: 'general-purpose@openrouter/openai/gpt-6-sol' }))
  expect((r as { deny?: string }).deny).toContain('not one of the scoped models')
  expect(w.spawned.length).toBe(0)
})

test('model or @claude: Claude runs the agent, pi never starts', async ($, on) => {
  const w = world(on)
  await launch($, w, ({ subagent_type: 'general-purpose', model: 'haiku' }))
  await launch($, w, ({ subagent_type: 'Explore@claude' }))
  expect(w.agentCalls[1]?.subagent_type).toBe('Explore')
  await step($, 'a1')
  await step($, 'a2')
  expect(w.claudeSteps).toBe(2)
  expect(w.spawns.length).toBe(0)
})

test('fork and remote pass through to Claude', async ($, on) => {
  const w = world(on)
  await launch($, w, ({ subagent_type: 'fork' }))
  await launch($, w, ({ subagent_type: 'general-purpose', isolation: 'remote' }))
  await step($, 'a1')
  expect(w.claudeSteps).toBe(1)
  expect(w.spawns.length).toBe(0)
})

const worktreeAgent = { subagent_type: 'general-purpose', isolation: 'worktree' }
const promptOf = (w: World) => [...w.writes.entries()].find(([f]) => f.endsWith('a1.cmd.jsonl'))?.[1] ?? ''

test('a worktree agent runs pi in its own worktree, pointed at the session HEAD', async ($, on) => {
  const w = world(on)
  await launch($, w, worktreeAgent)
  const { result } = await step($, 'a1')
  expect(w.spawns[0]?.cwd).toBe('/repo/.claude/worktrees/agent-a1')
  const reset = w.gitRuns.find(r => r.argv[0] === 'reset')
  expect(reset?.argv).toEqual(['reset', '--hard', 'aaa1111'])
  expect(reset?.cwd).toBe('/repo/.claude/worktrees/agent-a1')
  const prompt = promptOf(w)
  expect(prompt).toContain('isolated git worktree: /repo/.claude/worktrees/agent-a1 (branch worktree-agent-a1)')
  expect(prompt).toContain('aaa1111 the session')
  expect(prompt).toContain('do not cd into or edit anything under /repo')
  expect(prompt).toContain('do the task')
  expect(result.answer).toContain('[worktree · /repo/.claude/worktrees/agent-a1 · branch worktree-agent-a1]')
})

test('a worktree already at the session HEAD is not reset', async ($, on) => {
  const w = world(on)
  w.git.worktreeHead = w.git.sessionHead
  await launch($, w, worktreeAgent)
  await step($, 'a1')
  expect(w.gitRuns.some(r => r.argv[0] === 'reset')).toBe(false)
  expect(w.spawns[0]?.cwd).toBe('/repo/.claude/worktrees/agent-a1')
})

test('a worktree with changes in it is left alone and pi is told it is behind', async ($, on) => {
  const w = world(on)
  w.git.dirty = true
  await launch($, w, worktreeAgent)
  await step($, 'a1')
  expect(w.gitRuns.some(r => r.argv[0] === 'reset')).toBe(false)
  expect(w.spawns[0]?.cwd).toBe('/repo/.claude/worktrees/agent-a1')
  expect(promptOf(w)).toContain("caller's checkout is at aaa1111, which this worktree could not be pointed at")
})

test('a worktree that cannot be reset still runs, and pi is told', async ($, on) => {
  const w = world(on)
  w.git.resetFails = true
  await launch($, w, worktreeAgent)
  await step($, 'a1')
  expect(w.spawns.length).toBe(1)
  expect(promptOf(w)).toContain('could not be pointed at')
})

test('a worktree that is not found is an error: pi never runs in the main checkout', async ($, on) => {
  const w = world(on)
  w.git.worktrees = false
  await launch($, w, worktreeAgent)
  const { result } = await step($, 'a1')
  expect(w.spawns.length).toBe(0)
  expect(result.answer).toContain('pi failed: pi was not started: its isolated worktree was not found')
  expect(result.answer).toContain('agent-a1')
  expect(result.answer).toContain('never in another checkout')
  expect(result.answer).not.toContain('SendMessage to this agent retries')
  expect(result.answer).not.toContain('[worktree')
  expect(w.claudeSteps).toBe(0)
})

test('a resume whose worktree is gone fails without the old worktree or a retry hint', async ($, on) => {
  const w = world(on)
  await launch($, w, worktreeAgent)
  await step($, 'a1')
  w.git.worktrees = false
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'go on' }] },
    door: 'delivery',
    origin: { kind: 'tool', tool: 'SendMessage' },
    uuid: 'r1',
    agentId: 'a1',
  } as never)
  const { result } = await step($, 'a1')
  expect(w.spawns.length).toBe(1)
  expect(result.answer).toContain('start a new agent instead of resuming')
  expect(result.answer).not.toContain('SendMessage to this agent retries')
  expect(result.answer).not.toContain('[worktree')
})

test("the caller's checkout is read at the Agent call, whatever the agent's own hook is told", async ($, on) => {
  const w = world(on)
  await launch($, w, worktreeAgent)
  // As if inside the agent's hook the session's root were the agent's own worktree.
  w.root = '/repo/.claude/worktrees/agent-a1'
  await step($, 'a1')
  expect(w.gitRuns.find(r => r.argv[0] === 'reset')?.argv).toEqual(['reset', '--hard', 'aaa1111'])
  expect(promptOf(w)).toContain('do not cd into or edit anything under /repo. ')
})

test('a session started outside the repo uses the checkout it has cd-ed into', async ($, on) => {
  const w = world(on)
  w.root = '/home/u'
  w.cwd = '/repo/src'
  await launch($, w, worktreeAgent)
  await step($, 'a1')
  expect(w.gitRuns.find(r => r.argv[0] === 'reset')?.argv).toEqual(['reset', '--hard', 'aaa1111'])
  expect(promptOf(w)).toContain('do not cd into or edit anything under /repo. ')
})

test('outside any repo the caller\'s checkout falls back to the session root', async ($, on) => {
  const w = world(on)
  w.cwd = '/tmp'
  await launch($, w, worktreeAgent)
  await step($, 'a1')
  expect(promptOf(w)).toContain('do not cd into or edit anything under /repo. ')
})

test('after a reload a worktree agent resumes in its worktree with its message, not reset again', async ($, on) => {
  const kept = { id: 'a1', type: 'general-purpose', description: 'd', readOnly: false, isolated: true, repo: '/repo', based: 'aaa1111' }
  const w = world(on, { 'agent:a1': kept })
  w.spawned.push('a1')
  w.git.sessionHead = 'ccc3333'
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'go on' }] },
    door: 'delivery',
    origin: { kind: 'tool', tool: 'SendMessage' },
    uuid: 'r1',
    agentId: 'a1',
  } as never)
  const { result } = await step($, 'a1')
  expect(w.spawns[0]?.cwd).toBe('/repo/.claude/worktrees/agent-a1')
  expect(w.gitRuns.some(r => r.argv[0] === 'reset')).toBe(false)
  expect(promptOf(w)).toContain('go on')
  expect(promptOf(w)).not.toContain('isolated git worktree')
  expect(result.answer).toContain('[worktree · /repo/.claude/worktrees/agent-a1')
  expect(w.claudeSteps).toBe(0)
})

test('only the first run points the worktree at the session and briefs pi', async ($, on) => {
  const w = world(on)
  await launch($, w, worktreeAgent)
  await step($, 'a1')
  w.git.sessionHead = 'ccc3333'
  w.writes.clear()
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'go on' }] },
    door: 'delivery',
    origin: { kind: 'tool', tool: 'SendMessage' },
    uuid: 'r1',
    agentId: 'a1',
  } as never)
  await step($, 'a1')
  expect(w.gitRuns.filter(r => r.argv[0] === 'reset').length).toBe(1)
  expect(w.spawns[1]?.cwd).toBe('/repo/.claude/worktrees/agent-a1')
  expect(promptOf(w)).toContain('go on')
  expect(promptOf(w)).not.toContain('isolated git worktree')
})

test('an agent without isolation never touches git', async ($, on) => {
  const w = world(on)
  await launch($, w, { subagent_type: 'general-purpose' })
  const { result } = await step($, 'a1')
  expect(w.gitRuns.length).toBe(0)
  expect(result.answer).not.toContain('[worktree')
})

test('the Agent description says where a worktree starts', async ($, on) => {
  world(on)
  const d = await $.tool.describe({ tool: 'Agent', description: 'BASE', provider: { plugin: 'engine', tier: 'core' } } as never)
  expect(d.description).toContain("session's current HEAD")
  expect(d.description).toContain('origin/main')
})

test('a long silent tool is kept alive by beats', async ($, on) => {
  const w = world(on)
  w.pi.beats = 3
  await launch($, w, { subagent_type: 'general-purpose' })
  // One for pi's first output, then one per beat while its tool runs.
  expect((await step($, 'a1')).beats).toBe(4)
})

test('beats before pi has started a tool do not keep a silent model alive', async ($, on) => {
  const w = world(on)
  w.pi.earlyBeats = 3
  await launch($, w, { subagent_type: 'general-purpose' })
  expect((await step($, 'a1')).beats).toBe(1)
})

test('a tool whose end never came stops beating once its turn has ended', async ($, on) => {
  const w = world(on)
  w.pi.beats = 1
  w.pi.lostEnd = true
  w.pi.lateBeats = 3
  await launch($, w, { subagent_type: 'general-purpose' })
  expect((await step($, 'a1')).beats).toBe(2)
})

test('a step the engine closes mid-run stops the agent and kills pi with its commands', async ($, on) => {
  const w = world(on)
  let release = () => {}
  w.pi.gate = new Promise<void>(r => (release = r))
  await launch($, w, { subagent_type: 'general-purpose', name: 'closed' })
  const stream = $.turn.step({ turnId: 'Tc', index: 0, model: 'claude-x', messageCount: 1, agentId: 'a1' })
  const first = await stream.next()
  expect(!first.done && first.value.kind).toBe('thinking')
  const closing = stream.return(undefined as never)
  release()
  await closing.catch(() => undefined)
  expect(w.runs.some(a => a[0] === 'bash' && a[2]?.includes('pgrep') && a.includes('4242'))).toBe(true)
  const list = await $.tool.call({ tool: 'mcp__pi-subagent__subagent_activity', tool_use_id: 'xc' } as never)
  expect(JSON.stringify(list)).toContain('a1 (closed) · general-purpose · stopped')
})

test('beats never reach the failure report', async ($, on) => {
  const w = world(on)
  w.pi.fail = 'Error: Model "x" not found.'
  w.pi.earlyBeats = 2
  await launch($, w, { subagent_type: 'general-purpose' })
  const { result } = await step($, 'a1')
  expect(result.answer).not.toContain('PI_BEAT')
})

test('pi failing is reported as the answer, never retried on Claude', async ($, on) => {
  const w = world(on)
  w.pi.fail = 'Error: Model "x" not found.'
  await launch($, w, ({ subagent_type: 'general-purpose' }))
  const { result } = await step($, 'a1')
  expect(result.answer).toContain('pi failed')
  expect(result.answer).toContain('Model "x" not found')
  expect(w.claudeSteps).toBe(0)
})

test('a resumed agent continues its pi session with the new message', async ($, on) => {
  const w = world(on)
  await launch($, w, ({ subagent_type: 'general-purpose' }))
  await step($, 'a1')
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'and the codeword?' }] },
    door: 'delivery',
    origin: { kind: 'tool', tool: 'SendMessage' },
    uuid: 'r1',
    agentId: 'a1',
  } as never)
  await step($, 'a1')
  expect(after(argvOf(w), '--session')).toBe(`${HOME}/.pi/claude-subagents/2026-01-01_a1.jsonl`)
  expect(w.writes.get(`${HOME}/.pi/claude-subagents/a1.cmd.jsonl`)).toContain('and the codeword?')
})

test('SendMessage steers a working agent; otherwise the engine delivers', async ($, on) => {
  const w = world(on)
  let release = () => {}
  w.pi.gate = new Promise<void>(r => (release = r))
  await launch($, w, ({ subagent_type: 'general-purpose', name: 'worker' }))
  const running = step($, 'a1')
  while (!w.spawns.length) await new Promise(r => setTimeout(r, 5))
  const steered = await $.tool.call({ tool: 'SendMessage', tool_use_id: 's1', to: 'a1', message: 'change course' } as never)
  expect(JSON.stringify(steered)).toContain('Steering message queued')
  expect(w.runs.some(a => a[0] === 'bash' && a.some(x => x.includes('"type":"steer"') && x.includes('change course')))).toBe(true)
  release()
  await running
  const later = await $.tool.call({ tool: 'SendMessage', tool_use_id: 's2', to: 'a1', message: 'hi' } as never)
  expect(JSON.stringify(later)).toContain('engine delivered')
  const unknown = await $.tool.call({ tool: 'SendMessage', tool_use_id: 's3', to: 'nobody', message: 'hi' } as never)
  expect(JSON.stringify(unknown)).toContain('engine delivered')
})

test('activity lists and pages; watch notices wake an idle session and ride the next tool result of a busy turn', async ($, on) => {
  const w = world(on)
  const clock = w.clock
  const session = mock.session(on)
  let release = () => {}
  w.pi.gate = new Promise<void>(r => (release = r))
  await launch($, w, ({ subagent_type: 'general-purpose', name: 'watched' }))
  const running = step($, 'a1')
  while (!w.spawns.length) await new Promise(r => setTimeout(r, 5))
  await new Promise(r => setTimeout(r, 20))

  const list = await $.tool.call({ tool: 'mcp__pi-subagent__subagent_activity', tool_use_id: 'x1' } as never)
  expect(JSON.stringify(list)).toContain('a1 (watched)')
  const page = await $.tool.call({ tool: 'mcp__pi-subagent__subagent_activity', tool_use_id: 'x2', agent_id: 'watched' } as never)
  expect(JSON.stringify(page)).toContain('read {')
  const bad = await $.tool.call({ tool: 'mcp__pi-subagent__watch_subagent', tool_use_id: 'x3', action: 'start', agent_id: 'nobody' } as never)
  expect(JSON.stringify(bad)).toContain('deny')

  const started = await $.tool.call({ tool: 'mcp__pi-subagent__watch_subagent', tool_use_id: 'x4', action: 'start', agent_id: 'watched', interval_seconds: 5 } as never)
  expect(JSON.stringify(started)).toContain('every 30s')
  await clock.advance(30_000)
  await clock.settle()
  expect(w.submitted.some(t => t.includes('<pi-subagent-watch>'))).toBe(true)

  // A main model request marks the loop busy, as after a reload mid-turn.
  await step($, undefined as never)
  const before = w.submitted.length
  await clock.advance(30_000)
  await clock.settle()
  expect(w.submitted.length).toBe(before)
  // No row of its own: it waits for the main loop's next tool result and joins it.
  expect(session.appended().some(r => !r.agentId && JSON.stringify(r.message.content).includes('<pi-subagent-watch>'))).toBe(false)
  await mainToolResult($, 'out')
  const rows = session.appended().filter(r => !r.agentId && JSON.stringify(r.message.content).includes('<pi-subagent-watch>'))
  expect(rows.length).toBe(1)
  const block = rows[0]!.message.content[0] as { type: string; tool_use_id: string; content: { type: string; text: string }[] }
  expect(block.type).toBe('tool_result')
  expect(block.tool_use_id).toBe('tu-main')
  expect(block.content[0]).toEqual({ type: 'text', text: 'out' })
  expect(block.content[1]?.text).toContain('<pi-subagent-watch>')
  // Delivered once: a later tool result brings nothing new.
  await mainToolResult($, 'out2')
  expect(session.appended().filter(r => !r.agentId && JSON.stringify(r.message.content).includes('<pi-subagent-watch>')).length).toBe(1)

  const status = await $.tool.call({ tool: 'mcp__pi-subagent__watch_subagent', tool_use_id: 'x5', action: 'status', agent_id: 'watched' } as never)
  expect(JSON.stringify(status)).toContain('Watching a1 every 30s')
  release()
  await running
  const done = await $.tool.call({ tool: 'mcp__pi-subagent__watch_subagent', tool_use_id: 'x6', action: 'status', agent_id: 'watched' } as never)
  expect(JSON.stringify(done)).toContain('is not watched (completed)')
})


async function mainToolResult($: any, text: string) {
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-main', content: text }] },
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Bash' },
    uuid: `u-${text}`,
  } as never)
}

// ---- the other coding agents ------------------------------------------------------------------
//
// Each is a scripted stand-in for the real CLI: the lines it printed in a real run, in the order it printed them.

const out = (ev: object): Chunk => ({ stream: 'stdout', text: JSON.stringify(ev) + '\n' })
const err = (text: string): Chunk => ({ stream: 'stderr', text })

// The wrapper's arguments: bash -c <script> pi-subagent <mode> <file> <cli...>.
const modeOf = (argv: readonly string[]) => argv[4]
const fileOf = (argv: readonly string[]) => argv[5]
const cliOf = (argv: readonly string[]) => argv.slice(6)
const flag = (argv: readonly string[], name: string) => cliOf(argv).find(a => a.startsWith(`${name}=`))?.slice(name.length + 1)

const claudeRun = (answer = 'claude says hi', session = 'sess-claude-1'): CliScript => [
  out({ type: 'system', subtype: 'init', session_id: session, model: 'claude-opus-5-5' }),
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }),
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt', is_error: false }] } }),
  out({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } }),
  out({
    type: 'result', subtype: 'success', is_error: false, result: answer, permission_denials: [],
    modelUsage: { 'claude-opus-5-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 0 } },
  }),
]

const codexRun = (answer = 'codex says hi', thread = 'thread-codex-1', hold?: Promise<unknown>): CliScript => [
  out({ type: 'thread.started', thread_id: thread }),
  out({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: '/bin/zsh -lc ls', aggregated_output: '', exit_code: null, status: 'in_progress' } }),
  out({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: '/bin/zsh -lc ls', aggregated_output: 'a.txt\n', exit_code: 0, status: 'completed' } }),
  out({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: answer } }),
  out({ type: 'turn.completed', usage: { input_tokens: 105, cached_input_tokens: 5, output_tokens: 20 } }),
  ...(hold ? [hold] : []),
]

const agyRun = (answer = 'agy says hi', conversation = 'conv-agy-1'): CliScript => [
  out({ event: 'init', conversation_id: conversation }),
  out({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'list_dir', tool_info: { name: 'list_dir', parameters: { Path: '.' } } } }),
  out({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'list_dir', tool_info: { name: 'list_dir', parameters: { Path: '.' }, output: 'a.txt' } } }),
  out({ event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: answer, usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 5 } } }),
  out({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response: answer } }),
]

const opencodeRun = (answer = 'opencode says hi', session = 'ses_opencode1'): CliScript => [
  out({ type: 'step_start', sessionID: session, part: {} }),
  out({ type: 'tool_use', sessionID: session, part: { tool: 'read', state: { status: 'completed', input: { filePath: 'a.txt' }, output: 'one' } } }),
  out({ type: 'step_finish', sessionID: session, part: { reason: 'tool-calls', tokens: { input: 60, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } } }),
  out({ type: 'step_start', sessionID: session, part: {} }),
  out({ type: 'text', sessionID: session, part: { text: answer } }),
  out({ type: 'step_finish', sessionID: session, part: { reason: 'stop', tokens: { input: 40, output: 15, reasoning: 0, cache: { read: 5, write: 0 } } } }),
]

const ALL = ['pi', 'claude', 'codex', 'codebuddy', 'agy', 'opencode']
const describeAgent = ($: any) => $.tool.describe({ tool: 'Agent', description: 'BASE', provider: { plugin: 'engine', tier: 'core' } } as never)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
// The prompt file of the first agent, and what the plugin wrote into it.
const promptFileOf = (w: World, id = 'a1') => `${HOME}/.claude/pi-subagent/${id}.prompt.txt`

test('describe names every installed agent, how to ask for it, and where an unmarked call goes', async ($, on) => {
  world(on, undefined, { installed: ['pi', 'claude', 'codex'] })
  const d = await describeAgent($)
  expect(d.description).toContain('`@<agent>[/<model>][:<effort>]`')
  expect(d.description).toContain('Without an `@`, the agent runs on pi.')
  expect(d.description).toContain('`@claude-code` · Claude Code')
  expect(d.description).toContain('`@codex` · Codex CLI')
  expect(d.description).toContain('Not installed: codebuddy-code, agy, opencode.')
  expect(d.description).not.toContain('`@agy`')
  // pi's scoped models are still listed, as pi is here.
  expect(d.description).toContain('acme/deepseek-ai/DeepSeek-V4.1-Flash (default)')
  expect(d.description).toContain('`@claude`')
})

test('without pi the description lists no pi models and an unmarked call goes to Claude', async ($, on) => {
  const w = world(on, undefined, { installed: ['codex'] })
  const d = await describeAgent($)
  expect(d.description).toContain('Without an `@`, the agent runs on Claude.')
  expect(d.description).toContain('`@codex` · Codex CLI')
  expect(d.description).not.toContain('acme/deepseek')
  expect(d.description).not.toContain('`@pi`')
  await launch($, w, { subagent_type: 'general-purpose' })
  await step($, 'a1')
  expect(w.claudeSteps).toBe(1)
  expect(w.spawns.length).toBe(0)
})

test('claude: its CLI runs headless in the agent\'s directory, its prompt in a private file that is removed after', async ($, on) => {
  const w = world(on, undefined, { installed: ['claude'] })
  w.cli.claude = claudeRun()
  await launch($, w, { subagent_type: 'general-purpose@claude-code/opus:high' })
  expect(w.agentCalls[0]?.subagent_type).toBe('general-purpose')
  const { texts, result } = await step($, 'a1')
  const spawn = w.spawns[0]!
  expect(modeOf(spawn.argv)).toBe('file')
  expect(fileOf(spawn.argv)).toBe(promptFileOf(w))
  expect(cliOf(spawn.argv).slice(0, 4)).toEqual(['claude', '-p', '--output-format=stream-json', '--verbose'])
  expect(flag(spawn.argv, '--model')).toBe('opus')
  expect(flag(spawn.argv, '--effort')).toBe('high')
  expect(cliOf(spawn.argv)).toContain('--dangerously-skip-permissions')
  expect(cliOf(spawn.argv).join(' ')).not.toContain('do the task')
  expect(spawn.cwd).toBe('/repo')
  expect(w.writes.get(promptFileOf(w))).toBe('do the task\n')
  expect(w.runs).toContainEqual(['mkdir', '-p', '-m', '700', `${HOME}/.claude/pi-subagent`])
  expect(w.runs).toContainEqual(['rm', '-f', promptFileOf(w)])
  // No pi command file, and the engine's model is never asked.
  expect([...w.writes.keys()].some(f => f.endsWith('cmd.jsonl'))).toBe(false)
  expect(w.claudeSteps).toBe(0)
  expect(texts.join('')).toBe(result.answer)
  expect(result.answer).toContain('claude says hi')
  expect(result.answer).toContain('[claude · claude-opus-5-5 · 1 tool uses · 125 tokens: 100 in, 20 out, 5 cache read]')
  // The engine is told the cost under a name no Claude price list has.
  expect(result.usage).toMatchObject({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, model: 'claude-code/claude-opus-5-5' })
})

test('claude: the session it begins is continued by a resume, in the directory it began in', async ($, on) => {
  const w = world(on, undefined, { installed: ['claude'] })
  w.cli.claude = claudeRun('first', 'sess-claude-1')
  await launch($, w, { subagent_type: 'general-purpose@claude-code' })
  await step($, 'a1')
  expect(cliOf(w.spawns[0]!.argv).some(a => a.startsWith('--resume'))).toBe(false)
  w.cwd = '/elsewhere'
  w.cli.claude = claudeRun('second', 'sess-claude-1')
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'and now?' }] },
    door: 'delivery',
    origin: { kind: 'tool', tool: 'SendMessage' },
    uuid: 'r1',
    agentId: 'a1',
  } as never)
  const { result } = await step($, 'a1')
  const second = w.spawns[1]!
  expect(flag(second.argv, '--resume')).toBe('sess-claude-1')
  expect(second.cwd).toBe('/repo')
  expect(w.writes.get(promptFileOf(w))).toBe('and now?\n')
  expect(result.answer).toContain('second')
  const page = await $.tool.call({ tool: 'mcp__pi-subagent__subagent_activity', tool_use_id: 'xr', agent_id: 'a1' } as never)
  expect(JSON.stringify(page)).toContain('resumed its claude session')
})

test('after a reload an agent resumes its own backend session, with its own permissions', async ($, on) => {
  const kept = {
    id: 'a1', type: 'general-purpose', description: 'd', backend: 'codex', policy: 'guarded', model: 'gpt-5.5',
    readOnly: false, isolated: false, session: 'thread-kept-1', cwd: '/kept/dir',
  }
  const w = world(on, { 'agent:a1': kept }, { installed: ['codex'] })
  w.cli.codex = codexRun('resumed', 'thread-kept-1')
  const { result } = await step($, 'a1')
  const argv = cliOf(w.spawns[0]!.argv)
  expect(argv.slice(0, 3)).toEqual(['codex', 'exec', 'resume'])
  expect(argv.slice(-2)).toEqual(['thread-kept-1', '-'])
  expect(argv).toContain('sandbox_mode="workspace-write"')
  expect(argv).toContain('--model=gpt-5.5')
  expect(w.spawns[0]!.cwd).toBe('/kept/dir')
  expect(result.answer).toContain('resumed')
})

test('an agent kept by a backend this version does not know is left to the engine', async ($, on) => {
  const w = world(on, { 'agent:a1': { id: 'a1', type: 'general-purpose', description: 'd', backend: 'someday', readOnly: false, isolated: false } })
  await step($, 'a1')
  expect(w.claudeSteps).toBe(1)
  expect(w.spawns.length).toBe(0)
})

test('an agent kept before there were several backends is pi\'s', async ($, on) => {
  const w = world(on, { 'agent:a1': { id: 'a1', type: 'general-purpose', description: 'd', readOnly: false, isolated: false } })
  await step($, 'a1')
  expect(cliOf(w.spawns[0]!.argv)[0]).toBe('pi')
  expect(modeOf(w.spawns[0]!.argv)).toBe('feed')
})

test('codex: read-only types get the read-only sandbox, a model and an effort are options, the prompt leads with the note', async ($, on) => {
  const w = world(on, undefined, { installed: ['codex'] })
  w.cli.codex = codexRun()
  await launch($, w, { subagent_type: 'Explore@codex/gpt-5.5:high' })
  const { result } = await step($, 'a1')
  const argv = cliOf(w.spawns[0]!.argv)
  expect(argv).toContain('sandbox_mode="read-only"')
  expect(flag(w.spawns[0]!.argv, '--model')).toBe('gpt-5.5')
  expect(argv).toContain('model_reasoning_effort="high"')
  expect(argv.at(-1)).toBe('-')
  expect(w.writes.get(promptFileOf(w))).toBe(`${READ_ONLY_NOTE_ANY}\n\ndo the task\n`)
  expect(result.answer).toContain('[codex · gpt-5.5 · 1 tool uses')
  expect(result.usage?.model).toBe('codex/gpt-5.5')
  // The thread id comes from the CLI's own first event.
  expect(w.store.get('agent:a1')).toMatchObject({ backend: 'codex', policy: 'bypass', session: 'thread-codex-1', cwd: '/repo', model: 'gpt-5.5' })
})

test('the effort parameter reaches a backend unless the suffix names one', async ($, on) => {
  const w = world(on, undefined, { installed: ['codex'] })
  w.cli.codex = codexRun()
  await launch($, w, { subagent_type: 'general-purpose@codex', effort: 'low' })
  await launch($, w, { subagent_type: 'general-purpose@codex:xhigh', effort: 'low' })
  await launch($, w, { subagent_type: 'general-purpose@codex', effort: 'loud' })
  await step($, 'a1')
  await step($, 'a2')
  await step($, 'a3')
  expect(cliOf(w.spawns[0]!.argv)).toContain('model_reasoning_effort="low"')
  expect(cliOf(w.spawns[1]!.argv)).toContain('model_reasoning_effort="xhigh"')
  expect(cliOf(w.spawns[2]!.argv).some(a => a.startsWith('model_reasoning_effort'))).toBe(false)
})

test('agy: the prompt is the value of its flag and no file is written; the conversation id is kept', async ($, on) => {
  const w = world(on, undefined, { installed: ['agy'] })
  w.cli.agy = agyRun()
  await launch($, w, { subagent_type: 'general-purpose@agy/Gemini 3.8 Flash (High)' })
  const { result } = await step($, 'a1')
  const spawn = w.spawns[0]!
  expect(modeOf(spawn.argv)).toBe('none')
  expect(cliOf(spawn.argv)).toEqual([
    'agy', '--output-format=stream-json', '--model=Gemini 3.8 Flash (High)', '--dangerously-skip-permissions', '--prompt=do the task',
  ])
  expect(w.writes.has(promptFileOf(w))).toBe(false)
  expect(w.runs.some(a => a[0] === 'rm')).toBe(false)
  expect(result.answer).toContain('agy says hi')
  expect(result.answer).toContain('[agy · Gemini 3.8 Flash (High) · 1 tool uses · 125 tokens')
  expect(w.store.get('agent:a1')).toMatchObject({ backend: 'agy', session: 'conv-agy-1' })
  // The next run carries the conversation.
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'again' }] },
    door: 'delivery', origin: { kind: 'tool', tool: 'SendMessage' }, uuid: 'r2', agentId: 'a1',
  } as never)
  await step($, 'a1')
  expect(cliOf(w.spawns[1]!.argv)).toContain('--conversation=conv-agy-1')
})

test('opencode: a prompt that looks like a flag follows "--", and read-only denies commands and edits', async ($, on) => {
  const w = world(on, undefined, { installed: ['opencode'] })
  w.cli.opencode = opencodeRun()
  w.cli.env = opencodeRun('read-only reply')
  await launch($, w, { subagent_type: 'general-purpose@opencode/ollama/qwen3.5:9b:medium', prompt: '--help me' })
  await launch($, w, { subagent_type: 'Explore@opencode' })
  const { result } = await step($, 'a1')
  const argv = cliOf(w.spawns[0]!.argv)
  expect(argv).toEqual(['opencode', 'run', '--format=json', '--model=ollama/qwen3.5:9b', '--variant=medium', '--dangerously-skip-permissions', '--', '--help me'])
  expect(result.answer).toContain('opencode says hi')
  expect(w.store.get('agent:a1')).toMatchObject({ backend: 'opencode', session: 'ses_opencode1' })
  await step($, 'a2')
  const ro = cliOf(w.spawns[1]!.argv)
  expect(ro.slice(0, 3)).toEqual(['env', 'OPENCODE_PERMISSION={"bash":"deny","edit":"deny"}', 'opencode'])
  expect(ro).not.toContain('--dangerously-skip-permissions')
})

test('a prompt too long for a command line goes in a file the CLI is told to read', async ($, on) => {
  const w = world(on, undefined, { installed: ['agy'] })
  w.cli.agy = agyRun()
  const long = 'x'.repeat(31_000)
  await launch($, w, { subagent_type: 'general-purpose@agy', prompt: long })
  await step($, 'a1')
  const prompt = cliOf(w.spawns[0]!.argv).at(-1)!
  expect(prompt.length).toBeLessThan(500)
  expect(prompt).toContain(promptFileOf(w))
  expect(w.writes.get(promptFileOf(w))).toBe(`${long}\n`)
  expect(w.runs).toContainEqual(['rm', '-f', promptFileOf(w)])
})

test('a refused action is told with the answer; a run that was refused everything fails with the reason', async ($, on) => {
  const w = world(on, undefined, { installed: ['agy', 'claude'] })
  w.cli.agy = [
    out({ event: 'init', conversation_id: 'conv-denied' }),
    out({ event: 'result', result: { conversation_id: 'conv-denied', status: 'SUCCESS', response: '', denied_actions: [{ action: 'write_file', display_name: 'WriteFile' }] } }),
  ]
  w.cli.claude = [
    out({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' }),
    out({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't1', message: 'needs approval' }),
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'I could not run it.' }] } }),
    out({ type: 'result', subtype: 'success', is_error: false, result: 'I could not run it.', permission_denials: [] }),
  ]
  await launch($, w, { subagent_type: 'general-purpose@agy' })
  await launch($, w, { subagent_type: 'general-purpose@claude-code' })
  const refusedAll = (await step($, 'a1')).result.answer
  expect(refusedAll).toContain('agy failed: agy was not allowed to use WriteFile and ended without an answer')
  expect(refusedAll).toContain('[agy was refused: WriteFile.')
  expect(refusedAll).toContain("The agent's own safety rules still refuse some actions.")
  expect(refusedAll).toContain('SendMessage to this agent retries in the same agy session.')
  const answered = (await step($, 'a2')).result.answer
  expect(answered.startsWith('I could not run it.')).toBe(true)
  expect(answered).toContain('[claude was refused: Bash.')
  expect(answered).not.toContain('failed')
})

test('the refusal note says what to change: the policy, or the agent type', async ($, on) => {
  const denied = [
    out({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' }),
    out({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't1', message: 'needs approval' }),
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'blocked' }] } }),
    out({ type: 'result', subtype: 'success', is_error: false, result: 'blocked' }),
  ]
  const guarded = world(on, undefined, { installed: ['claude'], env: { PI_SUBAGENT_PERMISSIONS: 'guarded' } })
  guarded.cli.claude = denied
  await launch($, guarded, { subagent_type: 'general-purpose@claude-code' })
  await launch($, guarded, { subagent_type: 'Explore@claude-code' })
  expect((await step($, 'a1')).result.answer).toContain('PI_SUBAGENT_PERMISSIONS=guarded keeps the agent inside')
  expect((await step($, 'a2')).result.answer).toContain('This agent type is read-only')
})

test('a CLI that fails before finishing is reported with what it printed, never retried on Claude', async ($, on) => {
  const w = world(on, undefined, { installed: ['codex'] })
  w.cli.codex = [err('Error: no such model "zzz"\n')]
  w.cliCode = 1
  await launch($, w, { subagent_type: 'general-purpose@codex/zzz' })
  const { result } = await step($, 'a1')
  expect(result.answer).toContain('codex failed: codex exited (code 1) before finishing: Error: no such model "zzz"')
  expect(result.answer).toContain('SendMessage to this agent retries in a new codex session.')
  expect(result.answer).not.toContain('PI_PID')
  expect(w.claudeSteps).toBe(0)
  expect(w.runs).toContainEqual(['rm', '-f', promptFileOf(w)])
})

test('a CLI that says it failed is the failure, and one that ends with nothing to say is a failure too', async ($, on) => {
  const w = world(on, undefined, { installed: ['codex', 'agy'] })
  w.cli.codex = [
    out({ type: 'thread.started', thread_id: 't1' }),
    out({ type: 'error', message: "Reconnecting... 1/5 (stream disconnected: model 'x' not found)" }),
    out({ type: 'turn.failed', error: { message: "stream disconnected: model 'x' not found" } }),
  ]
  w.cli.agy = [out({ event: 'init', conversation_id: 'c1' }), out({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: '' } })]
  await launch($, w, { subagent_type: 'general-purpose@codex' })
  await launch($, w, { subagent_type: 'general-purpose@agy' })
  const failed = (await step($, 'a1')).result.answer
  expect(failed).toContain("codex failed: stream disconnected: model 'x' not found")
  expect(failed).toContain('in the same codex session')
  expect((await step($, 'a2')).result.answer).toContain('agy failed: agy ended without an answer')
  const list = await $.tool.call({ tool: 'mcp__pi-subagent__subagent_activity', tool_use_id: 'xl' } as never)
  expect(JSON.stringify(list)).toContain('a1 · general-purpose · failed · codex')
})

test('a CLI that exits without finishing is done only if it exited cleanly with an answer in hand', async ($, on) => {
  const w = world(on, undefined, { installed: ['opencode'] })
  // opencode 1.15.10 with a local model ends on its last message: no closing step event.
  w.cli.opencode = opencodeRun().slice(0, -1)
  await launch($, w, { subagent_type: 'general-purpose@opencode' })
  const done = (await step($, 'a1')).result.answer
  expect(done).toContain('opencode says hi')
  expect(done).not.toContain('opencode failed')
  // The same output from a CLI that crashed: failed, the message only what it said before.
  w.cliCode = 1
  await launch($, w, { subagent_type: 'general-purpose@opencode' })
  const crashed = (await step($, 'a2')).result.answer
  expect(crashed).toContain('opencode failed: opencode exited (code 1) before finishing')
  expect(crashed).toContain('Last answer before it failed:\nopencode says hi')
  // A clean exit with nothing said since its last tool call: failed too.
  w.cliCode = 0
  w.cli.opencode = opencodeRun().slice(0, 3)
  await launch($, w, { subagent_type: 'general-purpose@opencode' })
  expect((await step($, 'a3')).result.answer).toContain('opencode failed: opencode exited (code 0) before finishing: no output')
  const list = await $.tool.call({ tool: 'mcp__pi-subagent__subagent_activity', tool_use_id: 'xl' } as never)
  expect(JSON.stringify(list)).toContain('a1 · general-purpose · completed · opencode')
  expect(JSON.stringify(list)).toContain('a2 · general-purpose · failed · opencode')
})

test('pi that exits in the middle of its run is a failure even if it exited cleanly: its words so far are no answer', async ($, on) => {
  const w = world(on)
  w.pi.noSettle = true
  await launch($, w, { subagent_type: 'general-purpose' })
  const { result } = await step($, 'a1')
  expect(result.answer).toContain('pi failed: pi exited (code 0) before finishing')
  expect(result.answer).toContain('Last answer before it failed:\npi says hi')
})

test('a backend that is not installed is refused with what is, and found if it was installed since', async ($, on) => {
  const w = world(on, undefined, { installed: ['pi'] })
  const refused = (await launch($, w, { subagent_type: 'general-purpose@codex' })) as { deny?: string }
  expect(refused.deny).toContain('Codex CLI is not installed (no codex on PATH)')
  expect(refused.deny).toContain('Installed here: pi.')
  expect(refused.deny).toContain('@claude')
  expect(w.spawned.length).toBe(0)
  // Detection is repeated when something asked for is not there.
  w.installed.add('codex')
  w.cli.codex = codexRun()
  await launch($, w, { subagent_type: 'general-purpose@codex' })
  const { result } = await step($, 'a1')
  expect(result.answer).toContain('codex says hi')
})

test('with nothing installed every backend is refused, and pi by its models too', async ($, on) => {
  const w = world(on, undefined, { installed: [] })
  const codex = (await launch($, w, { subagent_type: 'general-purpose@codex' })) as { deny?: string }
  expect(codex.deny).toContain('No supported coding agent is installed here')
  const pi = (await launch($, w, { subagent_type: 'general-purpose@zai-coding-cn/glm-5.3' })) as { deny?: string }
  expect(pi.deny).toContain('pi is not installed')
  expect(w.spawned.length).toBe(0)
})

test('PI_SUBAGENT_DEFAULT sends unmarked calls to that agent; an @ still decides', async ($, on) => {
  const w = world(on, undefined, { installed: ['pi', 'codex'], env: { PI_SUBAGENT_DEFAULT: 'codex' } })
  w.cli.codex = codexRun()
  const d = await describeAgent($)
  expect(d.description).toContain('Without an `@`, the agent runs on Codex CLI.')
  await launch($, w, { subagent_type: 'general-purpose' })
  await launch($, w, { subagent_type: 'general-purpose@claude' })
  await launch($, w, { subagent_type: 'general-purpose@pi' })
  await step($, 'a1')
  await step($, 'a2')
  await step($, 'a3')
  expect(cliOf(w.spawns[0]!.argv)[0]).toBe('codex')
  expect(w.claudeSteps).toBe(1)
  expect(cliOf(w.spawns[1]!.argv)[0]).toBe('pi')
  expect(w.spawns.length).toBe(2)
})

test('a bad PI_SUBAGENT_DEFAULT or PI_SUBAGENT_PERMISSIONS refuses the call and says how to fix it', async ($, on) => {
  const badDefault = world(on, undefined, { installed: ['pi'], env: { PI_SUBAGENT_DEFAULT: 'gemini' } })
  const one = (await launch($, badDefault, { subagent_type: 'general-purpose' })) as { deny?: string }
  expect(one.deny).toContain('PI_SUBAGENT_DEFAULT is "gemini"')
  expect(one.deny).toContain('claude-code')
  // An explicit @ does not depend on the default.
  badDefault.cli.claude = claudeRun()
  badDefault.installed.add('claude')
  expect(((await launch($, badDefault, { subagent_type: 'general-purpose@claude' })) as { deny?: string }).deny).toBeUndefined()
})

test('a bad PI_SUBAGENT_PERMISSIONS refuses the agents that need a policy', async ($, on) => {
  const w = world(on, undefined, { installed: ['pi', 'codex'], env: { PI_SUBAGENT_PERMISSIONS: 'yolo' } })
  const refused = (await launch($, w, { subagent_type: 'general-purpose@codex' })) as { deny?: string }
  expect(refused.deny).toContain('PI_SUBAGENT_PERMISSIONS is "yolo"; use bypass or guarded.')
  expect(w.spawned.length).toBe(0)
  // Claude's own agents have none.
  expect(((await launch($, w, { subagent_type: 'general-purpose@claude' })) as { deny?: string }).deny).toBeUndefined()
})

test('PI_SUBAGENT_PERMISSIONS=guarded keeps each CLI inside its own rules', async ($, on) => {
  const w = world(on, undefined, { installed: ['claude', 'codex', 'agy', 'opencode'], env: { PI_SUBAGENT_PERMISSIONS: 'guarded' } })
  for (const id of ['claude', 'codex', 'agy', 'opencode']) w.cli[id] = id === 'claude' ? claudeRun() : id === 'codex' ? codexRun() : id === 'agy' ? agyRun() : opencodeRun()
  for (const agent of ['claude-code', 'codex', 'agy', 'opencode']) await launch($, w, { subagent_type: `general-purpose@${agent}` })
  for (const id of ['a1', 'a2', 'a3', 'a4']) await step($, id)
  const [claude, codex, agy, opencode] = w.spawns.map(s => cliOf(s.argv))
  expect(claude).toContain('--permission-mode=acceptEdits')
  expect(claude).not.toContain('--dangerously-skip-permissions')
  expect(codex).toContain('sandbox_mode="workspace-write"')
  expect(agy).not.toContain('--dangerously-skip-permissions')
  expect(opencode).not.toContain('--dangerously-skip-permissions')
})

test('a CLI started by this mod does not route its own subagents again', async ($, on) => {
  const w = world(on, undefined, { installed: ['pi', 'codex'], env: { PI_SUBAGENT_NESTED: '1', PI_SUBAGENT_DEFAULT: 'codex' } })
  const d = await describeAgent($)
  expect(d.description).toBe('BASE')
  await launch($, w, { subagent_type: 'general-purpose@codex' })
  await launch($, w, { subagent_type: 'general-purpose' })
  expect(w.agentCalls.map(c => c.subagent_type)).toEqual(['general-purpose', 'general-purpose'])
  await step($, 'a1')
  await step($, 'a2')
  expect(w.spawns.length).toBe(0)
  expect(w.claudeSteps).toBe(2)
})

test('SendMessage reaches only pi mid-run: another CLI reads its prompt once, so the engine queues the message', async ($, on) => {
  const w = world(on, undefined, { installed: ['codex'] })
  let release = () => {}
  w.cli.codex = codexRun('late answer', 'thread-1', new Promise<void>(r => (release = r)))
  await launch($, w, { subagent_type: 'general-purpose@codex', name: 'worker' })
  const running = step($, 'a1')
  while (!w.spawns.length) await sleep(5)
  await sleep(20)
  const sent = await $.tool.call({ tool: 'SendMessage', tool_use_id: 's1', to: 'worker', message: 'change course' } as never)
  expect(JSON.stringify(sent)).toContain('engine delivered')
  expect(w.runs.some(a => a[0] === 'bash' && a.some(x => x.includes('change course')))).toBe(false)
  release()
  await running
})

test('a CLI that says it is done but does not exit is killed after a grace period', async ($, on) => {
  const w = world(on, undefined, { installed: ['codex'] })
  const clock = w.clock
  let release = () => {}
  w.cli.codex = codexRun('done', 'thread-1', new Promise<void>(r => (release = r)))
  await launch($, w, { subagent_type: 'general-purpose@codex' })
  const running = step($, 'a1')
  while (!w.spawns.length) await sleep(5)
  await sleep(30)
  const killed = () => w.runs.some(a => a[0] === 'bash' && a[2]?.includes('pgrep') && a.includes('4242'))
  await clock.advance(14_000)
  expect(killed()).toBe(false)
  await clock.advance(2_000)
  expect(killed()).toBe(true)
  release()
  const { result } = await running
  expect(result.answer).toContain('done')
})

test('a CLI that exits by itself is not killed by the grace period', async ($, on) => {
  const w = world(on, undefined, { installed: ['codex'] })
  const clock = w.clock
  w.cli.codex = codexRun()
  await launch($, w, { subagent_type: 'general-purpose@codex' })
  await step($, 'a1')
  await clock.advance(60_000)
  expect(w.runs.some(a => a[0] === 'bash' && a[2]?.includes('pgrep'))).toBe(false)
})

test('a worktree agent on another backend runs in its worktree, briefed in its prompt', async ($, on) => {
  const w = world(on, undefined, { installed: ['codex'] })
  w.cli.codex = codexRun()
  await launch($, w, { subagent_type: 'general-purpose@codex', isolation: 'worktree' })
  const { result } = await step($, 'a1')
  expect(w.spawns[0]?.cwd).toBe('/repo/.claude/worktrees/agent-a1')
  expect(w.gitRuns.find(r => r.argv[0] === 'reset')?.argv).toEqual(['reset', '--hard', 'aaa1111'])
  expect(w.writes.get(promptFileOf(w))).toContain('/repo/.claude/worktrees/agent-a1')
  expect(w.writes.get(promptFileOf(w))).toContain('do the task')
  expect(result.answer).toContain('worktree-agent-a1')
})

test('a worktree that is not found stops any backend before it starts, and says which', async ($, on) => {
  const w = world(on, undefined, { installed: ['claude'] })
  w.git.worktrees = false
  w.cli.claude = claudeRun()
  await launch($, w, { subagent_type: 'general-purpose@claude-code', isolation: 'worktree' })
  const { result } = await step($, 'a1')
  expect(w.spawns.length).toBe(0)
  expect(result.answer).toContain('claude failed: claude was not started')
  expect(result.answer).toContain('claude runs only in the worktree the engine made for this agent')
})

test('the activity tools and the band name the agent that runs it', async ($, on) => {
  const w = world(on, undefined, { installed: ['pi', 'codex'] })
  w.cli.codex = codexRun()
  await launch($, w, { subagent_type: 'Explore@codex/gpt-5.5', name: 'scout' })
  await step($, 'a1')
  const list = await $.tool.call({ tool: 'mcp__pi-subagent__subagent_activity', tool_use_id: 'x1' } as never)
  expect(JSON.stringify(list)).toContain('a1 (scout) · Explore · completed · codex · gpt-5.5 · 1 tool uses')
  const page = await $.tool.call({ tool: 'mcp__pi-subagent__subagent_activity', tool_use_id: 'x2', agent_id: 'scout' } as never)
  expect(JSON.stringify(page)).toContain('a1 · completed · codex · gpt-5.5')
  expect(JSON.stringify(page)).toContain('shell {')
  const ui = await $.ui.mount({ plugin: 'pi-subagent', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, view: { agentId: 'a1' } } })
  const drawn = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(drawn).toContain('codex')
  expect(drawn).toContain('gpt-5.5')
  expect(drawn).toContain('codex says hi')
  expect(drawn).not.toContain('do the task')
  const status = await $.tool.call({ tool: 'mcp__pi-subagent__subagent_activity', tool_use_id: 'x3', agent_id: 'nobody' } as never)
  expect(JSON.stringify(status)).toContain('deny')
})

test('the status line groups the running agents by the backend that runs them', async ($, on) => {
  const w = world(on, undefined, { installed: ['pi', 'codex'] })
  let release = () => {}
  const gate = new Promise<void>(r => (release = r))
  w.cli.codex = codexRun('x', 't', gate)
  w.pi.gate = gate
  await launch($, w, { subagent_type: 'general-purpose@codex', name: 'c-agent' })
  await launch($, w, { subagent_type: 'general-purpose', name: 'p-agent' })
  const one = step($, 'a1')
  const two = step($, 'a2')
  while (w.spawns.length < 2) await sleep(5)
  await sleep(30)
  release()
  await Promise.all([one, two])
  expect(w.statuses.some(t => t?.includes('codex: c-agent') && t.includes('pi: p-agent'))).toBe(true)
  expect(w.statuses.at(-1)).toBeUndefined()
})

test('session start registers the supervision tools and stays quiet when everything is in order', async ($, on) => {
  const w = world(on, undefined, { installed: ['pi', 'codex'] })
  const started = await $.session.start({ cwd: '/repo' } as never)
  await sleep(50)
  expect(started.cwd).toBe('/repo')
  expect(w.registered).toEqual(['subagent_activity', 'watch_subagent'])
  expect(w.toasts).toEqual([])
})

test('session start says so when no agent CLI is installed, and when the settings name something that is not', async ($, on) => {
  const none = world(on, undefined, { installed: [] })
  await $.session.start({ cwd: '/repo' } as never)
  await sleep(50)
  expect(none.toasts.length).toBe(1)
  expect(none.toasts[0]).toContain('none of pi, claude, codex, codebuddy-code, agy, opencode is on PATH')
})

test('session start warns about a default that is not installed, and a bad policy or default', async ($, on) => {
  const w = world(on, undefined, { installed: ['pi'], env: { PI_SUBAGENT_DEFAULT: 'codex', PI_SUBAGENT_PERMISSIONS: 'yolo' } })
  await $.session.start({ cwd: '/repo' } as never)
  await sleep(50)
  expect(w.toasts.some(t => t.includes('PI_SUBAGENT_DEFAULT is codex, which is not on PATH'))).toBe(true)
  expect(w.toasts.some(t => t.includes('PI_SUBAGENT_PERMISSIONS is "yolo"'))).toBe(true)
})

test('session start checks pi\'s version only when pi is installed', async ($, on) => {
  const w = world(on, undefined, { installed: ['codex'] })
  await $.session.start({ cwd: '/repo' } as never)
  await sleep(50)
  expect(w.runs.some(a => a[0] === 'pi')).toBe(false)
  expect(w.toasts).toEqual([])
})

test('a nested CLI gets no toasts at session start', async ($, on) => {
  const w = world(on, undefined, { installed: [], env: { PI_SUBAGENT_NESTED: '1' } })
  await $.session.start({ cwd: '/repo' } as never)
  await sleep(50)
  expect(w.toasts).toEqual([])
})

// ---- gateways and roles ----------------------------------------------------------------------

const GW_ENV = { MYGW_BASE_URL: 'https://private.example/anthropic', MYGW_API_KEY: 'sk-SECRET-gw-7' }
const CONFIG = JSON.stringify({
  gateways: { mygw: { baseUrlEnv: 'MYGW_BASE_URL', keyEnv: 'MYGW_API_KEY', models: ['coding', 'explore'] } },
  roles: {
    explore: { type: 'Explore', targets: ['mygw/explore', 'agy/gemini-3.8-flash', 'claude/haiku'] },
    coding: { targets: ['mygw/coding'] },
  },
})
const withConfig = (extra: Record<string, string> = {}) => ({ env: { PI_SUBAGENT_CONFIG: CONFIG, ...GW_ENV, ...extra } })

// What Claude Code prints when the gateway refuses it (as seen live): an init, the error as its words, a failed result.
const gatewayRefused: CliScript = [
  out({ type: 'system', subtype: 'init', session_id: 'sess-gw-x', model: 'explore' }),
  // Claude Code tells an API failure as an assistant message too, before the failed result.
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'API Error: 401 invalid x-api-key' }] } }),
  out({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 401 invalid x-api-key', permission_denials: [] }),
]

test('gateway: Claude Code runs through the shim with only variable names on its command line', async ($, on) => {
  const w = world(on, undefined, { installed: ['claude'], ...withConfig() })
  // The wrapper execs bash (the shim), which execs Claude Code.
  w.cli.bash = claudeRun('gateway says hi', 'sess-gw-1')
  await launch($, w, { subagent_type: 'general-purpose@mygw/coding:high' })
  expect(w.agentCalls[0]?.subagent_type).toBe('general-purpose')
  const { result } = await step($, 'a1')
  const cli = cliOf(w.spawns[0]!.argv)
  expect(cli.slice(0, 8)).toEqual(['bash', '-c', GATEWAY_SHIM, 'pi-subagent-gateway', '', 'MYGW_BASE_URL', 'MYGW_API_KEY', 'ANTHROPIC_API_KEY'])
  expect(cli).toContain('ANTHROPIC_MODEL=coding')
  expect(flag(w.spawns[0]!.argv, '--effort')).toBe('high')
  // Neither the key nor the private URL is anywhere the mod passes or keeps.
  for (const secret of Object.values(GW_ENV)) {
    expect(w.spawns[0]!.argv.join('\n')).not.toContain(secret)
    expect(JSON.stringify([...w.store.values()])).not.toContain(secret)
    expect(JSON.stringify([...w.writes.values()])).not.toContain(secret)
  }
  expect(result.answer).toContain('gateway says hi')
  expect(result.answer).toContain('[mygw · claude-opus-5-5 · 1 tool uses')
  expect(result.usage).toMatchObject({ model: 'mygw/claude-opus-5-5' })
  expect(w.store.get('agent:a1')).toMatchObject({ backend: 'gateway', gateway: 'mygw', model: 'coding', session: 'sess-gw-1' })
})

test('gateway: refused with what is missing, and @gateway is not a name', async ($, on) => {
  const unset = world(on, undefined, { installed: ['claude'], env: { PI_SUBAGENT_CONFIG: CONFIG, MYGW_BASE_URL: 'https://x' } })
  const r1 = (await launch($, unset, { subagent_type: 'general-purpose@mygw/coding' })) as { deny?: string }
  expect(r1.deny).toBe('The mygw gateway cannot be used: MYGW_API_KEY is not set.')
  const r2 = (await launch($, unset, { subagent_type: 'general-purpose@mygw' })) as { deny?: string }
  expect(r2.deny).toContain('MYGW_API_KEY is not set')
  const r3 = (await launch($, unset, { subagent_type: 'general-purpose@gateway/x' })) as { deny?: string }
  expect(r3.deny).toContain('name the gateway itself')
  expect(unset.spawns.length).toBe(0)
})

test('gateway: no model and no default is refused', async ($, on) => {
  const w = world(on, undefined, { installed: ['claude'], ...withConfig() })
  const r = (await launch($, w, { subagent_type: 'general-purpose@mygw' })) as { deny?: string }
  expect(r.deny).toContain('no model: write @mygw/<model>')
})

test('a role runs on its first usable target, with its own agent type when the call names none', async ($, on) => {
  const w = world(on, undefined, { installed: ['claude', 'agy'], ...withConfig({ MYGW_API_KEY: '' }) })
  w.cli.agy = agyRun('agy explored')
  await launch($, w, { subagent_type: '@explore' })
  // The gateway's key is not set, so agy comes first; the engine is told the role's type.
  expect(w.agentCalls[0]?.subagent_type).toBe('Explore')
  const { result } = await step($, 'a1')
  expect(cliOf(w.spawns[0]!.argv)[0]).toBe('agy')
  expect(flag(w.spawns[0]!.argv, '--settings')).toContain('write_file(*)')
  expect(result.answer).toContain('agy explored')
  // Once it has worked it stays on agy: nothing is left to fail over to.
  expect(w.store.get('agent:a1')).toMatchObject({ role: 'explore', backend: 'agy', readOnly: true, worked: true })
  expect((w.store.get('agent:a1') as { fallbacks?: unknown }).fallbacks).toBeUndefined()
})

test('a role whose targets cannot start fails over to the next, and remembers the failure', async ($, on) => {
  const w = world(on, undefined, { installed: ['claude', 'agy'], ...withConfig() })
  w.cli.bash = gatewayRefused
  w.cli.agy = agyRun('agy after the gateway')
  await launch($, w, { subagent_type: 'Explore@explore' })
  const { result } = await step($, 'a1')
  expect(w.spawns.map(s => cliOf(s.argv)[0])).toEqual(['bash', 'agy'])
  expect(result.answer).toContain('agy after the gateway')
  expect(result.answer).toContain('[role explore: could not start mygw/explore: API Error: 401 invalid x-api-key]')
  expect(w.store.get('agent:a1')).toMatchObject({ backend: 'agy', worked: true })
  expect((w.store.get('health') as Record<string, { error: string }>)['mygw/explore']?.error).toContain('401')
  // The next call leaves the failed target out for now, and says why in the description.
  await launch($, w, { subagent_type: '@explore' })
  await step($, 'a2')
  expect(cliOf(w.spawns.at(-1)!.argv)[0]).toBe('agy')
  const d = await describeAgent($)
  expect(d.description).toContain('`@explore` (Explore): agy/gemini-3.8-flash → claude/haiku; skipped mygw/explore: could not start')
  // Named directly, a gateway is tried whatever its record.
  w.cli.bash = claudeRun('back up', 'sess-gw-2')
  await launch($, w, { subagent_type: 'Explore@mygw/explore' })
  const direct = await step($, 'a3')
  expect(direct.result.answer).toContain('back up')
  expect((w.store.get('health') as Record<string, unknown>)['mygw/explore']).toBeUndefined()
})

test('a role whose CLIs all fail hands the step to Claude with the role\'s model, and its later turns too', async ($, on) => {
  const w = world(on, undefined, { installed: ['claude'], ...withConfig() })
  w.cli.bash = gatewayRefused
  await launch($, w, { subagent_type: '@explore' })
  const { texts, result } = await step($, 'a1')
  expect(w.claudeSteps).toBe(1)
  expect(w.claudeModels).toEqual(['haiku'])
  expect(texts).toEqual(['CLAUDE'])
  expect(result.answer).toBe('CLAUDE')
  expect(w.store.get('agent:a1')).toMatchObject({ native: 'haiku' })
  await step($, 'a1')
  expect(w.claudeModels).toEqual(['haiku', 'haiku'])
  expect(w.spawns.length).toBe(1)
})

test('a role with nothing usable is refused with the reasons, and one whose first is Claude goes to Claude', async ($, on) => {
  const cfg = JSON.stringify({ roles: { solo: ['mygw/coding'], deep: ['claude/opus', 'codex'] }, gateways: { mygw: { baseUrlEnv: 'MYGW_BASE_URL' } } })
  const w = world(on, undefined, { installed: ['claude'], env: { PI_SUBAGENT_CONFIG: cfg } })
  const r = (await launch($, w, { subagent_type: '@solo' })) as { deny?: string }
  expect(r.deny).toContain('Nothing the solo role names can be used now: mygw/coding: MYGW_BASE_URL is not set')
  await launch($, w, { subagent_type: 'Plan@deep' })
  expect(w.agentCalls.at(-1)).toMatchObject({ subagent_type: 'Plan', model: 'opus' })
})

test('a failure after the agent has worked does not move it: its session belongs to that backend', async ($, on) => {
  const w = world(on, undefined, { installed: ['claude', 'agy'], ...withConfig() })
  w.cli.bash = claudeRun('first', 'sess-gw-1')
  await launch($, w, { subagent_type: '@explore' })
  await step($, 'a1')
  w.cli.bash = gatewayRefused
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'more' }] },
    door: 'delivery',
    origin: { kind: 'tool', tool: 'SendMessage' },
    uuid: 'u-more',
    agentId: 'a1',
  } as never)
  const { result } = await step($, 'a1')
  expect(w.spawns.map(s => cliOf(s.argv)[0])).toEqual(['bash', 'bash'])
  expect(result.answer).toContain('mygw failed')
  expect(w.claudeSteps).toBe(0)
})

test('the configuration file is read, the variable over it; problems are told at session start and in the description', async ($, on) => {
  const w = world(on, undefined, {
    installed: ['claude'],
    env: { ...GW_ENV, PI_SUBAGENT_CONFIG: JSON.stringify({ roles: { coding: ['mygw/coding'] }, gateways: { codex: { baseUrl: 'x' } } }) },
    files: { [`${HOME}/.claude/pi-subagent/config.json`]: CONFIG },
  })
  await $.session.start({ cwd: '/repo' } as never)
  await sleep(50)
  expect(w.toasts.some(t => t.includes('"codex" already means an agent'))).toBe(true)
  const d = await describeAgent($)
  expect(d.description).toContain('`@mygw` · models: `coding`, `explore`')
  // The variable's coding role replaced the file's; the file's explore role is still there.
  expect(d.description).toContain('`@coding`: mygw/coding')
  expect(d.description).toContain('`@explore` (Explore)')
  expect(d.description).toContain('configuration problems')
  for (const secret of Object.values(GW_ENV)) expect(d.description).not.toContain(secret)
})

test('PI_SUBAGENT_DEFAULT can name a role', async ($, on) => {
  const w = world(on, undefined, { installed: ['claude', 'agy'], ...withConfig({ PI_SUBAGENT_DEFAULT: 'explore', MYGW_API_KEY: '' }) })
  w.cli.agy = agyRun()
  await launch($, w, { subagent_type: 'general-purpose' })
  await step($, 'a1')
  expect(cliOf(w.spawns[0]!.argv)[0]).toBe('agy')
  const d = await describeAgent($)
  expect(d.description).toContain('Without an `@`, the agent runs on the explore role.')
})

test('session start restores saved logins with a script that reads them itself, not when nested', async ($, on) => {
  const w = world(on, undefined, { installed: ['agy'], env: { AGY_AUTH_B64: 'c2VjcmV0' } })
  await $.session.start({ cwd: '/repo' } as never)
  await sleep(50)
  const ran = w.runs.filter(a => a[2] === AUTH_RESTORE_SCRIPT)
  expect(ran.length).toBe(1)
  expect(ran[0]!.join(' ')).not.toContain('c2VjcmV0')
})

test('a nested CLI does not restore logins again', async ($, on) => {
  const w = world(on, undefined, { installed: ['agy'], env: { PI_SUBAGENT_NESTED: '1' } })
  await $.session.start({ cwd: '/repo' } as never)
  await sleep(50)
  expect(w.runs.some(a => a[2] === AUTH_RESTORE_SCRIPT)).toBe(false)
})

test('PI_SUBAGENT_CONFIG may name a file, and a missing one is a problem', async ($, on) => {
  const w = world(on, undefined, { installed: ['claude'], env: { ...GW_ENV, PI_SUBAGENT_CONFIG: '~/gw.json' }, files: { [`${HOME}/gw.json`]: CONFIG } })
  expect((await describeAgent($)).description).toContain('`@mygw`')
  void w
})

test('a configured file that is missing is reported', async ($, on) => {
  world(on, undefined, { installed: ['claude'], env: { PI_SUBAGENT_CONFIG: '/nope.json' } })
  expect((await describeAgent($)).description).toContain('PI_SUBAGENT_CONFIG: /nope.json does not exist')
})

// ---- delivering the report through the engine's SubagentHandback tool -------------------------

test('in auto mode the answer is delivered as a SubagentHandback call, not as last words', async ($, on) => {
  const w = world(on, undefined, { installed: ['codex'] })
  w.cli.codex = codexRun('codex reports')
  await launch($, w, { subagent_type: 'general-purpose@codex' }, { permissionMode: 'auto' })
  expect(w.store.get('agent:a1')).toMatchObject({ handback: true })
  const { texts, tools, result } = await step($, 'a1', { turnId: 'TH1', index: 0 })
  expect(texts).toEqual([])
  expect(tools.map(t => t.name)).toEqual(['SubagentHandback'])
  expect(JSON.parse(tools[0]!.json).message).toContain('codex reports')
  expect(result).toMatchObject({ answer: '', stopReason: 'tool_use', toolUses: [{ name: 'SubagentHandback' }] })
  expect((result.toolUses[0].input as { message: string }).message).toContain('[codex · ')
  expect(result.usage).toMatchObject({ model: 'codex/default' })
})

test('a second step in the same turn gives the answer again, the other way, without running the backend again', async ($, on) => {
  const w = world(on, undefined, { installed: ['codex'] })
  w.cli.codex = codexRun('only once')
  await launch($, w, { subagent_type: 'general-purpose@codex' }, { permissionMode: 'auto' })
  await step($, 'a1', { turnId: 'TH2', index: 0 })
  // The hand-back could not be taken: the engine steps the agent again in the same turn.
  const again = await step($, 'a1', { turnId: 'TH2', index: 1 })
  expect(w.spawns.length).toBe(1)
  expect(again.texts.join('')).toContain('only once')
  expect(again.result).toMatchObject({ stopReason: 'end_turn', toolUses: [], usage: null })
  // A new turn (a resume) runs the backend again.
  w.cli.codex = codexRun('second turn', 'thread-codex-1')
  const next = await step($, 'a1', { turnId: 'TH3', index: 0 })
  expect(w.spawns.length).toBe(2)
  expect(JSON.parse(next.tools[0]!.json).message).toContain('second turn')
})

test('outside auto mode the answer is the last words; asked again, it is handed back once, then said again', async ($, on) => {
  const w = world(on, undefined, { installed: ['codex'] })
  w.cli.codex = codexRun('plain words')
  await launch($, w, { subagent_type: 'general-purpose@codex' }, { permissionMode: 'default' })
  const first = await step($, 'a1', { turnId: 'TP1', index: 0 })
  expect(first.texts.join('')).toContain('plain words')
  expect(first.tools).toEqual([])
  // Not armed for hand-back: a repeat is the last words again, and the backend does not run again.
  const again = await step($, 'a1', { turnId: 'TP1', index: 1 })
  expect(again.tools).toEqual([])
  expect(again.texts.join('')).toContain('plain words')
  expect(w.spawns.length).toBe(1)
})

test('the engine\'s switches: CLAUDE_CODE_DISABLE_SUBAGENT_HANDBACK turns hand-back off, CLAUDE_CODE_SENDMESSAGE_HANDBACK decides when set', async ($, on) => {
  const off = world(on, undefined, { installed: ['codex'], env: { CLAUDE_CODE_DISABLE_SUBAGENT_HANDBACK: '1' } })
  off.cli.codex = codexRun()
  await launch($, off, { subagent_type: 'general-purpose@codex' }, { permissionMode: 'auto' })
  expect(off.store.get('agent:a1')).toMatchObject({ handback: false })
  const r = await step($, 'a1')
  expect(r.tools).toEqual([])
})

test('CLAUDE_CODE_SENDMESSAGE_HANDBACK=0 turns it off in auto mode too', async ($, on) => {
  const w = world(on, undefined, { installed: ['codex'], env: { CLAUDE_CODE_SENDMESSAGE_HANDBACK: '0' } })
  w.cli.codex = codexRun()
  await launch($, w, { subagent_type: 'general-purpose@codex' }, { permissionMode: 'auto' })
  expect(w.store.get('agent:a1')).toMatchObject({ handback: false })
})

test('a failed run is handed back too, so the caller hears why', async ($, on) => {
  const w = world(on, undefined, { installed: ['codex'] })
  w.cli.codex = [{ stream: 'stderr', text: 'boom\n' }]
  w.cliCode = 3
  await launch($, w, { subagent_type: 'general-purpose@codex' }, { permissionMode: 'auto' })
  const { tools } = await step($, 'a1')
  expect(JSON.parse(tools[0]!.json).message).toContain('codex failed')
})

test('the prompt the engine appends as soon as it has spawned the agent reaches the backend', async ($, on) => {
  const w = world(on, undefined, { installed: ['codex'] })
  w.promptOnSpawn = $
  w.idPrefix = 'race'
  let task = ''
  w.cli.codex = () => {
    task = w.writes.get(promptFileOf(w, 'race1')) ?? ''
    return codexRun('done') as (Chunk | Promise<unknown>)[]
  }
  const e = agentCall({ subagent_type: 'general-purpose@codex', prompt: 'THE REAL TASK' }) as unknown as { tool_use_id: string; prompt: string; description: string }
  const call = $.tool.call(e)
  while (!w.agentCalls.length) await sleep(1)
  await $.agent.spawn({
    tool_use_id: e.tool_use_id,
    prompt: e.prompt,
    description: e.description,
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-x',
    background: true,
    fork: false,
    permissionMode: 'auto',
  })
  w.agentCalls[0]!.done?.()
  await call
  // The engine's append has landed before the agent's first step.
  await sleep(30)
  await step($, 'race1')
  expect(task).toContain('THE REAL TASK')
})
