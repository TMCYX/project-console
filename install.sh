#!/usr/bin/env bash
#
# install.sh — Project Console installer (macOS / Linux).
#
# Idempotent: safe to re-run. It will:
#   1) verify node + npm are available,
#   2) npm install in the app directory,
#   3) copy agents/*   -> ~/.config/opencode/agent/   (the Project-Manager mode),
#   4) copy commands/* -> ~/.config/opencode/command/ (the /pm command),
#   5) copy skills/*   -> ~/.config/opencode/skills/  (the project-management skill),
#   6) print the next steps (launch + data root).
#
# Usage:
#   ./install.sh
#
set -euo pipefail

CYAN='\033[36m'; GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'; GRAY='\033[90m'; NC='\033[0m'
step()  { printf "${CYAN}==> %s${NC}\n" "$1"; }
ok()    { printf "${GREEN}    %s${NC}\n" "$1"; }
warn()  { printf "${YELLOW}    %s${NC}\n" "$1"; }
fail()  { printf "${RED}ERROR: %s${NC}\n" "$1" >&2; exit 1; }

# Resolve the directory this script lives in (works through symlinks).
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
APP_DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"

step "Project Console installer"
printf "    app dir: %s\n" "$APP_DIR"

# --- 1. node + npm ----------------------------------------------------------
command -v node >/dev/null 2>&1 || fail "node not found on PATH. Install Node.js LTS: https://nodejs.org/"
command -v npm  >/dev/null 2>&1 || fail "npm not found on PATH. Install Node.js LTS: https://nodejs.org/"
ok "node $(node --version)"

# --- 2. npm install ---------------------------------------------------------
step "Installing app dependencies (npm install)"
( cd "$APP_DIR" && npm install )
ok "dependencies installed"

# --- 3–5. bundle mode + /pm command + skill ---------------------------------
CONFIG_DIR="${HOME}/.config/opencode"
AGENT_DIR="${CONFIG_DIR}/agent"
SKILL_DIR="${CONFIG_DIR}/skills"
CMD_DIR="${CONFIG_DIR}/command"

step "Installing AI mode + /pm command + skill into ${CONFIG_DIR}"
mkdir -p "$AGENT_DIR" "$SKILL_DIR" "$CMD_DIR"

if [ -d "$APP_DIR/agents" ]; then
  cp -R "$APP_DIR/agents/." "$AGENT_DIR/"
  ok "agents -> $AGENT_DIR"
else
  warn "no agents/ folder found (skipped)"
fi

if [ -d "$APP_DIR/commands" ]; then
  cp -R "$APP_DIR/commands/." "$CMD_DIR/"
  ok "commands -> $CMD_DIR"
else
  warn "no commands/ folder found (skipped)"
fi

if [ -d "$APP_DIR/skills" ]; then
  cp -R "$APP_DIR/skills/." "$SKILL_DIR/"
  ok "skills -> $SKILL_DIR"
else
  warn "no skills/ folder found (skipped)"
fi

# --- 5. next steps ----------------------------------------------------------
printf "\n"
step "Done."
printf "\n"
printf "Next steps:\n"
printf "  1) Launch the app:\n"
printf "${GRAY}       cd \"%s\" && npm start${NC}\n" "$APP_DIR"
printf "  2) Data root (each subfolder with a plan.json is a project):\n"
printf "${GRAY}       default: ~/ProjectConsole/projects/  (set PROJECT_CONSOLE_ROOT to override)${NC}\n"
printf "${GRAY}       PROJECT_CONSOLE_ROOT=\"\$HOME/projects\" npm start${NC}\n"
printf "  3) Team sync: open a project -> Sync menu, or dashboard -> 加入 Git 專案.\n"
printf "  4) Optional — create the private repo with the gh CLI:\n"
printf "${GRAY}       brew install gh   # or your distro package\\n       gh auth login${NC}\n"
