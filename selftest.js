'use strict';

/* ==========================================================================
   selftest.js — headless data-layer test (human-only model, no Electron).
   Asserts the plan@2 / progress@1 contract, the _demo fixture values,
   graceful degradation, and a round-trip tick on a TEMP copy (the real
   _demo/progress.json is never mutated). Exit 0 = PASS, 1 = FAIL.
   ========================================================================== */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  scanProjects,
  scanRoots,
  setTaskDone,
  readJsonSafe,
  enrichTasks,
  deriveSummary,
  DEFAULT_ROOT,
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
  computeCriticalPath,
  backupProject,
  listBackups,
  restoreBackup,
  syncTasksMd,
  readTasksMd,
  importChecklist,
  planToCsv,
  planToMarkdown,
  // team sync
  validateBinding,
  readBinding,
  readBindingFile,
  writeBinding,
  runGit,
  gitStatus,
  gitPull,
  gitCommit,
  gitPush,
  gitInit,
  gitBind,
  gitClone,
  gitSync,
  deriveCommitMessage,
  commitMessageFromDiff,
} = require('./data');
const gx = require('./gitx');

const ROOT = process.env.PROJECT_CONSOLE_ROOT || DEFAULT_ROOT;

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    passed++;
    process.stdout.write(`  ok   ${label}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL ${label}${detail ? ' — ' + detail : ''}\n`);
  }
}

console.log('Project Console — selftest (human-only model)');
console.log('root: ' + ROOT);
console.log('');

/* -- 1. scan -------------------------------------------------------------- */

let scan;
let threw = false;
try {
  scan = scanProjects(ROOT);
} catch (err) {
  threw = true;
  console.log('scanProjects threw: ' + err.message);
}
check('scanProjects does not throw', !threw);
check('scan returns an array', Array.isArray(scan.projects));

console.log('');
console.log('Projects found: ' + scan.projects.length);
for (const p of scan.projects) {
  const s = p.summary;
  console.log(
    `  [${s.rag}] ${p.id} — "${p.title}" · ${s.tasksDone}/${s.tasksTotal} (${s.percent}%) · ` +
      `owners=${s.owners.join(',')} · progress=${p.progress ? 'yes' : 'none'}`
  );
}
if (scan.warnings.length) {
  console.log('Warnings:');
  for (const w of scan.warnings) console.log('  · ' + w);
}

/* -- 2. plan@2 / progress@1 contract -------------------------------------- */

console.log('');
console.log('Contract (plan@2 / progress@1):');
const demo = scan.projects.find((p) => p.id === '_demo');
check('_demo discovered', !!demo);
check('_demo plan schema = plan@2', demo && demo.schema === 'omo-project/plan@2', demo && demo.schema);

if (demo) {
  const s = demo.summary;
  check('_demo tasks = 8', demo.tasks.length === 8, String(demo.tasks.length));
  check('_demo phases = 4', demo.phases.length === 4, String(demo.phases.length));
  check('_demo milestones = 3', demo.milestones.length === 3, String(demo.milestones.length));
  check('_demo risks = 2', demo.risks.length === 2, String(demo.risks.length));
  check('_demo progress parsed', !!demo.progress);
  check('_demo progress schema = progress@1', demo.progress && demo.progress.schema === 'omo-project/progress@1');
  check('_demo total = 8', s.tasksTotal === 8, String(s.tasksTotal));
  // Don't hardcode tick counts (they drift as the project is used); assert the
  // summary is consistent with the progress file it is derived from.
  const doneFromFile = demo.tasks.filter((t) => t.done).length;
  check('_demo done matches progress file', s.tasksDone === doneFromFile, `${s.tasksDone} vs ${doneFromFile}`);
  check(
    '_demo percent consistent (round(done/8*100))',
    s.percent === Math.round((doneFromFile / 8) * 100),
    String(s.percent)
  );
  check('_demo owners include Jack', s.owners.includes('Jack'));
  check('_demo owners include Dorian', s.owners.includes('Dorian'));
  check('_demo rag is a live colour', ['green', 'amber', 'red'].includes(s.rag), s.rag);

  const badTask = demo.tasks.find(
    (t) => typeof t.owner !== 'string' || !t.start || !Number.isFinite(t.estimate_days) || !t.deliverable
  );
  check('every task has owner/start/estimate_days/deliverable', !badTask, badTask && JSON.stringify(badTask));
  check('no dangling deps/after refs', demo.danglingRefs.length === 0, demo.danglingRefs.join('; '));

  // Human-only: no agent/session/token/assignee artefacts anywhere.
  const hasForbidden = demo.tasks.some(
    (t) =>
      'assignee' in t ||
      'category' in t ||
      'ses_id' in t ||
      'verified' in t ||
      'tokens_used' in t
  );
  check('no assignee/session/token fields on tasks', !hasForbidden);
  check('no state.json handling (project has no `state`)', !('state' in demo));
  check('no state.json file in _demo', !fs.existsSync(path.join(demo.folder, 'state.json')));
}

/* -- 3. source scan: dead state.json / agent tokens must be gone ---------- */

console.log('');
console.log('Source hygiene:');
const FORBIDDEN = ['state.json', 'ses_id', 'bg_id', 'subagent', 'assignee', 'tokens_used', 'verified'];
const sources = ['main.js', 'data.js', 'preload.js', path.join('renderer', 'renderer.js')];
for (const rel of sources) {
  const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
  const hits = FORBIDDEN.filter((t) => src.includes(t));
  check(`${rel} free of forbidden tokens`, hits.length === 0, hits.join(', '));
}

/* -- 4. graceful degradation --------------------------------------------- */

console.log('');
console.log('Graceful degradation:');
if (demo) {
  const planOnly = {
    id: 'x',
    title: 'x',
    created: '2026-01-01',
    target: '2026-01-10',
    tasks: demo.tasks.map((t) => ({
      id: t.id,
      phase: t.phase,
      title: t.title,
      deliverable: t.deliverable,
      deps: t.deps,
      owner: t.owner,
      start: t.start,
      estimate_days: t.estimate_days,
      outputs: t.outputs,
    })),
    phases: demo.phases,
    milestones: [],
  };
  const noProg = deriveSummary(planOnly, null, enrichTasks(planOnly, null));
  check('missing progress -> rag grey', noProg.rag === 'grey', noProg.rag);
  check('missing progress -> done 0', noProg.tasksDone === 0, String(noProg.tasksDone));
  check('missing progress -> total from plan', noProg.tasksTotal === 8, String(noProg.tasksTotal));
}

// Malformed progress.json must be tolerated (project kept, progress nulled).
const tmpRootEarly = fs.mkdtempSync(path.join(__dirname, '.selftest-'));
try {
  const d = path.join(tmpRootEarly, 'p1');
  fs.mkdirSync(d);
  fs.writeFileSync(
    path.join(d, 'plan.json'),
    JSON.stringify({ id: 'p1', title: 'P1', created: '2026-01-01', target: '2026-01-02', tasks: [], phases: [], milestones: [] }),
    'utf8'
  );
  fs.writeFileSync(path.join(d, 'progress.json'), '{ broken json ', 'utf8');
  const r = scanProjects(tmpRootEarly);
  check('malformed progress tolerated (project kept)', r.projects.length === 1, 'got ' + r.projects.length);
  check('malformed progress -> progress null', r.projects[0] && r.projects[0].progress === null);
  check('malformed progress -> warned', r.warnings.some((w) => w.includes('progress')), r.warnings.join('; '));
} finally {
  fs.rmSync(tmpRootEarly, { recursive: true, force: true });
}

/* -- 5. round-trip tick on a TEMP copy ------------------------------------ */

console.log('');
console.log('Round-trip tick (temp copy):');

const realDir = path.join(ROOT, '_demo');
const realProgressPath = path.join(realDir, 'progress.json');
const realPlanPath = path.join(realDir, 'plan.json');
const realProgressBefore = fs.existsSync(realProgressPath) ? fs.readFileSync(realProgressPath, 'utf8') : null;
const realPlanBefore = fs.existsSync(realPlanPath) ? fs.readFileSync(realPlanPath, 'utf8') : null;

const tmpRoot = fs.mkdtempSync(path.join(__dirname, '.selftest-'));
const tmpProjectDir = path.join(tmpRoot, '_demo');
try {
  fs.mkdirSync(tmpProjectDir);
  fs.copyFileSync(realPlanPath, path.join(tmpProjectDir, 'plan.json'));
  fs.copyFileSync(realProgressPath, path.join(tmpProjectDir, 'progress.json'));
  const tmpPlanBefore = fs.readFileSync(path.join(tmpProjectDir, 'plan.json'), 'utf8');
  const tmpProgressPath = path.join(tmpProjectDir, 'progress.json');
  const beforeObj = JSON.parse(fs.readFileSync(tmpProgressPath, 'utf8'));
  const beforeDone = Object.values(beforeObj.tasks).filter((t) => t && t.done === true).length;

  // Tick T3.1 done.
  const r1 = setTaskDone(tmpRoot, '_demo', 'T3.1', true);
  check('setTaskDone(T3.1, true) ok', r1.ok, r1.error);
  const after1 = readJsonSafe(tmpProgressPath);
  check('written file parses', after1.ok, after1.ok ? '' : after1.error);
  const p1 = after1.value || {};
  check('schema preserved', p1.schema === 'omo-project/progress@1', p1.schema);
  check('project preserved', p1.project === '_demo', p1.project);
  check('T3.1.done = true', p1.tasks && p1.tasks['T3.1'] && p1.tasks['T3.1'].done === true);
  check('T3.1.doneAt set', !!(p1.tasks && p1.tasks['T3.1'] && p1.tasks['T3.1'].doneAt));
  check('updated changed to now', p1.updated && p1.updated !== '2026-10-12T18:00:00+08:00', p1.updated);
  check('all 8 task entries preserved', p1.tasks && Object.keys(p1.tasks).length === 8, p1.tasks && String(Object.keys(p1.tasks).length));
  check('untouched T1.1 preserved exactly', JSON.stringify(p1.tasks['T1.1']) === JSON.stringify(beforeObj.tasks['T1.1']));
  check('untouched T2.1 preserved exactly', JSON.stringify(p1.tasks['T2.1']) === JSON.stringify(beforeObj.tasks['T2.1']));
  check('untouched T2.2 preserved exactly', JSON.stringify(p1.tasks['T2.2']) === JSON.stringify(beforeObj.tasks['T2.2']));

  // Independent check: re-scan the temp root and confirm the summary advanced.
  const tmpScan = scanProjects(tmpRoot);
  const expectDone = beforeDone + (beforeObj.tasks['T3.1'] && beforeObj.tasks['T3.1'].done ? 0 : 1);
  check(
    'temp summary reflects the tick',
    tmpScan.projects[0] && tmpScan.projects[0].summary.tasksDone === expectDone,
    tmpScan.projects[0] ? `${tmpScan.projects[0].summary.tasksDone} vs ${expectDone}` : 'no project'
  );

  // Untick T1.1 -> done false, doneAt cleared, note kept.
  const r2 = setTaskDone(tmpRoot, '_demo', 'T1.1', false);
  check('setTaskDone(T1.1, false) ok', r2.ok, r2.error);
  const p2 = readJsonSafe(tmpProgressPath).value || {};
  check('T1.1.done = false', p2.tasks['T1.1'] && p2.tasks['T1.1'].done === false);
  check('T1.1.doneAt cleared', p2.tasks['T1.1'] && !('doneAt' in p2.tasks['T1.1']));
  check('T1.1.note preserved on untick', p2.tasks['T1.1'] && p2.tasks['T1.1'].note === (beforeObj.tasks['T1.1'].note || ''));
  check('T3.1 still done after later write', p2.tasks['T3.1'] && p2.tasks['T3.1'].done === true);

  // plan.json must be untouched by the writes.
  const tmpPlanAfter = fs.readFileSync(path.join(tmpProjectDir, 'plan.json'), 'utf8');
  check('plan.json untouched by writes', tmpPlanBefore === tmpPlanAfter);

  // No temp files left behind.
  const leftovers = fs.readdirSync(tmpProjectDir).filter((f) => f.includes('.tmp'));
  check('no temp files left behind', leftovers.length === 0, leftovers.join(', '));

  // Unsafe ids rejected.
  check('reject projectId ".."', setTaskDone(tmpRoot, '..', 'T1.1', true).ok === false);
  check('reject taskId traversal', setTaskDone(tmpRoot, '_demo', '../x', true).ok === false);
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

// The real fixture must be byte-identical after all of the above.
if (realProgressBefore !== null) {
  const realProgressAfter = fs.readFileSync(realProgressPath, 'utf8');
  check('real _demo/progress.json NOT mutated', realProgressBefore === realProgressAfter);
}
if (realPlanBefore !== null) {
  const realPlanAfter = fs.readFileSync(realPlanPath, 'utf8');
  check('real _demo/plan.json NOT mutated', realPlanBefore === realPlanAfter);
}

/* -- 7. write engine round-trips (temp copies) --------------------------- */

console.log('');
console.log('Write engine round-trips:');
const REAL_DEMO = path.join(ROOT, '_demo');
const tempRoots = [];
function freshCopy() {
  const root = fs.mkdtempSync(path.join(__dirname, '.selftest-'));
  tempRoots.push(root);
  const dst = path.join(root, '_demo');
  fs.mkdirSync(dst);
  for (const f of ['plan.json', 'progress.json']) {
    fs.copyFileSync(path.join(REAL_DEMO, f), path.join(dst, f));
  }
  return root;
}
const readPlan = (root) => readJsonSafe(path.join(root, '_demo', 'plan.json')).value;

try {
  {
    const root = freshCopy();
    const r1 = addTask(root, '_demo', 'P1', { title: 'New A' });
    const r2 = addTask(root, '_demo', 'P1', { title: 'New B' });
    check('addTask ok', r1.ok && r1.task && r1.task.id, r1.error);
    check('addTask auto id unique', r2.ok && r2.task.id !== r1.task.id, `${r1.task && r1.task.id}/${r2.task && r2.task.id}`);
    const plan = readPlan(root);
    check('addTask persisted', plan.tasks.some((t) => t.id === r1.task.id && t.title === 'New A'));
    check('addTask defaults', r1.task.deps.length === 0 && r1.task.estimate_days === 1 && r1.task.owner === '' && !!r1.task.start);
    const ru = updateTask(root, '_demo', r1.task.id, { title: 'Renamed', owner: 'Jack', estimate_days: 3 });
    check('updateTask ok', ru.ok && ru.task.title === 'Renamed' && ru.task.owner === 'Jack' && ru.task.estimate_days === 3, ru.error);
    check('addTask unknown phase rejected', addTask(root, '_demo', 'P9', { title: 'x' }).ok === false);
  }
  {
    const root = freshCopy();
    const rd = deleteTask(root, '_demo', 'T1.1');
    check('deleteTask ok', rd.ok, rd.error);
    check('deleteTask cleaned deps', rd.cleaned && rd.cleaned.depsFrom.includes('T2.1') && rd.cleaned.depsFrom.includes('T2.2'), JSON.stringify(rd.cleaned));
    check('deleteTask cleaned milestone after', rd.cleaned.milestones.includes('M1'), JSON.stringify(rd.cleaned));
    const plan = readPlan(root);
    check('deleted task gone', !plan.tasks.some((t) => t.id === 'T1.1'));
    check('deps stripped on disk', plan.tasks.every((t) => !t.deps.includes('T1.1')));
  }
  {
    const root = freshCopy();
    const rm = moveTask(root, '_demo', 'T2.1', { phaseId: 'P3' });
    check('moveTask ok', rm.ok && rm.task.phase === 'P3', rm.error);
    check('moveTask persisted', readPlan(root).tasks.find((t) => t.id === 'T2.1').phase === 'P3');
  }
  {
    const root = freshCopy();
    const ra = addPhase(root, '_demo', { name: 'Extra' });
    check('addPhase ok', ra.ok && ra.phase.id, ra.error);
    const bad = deletePhase(root, '_demo', 'P1');
    check('deletePhase refuses when tasks remain', bad.ok === false && /still has/.test(bad.error || ''), bad.error);
    const good = deletePhase(root, '_demo', 'P1', { moveToPhase: 'P2' });
    check('deletePhase with moveToPhase ok', good.ok && good.moved > 0, good.error);
    const plan = readPlan(root);
    check('phase removed', !plan.phases.some((p) => p.id === 'P1'));
    check('tasks moved out of P1', plan.tasks.filter((t) => t.phase === 'P1').length === 0);
  }
  {
    const root = freshCopy();
    const rm = upsertMilestone(root, '_demo', { name: 'Mid', date: '2026-10-15', after: ['T2.1'] });
    check('upsertMilestone add ok', rm.ok && rm.milestone.id, rm.error);
    const rm2 = upsertMilestone(root, '_demo', { id: rm.milestone.id, name: 'Mid2' });
    check('upsertMilestone update ok', rm2.ok && rm2.milestone.name === 'Mid2', rm2.error);
    check('deleteMilestone ok', deleteMilestone(root, '_demo', rm.milestone.id).ok);
  }
  {
    const root = freshCopy();
    const rc = setTaskDeps(root, '_demo', 'T1.1', ['T2.1']);
    check('setTaskDeps rejects cycle', rc.ok === false && /cycle/i.test(rc.error || ''), rc.error);
    check('setTaskDeps rejects self-dep', setTaskDeps(root, '_demo', 'T1.1', ['T1.1']).ok === false);
    check('setTaskDeps accepts acyclic', setTaskDeps(root, '_demo', 'T2.1', ['T1.1']).ok);
    const cp = computeCriticalPath(readPlan(root));
    check('computeCriticalPath non-empty', Array.isArray(cp.chain) && cp.chain.length > 0, JSON.stringify(cp.chain));
  }
  {
    const root = freshCopy();
    const rr = reschedule(root, '_demo');
    check('reschedule ok', rr.ok, rr.error);
    const off = new Map((rr.schedule || []).map((s) => [s.id, s.offset]));
    const plan = readPlan(root);
    let ordered = true;
    for (const t of plan.tasks) {
      for (const d of t.deps) {
        const dep = plan.tasks.find((x) => x.id === d);
        if (!dep) continue;
        if ((off.get(t.id) || 0) < (off.get(d.id) || 0) + (Number(dep.estimate_days) || 1)) ordered = false;
      }
    }
    check('reschedule respects deps ordering', ordered);
    check('reschedule critical path non-empty', Array.isArray(rr.criticalPath) && rr.criticalPath.length > 0, JSON.stringify(rr.criticalPath));
  }
  {
    const root = freshCopy();
    const rf = freezeBaseline(root, '_demo');
    check('freezeBaseline ok', rf.ok && rf.baseline && rf.baseline.schema === 'omo-project/baseline@1', rf.error);
    const rb = getBaseline(root, '_demo');
    check('getBaseline ok', rb.ok && rb.baseline && Object.keys(rb.baseline.tasks).length === 8, rb.error);
    check('baseline percent numeric', typeof rf.baseline.percent === 'number');
  }
  {
    const root = freshCopy();
    const before = JSON.parse(JSON.stringify(readPlan(root)));
    addTask(root, '_demo', 'P1', { title: 'Temp' });
    const rres = restoreFile(root, '_demo', 'plan.json', before);
    check('restoreFile ok', rres.ok, rres.error);
    check('restoreFile restored content', JSON.stringify(readPlan(root)) === JSON.stringify(before));
    check('restoreFile rejects non-writable file', restoreFile(root, '_demo', '../evil.json', { x: 1 }).ok === false);
  }
  {
    const root = freshCopy();
    const before = fs.readFileSync(path.join(root, '_demo', 'progress.json'), 'utf8');
    const rp = setTaskDone(root, '_demo', 'T99.9', true);
    check('setTaskDone rejects phantom task', rp.ok === false, rp.error);
    const prog = readJsonSafe(path.join(root, '_demo', 'progress.json')).value;
    check('setTaskDone phantom wrote no entry', !prog.tasks || !('T99.9' in prog.tasks));
    check('setTaskDone phantom left progress untouched', fs.readFileSync(path.join(root, '_demo', 'progress.json'), 'utf8') === before);
  }
} finally {
  for (const r of tempRoots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }
}

const realPlanNow = fs.readFileSync(path.join(ROOT, '_demo', 'plan.json'), 'utf8');
const realProgNow = fs.readFileSync(path.join(ROOT, '_demo', 'progress.json'), 'utf8');
check('real _demo/plan.json untouched by write tests', realPlanBefore === realPlanNow);
check('real _demo/progress.json untouched by write tests', realProgressBefore === realProgNow);

/* -- 8. pass 2: backup / tasks.md / import / export ----------------------- */

console.log('');
console.log('Pass 2 (backup / md / import / export):');
try {
  {
    const root = freshCopy();
    for (let i = 0; i < 25; i++) backupProject(root, '_demo');
    const lb = listBackups(root, '_demo');
    check('backupProject + prune to 20', lb.ok && lb.backups.length === 20, lb.backups && String(lb.backups.length));
    check('backup snapshot has plan+progress', lb.backups[0].hasPlan && lb.backups[0].hasProgress);
  }
  {
    const root = freshCopy();
    backupProject(root, '_demo');
    deleteTask(root, '_demo', 'T1.1');
    check('task deleted before restore', !readPlan(root).tasks.some((t) => t.id === 'T1.1'));
    const lb = listBackups(root, '_demo');
    const rb = restoreBackup(root, '_demo', lb.backups[0].ts);
    check('restoreBackup ok', rb.ok, rb.error);
    check('restoreBackup brought task back', readPlan(root).tasks.some((t) => t.id === 'T1.1'));
    check('restoreBackup returns undo files', rb.undo && rb.undo.files.length >= 1);
    check('restoreBackup rejects unknown ts', restoreBackup(root, '_demo', 'nope').ok === false);
  }
  {
    const root = freshCopy();
    const planPath = path.join(root, '_demo', 'plan.json');
    const before = fs.readFileSync(planPath, 'utf8');
    const bp = backupProject(root, '_demo');
    const rb = restoreBackup(root, '_demo', bp.stamp);
    check('restoreBackup writes byte-verbatim', rb.ok && fs.readFileSync(planPath, 'utf8') === before, rb.error);
  }
  {
    const root = freshCopy();
    setTaskDone(root, '_demo', 'T1.1', false);
    const s1 = syncTasksMd(root, '_demo');
    check('syncTasksMd ok', s1.ok, s1.error);
    const mdPath = path.join(root, '_demo', 'tasks.md');
    let md = fs.readFileSync(mdPath, 'utf8');
    check('tasks.md has unchecked line', md.includes('- [ ] T1.1'), md.split('\n').find((l) => l.includes('T1.1')));
    md = md.replace('- [ ] T1.1', '- [x] T1.1') + '\n<!-- my note -->\n';
    fs.writeFileSync(mdPath, md);
    const rd = readTasksMd(root, '_demo');
    check('readTasksMd ok', rd.ok, rd.error);
    check('readTasksMd applied [x]', rd.applied.some((a) => a.id === 'T1.1' && a.done === true));
    const prog = readJsonSafe(path.join(root, '_demo', 'progress.json')).value;
    check('readTasksMd wrote progress', prog.tasks['T1.1'] && prog.tasks['T1.1'].done === true);
    syncTasksMd(root, '_demo');
    const md2 = fs.readFileSync(mdPath, 'utf8');
    check('sync preserves user line', md2.includes('<!-- my note -->'));
    check('sync rewrites owned line', md2.includes('- [x] T1.1'));
  }
  {
    const root = freshCopy();
    const ri = importChecklist(root, '_demo', 'P1', '- [ ] Alpha task\n- [x] Beta task\n\n');
    check('importChecklist ok', ri.ok && ri.added.length === 2, ri.error || JSON.stringify(ri.added));
    const titles = readPlan(root).tasks.map((t) => t.title);
    check('importChecklist stripped markers', titles.includes('Alpha task') && titles.includes('Beta task'));
  }
  {
    const root = freshCopy();
    const rc = planToCsv(root, '_demo');
    const csvLines = rc.content.replace(/^\uFEFF/, '').split('\r\n');
    check(
      'planToCsv ok (BOM + readable headers)',
      rc.ok && rc.content.startsWith('\uFEFF') && csvLines[0] === 'ID,階段,任務,負責人,開始,天數,前置任務,交付物,完成',
      rc.error
    );
    const rowT11 = csvLines.find((l) => l.startsWith('T1.1,'));
    check('planToCsv row correct (task + 是/否)', !!rowT11 && rowT11.includes('script.md') && /,(是|否)$/.test(rowT11), rowT11);
    const rm = planToMarkdown(root, '_demo');
    check('planToMarkdown ok', rm.ok && rm.content.includes('## P1') && /- \[( |x)\] T1\.1/.test(rm.content), rm.error);
  }
} finally {
  for (const r of tempRoots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }
}
check('real _demo/plan.json untouched by pass-2 tests', realPlanBefore === fs.readFileSync(path.join(ROOT, '_demo', 'plan.json'), 'utf8'));
check('real _demo/progress.json untouched by pass-2 tests', realProgressBefore === fs.readFileSync(path.join(ROOT, '_demo', 'progress.json'), 'utf8'));

/* -- 9. team sync: binding (.pcproject.json) + git layer (TEMP repos) ------ */
/*
 * Everything here runs against throwaway repos under a temp dir — never the
 * vault and never the real app repo's git state.
 */

console.log('');
console.log('Team sync — binding + git (temp repos):');

// NOTE: the git tests MUST live outside this repo (os.tmpdir()), otherwise the
// temp "project" folders would be inside the app's own work tree and every
// `git rev-parse --is-inside-work-tree` would report true.
const gitTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-selftest-git-'));
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Selftest',
  GIT_AUTHOR_EMAIL: 'selftest@example.com',
  GIT_COMMITTER_NAME: 'Selftest',
  GIT_COMMITTER_EMAIL: 'selftest@example.com',
  GIT_TERMINAL_PROMPT: '0',
};
function gitx(args, cwd) {
  return String(execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })).trim();
}

(async () => {
  // data.js gitEnv() spreads process.env, so give this test process a git
  // identity (temp repos have none of their own).
  process.env.GIT_AUTHOR_NAME = 'Selftest';
  process.env.GIT_AUTHOR_EMAIL = 'selftest@example.com';
  process.env.GIT_COMMITTER_NAME = 'Selftest';
  process.env.GIT_COMMITTER_EMAIL = 'selftest@example.com';

  const gRoot = path.join(gitTmp, 'projects');
  const pdir = path.join(gRoot, 'gp');
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(
    path.join(pdir, 'plan.json'),
    JSON.stringify({
      schema: 'omo-project/plan@2',
      id: 'gp',
      title: 'GP',
      created: '2026-10-11',
      target: '2026-10-20',
      phases: [{ id: 'P1', name: 'P' }],
      tasks: [
        {
          id: 'T1.1',
          phase: 'P1',
          title: 't',
          owner: 'Jack',
          start: '2026-10-11',
          estimate_days: 1,
          deps: [],
          deliverable: '',
          acceptance: '',
          outputs: [],
        },
      ],
      milestones: [],
      risks: [],
    }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(pdir, 'progress.json'),
    JSON.stringify({ schema: 'omo-project/progress@1', project: 'gp', updated: null, tasks: {} }),
    'utf8'
  );

  /* --- binding ----------------------------------------------------------- */
  check('validateBinding accepts a full binding', validateBinding({ remote: 'https://x/y.git', branch: 'main', projectId: 'gp' }).ok);
  check('validateBinding defaults branch to main', validateBinding({ remote: 'https://x/y.git' }).binding.branch === 'main');
  check('validateBinding rejects empty remote', validateBinding({ remote: '', branch: 'main' }).ok === false);
  check('validateBinding rejects a leading-dash branch', validateBinding({ remote: 'https://x/y.git', branch: '-bad' }).ok === false);
  check('validateBinding rejects a traversal projectId', validateBinding({ remote: 'https://x/y.git', projectId: '..' }).ok === false);

  const wb = writeBinding(gRoot, 'gp', { remote: 'https://example.com/gp.git', branch: 'main' });
  check('writeBinding writes .pcproject.json', wb.ok && fs.existsSync(path.join(pdir, '.pcproject.json')), wb.error);
  const rb = readBinding(gRoot, 'gp');
  check(
    'readBinding round-trips remote + projectId',
    rb.ok && rb.binding.remote === 'https://example.com/gp.git' && rb.binding.projectId === 'gp',
    JSON.stringify(rb.binding)
  );
  const badBindPath = path.join(gitTmp, 'badbind');
  fs.mkdirSync(badBindPath, { recursive: true });
  fs.writeFileSync(path.join(badBindPath, '.pcproject.json'), '{ not json ', 'utf8');
  check('readBindingFile reports malformed json', readBindingFile(badBindPath).ok === false);
  check('writeBinding rejects an escaping projectId', writeBinding(gRoot, '../x', { remote: 'https://x/y.git' }).ok === false);

  /* --- git init + commit message ---------------------------------------- */
  check('gitStatus before init: isRepo=false', (await gitStatus(gRoot, 'gp')).isRepo === false);
  const ini = await gitInit(gRoot, 'gp');
  check('gitInit ok', ini.ok, ini.error);
  let st = await gitStatus(gRoot, 'gp');
  check('gitStatus isRepo=true after init', st.isRepo === true);
  check('gitStatus clean after the init commit', st.dirty === false, JSON.stringify(st.lastCommit));
  check('gitStatus exposes lastCommit', !!st.lastCommit && !!st.lastCommit.hash && !!st.lastCommit.author);

  setTaskDone(gRoot, 'gp', 'T1.1', true);
  st = await gitStatus(gRoot, 'gp');
  check('gitStatus dirty after a tick', st.dirty === true);
  const msg = await deriveCommitMessage(gRoot, 'gp');
  check('deriveCommitMessage = tick: T1.1 done by Jack', msg === 'tick: T1.1 done by Jack', msg);

  const c = await gitCommit(gRoot, 'gp', msg);
  check('gitCommit ok', c.ok && c.committed, c.error);
  check('gitStatus clean after commit', (await gitStatus(gRoot, 'gp')).dirty === false);
  check('gitCommit with an empty message is rejected', (await gitCommit(gRoot, 'gp', '')).ok === false);

  /* --- bind remote + push + pull ---------------------------------------- */
  const gOrigin = path.join(gitTmp, 'origin.git');
  gitx(['init', '--bare', '-b', 'main', gOrigin], gitTmp);
  const bind = await gitBind(gRoot, 'gp', gOrigin, { branch: 'main' });
  check('gitBind sets origin + rewrites binding', bind.ok, bind.error);
  const st2 = await gitStatus(gRoot, 'gp');
  check('gitStatus remote = origin path', st2.remote === gOrigin, st2.remote);
  const push = await gitPush(gRoot, 'gp');
  check('gitPush (first push, sets upstream) ok', push.ok, push.error);
  const st3 = await gitStatus(gRoot, 'gp');
  check(
    'after first push: hasUpstream, ahead/behind = 0/0',
    st3.hasUpstream && st3.ahead === 0 && st3.behind === 0,
    JSON.stringify({ up: st3.hasUpstream, ahead: st3.ahead, behind: st3.behind })
  );

  /* --- clone ------------------------------------------------------------- */
  const cloneDir = path.join(gitTmp, 'cloned', 'gp');
  const cl = await gitClone(gOrigin, cloneDir);
  check('gitClone ok', cl.ok, cl.error);
  check('cloned plan.json present', fs.existsSync(path.join(cloneDir, 'plan.json')));
  check('gitClone derives projectId from plan.json', cl.projectId === 'gp', cl.projectId);
  check('gitClone refuses a non-empty destination', (await gitClone(gOrigin, cloneDir)).ok === false);

  /* --- full sync (pull → auto-commit → push) ---------------------------- */
  setTaskDone(gRoot, 'gp', 'T1.1', false);
  const sync = await gitSync(gRoot, 'gp', {});
  check('gitSync ok', sync.ok, sync.error || JSON.stringify(sync.steps));
  check('gitSync auto-committed an untick message', sync.committed && /untick: T1\.1/.test(sync.message || ''), sync.message);
  check('gitSync pushed', sync.pushed === true);
  check('gitSync leaves a clean tree', (await gitStatus(gRoot, 'gp')).dirty === false);

  /* --- safety ------------------------------------------------------------ */
  check('gitStatus rejects a traversal projectId', (await gitStatus(gRoot, '../x')).ok === false);
  check('gitClone rejects an empty url', (await gitClone('', path.join(gitTmp, 'z'))).ok === false);
  check('gitClone rejects an unsupported scheme', (await gitClone('ftp://x/y', path.join(gitTmp, 'z2'))).ok === false);
  const badGit = await runGit(['definitely-not-a-command'], gRoot);
  check('runGit never throws on a bad command', badGit.ok === false && typeof badGit.timedOut === 'boolean');

  /* --- multi-root scan --------------------------------------------------- */
  const merged = scanRoots([gRoot, path.join(gitTmp, 'cloned')]);
  check('scanRoots merges roots and finds the project', merged.projects.some((p) => p.id === 'gp'), merged.projects.map((p) => p.id).join(','));

  /* --- pure message helper ---------------------------------------------- */
  check(
    'commitMessageFromDiff: plan edit',
    commitMessageFromDiff({ tasks: [{ id: 'T2.3', title: 'a' }] }, { tasks: {} }, { tasks: [{ id: 'T2.3', title: 'b' }] }, { tasks: {} }) === 'plan: edit T2.3'
  );
  check(
    'commitMessageFromDiff: plan add',
    commitMessageFromDiff({ tasks: [] }, { tasks: {} }, { tasks: [{ id: 'T5.3' }] }, { tasks: {} }) === 'plan: +T5.3'
  );

  /* ================= P3–P6: share / history / myday / merge ============== */

  console.log('');
  console.log('Part B — share / history / my-day / merge (temp repos):');

  /* --- P3: gh layer + graceful degrade ---------------------------------- */
  check('parseRemote: https github', JSON.stringify(gx.parseRemote('https://github.com/a/b.git')) === '{"host":"github.com","owner":"a","name":"b"}');
  check('parseRemote: ssh github', (gx.parseRemote('git@github.com:a/b.git') || {}).owner === 'a');
  check('parseRemote: rejects non-github', gx.parseRemote('https://gitlab.com/a/b.git') === null);
  const ghav = await gx.ghAvailable();
  check('ghAvailable: structured result', typeof ghav.installed === 'boolean' && typeof ghav.authed === 'boolean', JSON.stringify(ghav));
  const shareRes = await gx.shareInfo(gRoot, 'gp'); // gp remote is a local path
  check(
    'shareInfo degrades for a non-github remote (no crash)',
    shareRes && shareRes.ok === false && ['not_github', 'no_remote', 'gh_not_authed', 'gh_missing'].includes(shareRes.code),
    JSON.stringify(shareRes && shareRes.code)
  );
  const access = await gx.checkAccess(gRoot, 'gp');
  check('checkAccess: structured result', access && access.ok === true && typeof access.readOnly === 'boolean', JSON.stringify(access));

  /* --- P4: history / task-diff / restore on a temp project -------------- */
  const hxDir = path.join(gRoot, 'hx');
  const hxPlan = {
    schema: 'omo-project/plan@2', id: 'hx', title: 'HX', created: '2026-10-11', target: '2026-10-20',
    phases: [{ id: 'P1', name: 'P' }],
    tasks: [{ id: 'T1.1', phase: 'P1', title: 'first', owner: 'Jack', start: '2026-10-11', estimate_days: 1, deps: [], deliverable: '', acceptance: '', outputs: [] }],
    milestones: [], risks: [],
  };
  fs.mkdirSync(hxDir, { recursive: true });
  fs.writeFileSync(path.join(hxDir, 'plan.json'), JSON.stringify(hxPlan, null, 2));
  fs.writeFileSync(path.join(hxDir, 'progress.json'), JSON.stringify({ schema: 'omo-project/progress@1', project: 'hx', updated: null, tasks: {} }, null, 2));
  gitx(['init', '-b', 'main'], hxDir);
  gitx(['config', 'user.name', 'Selftest'], hxDir);
  gitx(['config', 'user.email', 'selftest@example.com'], hxDir);
  gitx(['add', '-A'], hxDir);
  gitx(['commit', '-m', 'init hx'], hxDir);

  setTaskDone(gRoot, 'hx', 'T1.1', true);
  const hxPlan2 = readJsonSafe(path.join(hxDir, 'plan.json')).value;
  hxPlan2.tasks[0].owner = 'Dorian';
  hxPlan2.tasks[0].title = 'renamed';
  fs.writeFileSync(path.join(hxDir, 'plan.json'), JSON.stringify(hxPlan2, null, 2));
  gitx(['add', '-A'], hxDir);
  gitx(['commit', '-m', 'tick + edit'], hxDir);

  const hist = await gx.historyLog(gRoot, 'hx', { limit: 10 });
  check('historyLog lists 2 commits', hist.ok && hist.commits.length === 2, JSON.stringify(hist.commits && hist.commits.length));
  check('historyLog newest first = "tick + edit"', hist.commits[0] && hist.commits[0].message === 'tick + edit', hist.commits[0] && hist.commits[0].message);
  check('historyLog author captured', hist.commits[0] && hist.commits[0].author === 'Selftest', hist.commits[0] && hist.commits[0].author);
  const latestSha = hist.commits[0].sha;
  const dif = await gx.commitDiff(gRoot, 'hx', latestSha);
  check('commitDiff ok', dif.ok === true, dif.error);
  check('commitDiff: T1.1 tick', dif.changes.some((c) => c.kind === 'tick' && c.id === 'T1.1'), JSON.stringify(dif.changes));
  check('commitDiff: owner Jack → Dorian', dif.changes.some((c) => c.kind === 'task-field' && c.id === 'T1.1' && c.field === 'owner' && c.from === 'Jack' && c.to === 'Dorian'), JSON.stringify(dif.changes));
  check('commitDiff: title edit', dif.changes.some((c) => c.kind === 'task-field' && c.field === 'title' && c.to === 'renamed'), JSON.stringify(dif.changes));
  const parentSha = hist.commits[1].sha;
  const restore = await gx.restoreCommit(gRoot, 'hx', parentSha);
  check('restoreCommit ok', restore.ok, restore.error);
  const progAfterRestore = readJsonSafe(path.join(hxDir, 'progress.json')).value;
  check('restoreCommit reverted the tick', !(progAfterRestore.tasks['T1.1'] && progAfterRestore.tasks['T1.1'].done === true));
  check('restoreCommit returns undo files', restore.undo && restore.undo.files.length >= 1);

  /* --- P5: my-day grouping ---------------------------------------------- */
  const my = gx.collectMyTasks(
    [{ id: 'x', title: 'X', tasks: [
      { id: 'A', owner: 'Jack', done: false, status: 'overdue', plannedEnd: '2026-01-01', deps: [] },
      { id: 'B', owner: 'Jack', done: false, status: 'pending', plannedEnd: '2026-10-11', deps: [] },
      { id: 'C', owner: 'Jack', done: false, status: 'pending', plannedEnd: '2026-10-15', deps: [] },
      { id: 'D', owner: 'Jack', done: false, status: 'pending', plannedEnd: '2026-11-01', deps: ['E'] },
      { id: 'E', owner: 'Jack', done: true, status: 'done', plannedEnd: '2026-10-01', deps: [] },
      { id: 'F', owner: 'Dorian', done: false, status: 'pending', plannedEnd: '2026-10-11', deps: [] },
    ] }],
    'Jack',
    '2026-10-11'
  );
  check('myday overdue', my.overdue.length === 1 && my.overdue[0].taskId === 'A', JSON.stringify(my.overdue.map((t) => t.taskId)));
  check('myday today', my.today.length === 1 && my.today[0].taskId === 'B', JSON.stringify(my.today.map((t) => t.taskId)));
  check('myday week', my.week.length === 1 && my.week[0].taskId === 'C', JSON.stringify(my.week.map((t) => t.taskId)));
  check('myday ready (deps done)', my.ready.length === 1 && my.ready[0].taskId === 'D', JSON.stringify(my.ready.map((t) => t.taskId)));
  check('myday excludes other owners + done', my.count === 4, String(my.count));
  check('myday empty for blank who', gx.collectMyTasks([{ id: 'x', tasks: [] }], '', '2026-10-11').count === 0);

  /* --- P6: field-level merge (pure) ------------------------------------- */
  const bplan = { schema: 'omo-project/plan@2', id: 'm', tasks: [{ id: 'T1.1', phase: 'P1', title: 'a', owner: 'Jack', deps: [], outputs: [] }, { id: 'T2.1', phase: 'P1', title: 'b', owner: 'Jack', deps: [], outputs: [] }], phases: [{ id: 'P1', name: 'P' }], milestones: [] };
  const oplan = JSON.parse(JSON.stringify(bplan));
  oplan.tasks[0].title = 'a-ours';
  const tplan = JSON.parse(JSON.stringify(bplan));
  tplan.tasks[1].title = 'b-theirs';
  const mt = gx.mergeTrees(bplan, { tasks: {} }, oplan, { tasks: {} }, tplan, { tasks: {} });
  check('merge: edits to different tasks auto-merge (0 conflicts)', mt.conflicts.length === 0, JSON.stringify(mt.conflicts));
  check('merge: keeps both edits', mt.plan.tasks[0].title === 'a-ours' && mt.plan.tasks[1].title === 'b-theirs');
  const tplan2 = JSON.parse(JSON.stringify(bplan));
  tplan2.tasks[0].title = 'a-theirs';
  const mt2 = gx.mergeTrees(bplan, { tasks: {} }, oplan, { tasks: {} }, tplan2, { tasks: {} });
  check('merge: same task+field surfaces 1 conflict', mt2.conflicts.length === 1 && mt2.conflicts[0].id === 'T1.1' && mt2.conflicts[0].field === 'title', JSON.stringify(mt2.conflicts));
  const pm = gx.mergeProgress3({ tasks: {} }, { tasks: { 'T1.1': { done: true, doneAt: '2026-10-11' } } }, { tasks: { 'T2.1': { done: true, doneAt: '2026-10-11' } } });
  check('merge: different tasks ticked auto-merge', pm.conflicts.length === 0 && pm.progress.tasks['T1.1'].done && pm.progress.tasks['T2.1'].done, JSON.stringify(pm.conflicts));
  const pm2 = gx.mergeProgress3({ tasks: {} }, { tasks: { 'T1.1': { done: true } } }, { tasks: { 'T1.1': { done: false } } });
  check('merge: same task done-vs-undone is a conflict', pm2.conflicts.length >= 1, JSON.stringify(pm2.conflicts));
  const mtResolve = gx.mergeTrees(bplan, { tasks: {} }, oplan, { tasks: {} }, tplan2, { tasks: {} }, { 'task:T1.1:title': 'theirs' });
  check('merge: choice=theirs resolves the conflict', mtResolve.conflicts.length === 0 && mtResolve.plan.tasks[0].title === 'a-theirs');

  /* --- P6: integrateRemote two-writer (temp repos) ---------------------- */
  const twRoot = path.join(gitTmp, 'tw');
  const org = path.join(twRoot, 'org.git');
  fs.mkdirSync(twRoot, { recursive: true });
  gitx(['init', '--bare', '-b', 'main', org], twRoot);
  const seedDir = path.join(twRoot, 'seed');
  fs.mkdirSync(seedDir, { recursive: true });
  const twPlan = {
    schema: 'omo-project/plan@2', id: 'tw', title: 'TW', created: '2026-10-11', target: '2026-10-20',
    phases: [{ id: 'P1', name: 'P' }],
    tasks: [
      { id: 'T1.1', phase: 'P1', title: 'one', owner: 'Jack', start: '2026-10-11', estimate_days: 1, deps: [], deliverable: '', acceptance: '', outputs: [] },
      { id: 'T2.1', phase: 'P1', title: 'two', owner: 'Jack', start: '2026-10-11', estimate_days: 1, deps: [], deliverable: '', acceptance: '', outputs: [] },
    ],
    milestones: [], risks: [],
  };
  fs.writeFileSync(path.join(seedDir, 'plan.json'), JSON.stringify(twPlan, null, 2));
  fs.writeFileSync(path.join(seedDir, 'progress.json'), JSON.stringify({ schema: 'omo-project/progress@1', project: 'tw', updated: null, tasks: {} }, null, 2));
  gitx(['init', '-b', 'main'], seedDir);
  gitx(['config', 'user.name', 'Selftest'], seedDir);
  gitx(['config', 'user.email', 'selftest@example.com'], seedDir);
  gitx(['add', '-A'], seedDir);
  gitx(['commit', '-m', 'seed tw'], seedDir);
  gitx(['remote', 'add', 'origin', org], seedDir);
  gitx(['push', '-u', 'origin', 'main'], seedDir);
  const cloneA = path.join(twRoot, 'cloneA');
  const cloneB = path.join(twRoot, 'cloneB');
  gitx(['clone', org, cloneA], twRoot);
  gitx(['clone', org, cloneB], twRoot);

  // A edits T1.1, pushes; B edits T2.1, commits → auto-merge.
  const aP = readJsonSafe(path.join(cloneA, 'plan.json')).value;
  aP.tasks[0].title = 'A-title';
  fs.writeFileSync(path.join(cloneA, 'plan.json'), JSON.stringify(aP, null, 2));
  gitx(['add', '-A'], cloneA);
  gitx(['commit', '-m', 'A edit'], cloneA);
  gitx(['push'], cloneA);
  const bP = readJsonSafe(path.join(cloneB, 'plan.json')).value;
  bP.tasks[1].title = 'B-title';
  fs.writeFileSync(path.join(cloneB, 'plan.json'), JSON.stringify(bP, null, 2));
  gitx(['add', '-A'], cloneB);
  gitx(['commit', '-m', 'B edit'], cloneB);
  const integ = await gx.integrateRemote(twRoot, 'cloneB', {});
  check('integrateRemote: divergent edits auto-merge', integ.ok && integ.merged === true && (!integ.conflicts || integ.conflicts.length === 0), JSON.stringify(integ));
  const bMerged = readJsonSafe(path.join(cloneB, 'plan.json')).value;
  check('auto-merged plan has BOTH A + B edits', bMerged.tasks[0].title === 'A-title' && bMerged.tasks[1].title === 'B-title', JSON.stringify(bMerged.tasks.map((t) => t.title)));

  // Same-task conflict: A and B both edit T1.1 differently.
  const aP2 = readJsonSafe(path.join(cloneA, 'plan.json')).value;
  aP2.tasks[0].title = 'A-second';
  fs.writeFileSync(path.join(cloneA, 'plan.json'), JSON.stringify(aP2, null, 2));
  gitx(['add', '-A'], cloneA);
  gitx(['commit', '-m', 'A edit2'], cloneA);
  gitx(['push'], cloneA);
  const bP2 = readJsonSafe(path.join(cloneB, 'plan.json')).value;
  bP2.tasks[0].title = 'B-second';
  fs.writeFileSync(path.join(cloneB, 'plan.json'), JSON.stringify(bP2, null, 2));
  gitx(['add', '-A'], cloneB);
  gitx(['commit', '-m', 'B edit2'], cloneB);
  const integ2 = await gx.integrateRemote(twRoot, 'cloneB', {});
  check('integrateRemote: same-task conflict needs resolution', integ2.ok && integ2.needsResolution === true && integ2.conflicts.length >= 1, JSON.stringify(integ2.conflicts));
  check('conflict is on T1.1 title', integ2.conflicts.some((c) => c.id === 'T1.1' && c.field === 'title' && c.ours === 'B-second' && c.theirs === 'A-second'), JSON.stringify(integ2.conflicts));
  const resolved = await gx.resolveMerge(
    twRoot,
    'cloneB',
    integ2.conflicts.map((c) => ({ scope: c.scope, id: c.id, field: c.field, choice: 'theirs' }))
  );
  check('resolveMerge commits the resolution', resolved.ok && (resolved.merged === true || resolved.newSha), JSON.stringify(resolved));
  const bFinal = readJsonSafe(path.join(cloneB, 'plan.json')).value;
  check('resolved plan took theirs (A-second)', bFinal.tasks[0].title === 'A-second', bFinal.tasks[0].title);
  check('resolved plan kept our non-conflicting T2.1', bFinal.tasks[1].title === 'B-title', bFinal.tasks[1].title);

  // syncProject basic (clean + up to date).
  const syncRes = await gx.syncProject(twRoot, 'cloneA', {});
  check('syncProject ok (clean, up-to-date)', syncRes.ok === true, JSON.stringify(syncRes));

  /* --- Publish to GitHub (one-click) — argv + validation, NO real repo --- */
  const plan1 = gx.publishPlan({ name: 'foo', owner: 'o', visibility: 'private', description: '', dir: 'D' });
  check('publishPlan: private argv', JSON.stringify(plan1.primary) === JSON.stringify(['repo', 'create', 'o/foo', '--private', '--source', 'D', '--push']), JSON.stringify(plan1.primary));
  const plan2 = gx.publishPlan({ name: 'foo', owner: 'o', visibility: 'public', description: 'my desc', dir: 'D' });
  check('publishPlan: public argv (+description)', JSON.stringify(plan2.primary) === JSON.stringify(['repo', 'create', 'o/foo', '--public', '--description', 'my desc', '--source', 'D', '--push']), JSON.stringify(plan2.primary));
  const plan3 = gx.publishPlan({ name: 'foo', owner: '', visibility: 'private', dir: 'D' });
  check('publishPlan: bare-name argv', JSON.stringify(plan3.primary) === JSON.stringify(['repo', 'create', 'foo', '--private', '--source', 'D', '--push']), JSON.stringify(plan3.primary));
  check('publishPlan: fallback create argv', JSON.stringify(plan3.fallbackCreate) === JSON.stringify(['repo', 'create', 'foo', '--private']), JSON.stringify(plan3.fallbackCreate));
  check('publishPlan: url', plan1.url === 'https://github.com/o/foo', plan1.url);
  check('repoNameError: rejects spaces/slash/dot', !!gx.repoNameError('a b') && !!gx.repoNameError('a/b') && !!gx.repoNameError('.'));
  check('repoNameError: accepts valid', gx.repoNameError('a-b.c_1') === null);
  check('slugifyRepoName', gx.slugifyRepoName('Project Console — App') === 'project-console-app', gx.slugifyRepoName('Project Console — App'));

  const mkPub = (id) => {
    const d = path.join(gRoot, id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'plan.json'), JSON.stringify({ schema: 'omo-project/plan@2', id, title: id, created: '2026-10-11', target: '2026-10-20', phases: [{ id: 'P1', name: 'P' }], tasks: [], milestones: [], risks: [] }));
    fs.writeFileSync(path.join(d, 'progress.json'), JSON.stringify({ schema: 'omo-project/progress@1', project: id, updated: null, tasks: {} }));
    return d;
  };
  const pubz = mkPub('pubz');
  const pubx = mkPub('pubx');
  const puby = mkPub('puby');

  // validation (dryRun, on a non-repo folder)
  const dry = await gx.publishProject(gRoot, 'pubz', { name: 'pubz', owner: 'me', dryRun: true });
  check('publishProject: non-repo folder → wouldInit', dry.ok === true && dry.dryRun === true && dry.wouldInit === true, JSON.stringify(dry));
  check('publishProject: bad name rejected', (await gx.publishProject(gRoot, 'pubz', { name: 'a b', owner: 'me', dryRun: true })).code === 'bad_name');
  check('publishProject: bad owner rejected', (await gx.publishProject(gRoot, 'pubz', { name: 'ok', owner: 'bad owner!', dryRun: true })).code === 'bad_owner');
  check('publishProject: owner/name form parsed', (await gx.publishProject(gRoot, 'pubz', { name: 'myorg/myrepo', owner: '', dryRun: true })).plan.target === 'myorg/myrepo');
  check('publishProject: already-bound project refused', (await gx.publishProject(gRoot, 'gp', { name: 'x', owner: 'me', dryRun: true })).code === 'already_bound');
  check('publishProject: rebind bypasses the guard', (await gx.publishProject(gRoot, 'gp', { name: 'x', owner: 'me', dryRun: true, rebind: true })).ok === true);

  // success via injected gh runner (no network): init → create → bind
  const calls = [];
  const fakeGh = async (argv) => {
    calls.push(argv);
    return { ok: true, code: 0, stdout: '✓ Created https://github.com/me/pubx on GitHub', stderr: '' };
  };
  const pub = await gx.publishProject(gRoot, 'pubx', { name: 'pubx', owner: 'me', visibility: 'private', description: 'desc', runGh: fakeGh });
  check('publishProject: success (injected gh)', pub.ok === true && pub.bound === true && pub.url === 'https://github.com/me/pubx', JSON.stringify(pub));
  check('publishProject: used the primary argv', JSON.stringify(calls[0]) === JSON.stringify(['repo', 'create', 'me/pubx', '--private', '--description', 'desc', '--source', pubx, '--push']), JSON.stringify(calls[0]));
  check('publishProject: initialized the folder', fs.existsSync(path.join(pubx, '.git')));
  check('publishProject: wrote the binding', /me\/pubx/.test(readJsonSafe(path.join(pubx, '.pcproject.json')).value.remote));
  check('publishProject: private visibility reported', pub.visibility === 'private', pub.visibility);

  // failure modes via injected runner
  const fakeExists = async () => ({ ok: false, code: 1, stdout: '', stderr: 'GraphQL: Name already exists on this account (createRepository)' });
  const pe = await gx.publishProject(gRoot, 'puby', { name: 'puby', owner: 'me', runGh: fakeExists });
  check('publishProject: repo name taken → repo_exists', pe.ok === false && pe.code === 'repo_exists', JSON.stringify(pe));
  check('publishProject: no binding written on failure', !fs.existsSync(path.join(puby, '.pcproject.json')));
  const fakeNoAuth = async () => ({ ok: false, code: 1, stdout: '', stderr: 'please run: gh auth login' });
  check('publishProject: gh not authed → gh_not_authed', (await gx.publishProject(gRoot, 'puby', { name: 'puby', owner: 'me', runGh: fakeNoAuth })).code === 'gh_not_authed');
  const fakeNoGh = async () => ({ ok: false, code: -1, stdout: '', stderr: 'gh: command not found' });
  check('publishProject: gh missing → gh_missing', (await gx.publishProject(gRoot, 'puby', { name: 'puby', owner: 'me', runGh: fakeNoGh })).code === 'gh_missing');
})()
  .catch((err) => {
    failed++;
    console.log('  FAIL team-sync section threw: ' + (err && err.stack ? err.stack : err));
  })
  .finally(() => {
    try {
      fs.rmSync(gitTmp, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }

    /* -- 10. verdict ------------------------------------------------------ */
    console.log('');
    console.log(`checks: ${passed} passed, ${failed} failed`);
    console.log(failed === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
    process.exit(failed === 0 ? 0 : 1);
  });
