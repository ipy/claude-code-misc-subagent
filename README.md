# pi-subagent

A Claude Code mod that lets **native subagents run on other coding agents**: [pi](https://pi.dev) (and through it DeepSeek, GLM, Qwen, MiniMax, Gemini, GPT…), Codex CLI, Claude Code itself, CodeBuddy Code, Antigravity (`agy`) and opencode. The main agent (Claude) stays the supervisor.

The subagent is still Claude Code's own: it shows up in the ↓ task list, completes with the native notification, can be isolated in a native worktree, stopped with TaskStop, and continued with SendMessage. The mod does one thing: it intercepts the subagent's model request, does not send it to Claude, hands the task to the chosen agent's CLI running headless, and returns that agent's final answer to the engine as the "model reply".

## Choose an agent

The `model` parameter of the Agent tool is a fixed enum of Claude models, so the agent is written after an `@` in `subagent_type`:

```
subagent_type: "<type>@<agent>[/<model>][:<effort>]"
```

| You want | Write |
|---|---|
| The default (pi when it is installed, otherwise Claude; or what `PI_SUBAGENT_DEFAULT` names) | `general-purpose` |
| pi on its current default model | `general-purpose@default` (or `@pi`), optionally `@default:high` |
| pi on a model | `Explore@codebuddy/deepseek-v4.1-flash` |
| pi with a thinking level | `general-purpose@minimax-cn/MiniMax-M3.1-Flash-Preview:high`, or add `effort: "high"` |
| Codex CLI | `general-purpose@codex`, `general-purpose@codex/gpt-5.5:high` |
| Claude Code as a separate process | `general-purpose@claude-code/opus` |
| CodeBuddy Code | `general-purpose@codebuddy-code/glm-5.3` |
| Antigravity | `general-purpose@agy/gemini-3.8-flash-high` |
| opencode | `general-purpose@opencode/ollama/qwen3.5:9b` |
| Claude itself (native) | `model: "haiku"` (or sonnet / opus / fable), or `general-purpose@claude` |

- `<agent>` is `pi`, `claude-code`, `codex`, `codebuddy-code`, `agy` or `opencode`. Anything else after the `@` is a pi model.
- `<model>` is whatever that CLI accepts after its own `--model`; leave it out for the CLI's own default. It may hold slashes and colons: for opencode, which names models `<provider>/<model>`, the example above is provider `ollama`, model `qwen3.5:9b`. `agy models` and `opencode models` list the models you can use there; `codebuddy --help` lists CodeBuddy's. A model your CLI cannot use (not installed, or not available on your plan or version) fails the run with the CLI's own error, shown in the answer.
- `:<effort>` is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Each CLI gets the nearest value of its own scale: `minimal` becomes `low` for Claude Code and agy, `max` becomes `xhigh` for Codex, and `off` sends nothing (Codex gets `none`). opencode takes the level as its model variant. The Agent tool's `effort` parameter is used when the suffix names none.
- `@claude` runs the agent natively on Claude. `@claude-code` runs a **separate Claude Code process** instead. It inherits Claude Code's environment, so a gateway or custom model names set with `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_MODEL` serve it too (`general-purpose@claude-code/<your model name>`), but it does not use the main session's model or conversation.
- `fork` and `isolation: "remote"` always run on Claude.

You rarely write this by hand: the Agent tool's description lists the agents installed on this machine, how to name a model for each, and where a call without `@` goes, so you can say "use codex for this one" and the main agent knows how.

## The agents

| Agent (`@…`) | Tested with | How the task reaches it | Session | Read-only types (Explore, Plan, claude-code-guide) |
|---|---|---|---|---|
| `pi` | pi 1.2.x | RPC command file | pi session file named after the agent | only `read,grep,find,ls` |
| `claude-code` | Claude Code 2.1.x | stdin | `--resume` | only `Read,Grep,Glob,LS` |
| `codex` | Codex CLI 0.135 | stdin | `codex exec resume <thread>` | `read-only` sandbox |
| `codebuddy-code` | CodeBuddy Code 2.181 | stdin | `--resume` | only `Read,Grep,Glob,LS` |
| `agy` | agy 1.5.3 | `--prompt=` argument | `--conversation` | no approval flag, so what needs approval (writes) is refused |
| `opencode` | opencode 1.15.10 | argument after `--` | `--session` | `bash` and `edit` denied for the run (`OPENCODE_PERMISSION`) |

A backend is used only if its executable is on `PATH` (`pi`, `claude`, `codex`, `codebuddy-code` / `codebuddy` / `cbc`, `agy`, `opencode`). An Agent call for one that is missing is refused with a message naming the ones that are installed.

## Permissions

Nobody can answer a permission prompt inside a headless subagent, so **by default each CLI runs unattended, with its permission prompts off** — as pi always does, since it has none. The agent can run any command as you, exactly as if you had told that CLI to skip permissions.

| Agent | Default (`bypass`) | `PI_SUBAGENT_PERMISSIONS=guarded` |
|---|---|---|
| `claude-code`, `codebuddy-code` | `--dangerously-skip-permissions` | `--permission-mode=acceptEdits` (edits in the directory; commands that need approval are refused) |
| `codex` | `danger-full-access` sandbox, approvals never asked | `workspace-write` sandbox, approvals never asked |
| `agy`, `opencode` | `--dangerously-skip-permissions` | no flag: the headless run refuses what needs approval |
| `pi` | no permission system | no permission system |

What a CLI refuses is not hidden: the answer ends with `[codex was refused: Bash. …]`, and a run that was refused everything and produced nothing fails with that reason. Read-only types are limited the same way under both settings. CodeBuddy Code still asks for approval on operations it rates high-risk even in `bypass`; those are refused and reported the same way.

To contain a risky task, use `isolation: "worktree"` (the agent works in its own git worktree) and/or `PI_SUBAGENT_PERMISSIONS=guarded`. Claude Code refuses `--dangerously-skip-permissions` when run as root, so use `guarded` there.

## Environment variables

Set them in the environment Claude Code is started from.

| Variable | Values | Effect |
|---|---|---|
| `PI_SUBAGENT_DEFAULT` | `claude`, `pi`, `claude-code`, `codex`, `codebuddy-code`, `agy`, `opencode` | Where an Agent call **without** `@` goes. Unset: pi if installed, otherwise Claude. |
| `PI_SUBAGENT_PERMISSIONS` | `bypass` (default), `guarded` | See [Permissions](#permissions). |
| `PI_SUBAGENT_NESTED` | set by the mod | Exported into every CLI the mod starts, so a Claude Code started as a backend does not route its own subagents again. Do not set it yourself. |

## Features

- **pi's model scope**: subagents on pi can only use the scoped models you configured in pi (`enabledModels`, i.e. `/scoped-models`). The list, with each model's context length, thinking and image support, is written into the Agent tool's description so the main agent can choose; a model outside the list is refused. With none named, pi's `defaultModel` is used.
- **`@default`**: `subagent_type: "general-purpose@default"` means "pi's current default model" (read again on every launch, not a snapshot from the session's start); a thinking level can follow: `@default:high`. The Agent description tells the main agent to use it unless you name a model.
- **Steering** (pi only): `SendMessage` to a running pi subagent becomes an RPC `steer`; pi reads it after its current batch of tool calls. The other agents read their prompt once, so a message sent while one works is queued by the engine and delivered when its current run ends, in the same session.
- **Resume**: after a subagent finishes, `SendMessage` continues it natively in the same session of its agent, also after the mod was reloaded or the session reopened. Sessions of the other agents continue in the directory they began in.
- **Stop**: native `TaskStop` stops the agent's whole process tree.
- **Supervision** (third-party models can drift or stall):
  - `mcp__pi-subagent__subagent_activity` reads a subagent's recent public activity (text, tool calls and results, model errors and retries), with cursor paging and single-event detail.
  - `mcp__pi-subagent__watch_subagent` pushes what the subagent did since the last notice to the main agent every N seconds. When the main agent is busy the notice is attached to the end of its next tool result (the row is rewritten before it is stored rather than added as a new row: the position of an added row in the transcript depends on when it lands on disk and may differ from where it was actually sent, so the next turn's prefix no longer matches and the prompt cache is rebuilt from the top; the TUI shows a one-line summary under that tool result, and ctrl+o expands it). When idle it wakes the agent directly.
- **Worktree isolation** (`isolation: "worktree"`): by default the engine creates the worktree from `origin/main`, not from the branch the main session is on. Before the agent first starts, if its worktree is clean, the mod resets it (`reset --hard`) to the main session's current HEAD commit (the session's repository is recorded at the Agent call; uncommitted changes in the main checkout do not come along). When that cannot be done (there are changes, the reset fails) the agent is told so. A resume does not reset again. The agent is told the worktree's path and to stay out of the main checkout and commit on that branch, and its answer ends with `[worktree · path · branch name]`. If the worktree cannot be found (for example the engine removed an unchanged one) the run is refused and **never falls back to another directory**; the answer says why (on a resume, start a new subagent instead). A Claude-run subagent keeps the engine's own worktree, based on origin/main.
- **Long commands are not taken for a stall**: a compile or test can print nothing for minutes, and the engine stops a subagent after 600 seconds without progress. The wrapper script that starts every CLI prints a heartbeat line to stderr every 20 seconds, and while the agent has a tool call in flight the mod turns it into an empty `thinking` block for the engine (shown, not recorded). A CLI that is silent with no tool running (a hung model) gets no heartbeat and is stopped after 600 seconds as before.
- **Read-only types**: `Explore`, `Plan` and `claude-code-guide` cannot change files; see [The agents](#the-agents) for how each CLI enforces it.
- **Live view**: open a subagent from ↓ and the area above the prompt shows its agent, model, status and latest steps live (text, tool calls and results, errors and retries), in normal colors; it folds away when you return to the main conversation. Each step is also written into the subagent's own transcript (the model does not read it); ctrl+o shows the full record, drawn dim by the engine.
- **Real usage**: the answer ends with one line of the token usage the agent reported (the token count in the native notification is the engine's own estimate and is inaccurate). For agents other than pi, the usage handed to the engine is labelled `<agent>/<model>`.

## Requirements

| Dependency | Notes |
|---|---|
| Claude Code | With Claude Mods (function hooks); developed and verified on 2.1.302 |
| macOS or Linux | The mod starts every CLI through `bash` (stock macOS bash 3.2 works) and stops it with `pgrep`, so it needs both; it has not been run on Windows |
| At least one agent CLI on `PATH` | See [The agents](#the-agents) for the executables and the versions the mod was verified with. Other versions usually work; a pi version other than 1.2.x is reported when the session starts. |
| pi's scoped models | `enabledModels` in `~/.pi/agent/settings.json` (or the project's `.pi/settings.json`); with none, any model goes |

Files the mod writes: pi sessions in `~/.pi/claude-subagents/`; the task of an agent that reads it from stdin in `~/.claude/pi-subagent/<agent id>.prompt.txt` (created private, removed when the run ends). Prompts of more than 30,000 characters for `agy` and `opencode`, which take the task as an argument, go the same way: the CLI is told to read the file.

## Install

In a Claude Code terminal session:

```
/plugin install pi-subagent --marketplace ipy/claude-code-misc-subagent
```

Answer `y` to `Add marketplace?`, then pick the scope (user applies to every session).

From a shell:

```bash
claude plugin install pi-subagent --marketplace ipy/claude-code-misc-subagent
```

In the desktop app: click + next to the input, choose Plugins → Add marketplace, enter `ipy/claude-code-misc-subagent`, then Add plugin.

### Develop or try locally

```bash
git clone https://github.com/ipy/claude-code-misc-subagent.git
claude --plugin-dir ./claude-code-misc-subagent
claude plugin test ./claude-code-misc-subagent       # unit tests and engine-level integration tests
claude plugin validate --strict ./claude-code-misc-subagent
```

The code is in `hooks/`: `core.ts` (helpers shared by all agents: the wrapper script, worktrees, activity, stats), `backends.ts` (the agents: command lines, output parsers, routing; pure, no engine), `register.tsx` (the engine glue). The plugin keeps the name `pi-subagent` so existing installs, tool names (`mcp__pi-subagent__…`) and stored agents keep working.

### Adding another coding agent

Add an entry to `BACKENDS` in `hooks/backends.ts` (and its id to `BACKEND_IDS`):

- `bins`: executable names to look for on `PATH`, best first;
- `input`: how the task is delivered, `stdin` (from a file) or `arg` (`rpc` is pi's);
- `argv`: the headless command line, given the session to resume, model, effort, read-only flag and permission policy;
- `parser`: reads one JSON line of the CLI's output at a time into activity items and run stats (answer, usage, session id, refused actions, whether a tool is in flight);
- `effort`: maps the mod's levels to the CLI's own; `steers`, `persistent` and `systemNote`: whether a message can reach it while it works, whether it stays up after its turn, and whether it takes the read-only note as a system prompt; `label`, `title` and `hint`: the names and the advice about models shown to the user and the main agent.

Then add the argv and parser cases to `hooks/backends.test.ts` using output captured from the real CLI. An agent whose headless protocol has not been verified against the real CLI should not be added: Gemini CLI, for one, is not supported for that reason.

## Known limitations

- The `subagent_tokens` in the native completion notification is computed by the engine and does not reflect the agent's real usage; read the line at the end of the answer, or `subagent_activity`.
- While the main agent is idle, a watch notice wakes it as a plugin prompt of its own (folded to one line in the transcript, ctrl+o expands it).
- `fork` (inherits Claude's context) and `remote` (cloud) cannot run on another agent.
- Only pi can be steered while it works; the other agents get the message when their run ends.
- A Claude Code started with `@claude-code` is a new process: it inherits the environment, but not the main session's model, conversation or approvals. Without a model after `@claude-code/` it starts on its own default (`ANTHROPIC_MODEL` if set).
- Codex, agy and opencode do not say which model answered, so the header of the answer shows the one you asked for, or `<agent>'s default model`.
- opencode reports tokens in the closing event of each step, and with some providers (seen with a local Ollama model) its last step has none, so the usage line of such a run leaves that step out. The run itself is not affected: it counts as done when opencode exits cleanly with its last message.

## License

MIT
