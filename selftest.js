'use strict';

/* ==========================================================================
   selftest.js — headless data-layer test (human-only model, no Electron).
   Asserts the plan@2 / progress@1 contract, the _demo fixture values,
   graceful degradation, and a round-trip tick on a TEMP copy (the real
   _demo/progress.json is never mutated). Exit 0 = PASS, 1 = FAIL.
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const {
  scanProjects,
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
} = require('./data');

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

/* -- 9. verdict ----------------------------------------------------------- */

console.log('');
console.log(`checks: ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(failed === 0 ? 0 : 1);
