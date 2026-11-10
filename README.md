# Polyagent: any coding agent or model as a native Claude Code subagent

**Run Codex, Gemini, DeepSeek, Kimi, GLM, Qwen and any Anthropic-compatible model as real Claude Code subagents.** Claude stays in charge; the work runs wherever it's cheapest, fastest or best.

Polyagent is a Claude Code mod: it changes how Claude Code runs its own subagents, and installs like a plugin. Write `subagent_type: "Explore@codex"` (or set up a role and write `"@explore"`) and the subagent runs on another agent's CLI, while staying a first-class Claude Code subagent: it appears in the task list, sends the usual completion notice, works in a git worktree, and can be stopped with TaskStop or continued with SendMessage.

```
/plugin install polyagent --marketplace ipy/polyagent
```

## Why Polyagent

- **Native, not bolted on.** No wrapper scripts and no copy-pasting between tools. The subagent is Claude Code's own; only its model calls are answered by the agent you chose. Background runs, worktrees, resume, stop and the live view all behave as they do for Claude.
- **Every major coding agent.** [pi](https://pi.dev) (and through it DeepSeek, GLM, Qwen, MiniMax, Gemini, GPT, …), OpenAI Codex CLI, Google Antigravity (`agy`), opencode, CodeBuddy Code, Claude Code itself, and Claude Code pointed at **any Anthropic-compatible API** (a gateway, a proxy, a provider's Anthropic endpoint).
- **Roles with automatic failover.** Say what a job needs, not which tool: `@explore`, `@coding`, `@review`. Each role lists agents best first. If one can't start (no login, a refused key, a bad model), the next takes over in the same turn, down to Claude itself.
- **Spend where it makes sense.** Send broad searches and first drafts to fast, cheap models, and keep Claude for judgment. Work that runs on another agent is billed by that agent's provider, not your Claude plan ([details](#does-it-use-my-claude-subscription)).
- **Supervised.** Read any subagent's live activity, or have its progress pushed to Claude every few minutes. Third-party models can drift; you'll see it.

## How it works

```
You ──▶ Claude (main agent) ──Agent tool──▶ native subagent
                                              │  its model calls are intercepted
                                              ▼
                                   codex / agy / opencode / pi / claude (gateway)
                                   running headless, streaming its steps back
```

Claude Code runs the subagent as usual. When the subagent asks its model for the next step, Polyagent sends the task to the chosen CLI instead, streams that agent's work into the subagent's transcript and live view, and hands back its final answer, with the agent's real token usage.

## Quick start

1. **Install the mod** (in a Claude Code session):
   ```
   /plugin install polyagent --marketplace ipy/polyagent
   ```
   Or from a shell: `claude plugin install polyagent --marketplace ipy/polyagent`. In the desktop app: + next to the input → Plugins → Add marketplace → `ipy/polyagent` → Add plugin.
2. **Have at least one agent CLI on `PATH`**, signed in: `codex`, `agy`, `opencode`, `pi`, `codebuddy`, or `claude` for a gateway.
3. **Just ask:** "have codex review this diff", "explore the repo with gemini-3.8-flash". The Agent tool's description lists the agents installed on your machine and how to name their models, so Claude knows what to write.

Optional: [define gateways and roles](#gateways-and-roles), and [set it all up from a cloud environment's start script](#set-up-from-a-start-script).

## Choose an agent

The Agent tool's `model` parameter only accepts Claude models, so the agent goes after an `@` in `subagent_type`:

```
subagent_type: "<type>@<agent>[/<model>][:<effort>]"
```

| You want | Write |
|---|---|
| The default (pi when installed, otherwise Claude; or what `POLYAGENT_DEFAULT` names) | `general-purpose` |
| A role you configured | `@explore` (the role's agent type), `Plan@review:high` |
| Codex CLI | `general-purpose@codex`, `general-purpose@codex/gpt-5.5:high` |
| Antigravity (Gemini) | `general-purpose@agy/gemini-3.8-flash-high` |
| Claude Code on a gateway you configured | `general-purpose@<gateway>/<model>` |
| opencode | `general-purpose@opencode/ollama/qwen3.5:9b` |
| CodeBuddy Code | `general-purpose@codebuddy-code/glm-5.3` |
| pi on its current default model | `general-purpose@default` (or `@pi`), optionally `@default:high` |
| pi on a model | `Explore@codebuddy/deepseek-v4.1-flash` |
| pi with a thinking level | `general-purpose@minimax-cn/MiniMax-M3.1-Flash-Preview:high`, or add `effort: "high"` |
| Claude Code as a separate process | `general-purpose@claude-code/opus` |
| Claude itself (native) | `model: "haiku"` (or sonnet / opus / fable), or `general-purpose@claude` |

- `<agent>` is `pi`, `claude-code`, `codex`, `codebuddy-code`, `agy` or `opencode`, or the name of a configured gateway or role. Anything else after the `@` is a pi model.
- `<model>` is whatever that CLI accepts after its own `--model`; leave it out for the CLI's default. It may hold slashes and colons (opencode names models `<provider>/<model>`: above, provider `ollama`, model `qwen3.5:9b`). `agy models` and `opencode models` list what you can use; `codebuddy --help` lists CodeBuddy's. A model your CLI can't use fails the run with the CLI's own error, shown in the answer.
- `:<effort>` is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Each CLI gets the nearest value on its own scale (`minimal` becomes `low` for Claude Code and agy, `max` becomes `xhigh` for Codex, `off` sends nothing and Codex gets `none`; opencode takes it as its model variant). The Agent tool's `effort` parameter is used when the suffix names none.
- `@claude` runs the agent natively on Claude. `@claude-code` runs a **separate Claude Code process** that inherits the environment (so `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_MODEL` apply to it) but not the main session's model or conversation. To point it at another API without touching the main session, use a [gateway](#gateways).
- `fork` and `isolation: "remote"` always run on Claude.

## Gateways and roles

### Configuration

Polyagent reads `~/.claude/polyagent/config.json`, and `POLYAGENT_CONFIG` (JSON, or a file path), whose entries replace the file's name by name. It's read at every Agent call, so edits take effect at once. Problems are shown when the session starts and in the Agent tool's description.

```json
{
  "gateways": {
    "mygw": {
      "baseUrlEnv": "MYGW_BASE_URL",
      "keyEnv": "MYGW_API_KEY",
      "models": ["coding", "explore"],
      "env": { "CLAUDE_CODE_EFFORT_LEVEL": "max" }
    },
    "local": { "baseUrl": "http://localhost:4000", "auth": "bearer", "keyEnv": "LOCAL_TOKEN", "model": "qwen3-coder" }
  },
  "roles": {
    "explore": { "type": "Explore", "targets": ["agy/gemini-3.8-flash", "mygw/explore", "claude/haiku"] },
    "coding":  { "targets": ["mygw/coding", "codex/gpt-5.5", "claude/sonnet"] },
    "review":  { "type": "Plan", "targets": ["agy/gemini-3.8-flash", "claude/sonnet"],
                 "description": "Have every finding confirmed by @review-confirm before reporting it." },
    "review-confirm": { "type": "Plan", "targets": ["agy/gemini-4-argon", "claude/opus"] }
  }
}
```

### Gateways

A gateway is Claude Code run against an Anthropic-compatible API (an LLM gateway, a self-hosted proxy, a provider's Anthropic endpoint), separate from the main session: `subagent_type: "general-purpose@mygw/coding"`.

| Field | |
|---|---|
| `baseUrl` or `baseUrlEnv` | The API's base URL, or the **name** of the variable that holds it (keep private URLs out of files). |
| `keyEnv` | The **name** of the variable that holds the key. Never the key itself. |
| `auth` | `api-key` (default: sent as `x-api-key`, `ANTHROPIC_API_KEY`) or `bearer` (`ANTHROPIC_AUTH_TOKEN`). |
| `model` | The model when a call names none. Without it a model is required (`@mygw/<model>`), since Claude Code's own default means nothing to most gateways. |
| `models` | Names to tell Claude about (aliases the gateway maps, or its ids). |
| `env` | Other variables for the CLI, such as `CLAUDE_CODE_EFFORT_LEVEL` or `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. Secrets are refused here. |
| `description` | Shown to Claude. |

**Your key stays out of sight.** Polyagent never reads the URL or the key. It starts the CLI through a small bash shim that reads the variables the gateway names, so neither value appears on a command line (`ps`), in the activity log or in the transcript. The shim also removes the main session's credentials and `CLAUDE_CODE_REMOTE` (a child `claude` in a Claude Code cloud session that keeps it and talks to another base URL hangs). Every Claude Code model slot (`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`) is set to the model asked for, so a gateway alias reaches the gateway; Claude Code's "doesn't recognize the model" warning is harmless. A gateway is usable when `claude` is on `PATH` and its variables are set. In a cloud environment, allow the gateway's host in the network settings.

### Roles

A role is a list of targets, best first: `<agent>[/<model>][:<effort>]`, `<gateway>/<model>`, or `claude/<opus|sonnet|haiku|fable>` (Claude itself). `subagent_type: "@<role>"` gives the agent the role's `type` (default `general-purpose`); `"<type>@<role>"` picks the type, and `@<role>:<effort>` sets the effort of targets that name none.

- The agent runs on the first target usable now: installed, its variables set, and not failed to start within the last hour.
- If that target can't start (an error before doing anything: a refused key, a bad model, a missing login), the next one runs in the same turn, and the answer says what was skipped. A run that fails after it started working isn't moved, since its session belongs to that agent.
- When the next target is Claude, the step is handed to Claude with that model, and the agent stays on Claude from then on.
- Read-only types (`Explore`, `Plan`) stay read-only on every target.

The Agent tool's description lists each role with the targets usable right now, so Claude delegates through roles without a skill or extra instructions. A role's `description` is shown to Claude with it: that's where rules like "confirm every finding with `@review-confirm`" go.

### Set up from a start script

`scripts/setup.sh` installs the mod and writes the configuration, and is safe to run again. In a Claude Code cloud environment, put it in the environment's setup script. The configuration only names variables; the values (`MYGW_API_KEY`, `AGY_AUTH_B64`, …) go in the environment's variables, which the session reads (the setup script can't).

```bash
curl -fsSL https://raw.githubusercontent.com/ipy/polyagent/main/scripts/setup.sh -o /tmp/polyagent-setup.sh
bash /tmp/polyagent-setup.sh <<'JSON'
{ "gateways": { "mygw": { "baseUrlEnv": "MYGW_BASE_URL", "keyEnv": "MYGW_API_KEY", "models": ["coding", "explore"] } },
  "roles": { "explore": { "type": "Explore", "targets": ["agy/gemini-3.8-flash", "mygw/explore", "claude/haiku"] },
             "coding": { "targets": ["mygw/coding", "claude/sonnet"] } } }
JSON
```

It prints the version it ends up with. Options: `--config FILE` (instead of stdin), `--source` (another marketplace source, such as a fork or a local path), `--no-install` (configuration only). Without a setup script, put the JSON in `POLYAGENT_CONFIG` and install the plugin once.

### Saved logins

Cloud containers start fresh, so CLI logins don't survive. At session start Polyagent unpacks `AGY_AUTH_B64` (and `CODEX_AUTH_B64`), each a base64 tar of the CLI's login files, into `$HOME`: once per container, never over an existing file. bash reads the value itself, so it never passes through the mod, a command line or a log. To make one without a local browser:

```bash
bash scripts/auth.sh login agy           # prints a URL to open on any device
bash scripts/auth.sh finish agy <code>   # the code the page shows after sign-in
bash scripts/auth.sh save agy            # writes ~/.model-router/AGY_AUTH_B64.txt
```

Then set the file's content as `AGY_AUTH_B64` where Claude Code starts (for a cloud session, the environment's variables).

## Supported agents

| Agent (`@…`) | Tested with | How the task reaches it | Resume | Read-only types (Explore, Plan, claude-code-guide) |
|---|---|---|---|---|
| `pi` | pi 1.2.x | RPC command file | pi session file | only `read,grep,find,ls` |
| `codex` | Codex CLI 0.135 | stdin | `codex exec resume <thread>` | `read-only` sandbox |
| `agy` | agy 1.5.3 | `--prompt=` argument | `--conversation` | file-writing and MCP tools denied (`--settings`); the shell stays, like Claude Code's own Explore keeps Bash (agy's rules can't limit commands to read-only ones, and without them it can't list a folder) |
| `opencode` | opencode 1.15.10 | argument after `--` | `--session` | `bash` and `edit` denied (`OPENCODE_PERMISSION`) |
| `codebuddy-code` | CodeBuddy Code 2.181 | stdin | `--resume` | only `Read,Grep,Glob,LS` |
| `claude-code` | Claude Code 2.1.x | stdin | `--resume` | only `Read,Grep,Glob,LS` |
| gateways | Claude Code 2.1.x | stdin | `--resume` | only `Read,Grep,Glob,LS` |

An agent is offered only when its executable is on `PATH` (`pi`, `claude`, `codex`, `codebuddy-code` / `codebuddy` / `cbc`, `agy`, `opencode`). A call for a missing one is refused with a message naming what is installed.

## Features

- **Live view**: open a subagent from ↓ and the area above the prompt shows its agent, model, status and latest steps (text, tool calls and results, errors, retries). Each step is also written into the subagent's transcript (ctrl+o shows it).
- **Resume**: after a subagent finishes, `SendMessage` continues it in the same session of its agent, also after a reload or reopening the session.
- **Steering** (pi): `SendMessage` to a running pi subagent is delivered after its current tool calls. Other agents get the message when their current run ends, in the same session.
- **Stop**: `TaskStop` stops the agent's whole process tree.
- **Worktrees** (`isolation: "worktree"`): the agent works in its own git worktree, reset to the session's current HEAD before it starts (Claude Code makes worktrees from `origin/main`; uncommitted changes in the main checkout don't come along). The agent is told to stay inside it and commit there, and its answer ends with `[worktree · path · branch]`. If the worktree can't be found, the run is refused; it never falls back to another directory.
- **Supervision**: `mcp__polyagent__subagent_activity` reads a subagent's recent activity (text, tool calls, results, model errors and retries) with paging. `mcp__polyagent__watch_subagent` pushes what the subagent did since the last notice every N seconds: on the next tool result while Claude is busy (keeping the prompt cache intact), or as a prompt of its own while it's idle.
- **No false stalls**: Claude Code stops a subagent after 600 s without progress, but a build or test run can be silent for minutes. A 20-second heartbeat keeps the subagent alive while its agent has a tool call in flight; a hung model with nothing running still gets stopped.
- **Auto mode hand-back**: in auto permission mode Claude Code only accepts a subagent's report through its `SubagentHandback` tool. Polyagent delivers the answer that way whenever Claude Code arms it, as its note to the agent says (`CLAUDE_CODE_DISABLE_SUBAGENT_HANDBACK` and `CLAUDE_CODE_SENDMESSAGE_HANDBACK` are honoured). If Claude Code asks again, the same answer is given again; the agent is never run twice.
- **Real usage**: each answer ends with the token usage the agent reported, and Claude Code is told it under the name `<agent>/<model>`, so it isn't priced as a Claude model.
- **pi's model scope**: subagents on pi can only use the models you scoped in pi (`enabledModels`); the list, with context length, thinking and image support, is shown to Claude. `@default` is pi's current default model.

## Permissions

Nobody can answer a permission prompt inside a headless subagent, so **by default each CLI runs unattended, with its permission prompts off**. The agent can run any command as you, as if you had told that CLI to skip permissions.

| Agent | Default (`bypass`) | `POLYAGENT_PERMISSIONS=guarded` |
|---|---|---|
| `claude-code`, gateways, `codebuddy-code` | `--dangerously-skip-permissions` | `--permission-mode=acceptEdits` (edits in the directory; commands that need approval are refused) |
| `codex` | `danger-full-access` sandbox, never asks | `workspace-write` sandbox, never asks |
| `agy`, `opencode` | `--dangerously-skip-permissions` | no flag: the headless run refuses what needs approval |
| `pi` | no permission system | no permission system |

What a CLI refuses is never hidden: the answer ends with `[codex was refused: Bash. …]`, and a run refused everything fails with that reason. Read-only types are limited the same way under both settings. To contain a risky task, use `isolation: "worktree"` and/or `guarded`. Claude Code refuses `--dangerously-skip-permissions` as root unless `IS_SANDBOX` is set (Claude Code cloud sessions set it); elsewhere as root, use `guarded`.

## Environment variables

| Variable | Values | Effect |
|---|---|---|
| `POLYAGENT_DEFAULT` | `claude`, `pi`, `claude-code`, `codex`, `codebuddy-code`, `agy`, `opencode`, or a configured role or gateway | Where an Agent call **without** `@` goes. Unset: pi if installed, otherwise Claude. |
| `POLYAGENT_CONFIG` | JSON, or a JSON file's path | Gateways and roles, over `~/.claude/polyagent/config.json`. |
| `POLYAGENT_PERMISSIONS` | `bypass` (default), `guarded` | See [Permissions](#permissions). |
| `AGY_AUTH_B64`, `CODEX_AUTH_B64` | base64 tar of a login | See [Saved logins](#saved-logins). |
| `POLYAGENT_NESTED` | set by Polyagent | Exported into every CLI it starts, so a Claude Code started as an agent doesn't route its own subagents again. Don't set it yourself. |

## FAQ

### Does it use my Claude subscription?

Only where Claude does the work. Requests from codex, agy, opencode, pi, CodeBuddy and gateways go to those agents' own providers and accounts, and your Claude plan doesn't meter them. Your plan still pays for the main agent (writing tasks and reading answers, so short reports help), `claude/*` role targets and fallbacks, `@claude` and `model:` calls, and `@claude-code`, which uses your Claude login. In auto mode, Claude Code's safety classifier also reviews hand-back reports.

### Is it really native?

Yes. The subagent is spawned, listed, notified, isolated, stopped and resumed by Claude Code itself. Polyagent only answers its model requests. That's why worktrees, background runs, SendMessage and TaskStop work unchanged.

### Is it safe?

By default agents run unattended, like any CLI with permissions skipped; use `guarded`, worktrees and read-only types to contain them. Gateway keys and saved logins never pass through the mod, a command line or a log.

### Which models can I use?

Whatever your installed CLIs can reach: Codex models, Gemini through Antigravity, local models through opencode and Ollama, DeepSeek, GLM, Qwen and MiniMax through pi or CodeBuddy, and anything an Anthropic-compatible gateway serves (Kimi, DeepSeek and others, behind your own gateway or a provider's Anthropic endpoint).

### Does it work in Claude Code on the web?

Yes. Install the agent CLIs and Polyagent from the environment's [setup script](#set-up-from-a-start-script), store keys and saved logins in the environment's variables, and allow the providers' hosts in its network settings.

## Coming from pi-subagent

Polyagent was called **pi-subagent**. Everything was renamed: the package and marketplace (`polyagent@polyagent`), the tools (`mcp__polyagent__…`), the variables (`POLYAGENT_*`) and the configuration path (`~/.claude/polyagent/config.json`).

- The old `PI_SUBAGENT_*` variables and `~/.claude/pi-subagent/config.json` still work while the new ones are unset or missing.
- `scripts/setup.sh` uninstalls `pi-subagent@claude-code-pi-subagent` and removes its marketplace before installing Polyagent. Installed by hand, uninstall the old package yourself, or every Agent call is handled twice.
- Agents started under the old name can't be resumed from the new one (the mod's stored state is kept per package name).

## Requirements

| Dependency | Notes |
|---|---|
| Claude Code | With Claude Mods (function hooks); verified on 2.1.3xx |
| macOS or Linux | CLIs are started through `bash` (stock macOS bash 3.2 works) and stopped with `pgrep`; not tested on Windows |
| At least one agent CLI on `PATH` | See [Supported agents](#supported-agents). Other versions usually work; a pi other than 1.2.x is reported at session start. |

Files Polyagent writes: pi sessions in `~/.pi/claude-subagents/`; the task of an agent that reads it from stdin in `~/.claude/polyagent/<agent id>.prompt.txt` (private, removed when the run ends). Prompts over 30,000 characters for `agy` and `opencode` go the same way, and the CLI is told to read the file.

## Develop

```bash
git clone https://github.com/ipy/polyagent.git
claude --plugin-dir ./polyagent
claude plugin test ./polyagent       # unit tests and engine-level integration tests
claude plugin validate --strict ./polyagent
```

The code is in `hooks/`: `core.ts` (shared helpers: the wrapper script, worktrees, activity, stats), `backends.ts` (the agents: command lines, output parsers, routes; pure), `routing.ts` (gateways and roles: configuration, role resolution, health; pure), `register.tsx` (the Claude Code glue). `scripts/` holds the setup and login scripts.

### Add a coding agent

Add an entry to `BACKENDS` in `hooks/backends.ts` (and its id to `BACKEND_IDS`):

- `bins`: executable names to look for on `PATH`, best first;
- `input`: how the task is delivered: `stdin` (from a file) or `arg` (`rpc` is pi's);
- `argv`: the headless command line, given the session to resume, model, effort, read-only flag and permission policy;
- `parser`: reads one JSON line of output at a time into activity items and run stats (answer, usage, session id, refused actions, whether a tool is in flight);
- `effort`, `steers`, `persistent`, `systemNote`, `promptNote`, `label`, `title`, `hint`: the effort mapping, whether it takes messages mid-run, stays up between turns, takes the read-only note as a system prompt, gets a line before every prompt, and how it is named to you and to Claude.

Then add argv and parser cases to `hooks/backends.test.ts`, using output captured from the real CLI. An agent whose headless protocol hasn't been verified against the real CLI isn't added (Gemini CLI, for one).

## Known limitations

- The token count in Claude Code's own completion notice is its estimate; the agent's real usage is the line at the end of the answer.
- A foreground Agent call's result doesn't show Claude the subagent's id (Claude Code 2.1.3xx, native agents too), so SendMessage can't reach it. Use `run_in_background: true` when you may want to continue the agent.
- When a role falls back to Claude, Claude's answer carries no line about the skipped targets; `subagent_activity` records it.
- A role fails over only when a target errors before doing anything. A CLI that hangs silently is stopped by Claude Code after 600 seconds and isn't failed over.
- `fork` and `isolation: "remote"` can't run on another agent. Only pi can be steered mid-run.
- Codex, agy and opencode don't report which model answered, so the answer shows the one asked for, or `<agent>'s default model`.
- With some providers (seen with a local Ollama model) opencode's last step reports no tokens, so the usage line leaves it out.

## License

MIT
