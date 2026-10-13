# INSTALL — Project Console (agent-oriented)

This file is written to be **followed by an AI coding agent** on behalf of a
human. If you are that agent, read this whole file, then do the steps in order.
If the human just wants the app and not the bundled AI mode, skip Step 3.

---

## The one-line prompt a human gives their agent

> Clone this repo and install Project Console for me:
>
> ```
> Clone https://github.com/TMCYX/project-console.git into a folder of your
> choice, then open INSTALL.md in that folder and follow it
> exactly to install Project Console — app dependencies, the Project-Manager
> agent mode (with its `/pm` command), and the project-management skill — then
> tell me how to launch it.
> ```

The app repo is **public** — anyone can clone it; no invite needed. (Only the
*project* repos you later sync through the app are private — those are shared
by invitation.)

---

## For the agent — do this

### 0. Preconditions

- `git` is on `PATH` (used to clone, and later by the app's sync layer).
- `node` **≥ 18** and `npm` are on `PATH`. Verify: `node --version` and `npm --version`.
  - If missing: Windows → `winget install OpenJS.NodeJS.LTS`; macOS → `brew install node`;
    Linux → the distro package or NodeSource.
- Optional but recommended: the `gh` CLI (`winget install GitHub.cli`), for
  creating a private repo and inviting collaborators from inside the app.

### 1. Clone

```bash
git clone <REPO_URL> project-console
cd project-console
```

### 2. Install app dependencies

```bash
npm install        # installs Electron — the only dependency
```

Quick sanity check (recommended — CI runs this on every push): `npm run smoke`
proves this copy boots end-to-end (module load · data layer · Electron window)
and exits 0 on success.

**Slow download?** The app's code is under 1 MB — the one big download is
Electron (~110 MB), pulled in by `npm install`; on a slow or throttled route to
GitHub that is what takes long (can be many minutes). If GitHub is slow or
blocked where you are, mirror it:

```powershell
# Windows (PowerShell)
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; npm install
```

```bash
# macOS / Linux
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm install
```

If the npm registry itself is slow, add `--registry=https://registry.npmmirror.com`
to the same command.

### 3. Bundle the AI mode + command + skill into the user's opencode config

The repo ships three things under `agents/`, `commands/` and `skills/`. Copy
them into the user's opencode config directory (`~/.config/opencode/`):

```bash
# macOS / Linux
mkdir -p ~/.config/opencode/agent ~/.config/opencode/command ~/.config/opencode/skills
cp -R agents/* ~/.config/opencode/agent/
cp -R commands/* ~/.config/opencode/command/
cp -R skills/* ~/.config/opencode/skills/
```

```powershell
# Windows (PowerShell)
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.config\opencode\agent" | Out-Null
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.config\opencode\command" | Out-Null
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.config\opencode\skills" | Out-Null
Copy-Item -Recurse -Force "agents\*" "$env:USERPROFILE\.config\opencode\agent\"
Copy-Item -Recurse -Force "commands\*" "$env:USERPROFILE\.config\opencode\command\"
Copy-Item -Recurse -Force "skills\*" "$env:USERPROFILE\.config\opencode\skills\"
```

Prefer the scripts (idempotent — safe to re-run):

```bash
./install.sh          # macOS / Linux
```
```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1     # Windows
```

Both scripts check `node`/`npm`, run `npm install`, copy the mode + the `/pm`
command + the skill, and print the next steps. They do **not** overwrite
anything outside `~/.config/opencode/`.

### 4. Launch (or tell the human to)

```bash
npm start             # launches the Electron app
```

The app reads projects from its **data root** (resolution order):
`PROJECT_CONSOLE_ROOT` env var → `project-console.config.json` next to the app
(`{ "dataRoot": "…" }`, gitignored) → default `~/ProjectConsole/projects`.

Any folder at any depth containing a `plan.json` is treated as a project.

### 5. Team sync & sharing (optional)

**Host (project owner)**
1. Open the project → toolbar **「發佈」** → creates a **private** repo (`gh repo create --source=… --push`), binds it, and shows the URL.
   *(CLI fallback: `gh repo create <name> --private --source=<project folder> --push`)*
2. Project header **「分享」** → invite a teammate by GitHub username → **write** (edit & tick) or **pull** (read-only).

**Teammate**
3. Accept the GitHub invite → dashboard **「加入 Git 專案」** → paste the repo URL → the app clones it into `~/ProjectConsole/<name>` and opens it. No manual CLI.

**Daily**: tick / edit → **Sync** (pull → commit → push) · **歷程** tab = who changed what (+ task-level diff + restore) · edits to different tasks auto-merge; same-task conflicts show the conflict UI · no push rights → **read-only** (唯讀).

Requires `git` on `PATH`; publish/invite need the **`gh`** CLI logged in (`gh auth login`).

---

## For the human — TL;DR

1. Copy the app repo URL from whoever shared it (the app repo is public).
2. Have your agent run the prompt above, **or** do it by hand:
   `git clone <URL> && cd project-console && npm install && npm start`.
   If the app fails to open, run `npm run smoke` and send the output to the
   owner — it pinpoints which layer fails (module load / data / app boot).
3. To also install the AI planning mode: run `./install.sh` (mac/Linux) or
   `install.ps1` (Windows).

---

## Uninstall

- Delete the cloned folder (the app keeps no state outside it).
- Remove `~/.config/opencode/agent/project-manager.md`,
  `~/.config/opencode/command/pm.md` and
  `~/.config/opencode/skills/project-management/` to drop the AI mode + skill.
- Project data lives in your data root; delete a project folder to remove it.
