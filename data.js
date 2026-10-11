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

const DEFAULT_ROOT = 'C:\\Users\\jackt\\.claude\\wiki\\projects\\';
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

  const rootResolved = path.resolve(root);
  const dir = findProjectDir(rootResolved, projectId);
  if (!dir) {
    return { ok: false, error: `project folder not found: ${projectId}` };
  }
  if (dir !== rootResolved && !dir.startsWith(rootResolved + path.sep)) {
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

/** Resolve a project folder, validating the id and staying inside the root. */
function projectDirOrError(root, projectId) {
  if (!SAFE_ID.test(String(projectId || '')) || projectId === '.' || projectId === '..') {
    return { error: `invalid projectId: ${projectId}` };
  }
  const rootResolved = path.resolve(root);
  const dir = findProjectDir(rootResolved, projectId);
  if (!dir) return { error: `project folder not found: ${projectId}` };
  if (!dir.startsWith(rootResolved + path.sep)) return { error: 'path escapes data root' };
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
};
