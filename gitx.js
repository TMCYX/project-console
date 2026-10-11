'use strict';

/* ==========================================================================
   gitx.js — Part B data layer for the team build.

   Pure Node (no Electron), built on ./data.js primitives. Covers:
     P3  share & permissions   → shareInfo / inviteCollaborator / removeCollaborator / checkAccess
     P4  project history        → historyLog / commitDiff / diffTrees / restoreCommit
     P5  my-day + identity      → collectMyTasks / identity
     P6  conflict & hardening   → mergeTrees (field-level 3-way) / integrateRemote / resolveMerge / syncProject

   All shell-outs go through spawn with a hard timeout and no interactive
   prompts. Nothing here reads or writes outside the project folder(s) it is
   asked about.
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const data = require('./data');

const {
  runGit,
  projectDirOrError,
  readJsonSafe,
  atomicWriteJson,
  atomicWriteText,
  backupProject,
  readBindingFile,
  readBinding,
  writeBinding,
  gitStatus,
  gitInit,
  gitCommit,
  gitPush,
  deriveCommitMessage,
  hkTodayStr,
  addDaysStr,
} = data;

const GIT_TIMEOUT_MS = 30000;
const GH_TIMEOUT_MS = 25000;

/* ============================ small helpers ============================== */

function eq(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (_) {
    return false;
  }
}

/** Parse a git remote URL that points at github.com → { host, owner, name } (else null). */
function parseRemote(url) {
  if (!url || typeof url !== 'string') return null;
  let s = url.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!s) return null;
  let m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)$/i.exec(s);
  if (m) return /(^|\.)github\.com$/i.test(m[1]) ? { host: m[1], owner: m[2], name: m[3] } : null;
  m = /^git@([^:]+):([^/]+)\/([^/]+)$/i.exec(s);
  if (m) return /(^|\.)github\.com$/i.test(m[1]) ? { host: m[1], owner: m[2], name: m[3] } : null;
  m = /^ssh:\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/]+)$/i.exec(s);
  if (m) return /(^|\.)github\.com$/i.test(m[1]) ? { host: m[1], owner: m[2], name: m[3] } : null;
  m = /^git:\/\/([^/]+)\/([^/]+)\/([^/]+)$/i.exec(s);
  if (m) return /(^|\.)github\.com$/i.test(m[1]) ? { host: m[1], owner: m[2], name: m[3] } : null;
  return null;
}

/** Map GitHub permissions object → 'ADMIN' | 'WRITE' | 'READ'. */
function permOf(perms) {
  if (!perms || typeof perms !== 'object') return null;
  if (perms.admin === true) return 'ADMIN';
  if (perms.maintain === true || perms.push === true) return 'WRITE';
  if (perms.pull === true || perms.read === true) return 'READ';
  return null;
}

function permLabel(p) {
  return p === 'ADMIN' ? '管理員（admin）' : p === 'WRITE' ? '可寫（write）' : p === 'READ' ? '唯讀（read）' : '未知';
}

/* ============================ gh CLI ===================================== */

function ghEnv() {
  return {
    ...process.env,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/** Run gh with a hard timeout. Never throws; resolves { ok, code, stdout, stderr, timedOut }. */
function runGh(args, timeoutMs = GH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('gh', args, { env: ghEnv(), windowsHide: true, shell: false });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(err.message), timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch (_) {
        /* ignore */
      }
      finish({ ok: false, code: -1, stdout, stderr: stderr || 'gh timed out', timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => finish({ ok: false, code: -1, stdout, stderr: stderr || String(err.message), timedOut }));
    child.on('close', (code) => finish({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut }));
  });
}

function classifyGhError(text) {
  const s = String(text || '').toLowerCase();
  if (/command not found|enoent|not recognized/.test(s)) return 'gh_missing';
  if (/not logged into any|gh auth login|authentication|please log in|not logged in/.test(s)) return 'gh_not_authed';
  if (/http 403|forbidden|insufficient|admin/.test(s)) return 'no_admin';
  if (/http 404|not found/.test(s)) return 'not_found';
  if (/could not resolve host|network|timed? ?out|offline|unable to access/.test(s)) return 'offline';
  return 'gh_error';
}

/** Is gh installed / authenticated? Never throws. */
async function ghAvailable() {
  const v = await runGh(['--version']);
  if (!v.ok) return { installed: false, authed: false, login: null, error: v.stderr.trim() || 'gh not available' };
  const u = await runGh(['api', 'user', '--jq', '.login']);
  if (u.ok && u.stdout.trim()) return { installed: true, authed: true, login: u.stdout.trim(), error: null };
  return { installed: true, authed: false, login: null, error: 'gh 未登入（gh auth login）' };
}

/** Run a gh api call and parse the JSON body. */
async function ghApi(endpoint, opts) {
  const args = ['api'];
  if (opts && opts.method && opts.method !== 'GET') args.push('-X', opts.method);
  args.push(endpoint);
  if (opts && opts.fields) {
    for (const [k, val] of Object.entries(opts.fields)) args.push('-f', `${k}=${val}`);
  }
  const res = await runGh(args);
  if (!res.ok) {
    const err = (res.stderr || res.stdout || 'gh api failed').trim();
    return { ok: false, code: classifyGhError(err), error: err, stderr: res.stderr.trim(), timedOut: res.timedOut };
  }
  const out = res.stdout.trim();
  let value = null;
  if (out) {
    try {
      value = JSON.parse(out);
    } catch (_) {
      value = out;
    }
  }
  return { ok: true, value };
}

/* ============================ P3: share & permissions ==================== */

/** Resolve a project's repo coords (owner/name) from its git remote / binding. */
async function repoCoords(root, projectId) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { error: r.error };
  const bind = readBindingFile(r.dir);
  const st = await gitStatus(root, projectId);
  const remote = (st && st.remote) || (bind.ok && bind.binding && bind.binding.remote) || null;
  return { dir: r.dir, isRepo: !!(st && st.isRepo), remote, repo: parseRemote(remote), binding: bind.ok ? bind.binding : null };
}

/** Read-only detection: gh repo permission first, else a dry-run push. */
async function checkAccess(root, projectId) {
  const c = await repoCoords(root, projectId);
  if (c.error) return { ok: false, error: c.error };
  if (!c.isRepo) return { ok: true, readOnly: false, permission: null, source: 'no_repo' };
  if (!c.repo) {
    // Not a GitHub remote: try a dry-run push to sniff a permission error.
    const dry = await runGit(['push', '--dry-run'], c.dir, 20000);
    if (!dry.ok && /denied|permission|forbidden|403|read-only|protected/i.test(dry.stderr || '')) {
      return { ok: true, readOnly: true, permission: 'READ', source: 'dryrun' };
    }
    return { ok: true, readOnly: false, permission: null, source: 'not_github' };
  }
  const gh = await ghAvailable();
  if (gh.installed && gh.authed) {
    const info = await ghApi(`repos/${c.repo.owner}/${c.repo.name}`);
    if (info.ok && info.value) {
      const perm = permOf(info.value.permissions);
      return { ok: true, readOnly: perm === 'READ', permission: perm, source: 'gh' };
    }
  }
  const dry = await runGit(['push', '--dry-run'], c.dir, 20000);
  if (!dry.ok && /denied|permission|forbidden|403|read-only|protected/i.test(dry.stderr || '')) {
    return { ok: true, readOnly: true, permission: 'READ', source: 'dryrun' };
  }
  return { ok: true, readOnly: false, permission: null, source: 'unknown' };
}

/**
 * Share panel data. Degrades gracefully: returns a structured { ok:false, code }
 * for no-remote / not-github / gh-missing / gh-not-authed, always with the
 * repo/remote/access context attached so the UI can explain exactly what's needed.
 */
async function shareInfo(root, projectId) {
  const c = await repoCoords(root, projectId);
  if (c.error) return { ok: false, code: 'no_project', error: c.error };
  const access = await checkAccess(root, projectId);
  const ctx = {
    remote: c.remote,
    repo: c.repo ? { owner: c.repo.owner, name: c.repo.name, full: `${c.repo.owner}/${c.repo.name}` } : null,
    readOnly: !!access.readOnly,
    permission: access.permission,
    permissionSource: access.source,
  };
  if (!c.remote) return { ok: false, code: 'no_remote', error: '呢個專案未綁定 git remote（先用「Git…」綁定）', ...ctx };
  if (!c.repo) return { ok: false, code: 'not_github', error: 'remote 唔係 GitHub repo（Share 只支援 GitHub）', ...ctx };

  const gh = await ghAvailable();
  if (!gh.installed) return { ok: false, code: 'gh_missing', error: '未安裝 gh CLI。安裝：winget install GitHub.cli', ...ctx, me: null };
  if (!gh.authed) return { ok: false, code: 'gh_not_authed', error: 'gh 未登入。請執行：gh auth login', ...ctx, me: null };

  const info = await ghApi(`repos/${c.repo.owner}/${c.repo.name}`);
  if (!info.ok) return { ok: false, code: info.code, error: info.error, ...ctx, me: gh.login };

  const value = info.value || {};
  const perm = permOf(value.permissions);
  const cols = await ghApi(`repos/${c.repo.owner}/${c.repo.name}/collaborators`);
  const invs = await ghApi(`repos/${c.repo.owner}/${c.repo.name}/invitations`);
  const warnings = [];
  if (!cols.ok) warnings.push('collaborators: ' + cols.error);
  if (!invs.ok) warnings.push('invitations: ' + invs.error);

  return {
    ok: true,
    me: gh.login,
    remote: c.remote,
    repo: {
      owner: c.repo.owner,
      name: c.repo.name,
      full: `${c.repo.owner}/${c.repo.name}`,
      url: value.html_url || `https://github.com/${c.repo.owner}/${c.repo.name}`,
      private: value.private === true,
      defaultBranch: value.default_branch || null,
    },
    permission: perm,
    permissionLabel: permLabel(perm),
    readOnly: perm === 'READ',
    permissionSource: 'gh',
    collaborators: (cols.ok && Array.isArray(cols.value) ? cols.value : []).map((x) => ({
      login: x.login,
      permission: permOf(x.permissions),
      role: x.role_name || null,
    })),
    invites: (invs.ok && Array.isArray(invs.value) ? invs.value : []).map((x) => ({
      login: (x.invitee && x.invitee.login) || x.login || '?',
      permission: permOf(x.permissions),
    })),
    warnings,
  };
}

/** Invite (or update) a collaborator. permission: 'write'|'push'|'read'. */
async function inviteCollaborator(root, projectId, user, permission) {
  const u = String(user == null ? '' : user).trim();
  if (!u || /[\s/@:]/.test(u)) return { ok: false, code: 'bad_user', error: '請輸入有效嘅 GitHub username' };
  const c = await repoCoords(root, projectId);
  if (c.error) return { ok: false, error: c.error };
  if (!c.repo) return { ok: false, code: 'not_github', error: 'remote 唔係 GitHub repo' };
  const gh = await ghAvailable();
  if (!gh.installed) return { ok: false, code: 'gh_missing', error: '未安裝 gh CLI。安裝：winget install GitHub.cli' };
  if (!gh.authed) return { ok: false, code: 'gh_not_authed', error: 'gh 未登入。請執行：gh auth login' };
  const perm = permission === 'read' || permission === 'pull' ? 'pull' : 'push';
  const res = await ghApi(`repos/${c.repo.owner}/${c.repo.name}/collaborators/${u}`, {
    method: 'PUT',
    fields: { permission: perm },
  });
  if (!res.ok) return { ok: false, code: res.code, error: res.error };
  return { ok: true, user: u, permission: perm };
}

/** Remove a collaborator. */
async function removeCollaborator(root, projectId, user) {
  const u = String(user == null ? '' : user).trim();
  if (!u) return { ok: false, code: 'bad_user', error: '請輸入有效嘅 GitHub username' };
  const c = await repoCoords(root, projectId);
  if (c.error) return { ok: false, error: c.error };
  if (!c.repo) return { ok: false, code: 'not_github', error: 'remote 唔係 GitHub repo' };
  const gh = await ghAvailable();
  if (!gh.installed) return { ok: false, code: 'gh_missing', error: '未安裝 gh CLI。安裝：winget install GitHub.cli' };
  if (!gh.authed) return { ok: false, code: 'gh_not_authed', error: 'gh 未登入。請執行：gh auth login' };
  const res = await ghApi(`repos/${c.repo.owner}/${c.repo.name}/collaborators/${u}`, { method: 'DELETE' });
  if (!res.ok) return { ok: false, code: res.code, error: res.error };
  return { ok: true, user: u };
}

/* ============================ P4: history / diff / restore =============== */

/** Read <rev>:<file> as JSON (or null). */
async function showJson(dir, rev, file) {
  const res = await runGit(['show', `${rev}:${file}`], dir);
  if (!res.ok || !res.stdout.trim()) return null;
  try {
    return JSON.parse(res.stdout);
  } catch (_) {
    return null;
  }
}

const PLAN_TASK_FIELDS = ['phase', 'title', 'deliverable', 'owner', 'start', 'estimate_days', 'acceptance', 'deps', 'outputs'];

/** Pure: task-level changes between two (plan, progress) revisions. */
function diffTrees(basePlan, baseProg, targetPlan, targetProg) {
  const changes = [];
  const bp = basePlan || {};
  const tp = targetPlan || {};
  const bTasks = new Map((bp.tasks || []).map((t) => [t.id, t]));
  const tTasks = new Map((tp.tasks || []).map((t) => [t.id, t]));

  for (const [id, t] of tTasks) if (!bTasks.has(id)) changes.push({ kind: 'task-add', id, title: t.title || '' });
  for (const [id, t] of bTasks) if (!tTasks.has(id)) changes.push({ kind: 'task-del', id, title: t.title || '' });
  for (const [id, t] of tTasks) {
    const b = bTasks.get(id);
    if (!b) continue;
    for (const f of PLAN_TASK_FIELDS) {
      if (!eq(b[f], t[f])) changes.push({ kind: 'task-field', id, field: f, from: b[f] == null ? null : b[f], to: t[f] == null ? null : t[f] });
    }
  }

  const bpProg = (baseProg && baseProg.tasks) || {};
  const tpProg = (targetProg && targetProg.tasks) || {};
  const progIds = [...new Set([...Object.keys(bpProg), ...Object.keys(tpProg)])].sort();
  for (const id of progIds) {
    const was = !!(bpProg[id] && bpProg[id].done);
    const now = !!(tpProg[id] && tpProg[id].done);
    if (was !== now) {
      const owner = (tTasks.get(id) || bTasks.get(id) || {}).owner || '';
      changes.push({ kind: now ? 'tick' : 'untick', id, owner, to: now });
    }
  }

  const bPhases = new Set((bp.phases || []).map((p) => p.id));
  const tPhases = new Set((tp.phases || []).map((p) => p.id));
  for (const p of tp.phases || []) if (!bPhases.has(p.id)) changes.push({ kind: 'phase-add', id: p.id, name: p.name || '' });
  for (const p of bp.phases || []) if (!tPhases.has(p.id)) changes.push({ kind: 'phase-del', id: p.id, name: p.name || '' });

  const bMs = new Set((bp.milestones || []).map((m) => m.id));
  const tMs = new Set((tp.milestones || []).map((m) => m.id));
  for (const m of tp.milestones || []) if (!bMs.has(m.id)) changes.push({ kind: 'milestone-add', id: m.id, name: m.name || '' });
  for (const m of bp.milestones || []) if (!tMs.has(m.id)) changes.push({ kind: 'milestone-del', id: m.id, name: m.name || '' });

  return changes;
}

/** Commit list for a project repo (newest first). */
async function historyLog(root, projectId, opts) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const st = await gitStatus(root, projectId);
  if (!st.isRepo) return { ok: false, error: 'not a git repository' };
  const limit = Math.max(1, Math.min(500, Number(opts && opts.limit) || 50));
  const res = await runGit(['log', '-n', String(limit), '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s'], r.dir);
  if (!res.ok) {
    if (/does not have any commits|unknown revision|ambiguous argument/i.test(res.stderr || '')) return { ok: true, commits: [] };
    return { ok: false, error: res.stderr.trim() || 'git log failed' };
  }
  const commits = res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\x1f');
      return { sha: parts[0] || '', short: parts[1] || '', author: parts[2] || '', email: parts[3] || '', date: parts[4] || '', message: parts.slice(5).join('\x1f') };
    });
  return { ok: true, commits };
}

/** Task-level diff for one commit (vs its first parent). */
async function commitDiff(root, projectId, sha) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const st = await gitStatus(root, projectId);
  if (!st.isRepo) return { ok: false, error: 'not a git repository' };
  const par = await runGit(['rev-list', '--parents', '-n', '1', sha], r.dir);
  if (!par.ok) return { ok: false, error: par.stderr.trim() || 'unknown commit' };
  const toks = par.stdout.trim().split(/\s+/);
  const target = toks[0];
  const parent = toks[1] || null;

  const basePlan = parent ? await showJson(r.dir, parent, 'plan.json') : null;
  const baseProg = parent ? await showJson(r.dir, parent, 'progress.json') : null;
  const targetPlan = await showJson(r.dir, target, 'plan.json');
  const targetProg = await showJson(r.dir, target, 'progress.json');
  const changes = diffTrees(basePlan, baseProg, targetPlan, targetProg);

  const metaRes = await runGit(['show', '-s', '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s', sha], r.dir);
  let commit = { sha, short: (sha || '').slice(0, 7), author: '', date: '', message: '' };
  if (metaRes.ok && metaRes.stdout.trim()) {
    const p = metaRes.stdout.trim().split('\x1f');
    commit = { sha: p[0], short: p[1], author: p[2], date: p[3], message: p.slice(4).join('\x1f') };
  }
  return { ok: true, sha: target, parent, commit, changes };
}

/** Restore plan.json + progress.json from a commit (recoverable via undo + backup). */
async function restoreCommit(root, projectId, sha) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const st = await gitStatus(root, projectId);
  if (!st.isRepo) return { ok: false, error: 'not a git repository' };
  const check = await runGit(['cat-file', '-e', `${sha}^{commit}`], r.dir);
  if (!check.ok) return { ok: false, error: `commit not found: ${sha}` };
  try {
    backupProject(root, projectId);
  } catch (_) {
    /* best effort */
  }
  const files = [];
  for (const f of ['plan.json', 'progress.json']) {
    const res = await runGit(['show', `${sha}:${f}`], r.dir);
    if (!res.ok || !res.stdout.trim()) continue;
    const dst = path.join(r.dir, f);
    const beforeRaw = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : null;
    const w = atomicWriteText(dst, res.stdout);
    if (!w.ok) return { ok: false, error: w.error };
    files.push({ file: f, beforeRaw, afterRaw: res.stdout });
  }
  return { ok: true, sha, restored: files.map((f) => f.file), undo: { files } };
}

/* ============================ P5: my-day + identity ===================== */

/** Pure: my open tasks grouped 逾期 / 今日 / 本週 / 下一個 ready. */
function collectMyTasks(projects, who, todayStr) {
  const out = { overdue: [], today: [], week: [], ready: [] };
  const me = String(who == null ? '' : who).trim().toLowerCase();
  if (!me) return { ...out, count: 0, who: '' };
  const today = todayStr || hkTodayStr();
  const in7 = addDaysStr(today, 7);
  for (const p of projects || []) {
    const doneById = new Map((p.tasks || []).map((t) => [t.id, t.done === true]));
    for (const t of p.tasks || []) {
      if (!t.owner || String(t.owner).trim().toLowerCase() !== me) continue;
      if (t.done) continue;
      const item = {
        projectId: p.id,
        projectTitle: p.title || p.id,
        taskId: t.id,
        title: t.title || '',
        owner: t.owner,
        plannedEnd: t.plannedEnd || null,
      };
      if (t.status === 'overdue') out.overdue.push(item);
      else if (t.plannedEnd && t.plannedEnd === today) out.today.push(item);
      else if (t.plannedEnd && t.plannedEnd > today && t.plannedEnd <= in7) out.week.push(item);
      else {
        const deps = Array.isArray(t.deps) ? t.deps : [];
        if (deps.every((d) => doneById.get(d) === true)) out.ready.push(item);
      }
    }
  }
  const byDate = (a, b) => String(a.plannedEnd || '').localeCompare(String(b.plannedEnd || ''));
  for (const k of Object.keys(out)) out[k].sort(byDate);
  out.count = out.overdue.length + out.today.length + out.week.length + out.ready.length;
  out.who = who;
  return out;
}

/** Best-effort identity: git user.name + the gh login (if authed). */
async function identity() {
  let gitUser = null;
  try {
    const g = await runGit(['config', '--global', 'user.name'], process.cwd());
    if (g.ok && g.stdout.trim()) gitUser = g.stdout.trim();
  } catch (_) {
    /* optional */
  }
  const gh = await ghAvailable();
  return { ok: true, gitUser, ghLogin: gh.authed ? gh.login : null, ghInstalled: gh.installed };
}

/* ============================ P6: field-level merge ===================== */

function combineValues(ov, tv) {
  if (Array.isArray(ov) && Array.isArray(tv)) {
    const seen = new Set();
    const out = [];
    for (const x of [...ov, ...tv]) {
      const k = JSON.stringify(x);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(x);
      }
    }
    return out;
  }
  if (typeof ov === 'boolean' && typeof tv === 'boolean') return ov || tv;
  if (typeof ov === 'number' && typeof tv === 'number') return Math.max(ov, tv);
  if (ov == null) return tv;
  if (tv == null) return ov;
  const a = String(ov);
  const b = String(tv);
  return a === b ? a : `${a} / ${b}`;
}

/**
 * 3-way merge of a single scalar. Records a conflict (and defaults to ours)
 * only when no explicit choice was supplied for that field.
 */
function mergeScalar(bv, ov, tv, ctx, choices, conflicts) {
  if (eq(ov, tv)) return ov;
  if (eq(ov, bv)) return tv;
  if (eq(tv, bv)) return ov;
  const key = `${ctx.scope}:${ctx.id}:${ctx.field}`;
  const choice = choices && choices[key];
  if (choice === 'theirs') return tv;
  if (choice === 'merge') return combineValues(ov, tv);
  if (!choice) {
    conflicts.push({
      scope: ctx.scope,
      id: ctx.id,
      field: ctx.field,
      base: bv === undefined ? null : bv,
      ours: ov === undefined ? null : ov,
      theirs: tv === undefined ? null : tv,
    });
  }
  return ov;
}

/** Merge two keyed arrays (tasks / phases / milestones) with per-item field merge. */
function mergeKeyed(bArr, oArr, tArr, keyOf, itemFn, scope, choices, conflicts) {
  const bm = new Map((bArr || []).map((x) => [keyOf(x), x]));
  const om = new Map((oArr || []).map((x) => [keyOf(x), x]));
  const tm = new Map((tArr || []).map((x) => [keyOf(x), x]));
  const keys = [...om.keys()];
  for (const k of tm.keys()) if (!om.has(k)) keys.push(k);
  const out = [];
  for (const k of keys) {
    const bv = bm.get(k);
    const ov = om.get(k);
    const tv = tm.get(k);
    const hadO = om.has(k);
    const hadT = tm.has(k);
    if (!hadO && !hadT) continue;
    if (hadO && !hadT) {
      // theirs deleted, ours kept:
      if (bv === undefined) {
        out.push(ov); // ours added it, theirs never had it → keep
        continue;
      }
      if (!eq(ov, bv)) {
        // ours edited, theirs deleted → keep ours + conflict (don't lose data)
        conflicts.push({ scope, id: k, field: 'deleted', base: bv, ours: ov, theirs: null });
        out.push(ov);
      }
      // else: theirs deleted, ours unchanged → accept deletion
      continue;
    }
    if (!hadO && hadT) {
      if (bv === undefined) {
        out.push(tv); // theirs added it → take
        continue;
      }
      if (!eq(tv, bv)) {
        conflicts.push({ scope, id: k, field: 'deleted', base: bv, ours: null, theirs: tv });
        out.push(tv);
      }
      continue;
    }
    out.push(itemFn(bv, ov, tv));
  }
  return out;
}

const PLAN_META_KEYS = ['title', 'owner', 'created', 'target', 'protocol', 'definition_of_done', 'scope', 'constraints', 'resources'];

/** Pure: 3-way merge of plan.json. Returns { plan, conflicts }. */
function mergePlan3(basePlan, oursPlan, theirsPlan, choices) {
  const conflicts = [];
  const b = basePlan || {};
  const o = oursPlan || {};
  const t = theirsPlan || {};
  const plan = { ...o };
  plan.schema = o.schema || t.schema || b.schema;
  plan.id = o.id || t.id || b.id;
  for (const k of PLAN_META_KEYS) {
    plan[k] = mergeScalar(b[k], o[k], t[k], { scope: 'meta', id: 'plan', field: k }, choices, conflicts);
  }
  plan.tasks = mergeKeyed(
    b.tasks,
    o.tasks,
    t.tasks,
    (x) => x.id,
    (bi, oi, ti) => {
      const item = { ...oi };
      for (const f of PLAN_TASK_FIELDS) {
        item[f] = mergeScalar(bi ? bi[f] : undefined, oi[f], ti[f], { scope: 'task', id: oi.id, field: f }, choices, conflicts);
      }
      return item;
    },
    'task',
    choices,
    conflicts
  );
  plan.phases = mergeKeyed(
    b.phases,
    o.phases,
    t.phases,
    (x) => x.id,
    (bi, oi, ti) => {
      const item = { ...oi };
      item.name = mergeScalar(bi ? bi.name : undefined, oi.name, ti.name, { scope: 'phase', id: oi.id, field: 'name' }, choices, conflicts);
      return item;
    },
    'phase',
    choices,
    conflicts
  );
  plan.milestones = mergeKeyed(
    b.milestones,
    o.milestones,
    t.milestones,
    (x) => x.id,
    (bi, oi, ti) => {
      const item = { ...oi };
      for (const f of ['name', 'date', 'after']) {
        item[f] = mergeScalar(bi ? bi[f] : undefined, oi[f], ti[f], { scope: 'milestone', id: oi.id, field: f }, choices, conflicts);
      }
      return item;
    },
    'milestone',
    choices,
    conflicts
  );
  return { plan, conflicts };
}

/** Pure: 3-way merge of progress.json. Returns { progress, conflicts }. */
function mergeProgress3(baseProg, oursProg, theirsProg, choices) {
  const conflicts = [];
  const b = baseProg || {};
  const o = oursProg || {};
  const t = theirsProg || {};
  const updatedVals = [o.updated, t.updated].filter(Boolean).sort();
  const progress = {
    schema: o.schema || t.schema || b.schema,
    project: o.project || t.project || b.project,
    updated: updatedVals.length ? updatedVals[updatedVals.length - 1] : null,
    tasks: {},
  };
  const bt = b.tasks || {};
  const ot = o.tasks || {};
  const tt = t.tasks || {};
  const keys = [...Object.keys(ot)];
  for (const k of Object.keys(tt)) if (!(k in ot)) keys.push(k);
  for (const id of keys) {
    const bv = bt[id];
    const ov = ot[id];
    const tv = tt[id];
    if (!ov && !tv) continue;
    if (ov && !tv) {
      if (bv === undefined) {
        progress.tasks[id] = ov; // ours added it, theirs never had it
        continue;
      }
      if (!eq(ov, bv)) {
        conflicts.push({ scope: 'progress', id, field: 'deleted', base: bv, ours: ov, theirs: null });
        progress.tasks[id] = ov;
      }
      continue;
    }
    if (!ov && tv) {
      if (bv === undefined) {
        progress.tasks[id] = tv; // theirs added it → take
        continue;
      }
      if (!eq(tv, bv)) {
        conflicts.push({ scope: 'progress', id, field: 'deleted', base: bv, ours: null, theirs: tv });
        progress.tasks[id] = tv;
      }
      continue;
    }
    const entry = { ...ov };
    for (const f of ['done', 'doneAt', 'note']) {
      entry[f] = mergeScalar(bv ? bv[f] : undefined, ov[f], tv[f], { scope: 'progress', id, field: f }, choices, conflicts);
    }
    progress.tasks[id] = entry;
  }
  return { progress, conflicts };
}

/** Pure: merge plan + progress together. Returns { plan, progress, conflicts }. */
function mergeTrees(basePlan, baseProg, ourPlan, ourProg, theirPlan, theirProg, choices) {
  const p = mergePlan3(basePlan, ourPlan, theirPlan, choices);
  const g = mergeProgress3(baseProg, ourProg, theirProg, choices);
  return { plan: p.plan, progress: g.progress, conflicts: [...p.conflicts, ...g.conflicts] };
}

/* ============================ P6: integrate remote ====================== */

/** Fetch + fast-forward or semantic-merge. opts.choices resolves conflicts. */
async function integrateRemote(root, projectId, opts) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, code: 'no_project', error: r.error };
  const dir = r.dir;
  const st = await gitStatus(root, projectId);
  if (!st.isRepo) return { ok: false, code: 'not_repo', error: 'not a git repository' };
  if (!st.remote) return { ok: true, upToDate: true, reason: 'no_remote' };
  const branch = st.branch || (st.binding && st.binding.branch) || 'main';

  const fetch = await runGit(['fetch', 'origin', branch], dir, GIT_TIMEOUT_MS);
  if (!fetch.ok) {
    const code = /could not resolve host|network|unable to access|timed out|offline/i.test(fetch.stderr || '') ? 'offline' : 'fetch_failed';
    return { ok: false, code, error: fetch.timedOut ? 'git fetch timed out' : (fetch.stderr || '').trim(), timedOut: fetch.timedOut };
  }
  const remoteRef = `origin/${branch}`;
  const remoteShaRes = await runGit(['rev-parse', remoteRef], dir);
  if (!remoteShaRes.ok || !remoteShaRes.stdout.trim()) return { ok: true, upToDate: true, reason: 'no_remote_branch' };
  const remoteSha = remoteShaRes.stdout.trim();
  const headRes = await runGit(['rev-parse', 'HEAD'], dir);
  const head = headRes.stdout.trim();
  if (head === remoteSha) return { ok: true, upToDate: true };

  const headIsAncestor = await runGit(['merge-base', '--is-ancestor', head, remoteSha], dir);
  if (headIsAncestor.ok) {
    // Only behind → fast-forward.
    const ff = await runGit(['merge', '--ff-only', remoteRef], dir, GIT_TIMEOUT_MS);
    if (ff.ok) return { ok: true, fastForwarded: true, from: head, to: remoteSha };
    return { ok: false, code: 'ff_failed', error: (ff.stderr || '').trim() || 'fast-forward failed', next: 'commit_first' };
  }
  const remoteIsAncestor = await runGit(['merge-base', '--is-ancestor', remoteSha, head], dir);
  if (remoteIsAncestor.ok) return { ok: true, upToDate: true, reason: 'ahead_only' };

  // Diverged → semantic merge.
  const baseRes = await runGit(['merge-base', head, remoteSha], dir);
  const base = baseRes.ok ? baseRes.stdout.trim() : null;
  const basePlan = base && base !== head ? await showJson(dir, base, 'plan.json') : await showJson(r.dir, head, 'plan.json');
  const baseProg = base && base !== head ? await showJson(dir, base, 'progress.json') : await showJson(r.dir, head, 'progress.json');
  const ourPlan = await showJson(dir, head, 'plan.json');
  const ourProg = await showJson(dir, head, 'progress.json');
  const theirPlan = await showJson(dir, remoteSha, 'plan.json');
  const theirProg = await showJson(dir, remoteSha, 'progress.json');

  const merged = mergeTrees(basePlan, baseProg, ourPlan, ourProg, theirPlan, theirProg, opts && opts.choices);

  if (merged.conflicts.length) {
    return {
      ok: true,
      needsResolution: true,
      conflicts: merged.conflicts,
      base,
      oursSha: head,
      theirsSha: remoteSha,
      branch,
      remoteRef,
      theirsMeta: null,
    };
  }

  // Write the merged files, then record a 2-parent merge commit.
  try {
    backupProject(root, projectId);
  } catch (_) {
    /* best effort */
  }
  const w1 = atomicWriteJson(path.join(dir, 'plan.json'), merged.plan);
  if (!w1.ok) return { ok: false, code: 'write_failed', error: w1.error };
  const w2 = atomicWriteJson(path.join(dir, 'progress.json'), merged.progress);
  if (!w2.ok) return { ok: false, code: 'write_failed', error: w2.error };

  const add = await runGit(['add', '-A'], dir, GIT_TIMEOUT_MS);
  if (!add.ok) return { ok: false, code: 'stage_failed', error: (add.stderr || '').trim() };
  const tree = await runGit(['write-tree'], dir);
  if (!tree.ok || !tree.stdout.trim()) return { ok: false, code: 'tree_failed', error: (tree.stderr || '').trim() };
  const mergeMsg = `merge: reconcile with ${branch} (auto field-level merge)`;
  const ct = await runGit(['commit-tree', tree.stdout.trim(), '-p', head, '-p', remoteSha, '-m', mergeMsg], dir);
  if (!ct.ok || !ct.stdout.trim()) return { ok: false, code: 'commit_failed', error: (ct.stderr || '').trim() };
  const newSha = ct.stdout.trim();
  const ur = await runGit(['update-ref', `refs/heads/${branch}`, newSha], dir);
  if (!ur.ok) return { ok: false, code: 'ref_failed', error: (ur.stderr || '').trim() };
  // keep the index in sync with the new HEAD (working tree already matches)
  await runGit(['reset', '--mixed', newSha], dir);

  return { ok: true, merged: true, conflicts: [], newSha, message: mergeMsg, base, theirsSha: remoteSha };
}

/** Resolve conflicts with explicit choices and record the merge commit. */
async function resolveMerge(root, projectId, choices) {
  const map = {};
  for (const c of choices || []) {
    if (!c) continue;
    map[`${c.scope}:${c.id}:${c.field}`] = c.choice || 'ours';
  }
  return integrateRemote(root, projectId, { choices: map });
}

/* ============================ P6: sync (commit → integrate → push) ====== */

/** One-click Sync with semantic integration: commit local → integrate → push. */
async function syncProject(root, projectId, opts) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, phase: 'status', error: r.error };
  const st0 = await gitStatus(root, projectId);
  if (!st0.isRepo) return { ok: false, phase: 'status', error: 'not a git repository (bind or init first)' };
  const steps = [];
  let committed = false;
  let message = null;

  // 1. Commit local changes first, so integration sees a clean tree.
  if (st0.dirty) {
    message = (opts && opts.message) || (await deriveCommitMessage(root, projectId));
    const cr = await gitCommit(root, projectId, message, { author: opts && opts.author });
    steps.push({ step: 'commit', ok: cr.ok, detail: cr.error || message });
    if (!cr.ok) return { ok: false, phase: 'commit', error: cr.error, message, steps };
    committed = true;
  }

  // 2. Integrate the remote (ff or semantic merge).
  let integrated = { upToDate: true };
  if (st0.remote) {
    integrated = await integrateRemote(root, projectId, {});
    steps.push({
      step: 'pull',
      ok: integrated.ok,
      detail: integrated.error || (integrated.fastForwarded ? 'fast-forward' : integrated.merged ? 'merged' : 'up-to-date'),
    });
    if (integrated.needsResolution) {
      return { ok: false, phase: 'merge', needsResolution: true, conflicts: integrated.conflicts, message, steps };
    }
    if (!integrated.ok) return { ok: false, phase: 'pull', error: integrated.error, code: integrated.code, message, steps };
  }

  // 3. Push.
  let pushed = false;
  if (st0.remote) {
    const pr = await gitPush(root, projectId);
    steps.push({ step: 'push', ok: pr.ok, detail: pr.error || pr.stdout });
    if (!pr.ok) {
      const rejected = /rejected|non-fast-forward|fetch first|failed to push/i.test((pr.stderr || '') + (pr.error || ''));
      return { ok: false, phase: 'push', error: pr.error, rejected, next: rejected ? 'pull_first' : undefined, message, steps };
    }
    pushed = true;
  }

  return { ok: true, message, committed, pulled: integrated.fastForwarded === true || integrated.merged === true, merged: integrated.merged === true, pushed, steps, status: await gitStatus(root, projectId) };
}

/* ============================ publish to GitHub ========================== */
/*
 * One-click 「發佈到 GitHub」: create a private/public repo from a project
 * folder using the gh CLI, push it, and write the .pcproject.json binding.
 * Testable without touching GitHub via `opts.dryRun` (plan only) and
 * `opts.runGh` (injected gh runner used by the selftest/harness).
 */

const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const GH_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function repoNameError(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return '請輸入 repo 名';
  if (s === '.' || s === '..') return 'repo 名唔可以係 "." 或 ".."';
  if (!REPO_NAME_RE.test(s)) return 'repo 名只可以係英文字母、數字、. _ -（唔可以有空格或 /）';
  return null;
}

/** Slugify a project id/title into a GitHub-safe repo name. */
function slugifyRepoName(s) {
  return String(s == null ? '' : s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

/**
 * Pure: build the gh argv (and URL) for a publish. Exposed so the argv shape
 * can be asserted without creating any repo.
 */
function publishPlan(input) {
  const name = String(input.name == null ? '' : input.name).trim();
  const owner = String(input.owner == null ? '' : input.owner).trim();
  const visibility = input.visibility === 'public' ? 'public' : 'private';
  const description = String(input.description == null ? '' : input.description).trim();
  const dir = input.dir;
  const vis = visibility === 'public' ? '--public' : '--private';
  const target = owner ? `${owner}/${name}` : name;

  // Primary: create + set source + push in one shot.
  const primary = ['repo', 'create', target, vis];
  if (description) primary.push('--description', description);
  primary.push('--source', dir, '--push');

  // Fallback: create (under the authed user), then add remote + push manually.
  const fallbackCreate = ['repo', 'create', name, vis];
  if (description) fallbackCreate.push('--description', description);

  const url = `https://github.com/${owner ? owner + '/' : ''}${name}`;
  return { name, owner: owner || null, visibility, description, dir, target, primary, fallbackCreate, url };
}

/** Ensure `origin` points at `url` (add or set-url). */
async function ensureOrigin(dir, url, g) {
  const has = await g(['remote', 'get-url', 'origin'], dir);
  if (has.ok) {
    if (has.stdout.trim() !== url) await g(['remote', 'set-url', 'origin', url], dir);
  } else {
    await g(['remote', 'add', 'origin', url], dir);
  }
}

/** Fallback path: gh repo create (no source) → add remote → push -u origin main. */
async function publishViaFallback(run, g, dir, plan) {
  const steps = [];
  const create = await run(plan.fallbackCreate);
  if (!create.ok) {
    const code = classifyGhError(create.stderr || create.stdout);
    if (/already exists|already taken|name already exists/i.test(create.stderr || '')) {
      return { ok: false, code: 'repo_exists', error: `repo 名「${plan.name}」已經有人用咗，改個名再試。`, steps };
    }
    return { ok: false, code, error: (create.stderr || create.stdout || '').trim() || 'gh repo create failed', steps };
  }
  steps.push({ step: 'create', ok: true, detail: plan.name });
  await ensureOrigin(dir, plan.url, g);
  const push = await g(['push', '-u', 'origin', 'main'], dir, GIT_TIMEOUT_MS);
  steps.push({ step: 'push', ok: push.ok, detail: (push.stderr || '').trim() });
  if (!push.ok) return { ok: false, code: 'push_failed', error: (push.stderr || '').trim() || 'git push failed', steps };
  return { ok: true, url: plan.url, remote: plan.url, steps };
}

/**
 * Publish a project as a GitHub repo (private by default) and bind it.
 *
 * opts: { name, owner, visibility, description, rebind, dryRun, runGh, runGit }
 *   - runGh / runGit: injected runners (tests). When runGh is injected the gh
 *     availability check is skipped and `owner` must be supplied by the caller.
 *   - dryRun: validate + return the plan only; no git/gh execution, no writes.
 */
async function publishProject(root, projectId, opts = {}) {
  const run = typeof opts.runGh === 'function' ? opts.runGh : runGh;
  const g = typeof opts.runGit === 'function' ? opts.runGit : runGit;
  const injected = typeof opts.runGh === 'function';

  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, code: 'no_project', error: r.error };
  const dir = r.dir;

  // Parse name / owner (accept "owner/name" in the name field).
  let name = String(opts.name == null ? '' : opts.name).trim();
  let owner = String(opts.owner == null ? '' : opts.owner).trim();
  if (name.includes('/')) {
    const parts = name.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      if (!owner) owner = parts[0];
      name = parts[1];
    }
  }
  const nameErr = repoNameError(name);
  if (nameErr) return { ok: false, code: 'bad_name', error: nameErr };
  if (owner && !GH_OWNER_RE.test(owner)) return { ok: false, code: 'bad_owner', error: `擁有者（owner）名唔啱：${owner}` };
  const visibility = opts.visibility === 'public' ? 'public' : 'private';
  const description = String(opts.description == null ? '' : opts.description).trim();

  // Guard: already bound to a remote (unless the caller asks to re-bind).
  const st = await gitStatus(root, projectId);
  const bind = readBindingFile(dir);
  const existing = (st && st.remote) || (bind.ok && bind.binding && bind.binding.remote) || null;
  if (existing && !opts.rebind) {
    return { ok: false, code: 'already_bound', remote: existing, error: `呢個專案已經綁定咗 remote：${existing}。可以揀「更改 remote」覆蓋，或者先解除綁定。` };
  }

  // gh availability + default owner.
  if (!injected) {
    const gh = await ghAvailable();
    if (!gh.installed) return { ok: false, code: 'gh_missing', error: '未安裝 gh CLI。安裝：winget install GitHub.cli' };
    if (!gh.authed) return { ok: false, code: 'gh_not_authed', error: 'gh 未登入。請執行：gh auth login' };
    if (!owner) owner = gh.login;
  }

  const plan = publishPlan({ name, owner, visibility, description, dir });
  const needsInit = !(st && st.isRepo);

  if (opts.dryRun) return { ok: true, dryRun: true, wouldInit: needsInit, plan };

  // 1. Init a repo (with an initial commit) if the folder isn't one yet.
  let initialized = false;
  if (needsInit) {
    const ini = await gitInit(root, projectId, { branch: 'main' });
    if (!ini.ok) return { ok: false, code: 'init_failed', error: ini.error, plan };
    initialized = true;
  }
  // Guarantee at least one commit exists.
  const head = await g(['rev-parse', '--verify', 'HEAD'], dir);
  if (!head.ok) {
    await g(['add', '-A'], dir, GIT_TIMEOUT_MS);
    const c = await g(['commit', '-m', 'chore: initial commit'], dir, GIT_TIMEOUT_MS);
    if (!c.ok) return { ok: false, code: 'commit_failed', error: (c.stderr || '').trim(), plan };
  }

  // 2. Create the remote (primary: create --source --push).
  const res = await run(plan.primary);
  if (!res.ok) {
    const code = classifyGhError(res.stderr || res.stdout);
    if (/already exists|already taken|name already exists|repository .* exists/i.test(res.stderr || '')) {
      return { ok: false, code: 'repo_exists', error: `repo 名「${plan.target}」已經有人用咗，改個名再試。`, argv: plan.primary, plan };
    }
    if (code === 'gh_missing') return { ok: false, code, error: '未安裝 gh CLI。安裝：winget install GitHub.cli', plan };
    if (code === 'gh_not_authed') return { ok: false, code, error: 'gh 未登入。請執行：gh auth login', plan };
    if (code === 'offline') return { ok: false, code: 'offline', error: '連唔到 GitHub（network）。檢查網絡後再試。', plan };
    // Fallback path.
    const fb = await publishViaFallback(run, g, dir, plan);
    if (!fb.ok) {
      return { ok: false, code: fb.code || code || 'create_failed', error: fb.error || (res.stderr || '').trim() || 'gh repo create failed', argv: plan.primary, plan, steps: fb.steps };
    }
    const wb = await bindPublished(root, projectId, plan);
    if (!wb.ok) return { ok: false, code: 'bind_failed', error: wb.error, plan };
    return { ok: true, initialized, bound: true, fallbackUsed: true, url: plan.url, repo: plan.target, visibility, remote: plan.url, plan, steps: fb.steps };
  }

  // 3. Primary succeeded (gh pushed) → ensure origin + write binding.
  await ensureOrigin(dir, plan.url, g);
  const wb = await bindPublished(root, projectId, plan);
  if (!wb.ok) return { ok: false, code: 'bind_failed', error: wb.error, plan };
  return { ok: true, initialized, bound: true, url: plan.url, repo: plan.target, visibility, remote: plan.url, plan, steps: [{ step: 'create', ok: true, detail: plan.target }] };
}

/** Write the .pcproject.json binding for a just-published repo. */
async function bindPublished(root, projectId, plan) {
  const wb = writeBinding(root, projectId, { remote: plan.url, branch: 'main', projectId });
  if (!wb.ok) return wb;
  return { ok: true, binding: wb.binding };
}

module.exports = {
  parseRemote,
  permOf,
  permLabel,
  runGh,
  ghAvailable,
  ghApi,
  classifyGhError,
  repoCoords,
  shareInfo,
  inviteCollaborator,
  removeCollaborator,
  checkAccess,
  diffTrees,
  historyLog,
  commitDiff,
  restoreCommit,
  collectMyTasks,
  identity,
  mergeScalar,
  mergePlan3,
  mergeProgress3,
  mergeTrees,
  integrateRemote,
  resolveMerge,
  syncProject,
  repoNameError,
  slugifyRepoName,
  publishPlan,
  publishProject,
};
