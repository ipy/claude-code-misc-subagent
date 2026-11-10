// One line of a subagent's live activity, as the band above the prompt draws it.
export type LiveLine = { seq: number; kind: string; text: string }

// What the band shows for one subagent run by another coding agent while its transcript is open.
// `agent` names the backend (pi, claude, codex, codebuddy, agy, opencode); it is missing from
// state written before there were several.
export type Live = { agent?: string; label: string; status: string; model?: string; steps: number; lines: LiveLine[] }

declare module 'claude-code' {
  interface PluginState {
    'polyagent': { live: StateFamily<Live> }
  }
}
