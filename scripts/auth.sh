#!/usr/bin/env bash
# Log in to agy without a local browser, and carry logins across sessions (pi-subagent's model-router).
# The pi-subagent mod runs the same restore at session start, so `restore` is rarely needed by hand.
#   auth.sh login  agy          start the CLI's login in tmux, print the URL to open
#   auth.sh finish agy <code>   paste the code shown on the page after sign-in
#   auth.sh save   agy          pack the new login files into an env-var value (file)
#   auth.sh restore             unpack AGY_AUTH_B64 / CODEX_AUTH_B64 into $HOME
set -uo pipefail

STATE=$HOME/.model-router
mkdir -p "$STATE" && chmod 700 "$STATE"
die() { echo "auth: $*" >&2; exit 2; }

cli_of()  { case $1 in agy) echo agy ;; *) die "unknown kind '$1' (agy)" ;; esac; }
dir_of()  { case $1 in agy) echo .gemini/antigravity-cli ;; codex) echo .codex ;; esac; }
var_of()  { echo "$(tr a-z A-Z <<<"$1")_AUTH_B64"; }
screen()  { tmux capture-pane -p -t "mr-login-$1" 2>/dev/null; }

login() { # kind
  local kind=$1 s="mr-login-$1" scr url picked=0 trusted=0 i
  command -v tmux >/dev/null || die "tmux is required"
  tmux kill-session -t "$s" 2>/dev/null
  touch "$STATE/login-$kind.marker"
  (cd "$STATE" && tmux new-session -d -s "$s" -x 1000 -y 60 "$(cli_of "$kind")")
  for i in $(seq 60); do
    sleep 1; scr=$(screen "$kind")
    url=$(grep -oE 'https://[^ ]+' <<<"$scr" | grep -vE '127\.0\.0\.1|/docs' | tail -1)
    if [ -n "$url" ] && grep -qiE 'authorization code|waiting for auth' <<<"$scr"; then
      echo "Open this URL and sign in:"; echo "$url"
      echo "Then run: auth.sh finish $kind <code shown on the page>"
      return 0
    fi
    if [ $trusted = 0 ] && grep -q 'trust the files' <<<"$scr"; then
      trusted=1; tmux send-keys -t "$s" Enter
    elif [ $picked = 0 ] && grep -q 'Select login method' <<<"$scr"; then
      picked=1; sleep 1   # menu needs a moment before it takes keys
      # agy: option 1 = Google OAuth
      tmux send-keys -t "$s" Enter
    elif [ $picked = 0 ] && [ $i -gt 15 ] && ! grep -qi 'sign' <<<"$scr"; then
      tmux kill-session -t "$s"; echo "No login prompt: $kind is probably already signed in."; return 0
    fi
  done
  echo "Timed out waiting for a login URL. Screen:"; screen "$kind" | grep -v '^\s*$' | tail -15
  return 1
}

finish() { # kind [code]
  local kind=$1 code=${2:-} s="mr-login-$1" wait=60 pending i
  tmux has-session -t "$s" 2>/dev/null || die "no login in progress; run: auth.sh login $kind"
  [ -n "$code" ] || die "needs the code: auth.sh finish $kind <code>"
  tmux send-keys -t "$s" -l "$code"; tmux send-keys -t "$s" Enter
  pending='authorization code'
  for i in $(seq "$wait"); do
    sleep 1
    if ! screen "$kind" | grep -qi "$pending"; then
      sleep 3; tmux kill-session -t "$s" 2>/dev/null
      rm -f "${TMPDIR:-/tmp}/pi-subagent-router.cache" "${TMPDIR:-/tmp}/model-router.cache"   # force a fresh probe
      echo "Signed in to $kind. To keep this login in future sessions run: auth.sh save $kind"
      return 0
    fi
  done
  echo "Still not signed in. Screen:"; screen "$kind" | grep -v '^\s*$' | tail -10; return 1
}

save() { # kind
  local kind=$1 dir marker out files
  dir=$(dir_of "$kind"); marker="$STATE/login-$kind.marker"; out="$STATE/$(var_of "$kind").txt"
  [ -f "$marker" ] || die "no recorded login for $kind; run auth.sh login $kind first"
  files=$(cd ~ && find "$dir" -type f -newer "$marker" \
            -not -regex '.*/\(log\|logs\|cache\|crashes\|sessions\|conversations\|traces\|diagnostics\|projects\|brain\|implicit\|plugins\|builtin\|bin\|updater\|shell-snapshots\|presence\)/.*' \
            -not -name '*.log' -not -name '*.db' -not -name '*.pb' -not -name '*.lock' 2>/dev/null)
  [ -n "$files" ] || die "no new login files under ~/$dir (the CLI may keep the token in a keyring)"
  (cd ~ && tar czf - $files) | base64 -w0 > "$out"; chmod 600 "$out"
  echo "Files packed:"; sed 's/^/  ~\//' <<<"$files"
  echo "Value written to: $out ($(wc -c <"$out") bytes)"
  echo "Set it as environment variable $(var_of "$kind") on the cloud environment to reuse this login."
}

restore() { # unpack every *_AUTH_B64 that is set; never overwrite existing files
  local kind var
  for kind in agy codex; do
    var=$(var_of "$kind")
    [ -n "${!var:-}" ] || continue
    [ -f "$STATE/restored-$kind" ] && continue
    if base64 -d <<<"${!var}" | tar xzf - -C ~ --skip-old-files 2>/dev/null; then
      touch "$STATE/restored-$kind"; echo "restored $kind login from $var"
    else echo "auth: could not unpack $var" >&2; fi
  done
}

cmd=${1:-}; shift || true
case $cmd in
  login)   [ $# -ge 1 ] || die "usage: auth.sh login agy"; login "$@" ;;
  finish)  [ $# -ge 1 ] || die "usage: auth.sh finish agy <code>"; finish "$@" ;;
  save)    [ $# -ge 1 ] || die "usage: auth.sh save agy"; save "$1" ;;
  restore) restore ;;
  *) sed -n '2,7p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
