// The coding agents a subagent can run on, and how each is driven. Pure: no `$`, so the tests reach every branch.
//
// The engine still owns the subagent (tasks list, worktree, notification, resume); a backend only
// answers its model requests: the mod starts the backend's CLI headless, reads what it prints, and
// hands the final answer back as the model's reply. Each entry below says how to start a CLI (argv),
// how the prompt reaches it, and how to read its output (a parser from its events to the same
// activity items and run stats for every backend).
import {
  type Activity,
  type PiEvent,
  type RunStats,
  type StdinMode,
  DETAIL_CHARS,
  READ_ONLY_NOTE_ANY,
  THINKING_LEVELS,
  clip,
  cut,
  dialogId,
  digest,
  piCli,
  rpc,
  textOf,
} from './core'

export type BackendId = 'pi' | 'claude-code' | 'codex' | 'codebuddy-code' | 'agy' | 'opencode'

export const BACKEND_IDS: readonly BackendId[] = ['pi', 'claude-code', 'codex', 'codebuddy-code', 'agy', 'opencode']

export const isBackendId = (value: string): value is BackendId => (BACKEND_IDS as readonly string[]).includes(value)

// `bypass`: nobody can answer a permission prompt in a headless subagent, so the backend runs
// without them (as pi always does). `guarded`: the backend keeps its own restrictions, and
// whatever they refuse is reported in the answer. Read-only agent types are limited either way.
export type Policy = 'bypass' | 'guarded'

export type Item = Omit<Activity, 'seq' | 'at'>

// What one event of a backend's output meant to the run.
export type Seen = {
  items: Item[]
  // A tool call began: its name, for the status line.
  tool?: string
  // Whether anything is in flight now, when this event changed that: while it is, the
  // wrapper's beats are passed on to the engine as proof the agent is still working.
  busy?: boolean
  // A line for the command file (pi's cancelled dialog).
  reply?: string
}

// One JSON line of a backend's output.
export type Ev = { [key: string]: unknown }

export type Parser = (ev: Ev, stats: RunStats) => Seen | undefined

export type Launch = {
  // The executable to run: a backend can be installed under more than one name.
  bin: string
  // What the backend is asked, worktree brief included.
  prompt: string
  // The file the wrapper reads stdin from: pi's command file, or the prompt file.
  file: string
  // The backend's own session to continue (pi's are found by file, see sessionArgs).
  session?: string
  sessionArgs?: string[]
  model?: string
  // A reasoning level of THINKING_LEVELS; each backend maps it to its own scale.
  effort?: string
  readOnly: boolean
  policy: Policy
}

export type Backend = {
  id: BackendId
  // The short name in status lines, answers and the band.
  label: string
  // The product's name, for messages that name what is missing.
  title: string
  // Executable names to look for on PATH, best first.
  bins: readonly string[]
  // How the prompt reaches the CLI: pi's RPC command file, stdin, or the command line.
  input: 'rpc' | 'stdin' | 'arg'
  // Whether a message can reach the CLI while it works.
  steers: boolean
  // Whether the CLI stays up when its turn ends, waiting for more commands: the run ends with the turn.
  persistent: boolean
  // Whether the CLI takes the read-only note as an addition to its system prompt (otherwise it leads the prompt).
  systemNote: boolean
  // What the main agent is told about naming a model.
  hint: string
  // The CLI's own value for a reasoning level, or none.
  effort(level: string): string | undefined
  argv(l: Launch): string[]
  parser(): Parser
}

export const stdinOf = (b: Backend): StdinMode => (b.input === 'rpc' ? 'feed' : b.input === 'stdin' ? 'file' : 'none')

// ---- reading output -------------------------------------------------------------------------

const textItem = (text: string): Item => ({ kind: 'text', summary: clip(text, 180), detail: cut(text, DETAIL_CHARS) })

const errorItem = (message: string): Item => ({ kind: 'error', summary: clip(message, 240), detail: cut(message, DETAIL_CHARS) })

const toolItem = (name: string, input: unknown, nested = false): Item => ({
  kind: 'tool',
  summary: `${nested ? '↳ ' : ''}${clip(name, 48)} ${clip(JSON.stringify(input ?? {}), 240)}`,
  detail: cut(JSON.stringify(input ?? {}, null, 2), DETAIL_CHARS),
})

const resultItem = (name: string, output: string, failed: boolean): Item => ({
  kind: failed ? 'error' : 'result',
  summary: `${clip(name, 48)}${failed ? ' failed' : ''}: ${clip(output || '(no output)', 180)}`,
  detail: cut(output, DETAIL_CHARS),
})

const retryItem = (why: string): Item => ({ kind: 'retry', summary: clip(why, 240), detail: why })

const str = (value: unknown) => (typeof value === 'string' ? value : '')

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const rec = (value: unknown) => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {})

// A session id is handed back to the CLI as an argument: only plain ids are kept.
export const validSession = (id: unknown): string | undefined => (typeof id === 'string' && /^[A-Za-z0-9][\w:.-]{0,199}$/.test(id) ? id : undefined)

// pi's RPC events, read by `digest`; the loop's bookkeeping around it is here.
function piParser(): Parser {
  let open = 0
  return (ev, stats) => {
    // Streaming partials: many per message, and the message's own end says it all.
    if (ev.type === 'message_update' || ev.type === 'tool_execution_update') return undefined
    const pi = ev as PiEvent
    const dialog = dialogId(pi)
    if (dialog) return { items: [], reply: rpc.cancelDialog(dialog) }
    const items = digest(pi, stats)
    if (ev.type === 'tool_execution_start') {
      open += 1
      return { items, tool: clip(String(ev.toolName), 24), busy: true }
    }
    if (ev.type === 'tool_execution_end') {
      open = Math.max(0, open - 1)
      return { items, busy: open > 0 }
    }
    // A turn ends once its tools have: one whose end never came (a nested call that threw)
    // must not keep beating for a model that has gone silent since.
    if ((ev.type === 'turn_end' || ev.type === 'agent_end') && !ev.parentToolCallId) {
      open = 0
      return { items, busy: false }
    }
    return { items }
  }
}

type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }

// The content blocks of a message, those that are objects: what a CLI sends is read with no trust in its shape.
const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content.filter(b => b && typeof b === 'object') as Block[]) : [])

// "Permission to use Bash has been denied because this tool requires approval…": how CodeBuddy
// words a refusal in a tool result, its own `permission_denials` list staying empty.
const DENIED_RESULT = /Permission to use (\S+) has been denied/i

// Claude Code's stream-json, which CodeBuddy Code speaks too: one event per content block, a
// `result` at the end. Their `modelUsage` is the only usage that means the same in both:
// `usage.input_tokens` counts cache reads in CodeBuddy and leaves them out in Claude.
function streamJsonParser(): Parser {
  const calls = new Map<string, { name: string; input: unknown }>()
  const open = new Set<string>()
  const denied = new Set<string>()
  const deny = (stats: RunStats, id: string | undefined, what: string) => {
    if (id) {
      if (denied.has(id)) return
      denied.add(id)
    }
    stats.denied.push(what)
  }
  return (ev, stats) => {
    switch (ev.type) {
      case 'system': {
        switch (ev.subtype) {
          case 'init':
            stats.session ??= validSession(ev.session_id)
            if (typeof ev.model === 'string' && ev.model) stats.model ??= ev.model
            return undefined
          case 'api_retry': {
            const status = ev.error_status ? ` ${String(ev.error_status)}` : ''
            const wait = Math.round(num(ev.retry_delay_ms) / 1000)
            return { items: [retryItem(`model call failed (${str(ev.error) || 'error'}${status}); retry ${String(ev.attempt)}/${String(ev.max_retries)} in ${wait}s`)] }
          }
          case 'permission_denied': {
            const tool = str(ev.tool_name) || 'a tool'
            deny(stats, str(ev.tool_use_id) || undefined, tool)
            return { items: [errorItem(`permission denied: ${tool}${ev.message ? ` (${clip(str(ev.message), 160)})` : ''}`)] }
          }
          case 'compact_boundary':
            return { items: [{ kind: 'note', summary: 'context compaction', detail: '' }] }
          default:
            return undefined
        }
      }
      case 'assistant': {
        const nested = Boolean(ev.parent_tool_use_id)
        const items: Item[] = []
        let tool: string | undefined
        for (const b of blocksOf(rec(ev.message).content)) {
          if (b.type === 'text' && b.text) {
            // A nested agent's words are not this agent's answer.
            if (!nested) stats.answer = b.text
            items.push(textItem(b.text))
          } else if (b.type === 'tool_use' && b.name) {
            stats.steps += 1
            if (b.id) {
              calls.set(b.id, { name: b.name, input: b.input })
              open.add(b.id)
            }
            tool = clip(b.name, 24)
            items.push(toolItem(b.name, b.input, nested))
          }
        }
        return items.length ? { items, tool, busy: tool ? true : undefined } : undefined
      }
      case 'user': {
        const content = rec(ev.message).content
        if (typeof content === 'string') return content ? { items: [{ kind: 'user', summary: clip(content, 180), detail: cut(content, DETAIL_CHARS) }] } : undefined
        const items: Item[] = []
        let ended = false
        for (const b of blocksOf(content)) {
          if (b.type === 'tool_result') {
            const call = b.tool_use_id ? calls.get(b.tool_use_id) : undefined
            if (b.tool_use_id) open.delete(b.tool_use_id)
            ended = true
            const out = textOf(b.content)
            const failed = b.is_error === true
            const refused = failed ? DENIED_RESULT.exec(out) : null
            if (refused) deny(stats, b.tool_use_id, refused[1] ?? 'a tool')
            items.push(resultItem(call?.name ?? 'tool', out, failed))
          } else if (b.type === 'text' && b.text) {
            items.push({ kind: 'user', summary: clip(b.text, 180), detail: cut(b.text, DETAIL_CHARS) })
          }
        }
        return items.length ? { items, busy: ended ? open.size > 0 : undefined } : undefined
      }
      case 'result': {
        stats.settled = true
        open.clear()
        const subtype = str(ev.subtype)
        const text = str(ev.result)
        const failed = ev.is_error === true || (subtype !== '' && subtype !== 'success')
        const byModel = Object.entries(rec(ev.modelUsage))
        if (byModel.length) {
          for (const [name, raw] of byModel) {
            const u = rec(raw)
            stats.usage.input += num(u.inputTokens)
            stats.usage.output += num(u.outputTokens)
            stats.usage.cacheRead += num(u.cacheReadInputTokens)
            stats.usage.cacheWrite += num(u.cacheCreationInputTokens)
            stats.model ??= name
          }
        } else {
          const u = rec(ev.usage)
          stats.usage.input += num(u.input_tokens)
          stats.usage.output += num(u.output_tokens)
          stats.usage.cacheRead += num(u.cache_read_input_tokens)
          stats.usage.cacheWrite += num(u.cache_creation_input_tokens)
        }
        for (const d of Array.isArray(ev.permission_denials) ? (ev.permission_denials as Record<string, unknown>[]) : []) {
          deny(stats, str(d.tool_use_id) || undefined, str(d.tool_name) || 'a tool')
        }
        if (failed) {
          stats.error = text || subtype || 'the run failed'
          // An API failure comes as the last message as well as the result.
          if (stats.answer === stats.error) stats.answer = ''
          return { items: [errorItem(stats.error)], busy: false }
        }
        stats.error = undefined
        if (text) stats.answer = text
        return { items: [], busy: false }
      }
      default:
        return undefined
    }
  }
}

type CodexItem = Record<string, unknown> & { id?: string; type?: string }

// `/bin/zsh -lc 'ls -la'` is how codex shows a command it ran; the shell wrapper is noise.
const unwrapShell = (command: string) => command.replace(/^\S*\/(?:ba|z|da|k|fi)?sh -l?c /, '').replace(/^'([\s\S]*)'$/, '$1')

// The tool a codex item stands for, if it is one: a name and what it was given.
function codexCall(item: CodexItem): { name: string; input: unknown } | undefined {
  switch (item.type) {
    case 'command_execution':
      return { name: 'shell', input: { command: unwrapShell(str(item.command)) } }
    case 'mcp_tool_call':
      return { name: `${str(item.server) || 'mcp'}.${str(item.tool) || 'tool'}`, input: item.arguments }
    case 'web_search':
      return { name: 'web_search', input: { query: str(item.query) } }
    case 'file_change':
      return { name: 'apply_patch', input: { changes: item.changes } }
    default:
      return undefined
  }
}

// `codex exec --json`: thread and turn events around items (reasoning, commands, messages).
function codexParser(): Parser {
  const open = new Set<string>()
  let reasoning = ''
  return (ev, stats) => {
    switch (ev.type) {
      case 'thread.started':
        stats.session ??= validSession(ev.thread_id)
        return undefined
      case 'item.started': {
        const item = rec(ev.item) as CodexItem
        const call = codexCall(item)
        if (!call) return undefined
        stats.steps += 1
        if (item.id) open.add(item.id)
        return { items: [toolItem(call.name, call.input)], tool: call.name, busy: true }
      }
      case 'item.completed': {
        const item = rec(ev.item) as CodexItem
        if (item.type === 'agent_message') {
          const text = str(item.text)
          if (!text) return undefined
          stats.answer = text
          return { items: [textItem(text)] }
        }
        // A local model may answer in its reasoning: kept as the answer only when nothing better comes.
        if (item.type === 'reasoning') {
          reasoning = str(item.text) || reasoning
          return undefined
        }
        if (item.type === 'error') return { items: [{ kind: 'note', summary: clip(`warning: ${str(item.message)}`, 240), detail: str(item.message) }] }
        const call = codexCall(item)
        if (!call) return undefined
        const items: Item[] = []
        if (!(item.id && open.has(item.id))) {
          stats.steps += 1
          items.push(toolItem(call.name, call.input))
        }
        if (item.id) open.delete(item.id)
        const failed = item.status === 'failed' || (item.type === 'command_execution' && typeof item.exit_code === 'number' && item.exit_code !== 0)
        let out = str(item.aggregated_output)
        if (item.type === 'file_change') {
          out = ((Array.isArray(item.changes) ? item.changes : []) as Record<string, unknown>[]).map(c => `${str(c.kind)} ${str(c.path)}`).join(', ')
        } else if (item.type === 'mcp_tool_call') {
          out = str(rec(item.error).message) || JSON.stringify(item.result ?? '')
        }
        items.push(resultItem(call.name, out, failed))
        return { items, busy: open.size > 0 }
      }
      case 'turn.completed': {
        stats.settled = true
        open.clear()
        const u = rec(ev.usage)
        const cached = num(u.cached_input_tokens)
        stats.usage.input += Math.max(0, num(u.input_tokens) - cached)
        stats.usage.cacheRead += cached
        stats.usage.output += num(u.output_tokens)
        if (!stats.answer) stats.answer = reasoning
        stats.error = undefined
        return { items: [], busy: false }
      }
      case 'turn.failed': {
        stats.settled = true
        open.clear()
        const message = str(rec(ev.error).message) || 'the turn failed'
        const again = stats.error === message
        stats.error = message
        return { items: again ? [] : [errorItem(message)], busy: false }
      }
      case 'error': {
        const message = str(ev.message) || 'error'
        // codex tells of each reconnect attempt; the failure itself comes after the last one.
        if (/^Reconnecting\b/i.test(message)) return { items: [retryItem(`model call failed; ${message}`)] }
        stats.error = message
        return { items: [errorItem(message)] }
      }
      default:
        return undefined
    }
  }
}

// `agy --output-format stream-json`: steps change state (ACTIVE, DONE, ERROR); the answer's
// text streams as deltas and the `result` carries it whole. Its usage is cumulative per
// conversation, so a resumed run's own is the sum of its steps'.
function agyParser(): Parser {
  const open = new Set<number>()
  const said = new Map<number, string>()
  // Steps whose tool call and whose usage are already in the stats.
  const shown = new Set<number>()
  const billed = new Set<number>()
  return (ev, stats) => {
    if (ev.event === 'init') {
      stats.session ??= validSession(ev.conversation_id)
      return undefined
    }
    if (ev.event === 'result') {
      const r = rec(ev.result)
      stats.settled = true
      open.clear()
      stats.session ??= validSession(r.conversation_id)
      for (const d of Array.isArray(r.denied_actions) ? (r.denied_actions as Record<string, unknown>[]) : []) {
        stats.denied.push(str(d.display_name) || str(d.action) || 'a tool')
      }
      const response = str(r.response)
      if (r.status !== 'SUCCESS') {
        stats.error = str(r.error) || 'agy reported an error'
        return { items: [errorItem(stats.error)], busy: false }
      }
      stats.error = undefined
      if (response.trim()) stats.answer = response
      return { items: [], busy: false }
    }
    if (ev.event !== 'step_update') return undefined
    const s = rec(ev.step_update)
    const index = num(s.step_index)
    const info = rec(s.tool_info)
    const state = str(s.state)
    const items: Item[] = []
    let tool: string | undefined
    let busy: boolean | undefined
    if (s.step_type === 'tool') {
      const name = str(s.tool_name) || str(info.name) || 'tool'
      if (state === 'ACTIVE' && !open.has(index)) {
        open.add(index)
        shown.add(index)
        stats.steps += 1
        tool = clip(name, 24)
        busy = true
        items.push(toolItem(name, info.parameters))
      } else if (state === 'DONE' || state === 'ERROR') {
        if (!shown.has(index)) {
          shown.add(index)
          stats.steps += 1
          items.push(toolItem(name, info.parameters))
        }
        open.delete(index)
        busy = open.size > 0
        items.push(resultItem(name, str(info.output), state === 'ERROR'))
      }
    } else if (s.step_type === 'agent_response') {
      if (typeof s.text_delta === 'string') said.set(index, (said.get(index) ?? '') + s.text_delta)
      if (state === 'DONE' || state === 'ERROR') {
        const text = (said.get(index) ?? '').trim()
        if (text) {
          stats.answer = text
          items.push(textItem(text))
        }
      }
    }
    if ((state === 'DONE' || state === 'ERROR') && s.usage && !billed.has(index)) {
      billed.add(index)
      const u = rec(s.usage)
      stats.usage.input += num(u.input_tokens)
      stats.usage.output += num(u.output_tokens)
      stats.usage.cacheRead += num(u.cache_read_tokens)
    }
    return items.length || busy !== undefined ? { items, tool, busy } : undefined
  }
}

// How opencode words a refused tool call: asked and auto-rejected (nobody can answer in a headless
// run), or ruled out by a permission setting.
const OPENCODE_REFUSED = /rejected permission|specified a rule which prevents/i

// `opencode run --format json`: steps hold text parts and tool parts; a tool part is
// reported once, when it has finished, so a step is all there is to tell a tool is running.
function opencodeParser(): Parser {
  // What the step in progress has said. It is the answer if no step follows: with some
  // providers opencode ends the run on its last message, without a closing `step_finish`,
  // and the run's own exit then says the message was the last.
  let said = ''
  return (ev, stats) => {
    stats.session ??= validSession(ev.sessionID)
    const part = rec(ev.part)
    switch (ev.type) {
      case 'step_start':
        said = ''
        stats.answer = ''
        return { items: [], busy: true }
      case 'text': {
        const text = str(part.text)
        if (!text) return undefined
        said += text
        stats.answer = said.trim() ? said : ''
        return { items: [textItem(text)] }
      }
      case 'tool_use': {
        const state = rec(part.state)
        const name = str(part.tool) || 'tool'
        stats.steps += 1
        const failed = state.status === 'error'
        const out = failed ? str(state.error) : str(state.output)
        if (failed && OPENCODE_REFUSED.test(out)) stats.denied.push(name)
        return { items: [toolItem(name, state.input), resultItem(name, out, failed)], tool: clip(name, 24) }
      }
      case 'step_finish': {
        const t = rec(part.tokens)
        const cache = rec(t.cache)
        stats.usage.input += num(t.input)
        stats.usage.output += num(t.output) + num(t.reasoning)
        stats.usage.cacheRead += num(cache.read)
        stats.usage.cacheWrite += num(cache.write)
        // Anything but a hand-off to tools ends the run; words before a hand-off are not the answer.
        if (part.reason !== 'tool-calls') {
          stats.settled = true
          stats.error = undefined
        } else {
          stats.answer = ''
        }
        return { items: [], busy: false }
      }
      case 'error': {
        const data = rec(rec(ev.error).data)
        const message = str(data.message) || str(rec(ev.error).name) || 'error'
        // The first says what went wrong; a later one is often only "unexpected server error".
        stats.error ??= message
        return { items: [errorItem(message)] }
      }
      default:
        return undefined
    }
  }
}

// ---- starting a CLI -------------------------------------------------------------------------

const flag = (name: string, value?: string) => (value ? [`${name}=${value}`] : [])

// What a prompt is sent as: one the CLI would take for a command (`/…`) gets a line before it;
// a backend that cannot be given a system prompt is told its mode in the prompt.
export function promptFor(b: Backend, l: Pick<Launch, 'prompt' | 'readOnly'>): string {
  const body = l.prompt.startsWith('/') ? `Task:\n${l.prompt}` : l.prompt
  return l.readOnly && !b.systemNote ? `${READ_ONLY_NOTE_ANY}\n\n${body}` : body
}

// The backend's value for the launch's reasoning level, if it has one.
const effortOf = (b: Backend, l: Launch) => (l.effort ? b.effort(l.effort) : undefined)

// Claude Code and CodeBuddy Code take the same flags for what is used here.
function claudeLikeArgv(l: Launch, bypass: string, effort: string | undefined): string[] {
  return [
    l.bin,
    '-p',
    '--output-format=stream-json',
    '--verbose',
    ...flag('--resume', l.session),
    ...flag('--model', l.model),
    ...flag('--effort', effort),
    // Read-only: the three tools that only look, and no permission bypass.
    ...(l.readOnly
      ? ['--tools=Read,Grep,Glob,LS', `--append-system-prompt=${READ_ONLY_NOTE_ANY}`]
      : l.policy === 'bypass'
        ? [bypass]
        : ['--permission-mode=acceptEdits']),
  ]
}

const codexSandbox = (l: Launch) => (l.readOnly ? 'read-only' : l.policy === 'bypass' ? 'danger-full-access' : 'workspace-write')

export const BACKENDS: Record<BackendId, Backend> = {
  pi: {
    id: 'pi',
    label: 'pi',
    title: 'pi',
    bins: ['pi'],
    input: 'rpc',
    steers: true,
    persistent: true,
    systemNote: true,
    hint: '`@<provider>/<model>[:<thinking>]`; `pi --list-models <search>` in Bash lists models',
    effort: level => level,
    argv: l => piCli({ session: l.sessionArgs ?? [], readOnly: l.readOnly, model: l.model, thinking: l.effort }),
    parser: piParser,
  },
  'claude-code': {
    id: 'claude-code',
    label: 'claude',
    title: 'Claude Code',
    bins: ['claude'],
    input: 'stdin',
    steers: false,
    persistent: false,
    systemNote: true,
    hint: 'a model alias or id such as `sonnet`, `opus` or `claude-opus-4-8`, or a name your `ANTHROPIC_BASE_URL` gateway serves; a separate Claude Code process that inherits the environment',
    effort: level => (level === 'off' ? undefined : level === 'minimal' ? 'low' : level),
    argv: l => claudeLikeArgv(l, '--dangerously-skip-permissions', effortOf(BACKENDS['claude-code'], l)),
    parser: streamJsonParser,
  },
  codex: {
    id: 'codex',
    label: 'codex',
    title: 'Codex CLI',
    bins: ['codex'],
    input: 'stdin',
    steers: false,
    persistent: false,
    systemNote: false,
    hint: 'a model id such as `gpt-5.5`; leave it out for the model in `~/.codex/config.toml`',
    effort: level => (level === 'off' ? 'none' : level === 'max' ? 'xhigh' : level),
    argv: l => {
      const effort = effortOf(BACKENDS.codex, l)
      return [
        l.bin,
        'exec',
        ...(l.session ? ['resume'] : []),
        '--json',
        '--skip-git-repo-check',
        ...flag('--model', l.model),
        ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
        '-c',
        `sandbox_mode="${codexSandbox(l)}"`,
        '-c',
        'approval_policy="never"',
        ...(l.session ? [l.session] : []),
        // The prompt comes from stdin.
        '-',
      ]
    },
    parser: codexParser,
  },
  'codebuddy-code': {
    id: 'codebuddy-code',
    label: 'codebuddy',
    title: 'CodeBuddy Code',
    bins: ['codebuddy-code', 'codebuddy', 'cbc'],
    input: 'stdin',
    steers: false,
    persistent: false,
    systemNote: true,
    hint: 'a CodeBuddy model id such as `glm-5.3` or `deepseek-v4.1-flash` (`codebuddy --help` lists them)',
    effort: level => (level === 'off' ? undefined : level),
    argv: l => claudeLikeArgv(l, '--dangerously-skip-permissions', effortOf(BACKENDS['codebuddy-code'], l)),
    parser: streamJsonParser,
  },
  agy: {
    id: 'agy',
    label: 'agy',
    title: 'Antigravity CLI (agy)',
    bins: ['agy'],
    input: 'arg',
    steers: false,
    persistent: false,
    systemNote: false,
    hint: 'a model id from `agy models` in Bash, such as `gemini-3.8-flash-high`',
    effort: level => (level === 'off' ? undefined : level === 'minimal' ? 'low' : level),
    argv: l => [
      l.bin,
      '--output-format=stream-json',
      ...flag('--conversation', l.session),
      ...flag('--model', l.model),
      ...flag('--effort', effortOf(BACKENDS.agy, l)),
      // Without the flag agy's headless mode refuses whatever needs approval, writes first.
      ...(!l.readOnly && l.policy === 'bypass' ? ['--dangerously-skip-permissions'] : []),
      `--prompt=${l.prompt}`,
    ],
    parser: agyParser,
  },
  opencode: {
    id: 'opencode',
    label: 'opencode',
    title: 'opencode',
    bins: ['opencode'],
    input: 'arg',
    steers: false,
    persistent: false,
    systemNote: false,
    hint: 'a model as `<provider>/<model>` from `opencode models` in Bash',
    effort: level => (level === 'off' ? undefined : level),
    argv: l => [
      // Read-only: running commands and changing files are denied for the whole run, and opencode
      // then does not offer those tools at all. (Its `plan` agent only denies edits, not commands.)
      ...(l.readOnly ? ['env', `OPENCODE_PERMISSION=${JSON.stringify({ bash: 'deny', edit: 'deny' })}`] : []),
      l.bin,
      'run',
      '--format=json',
      ...flag('--session', l.session),
      ...flag('--model', l.model),
      ...flag('--variant', effortOf(BACKENDS.opencode, l)),
      // Without the flag a headless run rejects what asks for approval, as it does for guarded.
      ...(!l.readOnly && l.policy === 'bypass' ? ['--dangerously-skip-permissions'] : []),
      '--',
      l.prompt,
    ],
    parser: opencodeParser,
  },
}

// ---- choosing a backend ---------------------------------------------------------------------

// Where an Agent call goes.
export type Route =
  | { kind: 'claude' }
  // `requested` is what pi is asked for, in pi's own syntax (`provider/model[:thinking]`, `default[:thinking]`).
  | { kind: 'pi'; requested?: string }
  | { kind: 'backend'; backend: Exclude<BackendId, 'pi'>; model?: string; level?: string }
  | { kind: 'error'; error: string }

export const AGENT_SYNTAX = '`@<agent>[/<model>][:<effort>]`'

const levels = THINKING_LEVELS.join('|')

// A model name goes to the CLI as one argument of a flag it is bound to, but is still kept plain.
export function modelProblem(model: string): string | undefined {
  if (model.startsWith('-')) return `"${model}" cannot be a model name: it starts with "-".`
  if (model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) return 'That model name is not usable: it is too long or holds control characters.'
  return undefined
}

// `codex/gpt-5.5:high`, `codex:high`, `codex`: the model after the first `/`, the effort after the last `:` when it is one.
function splitModel(rest: string): { model?: string; level?: string } {
  const slash = rest.startsWith('/')
  let tail = slash ? rest.slice(1) : rest
  let level: string | undefined
  const colon = tail.lastIndexOf(':')
  if (colon >= 0 && THINKING_LEVELS.includes(tail.slice(colon + 1))) {
    level = tail.slice(colon + 1)
    tail = tail.slice(0, colon)
  }
  return { model: tail || undefined, level }
}

// What follows the `@` of a subagent_type, or the default when there is none.
export function parseRoute(requested: string | undefined, fallback: Route): Route {
  if (requested === undefined || requested === '') return fallback
  if (requested.toLowerCase() === 'claude') return { kind: 'claude' }
  const head = /^[^/:]*/.exec(requested)![0].toLowerCase()
  if (!isBackendId(head)) return { kind: 'pi', requested }
  const rest = requested.slice(head.length)
  if (head === 'pi') {
    // `pi`, `pi:high` and `pi/<model>` are `default`, `default:high` and the model.
    const { model, level } = splitModel(rest)
    return { kind: 'pi', requested: model ? `${model}${level ? `:${level}` : ''}` : `default${level ? `:${level}` : ''}` }
  }
  const { model, level } = splitModel(rest)
  if (rest.startsWith(':') && !level) {
    return { kind: 'error', error: `"${requested}": after "${head}:" comes a reasoning effort (${levels}); to name a model write ${head}/<model>.` }
  }
  const problem = model ? modelProblem(model) : undefined
  if (problem) return { kind: 'error', error: problem }
  return { kind: 'backend', backend: head, model, level }
}

// The default for an Agent call with no `@`: pi when it is installed, else Claude; or what
// PI_SUBAGENT_DEFAULT names.
export function defaultRoute(setting: string | undefined, installed: ReadonlySet<BackendId>): Route {
  const word = (setting ?? '').trim().toLowerCase()
  if (!word) return installed.has('pi') ? { kind: 'pi' } : { kind: 'claude' }
  if (word === 'claude' || word === 'native') return { kind: 'claude' }
  if (word === 'pi') return { kind: 'pi' }
  if (isBackendId(word) && word !== 'pi') return { kind: 'backend', backend: word }
  return { kind: 'error', error: `PI_SUBAGENT_DEFAULT is "${setting}"; use claude or one of: ${BACKEND_IDS.join(', ')}.` }
}

export function policyOf(setting: string | undefined): Policy | { error: string } {
  const word = (setting ?? '').trim().toLowerCase()
  if (word === '' || word === 'bypass') return 'bypass'
  if (word === 'guarded') return 'guarded'
  return { error: `PI_SUBAGENT_PERMISSIONS is "${setting}"; use bypass or guarded.` }
}

// ---- finding what is installed --------------------------------------------------------------

// Prints `<name>\t<path>` for each name that is an executable on PATH.
export const DETECT_SCRIPT = 'for b in "$@"; do p=$(command -v "$b") && case "$p" in /*) printf "%s\\t%s\\n" "$b" "$p";; esac; done'

export const detectArgv = (): string[] => ['bash', '-c', DETECT_SCRIPT, 'pi-subagent', ...BACKEND_IDS.flatMap(id => BACKENDS[id].bins)]

// The executable to run for each backend that is installed.
export function parseDetected(stdout: string): Map<BackendId, string> {
  const found = new Set(stdout.split('\n').map(line => line.split('\t')[0] ?? ''))
  const out = new Map<BackendId, string>()
  for (const id of BACKEND_IDS) {
    const bin = BACKENDS[id].bins.find(b => found.has(b))
    if (bin) out.set(id, bin)
  }
  return out
}

// What the main agent is told about the backends: which are here, how to ask for one, and what happens without an `@`.
export function backendsNote(installed: ReadonlyMap<BackendId, string>, fallback: Route): string {
  const here = BACKEND_IDS.filter(id => installed.has(id))
  const missing = BACKEND_IDS.filter(id => !installed.has(id))
  const where =
    fallback.kind === 'claude'
      ? 'Claude'
      : fallback.kind === 'pi'
        ? 'pi'
        : fallback.kind === 'backend'
          ? BACKENDS[fallback.backend].title
          : 'an error: PI_SUBAGENT_DEFAULT is not valid'
  const rows = here.map(id => `  - \`@${id}\` · ${BACKENDS[id].title}: ${BACKENDS[id].hint}`)
  const other = here.filter(id => id !== 'pi')
  const examples = other.length ? ` (${[`\`Explore@${other[0]}/<model>:high\``, ...(other[1] ? [`\`general-purpose@${other[1]}\``] : [])].join(', ')})` : ''
  return [
    `- Agent: append ${AGENT_SYNTAX} to subagent_type${examples}; \`:<effort>\` is one of ${levels}. Without an \`@\`, the agent runs on ${where}.`,
    ...(rows.length ? ['  Installed here:', ...rows] : ['  None of the supported agent CLIs is installed here, so subagents run on Claude.']),
    ...(missing.length && here.length ? [`  Not installed: ${missing.join(', ')}.`] : []),
  ].join('\n')
}
