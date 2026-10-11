# INSTALL — Project Console (agent-oriented)

This file is written to be **followed by an AI coding agent** on behalf of a
human. If you are that agent, read this whole file, then do the steps in order.
If the human just wants the app and not the bundled AI mode, stop after Step 3.

---

## The one-line prompt a human gives their agent

> Clone this repo and install Project Console for me:
>
> ```
> Clone <REPO_URL> (e.g. https://github.com/<owner>/project-console.git) into a
> folder of your choice, then open INSTALL.md in that folder and follow it
> exactly to install Project Console — app dependencies, the Project-Manager
> agent mode, and the project-management skill — then tell me how to launch it.
> ```

Replace `<REPO_URL>` with the actual repository URL (it is a **private** repo:
the human must have been invited as a collaborator).

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

### 3. Bundle the AI mode + skill into the user's opencode config

The repo ships two things under `agents/` and `skills/`. Copy them into the
user's opencode config directory (`~/.config/opencode/`):

```bash
# macOS / Linux
mkdir -p ~/.config/opencode/agent ~/.config/opencode/skills
cp -R agents/* ~/.config/opencode/agent/
cp -R skills/* ~/.config/opencode/skills/
```

```powershell
# Windows (PowerShell)
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.config\opencode\agent" | Out-Null
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.config\opencode\skills" | Out-Null
Copy-Item -Recurse -Force "agents\*" "$env:USERPROFILE\.config\opencode\agent\"
Copy-Item -Recurse -Force "skills\*" "$env:USERPROFILE\.config\opencode\skills\"
```

Prefer the scripts (idempotent — safe to re-run):

```bash
./install.sh          # macOS / Linux
```
```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1     # Windows
```

Both scripts check `node`/`npm`, run `npm install`, copy the mode + skill, and
print the next steps. They do **not** overwrite anything outside
`~/.config/opencode/`.

### 4. Launch (or tell the human to)

```bash
npm start             # launches the Electron app
```

The app reads projects from its **data root** (resolution order):
`PROJECT_CONSOLE_ROOT` env var → `project-console.config.json` next to the app
(`{ "dataRoot": "…" }`, gitignored) → default `~/ProjectConsole/projects`.

Any folder at any depth containing a `plan.json` is treated as a project.

### 5. Team sync (optional)

- In the app: open a project → **Sync** menu → bind it to a private git repo.
- To join an existing project: **dashboard → 加入 Git 專案 → paste the repo URL**.
  The app clones it into `~/ProjectConsole/<name>` and opens it. No manual CLI.

---

## For the human — TL;DR

1. Get the repo URL from whoever owns it (you must be a collaborator).
2. Have your agent run the prompt above, **or** do it by hand:
   `git clone <URL> && cd project-console && npm install && npm start`.
3. To also install the AI planning mode: run `./install.sh` (mac/Linux) or
   `install.ps1` (Windows).

---

## Uninstall

- Delete the cloned folder (the app keeps no state outside it).
- Remove `~/.config/opencode/agent/project-manager.md` and
  `~/.config/opencode/skills/project-management/` to drop the AI mode + skill.
- Project data lives in your data root; delete a project folder to remove it.
