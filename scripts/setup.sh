#!/usr/bin/env bash
# Set up Polyagent for Claude Code: install the plugin and write its configuration (gateways and
# roles). Safe to run again. Made for a cloud environment's setup script, which runs as root
# before Claude starts and cannot read the environment's variables or secrets: the configuration
# names variables (baseUrlEnv, keyEnv), and the mod reads them in the session.
#
#   bash setup.sh [--config FILE|-] [--source SOURCE] [--no-install]
#
#   --config FILE   the configuration JSON to install (- or stdin when it is not a terminal);
#                   written to ~/.claude/polyagent/config.json
#   --source SRC    where the plugin's marketplace is (default ipy/polyagent; a
#                   path or URL works too)
#   --no-install    only write the configuration
#
# Example (an environment's setup script):
#   curl -fsSL https://raw.githubusercontent.com/ipy/polyagent/main/scripts/setup.sh -o /tmp/polyagent-setup.sh
#   bash /tmp/polyagent-setup.sh <<'EOF'
#   { "gateways": { "mygw": { "baseUrlEnv": "MYGW_BASE_URL", "keyEnv": "MYGW_API_KEY" } },
#     "roles": { "explore": { "type": "Explore", "targets": ["mygw/explore", "claude/haiku"] } } }
#   EOF
set -uo pipefail

SOURCE=ipy/polyagent
MARKETPLACE=polyagent
PLUGIN=polyagent
OLD_PLUGIN=pi-subagent@claude-code-pi-subagent
OLD_MARKETPLACE=claude-code-pi-subagent
CONFIG=
INSTALL=1

die() { echo "polyagent setup: $*" >&2; exit 2; }
say() { echo "polyagent setup: $*"; }

while [ $# -gt 0 ]; do
  case $1 in
    --config) [ $# -ge 2 ] || die "--config needs a file (or -)"; CONFIG=$2; shift 2 ;;
    --source) [ $# -ge 2 ] || die "--source needs a value"; SOURCE=$2; shift 2 ;;
    --no-install) INSTALL=0; shift ;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument $1 (see --help)" ;;
  esac
done
[ -z "$CONFIG" ] && [ ! -t 0 ] && CONFIG=-

# ---- configuration --------------------------------------------------------------------------
if [ -n "$CONFIG" ]; then
  if [ "$CONFIG" = - ]; then json=$(cat); else [ -f "$CONFIG" ] || die "no file $CONFIG"; json=$(cat "$CONFIG"); fi
  if [ -n "${json//[[:space:]]/}" ]; then
    # Checked when a JSON reader is at hand; the mod reports anything else wrong at session start.
    if command -v node >/dev/null; then
      printf '%s' "$json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j||typeof j!=="object"||Array.isArray(j))throw new Error("not a JSON object")})' 2>/dev/null \
        || die "the configuration is not a JSON object"
    elif command -v jq >/dev/null; then
      printf '%s' "$json" | jq -e 'type == "object"' >/dev/null 2>&1 || die "the configuration is not a JSON object"
    fi
    dir="$HOME/.claude/polyagent"
    mkdir -p "$dir" && chmod 700 "$dir"
    tmp=$(mktemp "$dir/config.json.XXXXXX") || die "cannot write in $dir"
    printf '%s\n' "$json" > "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$dir/config.json" || die "cannot write $dir/config.json"
    say "configuration written to $dir/config.json"
  fi
fi

# ---- plugin ---------------------------------------------------------------------------------
if [ "$INSTALL" = 1 ]; then
  command -v claude >/dev/null || die "claude is not on PATH; install Claude Code first (or pass --no-install)"
  # The project was called pi-subagent: an install under the old name would hook every Agent call a
  # second time, and its marketplace holds the same repository, so both go first.
  if claude plugin list 2>/dev/null | grep -q "$OLD_PLUGIN"; then
    claude plugin uninstall "$OLD_PLUGIN" && say "removed $OLD_PLUGIN (the project is now $PLUGIN)" || say "WARNING: could not remove $OLD_PLUGIN; uninstall it by hand"
  fi
  if claude plugin marketplace list 2>/dev/null | grep -q "$OLD_MARKETPLACE"; then
    claude plugin marketplace remove "$OLD_MARKETPLACE" >/dev/null || say "WARNING: could not remove the $OLD_MARKETPLACE marketplace"
  fi
  # Updates are shown, not hidden: a stale install should say why it stayed stale.
  if claude plugin marketplace list 2>/dev/null | grep -q "$MARKETPLACE"; then
    claude plugin marketplace update "$MARKETPLACE" || say "WARNING: could not update the $MARKETPLACE marketplace; the copy already here is used"
  else
    claude plugin marketplace add "$SOURCE" || die "could not add the marketplace from $SOURCE"
  fi
  if claude plugin list 2>/dev/null | grep -q "$PLUGIN@$MARKETPLACE"; then
    claude plugin update "$PLUGIN@$MARKETPLACE" || say "WARNING: could not update $PLUGIN@$MARKETPLACE"
  else
    claude plugin install "$PLUGIN@$MARKETPLACE" || die "could not install $PLUGIN@$MARKETPLACE"
  fi
  version=$(claude plugin list 2>/dev/null | grep -A3 "$PLUGIN@$MARKETPLACE" | sed -n 's/.*Version: *//p' | head -1)
  say "$PLUGIN@$MARKETPLACE ${version:+version $version }is installed"
fi
