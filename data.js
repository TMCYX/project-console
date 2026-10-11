'use strict';

/**
 * Project Console — data layer (human-only model).
 *
 * Pure Node (no Electron) so it can be exercised headlessly by selftest.js.
 * Reads a data root whose immediate sub-folders each contain a plan.json
 * (omo-project/plan@2) and optionally a progress.json (omo-project/progress@1).
 *
 * The app READS plan.json and READS+WRITES progress.json. It never touches
 * plan.json. Progress is the only per-project file the app may write.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ensureGitIdentity, identityArgs } = require('./git-identity');
const github = require('./github');

/**
 * Resolve the default data root (the folder that holds project folders).
 * Order: env PROJECT_CONSOLE_ROOT → <app>/project-console.config.json
 * ({ "dataRoot": "..." }, gitignored) → ~/ProjectConsole/projects.
 */
function resolveDefaultRoot() {
  if (process.env.PROJECT_CONSOLE_ROOT) return process.env.PROJECT_CONSOLE_ROOT;
  try {
    const cfgPath = path.join(__dirname, 'project-console.config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg && typeof cfg.dataRoot === 'string' && cfg.dataRoot) return cfg.dataRoot;
    }
  } catch (_) {
    /* ignore malformed config */
  }
  return path.join(os.homedir(), 'ProjectConsole', 'projects');
}

const DEFAULT_ROOT = resolveDefaultRoot();
const PLAN_SCHEMA = 'omo-project/plan@2';
const PROGRESS_SCHEMA = 'omo-project/progress@1';
const DAY = 86400000;

/* ------------------------------ primitives ------------------------------- */

function readJsonSafe(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { ok: false, error: `read failed: ${err.message}` };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: `parse failed: ${err.message}` };
  }
}

function toDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateOnlyUTC(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** Hong Kong wall-clock "today" as YYYY-MM-DD. */
function hkTodayStr() {
  return dateOnlyUTC(new Date(Date.now() + 8 * 3600 * 1000));
}

/** Hong Kong wall-clock now as an ISO-8601 string with +08:00. */
function hkNowIso() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+08:00`
  );
}

/** Add n days to a YYYY-MM-DD string (UTC-safe), returning YYYY-MM-DD. */
function addDaysStr(s, n) {
  const d = toDate(s);
  if (!d) return null;
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + n * DAY;
  return dateOnlyUTC(new Date(t));
}

/* ------------------------------ domain ----------------------------------- */

/** Inclusive planned end = start + (estimate_days - 1). */
function plannedEndStr(task) {
  const days = Number.isFinite(Number(task && task.estimate_days))
    ? Math.max(1, Number(task.estimate_days))
    : 1;
  return addDaysStr(task && task.start, days - 1);
}

/** Exclusive planned end = start + estimate_days (bar length in days). */
function plannedEndExclusiveStr(task) {
  const days = Number.isFinite(Number(task && task.estimate_days))
    ? Math.max(1, Number(task.estimate_days))
    : 1;
  return addDaysStr(task && task.start, days);
}

function progressEntry(progress, taskId) {
  if (!progress || !progress.tasks) return null;
  return progress.tasks[taskId] || null;
}

function isDone(progress, taskId) {
  const e = progressEntry(progress, taskId);
  return !!(e && e.done === true);
}

/** Enrich raw plan tasks with done state + planned schedule. */
function enrichTasks(plan, progress) {
  const today = hkTodayStr();
  return (Array.isArray(plan.tasks) ? plan.tasks : []).map((t) => {
    const e = progressEntry(progress, t.id);
    const done = !!(e && e.done === true);
    const doneAt = (e && e.doneAt) || null;
    const note = (e && e.note) || '';
    const plannedEnd = plannedEndStr(t);
    let status;
    if (done) status = doneAt && plannedEnd && doneAt > plannedEnd ? 'late' : 'done';
    else if (plannedEnd && today > plannedEnd) status = 'overdue';
    else status = 'pending';
    return {
      id: t.id,
      phase: t.phase,
      title: t.title,
      deliverable: t.deliverable || null,
      deps: Array.isArray(t.deps) ? t.deps : [],
      owner: t.owner || null,
      start: t.start || null,
      estimate_days: Number.isFinite(Number(t.estimate_days)) ? Number(t.estimate_days) : 1,
      acceptance: t.acceptance || null,
      outputs: Array.isArray(t.outputs) ? t.outputs : [],
      done,
      doneAt,
      note,
      plannedEnd,
      plannedEndExclusive: plannedEndExclusiveStr(t),
      status,
    };
  });
}

function deriveSummary(plan, progress, tasks) {
  const list = Array.isArray(tasks) ? tasks : enrichTasks(plan, progress);
  const total = list.length;
  const done = list.filter((t) => t.done).length;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  const today = hkTodayStr();
  const overdue = list.filter((t) => t.status === 'overdue').length;
  const late = list.filter((t) => t.status === 'late').length;

  const targetPast = !!(plan.target && today > plan.target);

  let rag = 'green';
  if (!progress) rag = 'grey';
  else if (overdue > 0 || (targetPast && percent < 100)) rag = 'red';
  else if (percent === 100) rag = 'green';
  else rag = 'amber';

  const milestones = Array.isArray(plan.milestones) ? plan.milestones.slice() : [];
  milestones.sort((a, b) => (toDate(a.date)?.getTime() || 0) - (toDate(b.date)?.getTime() || 0));
  const nextMilestone =
    milestones.find((m) => {
      const d = toDate(m.date);
      return d && d.getTime() >= Date.now();
    }) ||
    milestones[0] ||
    null;

  const owners = [...new Set(list.map((t) => t.owner).filter(Boolean))];

  return {
    tasksDone: done,
    tasksTotal: total,
    percent,
    rag,
    overdue,
    late,
    target: plan.target || null,
    lastUpdated: (progress && progress.updated) || null,
    owners,
    nextMilestone: nextMilestone
      ? { id: nextMilestone.id, name: nextMilestone.name, date: nextMilestone.date }
      : null,
  };
}

function findDanglingRefs(plan) {
  const ids = new Set((Array.isArray(plan.tasks) ? plan.tasks : []).map((t) => t.id));
  const problems = [];
  for (const t of plan.tasks || []) {
    for (const dep of t.deps || []) {
      if (!ids.has(dep)) problems.push(`task ${t.id} deps -> unknown ${dep}`);
    }
  }
  for (const m of plan.milestones || []) {
    for (const a of m.after || []) {
      if (!ids.has(a)) problems.push(`milestone ${m.id} after -> unknown ${a}`);
    }
  }
  return problems;
}

function normalizeProject(dir, plan, progress, progressError) {
  const id = plan.id || path.basename(dir);
  const tasks = enrichTasks(plan, progress);
  return {
    id,
    folder: dir,
    schema: plan.schema || null,
    source: {
      planPath: path.join(dir, 'plan.json'),
      progressPath: fs.existsSync(path.join(dir, 'progress.json'))
        ? path.join(dir, 'progress.json')
        : null,
    },
    title: plan.title || id,
    owner: plan.owner || null,
    created: plan.created || null,
    target: plan.target || null,
    protocol: plan.protocol || null,
    definition_of_done: plan.definition_of_done || null,
    scope: plan.scope || null,
    constraints: plan.constraints || null,
    phases: Array.isArray(plan.phases) ? plan.phases : [],
    tasks,
    milestones: Array.isArray(plan.milestones) ? plan.milestones : [],
    resources: plan.resources || null,
    risks: Array.isArray(plan.risks) ? plan.risks : [],
    progress: progress || null,
    progressError: progressError || null,
    baseline: null, // no longer used in the human-only model
    summary: deriveSummary(plan, progress, tasks),
    danglingRefs: findDanglingRefs(plan),
  };
}

/** Scan a data root and return { projects, warnings, root }. Never throws. */
function scanProjects(root = DEFAULT_ROOT) {
  const projects = [];
  const warnings = [];

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    return { projects, warnings: [`cannot read root: ${err.message}`], root };
  }

  // Recursively collect project folders: a folder containing plan.json IS a
  // project (we do not descend into it). Nested layout (e.g. academic/fyp) works.
  const projectDirs = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let sub;
    try {
      sub = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      warnings.push(`cannot read ${dir}: ${err.message}`);
      continue;
    }
    if (fs.existsSync(path.join(dir, 'plan.json'))) {
      projectDirs.push(dir);
      continue;
    }
    for (const entry of sub) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      stack.push(path.join(dir, entry.name));
    }
  }

  for (const dir of projectDirs) {
    const name = path.basename(dir);
    const planPath = path.join(dir, 'plan.json');

    const planRes = readJsonSafe(planPath);
    if (!planRes.ok) {
      warnings.push(`${name}: ${planRes.error} (skipped)`);
      continue;
    }
    const plan = planRes.value;
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
      warnings.push(`${name}: plan.json is not an object (skipped)`);
      continue;
    }

    let progress = null;
    let progressError = null;
    const progressPath = path.join(dir, 'progress.json');
    if (fs.existsSync(progressPath)) {
      const pRes = readJsonSafe(progressPath);
      if (pRes.ok && pRes.value && typeof pRes.value === 'object') progress = pRes.value;
      else {
        progressError = pRes.ok ? 'progress.json is not an object' : pRes.error;
        warnings.push(`${name}: ${progressError} (progress ignored)`);
      }
    }

    try {
      const project = normalizeProject(dir, plan, progress, progressError);
      for (const d of project.danglingRefs) warnings.push(`${name}: ${d}`);
      projects.push(project);
    } catch (err) {
      warnings.push(`${name}: normalize failed: ${err.message} (skipped)`);
    }
  }

  const RAG_RANK = { red: 3, amber: 2, green: 1, grey: 0 };
  projects.sort((a, b) => {
    const r = RAG_RANK[b.summary.rag] - RAG_RANK[a.summary.rag];
    return r !== 0 ? r : a.id.localeCompare(b.id);
  });

  return { projects, warnings, root };
}

/* ------------------------------ writing ---------------------------------- */

const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * Toggle a task's done state in <root>/<projectId>/progress.json.
 * Atomic (temp file in the same dir, then rename) and merge-preserving:
 * every other field and every other task entry is kept. Sets `updated` to now
 * and sets/clears `doneAt`. Only ever writes progress.json.
 *
 * Returns { ok:true, progress } or { ok:false, error }.
 */
/** Recursively find a project folder under root (basename or plan.id === projectId). */
function findProjectDir(root, projectId) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    if (fs.existsSync(path.join(dir, 'plan.json'))) {
      const p = readJsonSafe(path.join(dir, 'plan.json'));
      const id = (p.ok && p.value && p.value.id) || path.basename(dir);
      if (path.basename(dir) === projectId || id === projectId) return dir;
      continue; // project folder; do not descend
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      stack.push(path.join(dir, entry.name));
    }
  }
  return null;
}

function setTaskDone(root, projectId, taskId, done) {
  if (!SAFE_ID.test(String(projectId || '')) || projectId === '.' || projectId === '..') {
    return { ok: false, error: `invalid projectId: ${projectId}` };
  }
  if (!SAFE_ID.test(String(taskId || ''))) {
    return { ok: false, error: `invalid taskId: ${taskId}` };
  }

  const roots = asRootList(root);
  if (!roots.length) return { ok: false, error: 'no data root configured' };
  const dir = findProjectDirIn(roots, projectId);
  if (!dir) {
    return { ok: false, error: `project folder not found: ${projectId}` };
  }
  if (!roots.some((r) => dir === r || dir.startsWith(r + path.sep))) {
    return { ok: false, error: 'path escapes data root' };
  }

  // Reject phantom task ids: the task must exist in the project's plan.json.
  const planRes = readJsonSafe(path.join(dir, 'plan.json'));
  if (!planRes.ok) return { ok: false, error: `cannot read plan.json (${planRes.error})` };
  const planIds = new Set((Array.isArray(planRes.value.tasks) ? planRes.value.tasks : []).map((t) => t.id));
  if (!planIds.has(taskId)) return { ok: false, error: `no such task in plan: ${taskId}` };

  const target = path.join(dir, 'progress.json');
  let current = { schema: PROGRESS_SCHEMA, project: projectId, updated: null, tasks: {} };

  if (fs.existsSync(target)) {
    const res = readJsonSafe(target);
    if (!res.ok) return { ok: false, error: `progress.json is malformed; refusing to overwrite (${res.error})` };
    if (res.value && typeof res.value === 'object' && !Array.isArray(res.value)) {
      current = res.value;
    } else {
      return { ok: false, error: 'progress.json is malformed; refusing to overwrite' };
    }
  }

  const tasksObj = current.tasks && typeof current.tasks === 'object' ? { ...current.tasks } : {};
  const prev = tasksObj[taskId] && typeof tasksObj[taskId] === 'object' ? { ...tasksObj[taskId] } : {};

  const nextEntry = { ...prev };
  if (done) {
    nextEntry.done = true;
    if (!nextEntry.doneAt) nextEntry.doneAt = hkTodayStr();
    if (typeof nextEntry.note !== 'string') nextEntry.note = '';
  } else {
    nextEntry.done = false;
    delete nextEntry.doneAt;
  }
  tasksObj[taskId] = nextEntry;

  const next = {
    ...current,
    schema: current.schema || PROGRESS_SCHEMA,
    project: current.project || projectId,
    updated: hkNowIso(),
    tasks: tasksObj,
  };

  const tmp = path.join(dir, `.progress.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    try {
      fs.renameSync(tmp, target); // atomic replace on the same volume
    } catch (renameErr) {
      // Windows fallback if the destination is momentarily locked.
      fs.rmSync(target, { force: true });
      fs.renameSync(tmp, target);
    }
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (_) {
      /* ignore */
    }
    return { ok: false, error: `write failed: ${err.message}` };
  }

  return { ok: true, progress: next, path: target, undo: { file: 'progress.json', before: current } };
}

/* ------------------------------ plan writing ----------------------------- */

const BASELINE_SCHEMA = 'omo-project/baseline@1';
const WRITABLE_FILES = new Set(['plan.json', 'progress.json']);

function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  );
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    try {
      fs.renameSync(tmp, filePath);
    } catch (_) {
      fs.rmSync(filePath, { force: true });
      fs.renameSync(tmp, filePath);
    }
    return { ok: true };
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (_) {
      /* ignore */
    }
    return { ok: false, error: err.message };
  }
}

/** Resolve a project folder, validating the id and staying inside the root(s). */
function projectDirOrError(root, projectId) {
  if (!SAFE_ID.test(String(projectId || '')) || projectId === '.' || projectId === '..') {
    return { error: `invalid projectId: ${projectId}` };
  }
  const roots = asRootList(root);
  if (!roots.length) return { error: 'no data root configured' };
  const dir = findProjectDirIn(roots, projectId);
  if (!dir) return { error: `project folder not found: ${projectId}` };
  if (!roots.some((r) => dir === r || dir.startsWith(r + path.sep))) return { error: 'path escapes data root' };
  if (!fs.existsSync(path.join(dir, 'plan.json'))) return { error: `no plan.json in ${projectId}` };
  return { dir };
}

function loadPlan(dir) {
  const res = readJsonSafe(path.join(dir, 'plan.json'));
  if (!res.ok) return { ok: false, error: res.error };
  if (!res.value || typeof res.value !== 'object' || Array.isArray(res.value)) {
    return { ok: false, error: 'plan.json is not an object' };
  }
  return { ok: true, plan: res.value };
}

/** Load plan, deep-clone it as `before`, run mutate, write back atomically. */
function withPlan(root, projectId, mutate) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const lp = loadPlan(r.dir);
  if (!lp.ok) return { ok: false, error: lp.error };
  const plan = lp.plan;
  const before = JSON.parse(JSON.stringify(plan));
  let extra;
  try {
    extra = mutate(plan) || {};
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (extra.error) return { ok: false, error: extra.error };
  try {
    backupProject(root, projectId); // best-effort snapshot before every plan write
  } catch (_) {
    /* backup is best-effort */
  }
  const w = atomicWriteJson(path.join(r.dir, 'plan.json'), plan);
  if (!w.ok) return { ok: false, error: w.error };
  return { ok: true, plan, dir: r.dir, before, ...extra };
}

function planOp(res) {
  if (!res.ok) return { ok: false, error: res.error };
  const out = { ok: true, plan: res.plan, undo: { file: 'plan.json', before: res.before } };
  for (const k of Object.keys(res)) {
    if (!['ok', 'plan', 'dir', 'before', 'error'].includes(k)) out[k] = res[k];
  }
  return out;
}

function nextPhaseId(plan) {
  const used = new Set((plan.phases || []).map((p) => p.id));
  let n = 1;
  while (used.has(`P${n}`)) n++;
  return `P${n}`;
}

function nextMilestoneId(plan) {
  const used = new Set((plan.milestones || []).map((m) => m.id));
  let n = 1;
  while (used.has(`M${n}`)) n++;
  return `M${n}`;
}

function nextTaskIdFor(plan, phaseId) {
  const phases = plan.phases || [];
  const idx = phases.findIndex((p) => p.id === phaseId);
  const m = /^P(\d+)$/.exec(phaseId);
  const num = m ? String(Number(m[1])) : String(idx + 1);
  const used = new Set((plan.tasks || []).map((t) => t.id));
  let n = 1;
  while (used.has(`T${num}.${n}`)) n++;
  return `T${num}.${n}`;
}

/** DFS cycle detection over deps, with an optional override for one task. */
function detectCycle(tasks, override) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depsOf = (id) => {
    if (override && override.has(id)) return override.get(id) || [];
    const t = byId.get(id);
    return t && Array.isArray(t.deps) ? t.deps : [];
  };
  const color = new Map();
  const stack = [];
  let cycle = null;
  const dfs = (id) => {
    color.set(id, 1);
    stack.push(id);
    for (const d of depsOf(id)) {
      if (!byId.has(d)) continue;
      const c = color.get(d) || 0;
      if (c === 1) {
        cycle = stack.slice(stack.indexOf(d)).concat(d);
        return true;
      }
      if (c === 0 && dfs(d)) return true;
    }
    color.set(id, 2);
    stack.pop();
    return false;
  };
  for (const t of tasks) {
    if ((color.get(t.id) || 0) === 0 && dfs(t.id)) return cycle;
  }
  return null;
}

function estimateOf(t) {
  const v = Number(t && t.estimate_days);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/** Longest-path schedule (earliest starts) + the critical chain. */
function computeSchedule(plan) {
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const start = new Map();
  const end = new Map();
  const pred = new Map();
  const resolve = (id, seen) => {
    if (end.has(id)) return end.get(id);
    const t = byId.get(id);
    if (!t || seen.has(id)) return 0;
    seen.add(id);
    let s = 0;
    let best = -1;
    let p = null;
    for (const d of Array.isArray(t.deps) ? t.deps : []) {
      if (!byId.has(d)) continue;
      const de = resolve(d, seen);
      if (de > best) {
        best = de;
        p = d;
      }
      s = Math.max(s, de);
    }
    start.set(id, s);
    end.set(id, s + estimateOf(t));
    if (p) pred.set(id, p);
    seen.delete(id);
    return end.get(id);
  };
  for (const t of tasks) resolve(t.id, new Set());

  let totalDays = 0;
  let last = null;
  let maxEnd = -1;
  for (const t of tasks) {
    const e = end.get(t.id) || 0;
    if (e > totalDays) totalDays = e;
    if (e > maxEnd) {
      maxEnd = e;
      last = t.id;
    }
  }
  const chain = [];
  let cur = last;
  while (cur) {
    chain.push(cur);
    cur = pred.get(cur);
  }
  chain.reverse();
  return { start, end, totalDays, criticalChain: chain };
}

function computeCriticalPath(plan) {
  const s = computeSchedule(plan);
  return { chain: s.criticalChain, totalDays: s.totalDays };
}

function addTask(root, projectId, phaseId, partial) {
  return planOp(
    withPlan(root, projectId, (plan) => {
      if (!(plan.phases || []).some((p) => p.id === phaseId)) return { error: `no such phase: ${phaseId}` };
      const t = { ...(partial || {}) };
      if (!t.id) t.id = nextTaskIdFor(plan, phaseId);
      if ((plan.tasks || []).some((x) => x.id === t.id)) return { error: `task id exists: ${t.id}` };
      t.phase = phaseId;
      if (!t.title) t.title = '新任務';
      if (t.deliverable == null) t.deliverable = '';
      if (!Array.isArray(t.deps)) t.deps = [];
      if (t.owner == null) t.owner = '';
      if (!t.start) t.start = hkTodayStr();
      if (!(Number(t.estimate_days) > 0)) t.estimate_days = 1;
      if (t.acceptance == null) t.acceptance = '';
      if (!Array.isArray(t.outputs)) t.outputs = [];
      const ids = new Set((plan.tasks || []).map((x) => x.id));
      for (const d of t.deps) if (!ids.has(d)) return { error: `unknown dep: ${d}` };
      if (!Array.isArray(plan.tasks)) plan.tasks = [];
      let insertAt = plan.tasks.length;
      for (let i = plan.tasks.length - 1; i >= 0; i--) {
        if (plan.tasks[i].phase === phaseId) {
          insertAt = i + 1;
          break;
        }
      }
      plan.tasks.splice(insertAt, 0, t);
      return { task: t };
    })
  );
}

function updateTask(root, projectId, taskId, patch) {
  return planOp(
    withPlan(root, projectId, (plan) => {
      const t = (plan.tasks || []).find((x) => x.id === taskId);
      if (!t) return { error: `no such task: ${taskId}` };
      const p = { ...(patch || {}) };
      delete p.id;
      if (p.deps) {
        const ids = new Set((plan.tasks || []).map((x) => x.id));
        for (const d of p.deps) {
          if (d === taskId) return { error: 'task cannot depend on itself' };
          if (!ids.has(d)) return { error: `unknown dep: ${d}` };
        }
        const cyc = detectCycle(plan.tasks, new Map([[taskId, p.deps]]));
        if (cyc) return { error: `dependency cycle: ${cyc.join(' → ')}` };
      }
      if (p.estimate_days != null && !(Number(p.estimate_days) > 0)) p.estimate_days = 1;
      if (p.phase && !(plan.phases || []).some((x) => x.id === p.phase)) return { error: `no such phase: ${p.phase}` };
      Object.assign(t, p);
      return { task: t };
    })
  );
}

function deleteTask(root, projectId, taskId) {
  return planOp(
    withPlan(root, projectId, (plan) => {
      const tasks = plan.tasks || [];
      const i = tasks.findIndex((x) => x.id === taskId);
      if (i < 0) return { error: `no such task: ${taskId}` };
      tasks.splice(i, 1);
      const depsFrom = [];
      for (const t of tasks) {
        if (Array.isArray(t.deps) && t.deps.includes(taskId)) {
          t.deps = t.deps.filter((d) => d !== taskId);
          depsFrom.push(t.id);
        }
      }
      const milestones = [];
      for (const m of plan.milestones || []) {
        if (Array.isArray(m.after) && m.after.includes(taskId)) {
          m.after = m.after.filter((a) => a !== taskId);
          milestones.push(m.id);
        }
      }
      return { cleaned: { depsFrom, milestones } };
    })
  );
}

function moveTask(root, projectId, taskId, opts) {
  return planOp(
    withPlan(root, projectId, (plan) => {
      const tasks = plan.tasks || [];
      const i = tasks.findIndex((x) => x.id === taskId);
      if (i < 0) return { error: `no such task: ${taskId}` };
      const t = tasks[i];
      const targetPhase = (opts && opts.phaseId) || t.phase;
      if (!(plan.phases || []).some((p) => p.id === targetPhase)) return { error: `no such phase: ${targetPhase}` };
      tasks.splice(i, 1);
      t.phase = targetPhase;
      const idxs = [];
      tasks.forEach((x, k) => {
        if (x.phase === targetPhase) idxs.push(k);
      });
      let at;
      if (opts && Number.isInteger(opts.index) && idxs[opts.index] != null) at = idxs[opts.index];
      else at = idxs.length ? idxs[idxs.length - 1] + 1 : tasks.length;
      tasks.splice(at, 0, t);
      return { task: t };
    })
  );
}

function addPhase(root, projectId, phase) {
  return planOp(
    withPlan(root, projectId, (plan) => {
      const p = { ...(phase || {}) };
      if (!p.id) p.id = nextPhaseId(plan);
      if (!p.name) p.name = p.id;
      if ((plan.phases || []).some((x) => x.id === p.id)) return { error: `phase id exists: ${p.id}` };
      if (!Array.isArray(plan.phases)) plan.phases = [];
      plan.phases.push(p);
      return { phase: p };
    })
  );
}

function updatePhase(root, projectId, phaseId, patch) {
  return planOp(
    withPlan(root, projectId, (plan) => {
      const phases = plan.phases || [];
      const ph = phases.find((p) => p.id === phaseId);
      if (!ph) return { error: `no such phase: ${phaseId}` };
      const p = { ...(patch || {}) };
      const newId = p.id;
      delete p.id;
      if (p.name != null) ph.name = p.name;
      if (newId && newId !== phaseId) {
        if (phases.some((x) => x.id === newId)) return { error: `phase id exists: ${newId}` };
        ph.id = newId;
        for (const t of plan.tasks || []) if (t.phase === phaseId) t.phase = newId;
      }
      if (Number.isInteger(p.index)) {
        const cur = phases.indexOf(ph);
        phases.splice(cur, 1);
        phases.splice(Math.max(0, Math.min(phases.length, p.index)), 0, ph);
      }
      return { phase: ph };
    })
  );
}

function deletePhase(root, projectId, phaseId, opts) {
  return planOp(
    withPlan(root, projectId, (plan) => {
      const phases = plan.phases || [];
      const idx = phases.findIndex((p) => p.id === phaseId);
      if (idx < 0) return { error: `no such phase: ${phaseId}` };
      const mine = (plan.tasks || []).filter((t) => t.phase === phaseId);
      if (mine.length > 0) {
        const dest = opts && opts.moveToPhase;
        if (!dest) return { error: `phase ${phaseId} still has ${mine.length} task(s); pass moveToPhase` };
        if (!phases.some((p) => p.id === dest)) return { error: `no such target phase: ${dest}` };
        for (const t of mine) t.phase = dest;
      }
      phases.splice(idx, 1);
      return { moved: mine.length };
    })
  );
}

function upsertMilestone(root, projectId, milestone) {
  return planOp(
    withPlan(root, projectId, (plan) => {
      const m = { ...(milestone || {}) };
      if (!Array.isArray(plan.milestones)) plan.milestones = [];
      if (!m.id) m.id = nextMilestoneId(plan);
      if (!m.name) m.name = m.id;
      if (!Array.isArray(m.after)) m.after = m.after ? [m.after] : [];
      const ids = new Set((plan.tasks || []).map((t) => t.id));
      for (const a of m.after) if (!ids.has(a)) return { error: `unknown task in after: ${a}` };
      const idx = plan.milestones.findIndex((x) => x.id === m.id);
      if (idx >= 0) plan.milestones[idx] = { ...plan.milestones[idx], ...m };
      else plan.milestones.push(m);
      return { milestone: m };
    })
  );
}

function deleteMilestone(root, projectId, id) {
  return planOp(
    withPlan(root, projectId, (plan) => {
      const ms = plan.milestones || [];
      const i = ms.findIndex((m) => m.id === id);
      if (i < 0) return { error: `no such milestone: ${id}` };
      ms.splice(i, 1);
      return {};
    })
  );
}

function setTaskDeps(root, projectId, taskId, deps) {
  return planOp(
    withPlan(root, projectId, (plan) => {
      const t = (plan.tasks || []).find((x) => x.id === taskId);
      if (!t) return { error: `no such task: ${taskId}` };
      const list = Array.isArray(deps) ? deps.slice() : [];
      const ids = new Set((plan.tasks || []).map((x) => x.id));
      for (const d of list) {
        if (d === taskId) return { error: 'task cannot depend on itself' };
        if (!ids.has(d)) return { error: `unknown dep: ${d}` };
      }
      const cyc = detectCycle(plan.tasks, new Map([[taskId, list]]));
      if (cyc) return { error: `dependency cycle: ${cyc.join(' → ')}` };
      t.deps = list;
      return { task: t };
    })
  );
}

function reschedule(root, projectId) {
  return planOp(
    withPlan(root, projectId, (plan) => {
      const sched = computeSchedule(plan);
      const created = plan.created || hkTodayStr();
      for (const t of plan.tasks || []) {
        const off = sched.start.get(t.id) || 0;
        t.start = addDaysStr(created, off) || t.start;
      }
      const schedule = (plan.tasks || []).map((t) => ({
        id: t.id,
        start: t.start,
        offset: sched.start.get(t.id) || 0,
      }));
      return { schedule, criticalPath: sched.criticalChain, totalDays: sched.totalDays };
    })
  );
}

function freezeBaseline(root, projectId) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const lp = loadPlan(r.dir);
  if (!lp.ok) return { ok: false, error: lp.error };
  const plan = lp.plan;
  const progPath = path.join(r.dir, 'progress.json');
  let progress = null;
  if (fs.existsSync(progPath)) {
    const pr = readJsonSafe(progPath);
    if (pr.ok) progress = pr.value;
  }
  const tasks = {};
  for (const t of plan.tasks || []) {
    tasks[t.id] = {
      start: t.start || null,
      estimate_days: estimateOf(t),
      plannedEnd: plannedEndStr(t),
    };
  }
  const total = (plan.tasks || []).length;
  const done = (plan.tasks || []).filter((t) => isDone(progress, t.id)).length;
  const baseline = {
    schema: BASELINE_SCHEMA,
    project: plan.id || projectId,
    frozen: hkNowIso(),
    percent: total ? Math.round((done / total) * 100) : 0,
    tasks,
  };
  const w = atomicWriteJson(path.join(r.dir, 'baseline.json'), baseline);
  if (!w.ok) return { ok: false, error: w.error };
  return { ok: true, baseline, dir: r.dir };
}

function getBaseline(root, projectId) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const p = path.join(r.dir, 'baseline.json');
  if (!fs.existsSync(p)) return { ok: true, baseline: null };
  const res = readJsonSafe(p);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, baseline: res.value };
}

/** Restore a whole file from a snapshot (used by undo/redo). */
function restoreFile(root, projectId, file, content) {
  if (!WRITABLE_FILES.has(file)) return { ok: false, error: `file not writable: ${file}` };
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return { ok: false, error: 'content must be a JSON object' };
  }
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const w = atomicWriteJson(path.join(r.dir, file), content);
  if (!w.ok) return { ok: false, error: w.error };
  return { ok: true };
}

/* ------------------------------ pass 2: backup / md / export ------------- */

const BACKUP_KEEP = 20;
const BACKUP_DIR = '.backups';
const MD_LINE = /^- \[( |x|X)\]\s+(\S+)\s+(.*)$/;

function atomicWriteText(filePath, text) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    try {
      fs.renameSync(tmp, filePath);
    } catch (_) {
      fs.rmSync(filePath, { force: true });
      fs.renameSync(tmp, filePath);
    }
    return { ok: true };
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (_) {
      /* ignore */
    }
    return { ok: false, error: err.message };
  }
}

function backupProject(root, projectId) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const dir = r.dir;
  const bdir = path.join(dir, BACKUP_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snap = path.join(bdir, stamp);
  try {
    fs.mkdirSync(snap, { recursive: true });
    let copied = 0;
    for (const f of ['plan.json', 'progress.json']) {
      const src = path.join(dir, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(snap, f));
        copied++;
      }
    }
    // prune to newest BACKUP_KEEP
    let names = [];
    try {
      names = fs
        .readdirSync(bdir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch (_) {
      names = [];
    }
    while (names.length > BACKUP_KEEP) {
      const old = names.shift();
      try {
        fs.rmSync(path.join(bdir, old), { recursive: true, force: true });
      } catch (_) {
        /* ignore */
      }
    }
    return { ok: true, stamp, copied };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function listBackups(root, projectId) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const bdir = path.join(r.dir, BACKUP_DIR);
  if (!fs.existsSync(bdir)) return { ok: true, backups: [] };
  let names = [];
  try {
    names = fs
      .readdirSync(bdir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (_) {
    names = [];
  }
  names.sort().reverse();
  return {
    ok: true,
    backups: names.map((n) => ({
      ts: n,
      hasPlan: fs.existsSync(path.join(bdir, n, 'plan.json')),
      hasProgress: fs.existsSync(path.join(bdir, n, 'progress.json')),
    })),
  };
}

/** Restore a snapshot (plan.json + progress.json). Returns undo info for both. */
function restoreBackup(root, projectId, ts) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const bdir = path.join(r.dir, BACKUP_DIR);
  const snap = path.join(bdir, String(ts));
  if (!snap.startsWith(bdir + path.sep) || !fs.existsSync(snap) || !fs.statSync(snap).isDirectory()) {
    return { ok: false, error: 'snapshot not found' };
  }
  const files = [];
  const restored = {};
  for (const f of ['plan.json', 'progress.json']) {
    const src = path.join(snap, f);
    if (!fs.existsSync(src)) continue;
    let raw;
    try {
      raw = fs.readFileSync(src, 'utf8');
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const parsed = readJsonSafe(src);
    if (!parsed.ok) return { ok: false, error: `backup ${f} malformed` };
    const dst = path.join(r.dir, f);
    const beforeRaw = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : null;
    const w = atomicWriteText(dst, raw); // byte-verbatim so identical content = identical bytes
    if (!w.ok) return { ok: false, error: w.error };
    files.push({ file: f, beforeRaw, afterRaw: raw });
    restored[f === 'plan.json' ? 'plan' : 'progress'] = parsed.value;
  }
  return { ok: true, restored, undo: { files } };
}

/** Write a file exactly from raw text (used by verbatim restore / undo). */
function restoreFileRaw(root, projectId, file, raw) {
  if (!WRITABLE_FILES.has(file)) return { ok: false, error: `file not writable: ${file}` };
  if (typeof raw !== 'string') return { ok: false, error: 'raw must be a string' };
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const w = atomicWriteText(path.join(r.dir, file), raw);
  if (!w.ok) return { ok: false, error: w.error };
  return { ok: true };
}

function mdLine(t, done) {
  return `- [${done ? 'x' : ' '}] ${t.id} ${t.title || ''}${t.owner ? ' — ' + t.owner : ''}`.trimEnd();
}

/** Write/update <project>/tasks.md. Only manages checkbox lines it owns. */
function syncTasksMd(root, projectId) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const lp = loadPlan(r.dir);
  if (!lp.ok) return { ok: false, error: lp.error };
  const plan = lp.plan;
  const progPath = path.join(r.dir, 'progress.json');
  const progress = fs.existsSync(progPath) ? readJsonSafe(progPath).value : null;

  const file = path.join(r.dir, 'tasks.md');
  let lines = [];
  if (fs.existsSync(file)) {
    try {
      lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    } catch (_) {
      lines = [];
    }
  }
  const taskIds = new Set((plan.tasks || []).map((t) => t.id));
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const m = MD_LINE.exec(line.trim());
    if (m) {
      const id = m[2];
      if (taskIds.has(id)) {
        const t = plan.tasks.find((x) => x.id === id);
        out.push(mdLine(t, isDone(progress, id)));
        seen.add(id);
      }
      // checkbox line for an unknown id -> ours but stale -> dropped
      continue;
    }
    out.push(line); // user-authored line -> preserved verbatim
  }
  let added = 0;
  for (const t of plan.tasks || []) {
    if (!seen.has(t.id)) {
      out.push(mdLine(t, isDone(progress, t.id)));
      added++;
    }
  }
  let content = out.join('\n').replace(/\n{3,}/g, '\n\n');
  if (!content.endsWith('\n')) content += '\n';
  const w = atomicWriteText(file, content);
  if (!w.ok) return { ok: false, error: w.error };
  return { ok: true, file, updated: seen.size, added };
}

/** Read <project>/tasks.md and apply checkbox state into progress.json. */
function readTasksMd(root, projectId) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const file = path.join(r.dir, 'tasks.md');
  if (!fs.existsSync(file)) return { ok: false, error: 'tasks.md not found' };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const lp = loadPlan(r.dir);
  if (!lp.ok) return { ok: false, error: lp.error };
  const ids = new Set((lp.plan.tasks || []).map((t) => t.id));
  const progPath = path.join(r.dir, 'progress.json');
  const current = fs.existsSync(progPath) ? readJsonSafe(progPath).value : null;
  const tasksObj = current && current.tasks ? { ...current.tasks } : {};
  const applied = [];
  const unmatched = [];
  for (const line of text.split(/\r?\n/)) {
    const m = MD_LINE.exec(line.trim());
    if (!m) continue;
    const id = m[2];
    const done = m[1].toLowerCase() === 'x';
    if (!ids.has(id)) {
      unmatched.push(id);
      continue;
    }
    const prev = tasksObj[id] && typeof tasksObj[id] === 'object' ? { ...tasksObj[id] } : {};
    if (done) {
      prev.done = true;
      if (!prev.doneAt) prev.doneAt = hkTodayStr();
      if (typeof prev.note !== 'string') prev.note = '';
    } else {
      prev.done = false;
      delete prev.doneAt;
    }
    tasksObj[id] = prev;
    applied.push({ id, done });
  }
  const next = {
    ...(current || {}),
    schema: (current && current.schema) || PROGRESS_SCHEMA,
    project: (current && current.project) || projectId,
    updated: hkNowIso(),
    tasks: tasksObj,
  };
  const w = atomicWriteJson(progPath, next);
  if (!w.ok) return { ok: false, error: w.error };
  return {
    ok: true,
    applied,
    unmatched,
    progress: next,
    undo: { file: 'progress.json', before: current || { schema: PROGRESS_SCHEMA, project: projectId, updated: null, tasks: {} } },
  };
}

/** Parse a Markdown checklist into tasks in a phase. */
/**
 * Import a Markdown checklist into a phase. Only lines matching
 * `- [ ] item` / `- [x] item` become tasks (headings, blanks and prose are
 * skipped). `[x]` items are created already done (progress.json updated too).
 * Returns { ok, created, done, added, plan, progress, undo }.
 */
function importChecklist(root, projectId, phaseId, text) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const lp = loadPlan(r.dir);
  if (!lp.ok) return { ok: false, error: lp.error };
  const plan = lp.plan;
  if (!(plan.phases || []).some((p) => p.id === phaseId)) return { ok: false, error: `no such phase: ${phaseId}` };

  const RX = /^\s*[-*]\s*\[( |x|X)\]\s+(.+)$/;
  const items = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = RX.exec(line);
    if (!m) continue; // headings / blank lines / prose are ignored
    const title = m[2].trim();
    if (title) items.push({ title, done: m[1].toLowerCase() === 'x' });
  }
  if (!items.length) return { ok: false, error: 'no checklist items found' };

  const beforePlan = JSON.parse(JSON.stringify(plan));
  try {
    backupProject(root, projectId);
  } catch (_) {
    /* best-effort */
  }
  if (!Array.isArray(plan.tasks)) plan.tasks = [];
  const added = [];
  const doneIds = [];
  for (const it of items) {
    const t = {
      id: nextTaskIdFor(plan, phaseId),
      phase: phaseId,
      title: it.title,
      deliverable: '',
      deps: [],
      owner: '',
      start: hkTodayStr(),
      estimate_days: 1,
      acceptance: '',
      outputs: [],
    };
    let at = plan.tasks.length;
    for (let i = plan.tasks.length - 1; i >= 0; i--) {
      if (plan.tasks[i].phase === phaseId) {
        at = i + 1;
        break;
      }
    }
    plan.tasks.splice(at, 0, t);
    added.push(t.id);
    if (it.done) doneIds.push(t.id);
  }
  const wp = atomicWriteJson(path.join(r.dir, 'plan.json'), plan);
  if (!wp.ok) return { ok: false, error: wp.error };

  const files = [{ file: 'plan.json', before: beforePlan, after: plan }];
  let progress = null;
  if (doneIds.length) {
    const progPath = path.join(r.dir, 'progress.json');
    const current = fs.existsSync(progPath) ? readJsonSafe(progPath).value : null;
    const tasksObj = current && current.tasks ? { ...current.tasks } : {};
    for (const id of doneIds) {
      const prev = tasksObj[id] && typeof tasksObj[id] === 'object' ? { ...tasksObj[id] } : {};
      prev.done = true;
      if (!prev.doneAt) prev.doneAt = hkTodayStr();
      if (typeof prev.note !== 'string') prev.note = '';
      tasksObj[id] = prev;
    }
    progress = {
      ...(current || {}),
      schema: (current && current.schema) || PROGRESS_SCHEMA,
      project: (current && current.project) || projectId,
      updated: hkNowIso(),
      tasks: tasksObj,
    };
    const wg = atomicWriteJson(progPath, progress);
    if (!wg.ok) return { ok: false, error: wg.error };
    files.push({
      file: 'progress.json',
      before: current || { schema: PROGRESS_SCHEMA, project: projectId, updated: null, tasks: {} },
      after: progress,
    });
  }

  return { ok: true, created: added.length, done: doneIds.length, added, plan, progress, undo: { files } };
}

function planToCsv(root, projectId) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const lp = loadPlan(r.dir);
  if (!lp.ok) return { ok: false, error: lp.error };
  const progPath = path.join(r.dir, 'progress.json');
  const progress = fs.existsSync(progPath) ? readJsonSafe(progPath).value : null;
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  // All tasks in WBS order (phase order, then task order within the phase).
  const byPhase = new Map();
  for (const t of lp.plan.tasks || []) {
    const k = t.phase || '';
    if (!byPhase.has(k)) byPhase.set(k, []);
    byPhase.get(k).push(t);
  }
  const ordered = [];
  const phaseIds = new Set((lp.plan.phases || []).map((ph) => ph.id));
  for (const ph of lp.plan.phases || []) for (const t of byPhase.get(ph.id) || []) ordered.push(t);
  for (const [k, list] of byPhase) if (!phaseIds.has(k)) for (const t of list) ordered.push(t);

  const header = ['ID', '階段', '任務', '負責人', '開始', '天數', '前置任務', '交付物', '完成'];
  const rows = [header];
  for (const t of ordered) {
    rows.push([
      t.id,
      t.phase || '',
      t.title || '',
      t.owner || '',
      t.start || '',
      t.estimate_days != null ? t.estimate_days : 1,
      (t.deps || []).join(';'),
      t.deliverable || '',
      isDone(progress, t.id) ? '是' : '否',
    ]);
  }
  // UTF-8 BOM so Excel on Chinese Windows decodes UTF-8 (not GBK).
  const content = '\uFEFF' + rows.map((r2) => r2.map(esc).join(',')).join('\r\n') + '\r\n';
  return { ok: true, filename: `${projectId}-plan.csv`, content };
}

function planToMarkdown(root, projectId) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const lp = loadPlan(r.dir);
  if (!lp.ok) return { ok: false, error: lp.error };
  const progPath = path.join(r.dir, 'progress.json');
  const progress = fs.existsSync(progPath) ? readJsonSafe(progPath).value : null;
  const lines = [`# ${lp.plan.title || projectId} — WBS`, ''];
  for (const ph of lp.plan.phases || []) {
    lines.push(`## ${ph.id} · ${ph.name || ''}`);
    for (const t of lp.plan.tasks || []) {
      if (t.phase !== ph.id) continue;
      lines.push(`- [${isDone(progress, t.id) ? 'x' : ' '}] ${t.id} ${t.title || ''}${t.owner ? ' — ' + t.owner : ''}`);
    }
    lines.push('');
  }
  return { ok: true, filename: `${projectId}-wbs.md`, content: lines.join('\n') };
}

/* ============================ team sync: multi-root ====================== */
/*
 * A data "root" may be a single path (back-compat) or an array of paths. Each
 * sub-folder containing a plan.json is a project. Extra roots let a project
 * cloned outside the primary root (e.g. ~/ProjectConsole/<name>) still be read
 * and written by the same code paths.
 */

/** Normalise a root (string) or roots (array) into a non-empty array of resolved paths. */
function asRootList(root) {
  const list = Array.isArray(root) ? root : [root];
  const out = [];
  for (const r of list) {
    if (r == null || r === '') continue;
    out.push(path.resolve(String(r)));
  }
  return out;
}

/** Find a project folder across one or more roots (first match wins). */
function findProjectDirIn(roots, projectId) {
  for (const root of roots) {
    const dir = findProjectDir(root, projectId);
    if (dir) return dir;
  }
  return null;
}

const RAG_RANK_SCAN = { red: 3, amber: 2, green: 1, grey: 0 };

/** Scan one or more roots and merge the results (RAG-sorted, ids de-duped). */
function scanRoots(roots) {
  const list = asRootList(roots);
  const projects = [];
  const warnings = [];
  const seen = new Set();
  for (const root of list) {
    let r;
    try {
      r = scanProjects(root);
    } catch (err) {
      warnings.push(`${root}: ${err.message}`);
      continue;
    }
    for (const p of r.projects) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      projects.push(p);
    }
    for (const w of r.warnings) warnings.push(list.length > 1 ? `${path.basename(root)}: ${w}` : w);
  }
  projects.sort((a, b) => {
    const rr = RAG_RANK_SCAN[b.summary.rag] - RAG_RANK_SCAN[a.summary.rag];
    return rr !== 0 ? rr : a.id.localeCompare(b.id);
  });
  return { projects, warnings, roots: list };
}

/* ============================ team sync: binding ========================= */
/*
 * A project may be bound to a git remote via a `.pcproject.json` file at the
 * project folder root:  { "remote": "<git url>", "branch": "main", "projectId": "<id>" }
 * The file is the source of truth for "which repo does this project belong to";
 * the git remote (origin) is kept in sync with it.
 */

const BINDING_FILE = '.pcproject.json';
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function bindingPath(dir) {
  return path.join(dir, BINDING_FILE);
}

/** Validate a binding object; returns { ok, binding } or { ok:false, error }. */
function validateBinding(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'binding must be a JSON object' };
  }
  const remote = typeof obj.remote === 'string' ? obj.remote.trim() : '';
  if (!remote) return { ok: false, error: 'binding.remote must be a non-empty string' };
  if (remote.startsWith('-')) return { ok: false, error: 'binding.remote is invalid' };
  const branch = obj.branch == null ? 'main' : String(obj.branch);
  if (!BRANCH_RE.test(branch)) return { ok: false, error: `binding.branch is invalid: ${branch}` };
  let projectId = null;
  if (obj.projectId != null && obj.projectId !== '') {
    projectId = String(obj.projectId);
    if (!SAFE_ID.test(projectId) || projectId === '.' || projectId === '..') {
      return { ok: false, error: `binding.projectId is invalid: ${projectId}` };
    }
  }
  return { ok: true, binding: { remote, branch, projectId } };
}

/** Read + validate <dir>/.pcproject.json. Absent file => { ok:true, binding:null }. */
function readBindingFile(dir) {
  const p = bindingPath(dir);
  if (!fs.existsSync(p)) return { ok: true, binding: null };
  const res = readJsonSafe(p);
  if (!res.ok) return { ok: false, error: res.error };
  const v = validateBinding(res.value);
  if (!v.ok) return { ok: false, error: v.error };
  return { ok: true, binding: v.binding };
}

/** Read the binding for a project (resolves the folder, confined to the root). */
function readBinding(root, projectId) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const b = readBindingFile(r.dir);
  if (!b.ok) return b;
  return { ok: true, binding: b.binding, dir: r.dir };
}

/** Write <project>/.pcproject.json (atomic, validated, confined to the root). */
function writeBinding(root, projectId, binding) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const merged = { ...(binding || {}) };
  if (merged.projectId == null || merged.projectId === '') merged.projectId = projectId;
  const v = validateBinding(merged);
  if (!v.ok) return { ok: false, error: v.error };
  const w = atomicWriteJson(bindingPath(r.dir), v.binding);
  if (!w.ok) return { ok: false, error: w.error };
  return { ok: true, binding: v.binding, dir: r.dir };
}

/* ============================ team sync: git layer ======================= */
/*
 * All git access goes through spawn (no new npm deps). Every call:
 *   - runs with a hard timeout and is killed if it overruns (never hangs),
 *   - disables interactive prompts (GIT_TERMINAL_PROMPT=0, no askpass),
 *   - operates only on the project folder (or an explicit clone destination).
 */

const GIT_TIMEOUT_MS = 30000;
const GIT_CLONE_TIMEOUT_MS = 120000;

function gitEnv() {
  const env = { ...process.env };
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GCM_INTERACTIVE = 'Never';
  env.GIT_ASKPASS = env.GIT_ASKPASS || '';
  env.SSH_ASKPASS = env.SSH_ASKPASS || '';
  return env;
}

/** Run git with a hard timeout. Never throws; resolves { ok, code, stdout, stderr, timedOut }. */
function runGit(args, cwd, timeoutMs = GIT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, { cwd, env: gitEnv(), windowsHide: true, shell: false });
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
      finish({ ok: false, code: -1, stdout, stderr: stderr || `git ${args[0]} timed out`, timedOut: true });
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

/**
 * Pure: build the argv for a network git op (fetch/pull/push).
 *
 * When a token is supplied AND the remote is a github URL, the token is inlined
 * into a per-command authenticated URL (`https://x-access-token:<token>@…`) so
 * it is NEVER written into `.git/config` (the stored remote stays clean). When
 * there is no token, or the remote is not github, the normal remote is used.
 *
 * kind: 'fetch' | 'pull' | 'push'
 * ctx:  { remote, token, branch, hasUpstream }
 * Returns { args: string[], authed: boolean }.
 */
function resolveGitNetwork(kind, ctx = {}) {
  const remote = ctx.remote || null;
  const branch = ctx.branch || 'main';
  const hasUpstream = !!ctx.hasUpstream;
  const url = ctx.token ? github.authedRemoteUrl(remote, ctx.token) : null;

  if (kind === 'fetch') {
    if (url) return { args: ['fetch', url, `+refs/heads/${branch}:refs/remotes/origin/${branch}`], authed: true };
    return { args: ['fetch', 'origin', branch], authed: false };
  }
  if (kind === 'pull') {
    if (url) return { args: ['pull', '--rebase', '--autostash', url, branch], authed: true };
    return { args: ['pull', '--rebase', '--autostash'], authed: false };
  }
  if (kind === 'push') {
    // Never use `-u` with an authed URL (that would persist the token).
    if (url) return { args: ['push', url, `${branch}:${branch}`], authed: true };
    return { args: hasUpstream ? ['push'] : ['push', '-u', 'origin', branch], authed: false };
  }
  return { args: [], authed: false };
}

/** Friendly network error (never surfaces raw git stderr to the user). */
function friendlyNetworkError(kind, res) {
  const stderr = String((res && res.stderr) || '');
  if (res && res.timedOut) return `git ${kind} timed out`;
  if (/could not resolve host|network|unable to access|connection|offline|proxy/i.test(stderr)) {
    return '連唔到 remote（offline / 網絡問題）— 檢查網絡後再試。';
  }
  if (/authentication|401|403|forbidden|invalid username|password|terminal prompts disabled|permission denied/i.test(stderr)) {
    return '認證失敗 — 請喺 app 內『連接 GitHub』貼一個有效 token，或者用 gh 登入。';
  }
  if (/rejected|non-fast-forward|fetch first|failed to push/i.test(stderr)) {
    return 'push 被拒（remote 有新 commit）— 先 Sync / pull 再 push。';
  }
  const first = stderr.trim().split('\n').find((l) => l.trim()) || `git ${kind} failed`;
  return first.slice(0, 300);
}

/**
 * Full status of a project's git working tree.
 * Returns { ok, isRepo, remote, branch, ahead, behind, dirty, lastCommit, bound, hasUpstream, binding }.
 */
async function gitStatus(root, projectId) {
  const base = {
    ok: true,
    isRepo: false,
    remote: null,
    branch: null,
    ahead: 0,
    behind: 0,
    dirty: false,
    lastCommit: null,
    bound: false,
    hasUpstream: false,
    binding: null,
  };
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ...base, ok: false, error: r.error };
  const dir = r.dir;

  const bindRes = readBindingFile(dir);
  const binding = bindRes.ok ? bindRes.binding : null;

  // A project is a git repo only if its OWN folder holds a `.git` (a dir, or a
  // gitdir pointer file for worktrees). We deliberately do NOT use
  // `rev-parse --is-inside-work-tree`: it walks up to any ancestor repo (e.g. a
  // stray repo at a drive root, or the vault repo) and would misreport, then run
  // git over a huge unrelated tree.
  if (!fs.existsSync(path.join(dir, '.git'))) {
    return {
      ...base,
      isRepo: false,
      bound: !!(binding && binding.remote),
      remote: binding ? binding.remote : null,
      branch: binding ? binding.branch : null,
      binding,
      bindingError: bindRes.ok ? undefined : bindRes.error,
    };
  }

  const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  const branch = branchRes.ok ? branchRes.stdout.trim() : binding ? binding.branch : null;

  const remoteRes = await runGit(['remote', 'get-url', 'origin'], dir);
  const remote = remoteRes.ok && remoteRes.stdout.trim() ? remoteRes.stdout.trim() : binding ? binding.remote : null;

  const st = await runGit(['status', '--porcelain'], dir);
  const dirty = st.ok && st.stdout.trim().length > 0;

  let ahead = 0;
  let behind = 0;
  let hasUpstream = false;
  const up = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], dir);
  if (up.ok && up.stdout.trim()) {
    hasUpstream = true;
    const cnt = await runGit(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], dir);
    if (cnt.ok) {
      const parts = cnt.stdout.trim().split(/\s+/);
      behind = Number(parts[0]) || 0;
      ahead = Number(parts[1]) || 0;
    }
  }

  const logRes = await runGit(['log', '-1', '--format=%h%x1f%an%x1f%aI%x1f%s'], dir);
  let lastCommit = null;
  if (logRes.ok && logRes.stdout.trim()) {
    const parts = logRes.stdout.trim().split('\x1f');
    lastCommit = { hash: parts[0] || '', author: parts[1] || '', date: parts[2] || '', message: parts.slice(3).join('\x1f') };
  }

  return {
    ok: true,
    isRepo: true,
    bound: !!(binding || remote),
    remote,
    branch,
    ahead,
    behind,
    dirty,
    lastCommit,
    hasUpstream,
    binding,
  };
}

/** git pull (per-command authed URL when a token is supplied; else plain pull). */
async function gitPull(root, projectId, opts) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const st = await gitStatus(root, projectId);
  if (!st.isRepo) return { ok: false, error: 'not a git repository' };
  if (!st.remote) return { ok: false, error: 'no git remote configured (bind a repo first)' };
  const branch = st.branch || (st.binding && st.binding.branch) || 'main';
  const net = resolveGitNetwork('pull', { remote: st.remote, token: opts && opts.token, branch, hasUpstream: st.hasUpstream });
  if (!net.authed && !st.hasUpstream) return { ok: false, error: 'current branch has no upstream (push once first)' };
  const run = typeof (opts && opts.runGit) === 'function' ? opts.runGit : runGit;
  const res = await run(net.args, r.dir, GIT_TIMEOUT_MS);
  return {
    ok: res.ok,
    stdout: res.stdout.trim(),
    stderr: res.stderr.trim(),
    timedOut: res.timedOut,
    error: res.ok ? undefined : friendlyNetworkError('pull', res),
  };
}

/** Stage everything and commit. Returns { ok, committed, message } (no-op if clean). */
async function gitCommit(root, projectId, message, opts) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const msg = String(message == null ? '' : message).trim();
  if (!msg) return { ok: false, error: 'commit message required' };
  const st = await gitStatus(root, projectId);
  if (!st.isRepo) return { ok: false, error: 'not a git repository' };
  if (!st.dirty) return { ok: true, committed: false, message: msg };
  // Resolve (and persist) a git identity so the commit never hard-fails.
  const id = await ensureGitIdentity(r.dir, opts || {});
  const add = await runGit(['add', '-A'], r.dir, GIT_TIMEOUT_MS);
  if (!add.ok) return { ok: false, error: add.stderr.trim() || 'git add failed', identity: idInfo(id) };
  const args = [...identityArgs(id), 'commit', '-m', msg];
  if (opts && opts.author) args.push(`--author=${opts.author}`);
  const res = await runGit(args, r.dir, GIT_TIMEOUT_MS);
  return {
    ok: res.ok,
    committed: res.ok,
    message: msg,
    identity: idInfo(id),
    needIdentitySetup: !!id.needSetup,
    warning: id.needSetup ? id.warning : undefined,
    stdout: res.stdout.trim(),
    timedOut: res.timedOut,
    error: res.ok ? undefined : res.timedOut ? 'git commit timed out' : friendlyGitError(res.stderr),
  };
}

function idInfo(id) {
  return { name: id.name, email: id.email, source: id.source };
}

/** Turn common git commit failures into a friendly message with the next step. */
function friendlyGitError(stderr) {
  const s = String(stderr || '');
  if (/author identity unknown|please tell me who you are|unable to auto-detect email|empty ident name/i.test(s)) {
    return '未能設定 git 身份（commit 需要 user.name / user.email）。喺 app「設定 git 身份」輸入你嘅名同 email 即可。';
  }
  return s.trim() || 'git commit failed';
}

/** git push (per-command authed URL when a token is supplied; else normal remote). */
async function gitPush(root, projectId, opts) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const st = await gitStatus(root, projectId);
  if (!st.isRepo) return { ok: false, error: 'not a git repository' };
  if (!st.remote) return { ok: false, error: 'no git remote configured (bind a repo first)' };
  const branch = st.branch || (st.binding && st.binding.branch) || 'main';
  const net = resolveGitNetwork('push', { remote: st.remote, token: opts && opts.token, branch, hasUpstream: st.hasUpstream });
  const run = typeof (opts && opts.runGit) === 'function' ? opts.runGit : runGit;
  const res = await run(net.args, r.dir, GIT_TIMEOUT_MS);
  if (res.ok && net.authed) {
    // Track the CLEAN origin (never the tokened URL) so the token is not persisted.
    await runGit(['config', `branch.${branch}.remote`, 'origin'], r.dir);
    await runGit(['config', `branch.${branch}.merge`, `refs/heads/${branch}`], r.dir);
  }
  return {
    ok: res.ok,
    stdout: res.stdout.trim(),
    stderr: res.stderr.trim(),
    timedOut: res.timedOut,
    error: res.ok ? undefined : friendlyNetworkError('push', res),
  };
}

/** git init in a project folder + an initial commit (best effort). */
async function gitInit(root, projectId, opts) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const st = await gitStatus(root, projectId);
  if (st.isRepo) return { ok: true, alreadyRepo: true };
  const branch = (opts && opts.branch) || 'main';
  let init = await runGit(['init', '-b', branch], r.dir);
  if (!init.ok) init = await runGit(['init'], r.dir); // older git has no `-b`
  if (!init.ok) return { ok: false, error: init.stderr.trim() || 'git init failed' };
  const gi = path.join(r.dir, '.gitignore');
  if (!fs.existsSync(gi)) {
    try {
      fs.writeFileSync(gi, '.backups/\n*.tmp\n', 'utf8');
    } catch (_) {
      /* ignore */
    }
  }
  await runGit(['add', '-A'], r.dir, GIT_TIMEOUT_MS);
  const id = await ensureGitIdentity(r.dir, opts || {});
  const c = await runGit([...identityArgs(id), 'commit', '-m', 'chore: init project repo'], r.dir, GIT_TIMEOUT_MS);
  return {
    ok: true,
    initialized: true,
    committed: c.ok,
    identity: idInfo(id),
    needIdentitySetup: !!id.needSetup,
    warning: c.ok ? (id.needSetup ? id.warning : undefined) : friendlyGitError(c.stderr),
  };
}

/** Effective git identity for a project (read-only). */
async function gitIdentityInfo(root, projectId) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const id = await ensureGitIdentity(r.dir, { useGh: false, persist: false });
  return { ok: true, name: id.name, email: id.email, source: id.source, needSetup: !!id.needSetup };
}

/** Persist a repo-local git identity (name + email). Never touches global config. */
async function setGitIdentity(root, projectId, name, email) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const n = String(name == null ? '' : name).trim();
  const e = String(email == null ? '' : email).trim();
  if (!n) return { ok: false, error: '請輸入名（name）' };
  if (!e || !/^[^\s@]+@[^\s@]+$/.test(e)) return { ok: false, error: '請輸入有效嘅 email' };
  const st = await gitStatus(root, projectId);
  if (!st.isRepo) return { ok: false, error: '呢個專案未係 git repo（先 bind / 發佈）' };
  const a = await runGit(['config', 'user.name', n], r.dir);
  const b = await runGit(['config', 'user.email', e], r.dir);
  if (!a.ok || !b.ok) return { ok: false, error: (a.stderr || b.stderr || '').trim() || 'write failed' };
  return { ok: true, name: n, email: e };
}

/** Validate a clone URL: https / ssh / git / file scheme, or a local path. */
function validateCloneUrl(url) {
  const s = String(url == null ? '' : url).trim();
  if (!s) return { error: 'url required' };
  if (s.startsWith('-')) return { error: 'invalid url' };
  const okScheme =
    /^(https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)/i.test(s) ||
    /^[A-Za-z]:[\\/]/.test(s) ||
    s.startsWith('/') ||
    s.startsWith('./') ||
    s.startsWith('../') ||
    s.startsWith('\\\\');
  if (!okScheme) return { error: 'unsupported url (use https / ssh / a local path)' };
  return { url: s };
}

/** Clone a repo into destDir (must be empty/absent). Never prompts; hard timeout. */
async function gitClone(url, destDir, opts) {
  const v = validateCloneUrl(url);
  if (v.error) return { ok: false, error: v.error };
  if (!destDir || typeof destDir !== 'string') return { ok: false, error: 'destDir required' };
  const dest = path.resolve(destDir);
  if (dest === path.parse(dest).root) return { ok: false, error: 'refusing to clone into a filesystem root' };
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
    return { ok: false, error: `destination is not empty: ${dest}` };
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
  } catch (err) {
    return { ok: false, error: `cannot create parent dir: ${err.message}` };
  }
  // Clone with a per-command authenticated URL when a token is supplied, then
  // rewrite origin back to the CLEAN url so the token is never persisted.
  const authed = opts && opts.token ? github.authedRemoteUrl(v.url, opts.token) : null;
  const cloneUrl = authed || v.url;
  const res = await runGit(['clone', '--', cloneUrl, dest], path.dirname(dest), GIT_CLONE_TIMEOUT_MS);
  if (!res.ok) {
    return {
      ok: false,
      timedOut: res.timedOut,
      error: res.timedOut ? 'git clone timed out' : friendlyNetworkError('clone', res),
    };
  }
  if (authed) {
    try {
      await runGit(['remote', 'set-url', 'origin', v.url], dest);
    } catch (_) {
      /* best effort — the clone still succeeded */
    }
  }
  let projectId = path.basename(dest);
  const planRes = readJsonSafe(path.join(dest, 'plan.json'));
  if (planRes.ok && planRes.value && planRes.value.id) projectId = planRes.value.id;
  return { ok: true, dir: dest, projectId, name: path.basename(dest) };
}

/** Ensure a project repo is initialised, set `origin`, and write the binding. */
async function gitBind(root, projectId, remote, opts) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const url = String(remote == null ? '' : remote).trim();
  if (!url || url.startsWith('-')) return { ok: false, error: 'remote url required' };
  const branch = (opts && opts.branch) || 'main';
  const st0 = await gitStatus(root, projectId);
  if (!st0.isRepo) {
    const ini = await gitInit(root, projectId, {
      branch,
      account: opts && opts.account,
      ghUser: opts && opts.ghUser,
      useGh: opts && opts.useGh,
    });
    if (!ini.ok) return ini;
  }
  const has = await runGit(['remote', 'get-url', 'origin'], r.dir);
  const setRes = has.ok
    ? await runGit(['remote', 'set-url', 'origin', url], r.dir)
    : await runGit(['remote', 'add', 'origin', url], r.dir);
  if (!setRes.ok) return { ok: false, error: setRes.stderr.trim() || 'git remote failed' };
  // Resolve a repo-local identity now so the first commit never hard-fails.
  await ensureGitIdentity(r.dir, {
    account: opts && opts.account,
    ghUser: opts && opts.ghUser,
    useGh: opts && opts.useGh,
  });
  const wb = writeBinding(root, projectId, { remote: url, branch, projectId });
  if (!wb.ok) return wb;
  return { ok: true, remote: url, branch, binding: wb.binding };
}

/* ---- commit message derivation (pure + integration) --------------------- */

function taskOwnerOf(plan, id) {
  const t = ((plan && plan.tasks) || []).find((x) => x.id === id);
  return t ? t.owner || '' : '';
}

function tasksEqual(a, b) {
  const fields = ['phase', 'title', 'deliverable', 'owner', 'start', 'estimate_days', 'acceptance'];
  for (const f of fields) {
    if (JSON.stringify(a[f] == null ? null : a[f]) !== JSON.stringify(b[f] == null ? null : b[f])) return false;
  }
  if (JSON.stringify(a.deps || []) !== JSON.stringify(b.deps || [])) return false;
  if (JSON.stringify(a.outputs || []) !== JSON.stringify(b.outputs || [])) return false;
  return true;
}

/**
 * Pure: derive a human commit message from before/after plan+progress.
 * Examples: "tick: T3.1 done by Jack", "plan: edit T2.3", "plan: +T5.3".
 */
function commitMessageFromDiff(planBefore, progressBefore, planAfter, progressAfter) {
  const parts = [];
  const pb = (progressBefore && progressBefore.tasks) || {};
  const pa = (progressAfter && progressAfter.tasks) || {};
  const ids = [...new Set([...Object.keys(pb), ...Object.keys(pa)])].sort();
  for (const id of ids) {
    const was = !!(pb[id] && pb[id].done);
    const now = !!(pa[id] && pa[id].done);
    if (!was && now) {
      const owner = taskOwnerOf(planAfter, id) || taskOwnerOf(planBefore, id);
      parts.push(`tick: ${id} done${owner ? ' by ' + owner : ''}`);
    } else if (was && !now) {
      const owner = taskOwnerOf(planAfter, id) || taskOwnerOf(planBefore, id);
      parts.push(`untick: ${id}${owner ? ' by ' + owner : ''}`);
    }
  }
  const tb = new Map(((planBefore && planBefore.tasks) || []).map((t) => [t.id, t]));
  const ta = new Map(((planAfter && planAfter.tasks) || []).map((t) => [t.id, t]));
  for (const id of ta.keys()) if (!tb.has(id)) parts.push(`plan: +${id}`);
  for (const id of tb.keys()) if (!ta.has(id)) parts.push(`plan: -${id}`);
  for (const [id, t] of ta) {
    const b = tb.get(id);
    if (b && !tasksEqual(b, t)) parts.push(`plan: edit ${id}`);
  }
  // phases
  const phb = new Set(((planBefore && planBefore.phases) || []).map((p) => p.id));
  const phAfter = new Set(((planAfter && planAfter.phases) || []).map((p) => p.id));
  for (const id of phAfter) if (!phb.has(id)) parts.push(`plan: +phase ${id}`);
  for (const id of phb) if (!phAfter.has(id)) parts.push(`plan: -phase ${id}`);
  // milestones
  const mb = new Map(((planBefore && planBefore.milestones) || []).map((m) => [m.id, m]));
  const ma = new Map(((planAfter && planAfter.milestones) || []).map((m) => [m.id, m]));
  for (const id of ma.keys()) if (!mb.has(id)) parts.push(`plan: +milestone ${id}`);
  for (const id of mb.keys()) if (!ma.has(id)) parts.push(`plan: -milestone ${id}`);

  if (!parts.length) return 'sync';
  const uniq = [...new Set(parts)];
  return uniq.slice(0, 6).join('; ');
}

/** Integration: read HEAD:plan/progress via git and diff against the working tree. */
async function deriveCommitMessage(root, projectId) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return 'sync';
  const readWorking = (f) => {
    const res = readJsonSafe(path.join(r.dir, f));
    return res.ok ? res.value : null;
  };
  const readHead = async (f) => {
    const res = await runGit(['show', `HEAD:${f}`], r.dir);
    if (!res.ok || !res.stdout.trim()) return null;
    try {
      return JSON.parse(res.stdout);
    } catch (_) {
      return null;
    }
  };
  const planAfter = readWorking('plan.json');
  const progAfter = readWorking('progress.json');
  const planBefore = await readHead('plan.json');
  const progBefore = await readHead('progress.json');
  return commitMessageFromDiff(planBefore, progBefore, planAfter, progAfter);
}

/** One-click Sync: pull --rebase --autostash → auto-commit → push. */
async function gitSync(root, projectId, opts) {
  const r = projectDirOrError(root, projectId);
  if (r.error) return { ok: false, error: r.error };
  const st0 = await gitStatus(root, projectId);
  if (!st0.isRepo) return { ok: false, phase: 'status', error: 'not a git repository (bind or init first)' };
  const steps = [];
  let pulled = false;
  let committed = false;
  let pushed = false;
  let message = null;

  if (st0.remote && (st0.hasUpstream || (opts && opts.token && github.parseGitHubRemote(st0.remote)))) {
    const pr = await gitPull(root, projectId, { token: opts && opts.token });
    steps.push({ step: 'pull', ok: pr.ok, detail: pr.error || pr.stdout });
    if (!pr.ok) return { ok: false, phase: 'pull', error: pr.error, steps };
    pulled = true;
  }

  const st1 = await gitStatus(root, projectId);
  if (st1.dirty) {
    message = (opts && opts.message) || (await deriveCommitMessage(root, projectId));
    const cr = await gitCommit(root, projectId, message, { author: opts && opts.author, account: opts && opts.account, useGh: opts && opts.useGh });
    steps.push({ step: 'commit', ok: cr.ok, detail: cr.error || message });
    if (!cr.ok) return { ok: false, phase: 'commit', error: cr.error, message, steps };
    committed = true;
  }

  if (st1.remote) {
    const pr = await gitPush(root, projectId, { token: opts && opts.token });
    steps.push({ step: 'push', ok: pr.ok, detail: pr.error || pr.stdout });
    if (!pr.ok) return { ok: false, phase: 'push', error: pr.error, message, steps };
    pushed = true;
  }

  const status = await gitStatus(root, projectId);
  return { ok: true, message, committed, pulled, pushed, steps, status };
}

module.exports = {
  DEFAULT_ROOT,
  PLAN_SCHEMA,
  PROGRESS_SCHEMA,
  BASELINE_SCHEMA,
  readJsonSafe,
  toDate,
  addDaysStr,
  hkTodayStr,
  hkNowIso,
  plannedEndStr,
  plannedEndExclusiveStr,
  isDone,
  enrichTasks,
  deriveSummary,
  findDanglingRefs,
  normalizeProject,
  scanProjects,
  setTaskDone,
  // write engine
  atomicWriteJson,
  projectDirOrError,
  detectCycle,
  computeSchedule,
  computeCriticalPath,
  addTask,
  updateTask,
  deleteTask,
  moveTask,
  addPhase,
  updatePhase,
  deletePhase,
  upsertMilestone,
  deleteMilestone,
  setTaskDeps,
  reschedule,
  freezeBaseline,
  getBaseline,
  restoreFile,
  // pass 2
  atomicWriteText,
  backupProject,
  listBackups,
  restoreBackup,
  syncTasksMd,
  readTasksMd,
  importChecklist,
  planToCsv,
  planToMarkdown,
  restoreFileRaw,
  // team sync: multi-root
  asRootList,
  findProjectDirIn,
  scanRoots,
  // team sync: binding (.pcproject.json)
  BINDING_FILE,
  bindingPath,
  validateBinding,
  readBindingFile,
  readBinding,
  writeBinding,
  // team sync: git layer
  runGit,
  resolveGitNetwork,
  friendlyNetworkError,
  friendlyGitError,
  gitStatus,
  gitPull,
  gitCommit,
  gitPush,
  gitInit,
  gitIdentityInfo,
  setGitIdentity,
  ensureGitIdentity,
  identityArgs,
  gitBind,
  gitClone,
  gitSync,
  validateCloneUrl,
  deriveCommitMessage,
  commitMessageFromDiff,
};
