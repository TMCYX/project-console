# Project Console

**Project Console** is a local-first desktop app that turns a folder of project
plans into a live **總覽 · WBS · 進度 · 甘特** console — and, in the team build,
syncs those plans across machines through a private GitHub repo.

It reads each project's `plan.json` (the plan) and `progress.json` (the ticks),
renders them as four views, and lets a person tick tasks by hand. There is no
server, no account system, no cloud database — a project is just a folder, and
a team is just a shared git repo.

Design: Swiss-industrial editorial — cold off-white paper, near-black ink, a
single vermilion accent, monospace labels, hairline rules. **Zero CDN, zero
external fonts, zero non-Electron runtime dependencies.**

---

## What it is

- **A portfolio console.** Point it at a folder; every immediate-or-nested
  subfolder containing a `plan.json` becomes a project. See RAG status,
  completion %, next milestone across everything on one dashboard.
- **A planning surface.** Add/edit tasks, phases and milestones; reschedule by
  dependency; freeze a baseline; track critical path — all written back to
  `plan.json` atomically.
- **A progress tracker.** Tick tasks by hand (the only thing the app *must* do);
  state is written to `progress.json`, merge-preserving and atomic.
- **A team sync layer** (this build). Bind a project to a private git repo, then
  pull / commit / push it with one button. Teammates clone the repo, tick their
  tasks, and push back — every change lands as a commit with author and time.

## Features

| Area | What you get |
| --- | --- |
| **Views** | 總覽 (overview) · WBS (top-down tree, zoom/pan) · 進度 (progress bars, per-owner load) · 甘特 (inline-SVG Gantt with dependencies, milestones, today line) |
| **Cross-project** | 儀表板 (dashboard: open / done / overdue / this-week + jump-to-task lists) · 路線圖 (roadmap across all projects) · pin / sort / colour |
| **Editing** | Add / edit / delete / reorder tasks & phases & milestones · dependency editor with cycle detection · reschedule (longest-path) · critical path · baseline freeze & ghost bars · filters · multi-select batch tick · Undo/Redo (100 deep) |
| **Data I/O** | Export PNG / PDF / CSV / Markdown · Obsidian bridge (`tasks.md` sync + read-back) · Markdown checklist import · automatic per-write backups (keep 20) with one-click restore |
| **Appearance** | Light / dark / auto · compact / cosy density · resizable rail & task panel · WBS mini-map · focus mode |
| **Team sync** *(new)* | Per-project git status chip (已最新 / 領先 N / 落後 N / 有本地改動 / 未連接 / 同步中) · one-click **Sync** = commit → integrate → push · auto commit messages (`tick: T3.1 done by Jack`) · 「加入 Git 專案」 clone-from-URL flow |
| **Share & permissions** *(P3)* | 「分享」 panel: repo (owner/name, URL, private/public), collaborator list + per-person permission, pending invites · invite / remove via `gh api` · **read-only mode** (唯讀 chip) when you lack push rights |
| **Project history** *(P4)* | 「歷程」 view: commit list (author / relative time / message, marks your commits) · **task-level diff** (`T3.1 未完成 → 已完成`, `T2.3 owner Jack → Dorian`) · one-click **restore** to any commit (recoverable) |
| **My day** *(P5)* | 「我今日要做」 top-level view: my tasks grouped 逾期 / 今日 / 本週 / 下一個 ready, clickable → jump to the task · 「我是誰」 identity (defaults to git user / GitHub login) |
| **Conflict handling** *(P6)* | **field-level 3-way merge** — edits to different tasks/fields auto-merge on pull · same-task conflicts raise a **conflict UI** (揀本地 / 揀對方 / 合併) · clear errors for offline / rejected push / no remote / read-only |

## Quick start

Requirements: **Node.js ≥ 18** (Electron 33), and for team sync, **git** on your
`PATH` (and optionally the **`gh` CLI** to create the repo for you).

```bash
cd project-manager
npm install          # installs Electron (the only dependency)
npm start            # launch the app
```

Out of the box the app reads its projects from:

```
C:\Users\jackt\.claude\wiki\projects\        (Windows)
```

Override it for a test run:

```bash
PROJECT_CONSOLE_ROOT="/path/to/projects" npm start     # bash
$env:PROJECT_CONSOLE_ROOT="D:\projects"; npm start     # PowerShell
```

> Git-bash: if `ELECTRON_RUN_AS_NODE` is set in your environment, `unset` it
> before `npm start`.

Full install instructions (including installing the bundled AI agent mode and
skill) are in **[INSTALL.md](INSTALL.md)**.

## Data contract

A **project** is one folder containing:

- `plan.json` — schema `omo-project/plan@2`. The plan. Read-only to viewers.
- `progress.json` — schema `omo-project/progress@1`. The ticks. App-written.
- `charter.md` — human-readable charter (optional, ignored by the app).
- `artifacts/` — deliverables (ignored by the app).
- `.pcproject.json` — *(team build)* binding to a git remote:
  `{ "remote": "<git url>", "branch": "main", "projectId": "<id>" }`.

The app **only ever writes** inside a project folder — `plan.json`,
`progress.json`, `baseline.json`, `tasks.md`, `.backups/`, `.pcproject.json` —
and never outside the data root(s). Every write is atomic (temp file + rename)
and merge-preserving.

## Team workflow (git sync)

1. Host: open a project → **Sync** menu → **綁定 git remote** (or create the
   repo with `gh`). The app writes `.pcproject.json` and sets the remote.
2. Host invites collaborators to the private repo (Part B / `gh api`).
3. Teammate: dashboard → **加入 Git 專案** → paste the repo URL → the app clones
   it into `~/ProjectConsole/<name>` and opens it.
4. Anyone ticks a task → **Sync** → the app pulls (rebase), commits with an auto
   message, and pushes. Others pull the same way.

## Views

| View | Content |
| --- | --- |
| **總覽** | project header (completion / tasks / overdue / next milestone), definition of done, scope in/out, constraints, people, risk table |
| **WBS** | Project → Phase → Task top-down tree (root box on top, phase row, tasks stacked per phase, orthogonal elbow connectors, inline SVG); collapsible phases; wheel-zoom-to-cursor, drag-pan, −/100%/+/⤢ controls; each task has a tick box, id, title, owner, deliverable |
| **進度** | overall % + bar, per-phase %, per-person load, deliverables board, planned-vs-actual table (overdue / late) |
| **甘特** | inline-SVG bars (`start` + `estimate_days`; done = solid vermilion, pending = hairline outline; milestone diamonds; dependency arrows; today line); timeline wheel-zoom, drag-pan, shift+wheel h-scroll, sticky left label column, −/100%/+/⤢; plus a tickable task table |

The left rail is the portfolio (per-project RAG dot, %, next milestone).

## Manual ticking (the core write)

- WBS rows and the task table each have a checkbox → `api.setTaskDone(projectId, taskId, done)`.
- The write is **atomic** (same-dir temp file, then rename) and
  **merge-preserving** (all other fields and every other task entry kept); it
  sets `updated` to now and sets/clears `doneAt`.
- It only ever writes `<dataRoot>\<projectId>\progress.json`. It **never**
  modifies `plan.json` on a tick, and never touches anything outside the root.

## Live updates

- `fs.watch(dataRoot, { recursive: true })` (300 ms debounce) + a 5 s poll +
  a manual **Refresh**.
- After a tick the main process re-scans and pushes via the `projects:update`
  IPC channel.

## UX (interaction / gestures)

- **Resizable rail**: a 6 px splitter between rail and main (`cursor: col-resize`),
  drag to 180–480 px, double-click resets to 300 px. Width persisted in `localStorage`.
- **WBS**: wheel = zoom (anchored to cursor, 0.4×–2.5×; ctrl/⌘+wheel = pad pinch);
  background drag = pan; header `−` / `100%` / `+` / `⤢ fit`. Zoom uses CSS
  `transform: scale`, so ticks / collapse / click keep working at any zoom.
- **Gantt**: wheel = timeline zoom; drag = pan (h & v); `shift`+wheel = h-scroll;
  sticky label column; same header controls.
- **Panel**: `Esc` or a click outside the panel closes the task detail.
- **Persistence** (`localStorage`): `pc.railWidth`, `pc.projectId`, `pc.view`,
  `pc.wbsZoom`, `pc.ganttZoom`, and more.
- Wheel `preventDefault` only fires when the cursor is genuinely over the WBS
  canvas / Gantt, so normal page scrolling is never stolen.

## Editing & planning tools

The app can write **`plan.json`** as well as `progress.json`. All writes are
atomic, merge-preserving, and confined to `<dataRoot>/<project>/`. Undo/Redo
restores whole files.

- **Tasks**: header「＋ 新任務」/ per-phase「＋」/ key `n` → inline form; edit in the
  panel (title / owner / start / estimate_days / deliverable / acceptance /
  outputs / deps / phase); delete (panel button + context menu, warns which
  dep-refs get cleaned); move up/down; drag a WBS「≡」handle onto another phase
  to re-phase it.
- **Batch**: Ctrl/Shift-click or task-table checkboxes → mark all done / undone / clear.
- **Phases**: add (inline) / rename / reorder / delete (with `moveToPhase` when it
  still holds tasks; the only phase cannot be deleted).
- **Milestones**: add / edit (name / date / after) / delete on the overview table.
- **Planners**: reschedule (longest-path `start` recompute + critical path);
  critical-path toggle; baseline freeze (`baseline.json`) + ghost bars + slip sum;
  filters (owner / phase / status / overdue-only).
- **Undo/Redo**: every write (plan or progress) records the inverse op; `Ctrl+Z`
  undoes, `Ctrl+Shift+Z` / `Ctrl+Y` redoes, capped at 100, stored in `localStorage`.

## Data / export / backup

- **Export** (native save dialog): **PNG** (page capture), **PDF** (printToPDF),
  **CSV** (one row per task, UTF-8 BOM), **Markdown** (WBS checklist).
- **Obsidian bridge**: "同步 tasks.md" writes/updates `<project>/tasks.md`
  (`- [x] T1.1 title — owner`); "由 tasks.md 讀回" parses `[x]` back into
  `progress.json`. It only owns the checkbox lines it wrote; your own lines are
  preserved.
- **Backup / restore**: a snapshot (plan + progress) is taken before every
  `plan.json` write into `<project>/.backups/<ISO>/`, keeping the newest 20.
- **Import checklist**: pick a Markdown file → parse `- [ ]` / `- [x]` → add to
  a phase (marker stripped, title = line text).

## Testing (headless)

```bash
node selftest.js
```

Scans the data root, asserts the `plan@2` / `progress@1` contract and the
`_demo` fixture, checks graceful degradation (bad JSON, missing progress), does a
round-trip tick on a **temp copy** (the real `_demo/progress.json` is never
touched), and exercises the **binding + git layer + share/history/my-day/merge**
on **temp repos** (field-level merge, two-writer conflicts, commit history &
restore). Prints `RESULT: PASS` / `FAIL` (exit 0 / 1).

```bash
./node_modules/.bin/electron harness.js        # UI acceptance (in-app guide)
./node_modules/.bin/electron harness-git.js    # UI acceptance (git sync + clone)
./node_modules/.bin/electron harness-pb.js     # UI acceptance (share / history / my-day / conflict)
```

## Files

| File | Role |
| --- | --- |
| `main.js` | Electron main process: window, scan, watch, IPC (writes + git) |
| `data.js` | Pure-Node data layer (scan / parse / summary / atomic writes / **git layer**) — shared by main and selftest |
| `gitx.js` | Pure-Node Part B layer: `gh` share/permissions, project history/diff/restore, my-day, field-level merge + integrate (shared by main, selftest, harnesses) |
| `preload.js` | `contextBridge`: data + write + **git** calls |
| `renderer/index.html` | shell (topbar / rail / main / task panel) |
| `renderer/styles.css` | Swiss-industrial theme — all design tokens in `:root` |
| `renderer/renderer.js` | the four views + inline-SVG Gantt + ticking + sync UI |
| `selftest.js` | headless data-layer tests |
| `harness.js` / `harness-git.js` / `harness-pb.js` | headless UI acceptance harnesses |
| `agents/project-manager.md` | the Project-Manager AI agent mode (bundled) |
| `skills/project-management/` | the project-management skill (bundled) |

## Electron settings

- `contextIsolation: true`, `nodeIntegration: false`, CSP `default-src 'none'`
- Window 1200×800, min 900×600
- Windows-safe paths (`path.join`); tolerates missing `progress.json`, bad JSON,
  `_`-prefixed folders

## Theme

Swiss-industrial, single light/dark theme. All colours / fonts / spacing live in
the `:root` tokens in `renderer/styles.css`. UI labels are 繁體中文 (HK); ids and
people names stay English. No emoji. Zero CDN, zero external fonts.

## License

MIT — see [LICENSE](LICENSE). © 2026 Jack Tsoi.
