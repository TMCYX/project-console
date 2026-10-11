'use strict';

/* ==========================================================================
   harness-pb.js — headless acceptance harness for Part B (P3–P6).

   Boots the REAL renderer with harness-git-preload.js (real ./gitx + ./data)
   against TEMP git repos under os.tmpdir(). Asserts:
     T3.1 share panel renders + degrades cleanly without gh auth
     T4.1 history lists commits · T4.2 task-level diff · T4.3 restore works
     T5.1 「我今日要做」 filters correctly
     T6.1 two-writer edits on different tasks auto-merge (field-level)
     T6.2 a same-task conflict raises the conflict UI, and resolves

   Nothing here touches the vault or the real app repo.

   Run:  ./node_modules/.bin/electron harness-pb.js
   ========================================================================== */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'pc-pb-user-')));
app.disableHardwareAcceleration();

const results = [];
function check(label, cond, detail) {
  const okFlag = !!cond;
  results.push({ label, ok: okFlag });
  process.stdout.write(`  ${okFlag ? 'ok  ' : 'FAIL'} ${label}${!okFlag && detail ? ' — ' + detail : ''}\n`);
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-pb-'));
const ROOT = path.join(BASE, 'projects');
const PBDIR = path.join(ROOT, 'pb');
const ORIGIN = path.join(BASE, 'origin.git');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Harness',
  GIT_AUTHOR_EMAIL: 'harness@example.com',
  GIT_COMMITTER_NAME: 'Harness',
  GIT_COMMITTER_EMAIL: 'harness@example.com',
  GIT_TERMINAL_PROMPT: '0',
};
function git(args, cwd) {
  return String(execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })).trim();
}
function writeJson(dir, file, obj) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
function readJson(dir, file) {
  return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
}

function makePlan(id) {
  return {
    schema: 'omo-project/plan@2',
    id,
    title: id.toUpperCase(),
    owner: 'Jack',
    created: '2026-10-11',
    target: '2026-10-20',
    phases: [{ id: 'P1', name: 'P' }],
    tasks: [
      { id: 'T1.1', phase: 'P1', title: 'one', owner: 'Jack', start: '2026-10-11', estimate_days: 1, deps: [], deliverable: '', acceptance: '', outputs: [] },
      { id: 'T2.1', phase: 'P1', title: 'JACKTASK', owner: 'Jack', start: '2026-10-11', estimate_days: 1, deps: [], deliverable: '', acceptance: '', outputs: [] },
      { id: 'T3.1', phase: 'P1', title: 'DORIANTASK', owner: 'Dorian', start: '2026-10-11', estimate_days: 1, deps: [], deliverable: '', acceptance: '', outputs: [] },
    ],
    milestones: [],
    risks: [],
  };
}

function setupRepos() {
  fs.mkdirSync(ROOT, { recursive: true });
  writeJson(PBDIR, 'plan.json', makePlan('pb'));
  writeJson(PBDIR, 'progress.json', { schema: 'omo-project/progress@1', project: 'pb', updated: null, tasks: {} });
  git(['init', '-b', 'main'], PBDIR);
  git(['config', 'user.name', 'Harness'], PBDIR);
  git(['config', 'user.email', 'harness@example.com'], PBDIR);
  git(['init', '--bare', '-b', 'main', ORIGIN], BASE);
  git(['add', '-A'], PBDIR);
  git(['commit', '-m', 'seed pb'], PBDIR);
  git(['remote', 'add', 'origin', ORIGIN], PBDIR);
  git(['push', '-u', 'origin', 'main'], PBDIR);

  const pbgit = path.join(ROOT, 'pbgit');
  writeJson(pbgit, 'plan.json', makePlan('pbgit'));
  writeJson(pbgit, 'progress.json', { schema: 'omo-project/progress@1', project: 'pbgit', updated: null, tasks: {} });
  git(['init', '-b', 'main'], pbgit);
  git(['config', 'user.name', 'Harness'], pbgit);
  git(['config', 'user.email', 'harness@example.com'], pbgit);
  git(['add', '-A'], pbgit);
  git(['commit', '-m', 'seed pbgit'], pbgit);
  git(['remote', 'add', 'origin', 'https://github.com/example/pbgit.git'], pbgit);
}

/** Simulate the OTHER writer: fresh clone of origin, mutate plan.json, push. */
function remoteEdit(mutator, msg) {
  const w = path.join(BASE, 'writer-' + Date.now() + '-' + Math.floor(Math.random() * 1000));
  git(['clone', ORIGIN, w], BASE);
  const plan = readJson(w, 'plan.json');
  mutator(plan);
  writeJson(w, 'plan.json', plan);
  git(['add', '-A'], w);
  git(['commit', '-m', msg], w);
  git(['push'], w);
}
function localEdit(mutator) {
  const plan = readJson(PBDIR, 'plan.json');
  mutator(plan);
  writeJson(PBDIR, 'plan.json', plan); // leaves the working tree dirty → UI Sync commits it
}

app.whenReady().then(async () => {
  let setupErr = null;
  try {
    setupRepos();
  } catch (err) {
    setupErr = err;
  }

  process.stdout.write('\nPart B harness — Project Console (P3–P6)\n\n');
  if (setupErr) {
    check('temp repos set up', false, setupErr.message);
    process.stdout.write('\nRESULT: FAIL\n');
    app.exit(1);
    return;
  }
  check('temp repos set up', fs.existsSync(path.join(ORIGIN, 'HEAD')));

  process.env.PC_HARNESS_ROOT = ROOT;

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    useContentSize: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'harness-git-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (...args) => {
    let level;
    let message;
    if (typeof args[1] === 'number') {
      level = args[1];
      message = args[2];
    } else {
      const d = args[1] || {};
      level = d.level;
      message = d.message;
    }
    const lv =
      typeof level === 'string'
        ? { verbose: 0, info: 1, warning: 2, error: 3 }[level] != null
          ? { verbose: 0, info: 1, warning: 2, error: 3 }[level]
          : 1
        : level || 0;
    if (lv >= 3) errors.push(String(message));
  });
  win.webContents.on('render-process-gone', (_e, d) => errors.push('render-process-gone: ' + d.reason));
  win.webContents.on('did-fail-load', (_e, code, desc) => errors.push('did-fail-load: ' + code + ' ' + desc));
  win.webContents.on('preload-error', (_e, _p, err) => errors.push('preload-error: ' + err.message));

  const js = (code) => win.webContents.executeJavaScript(code);
  async function waitForJs(code, timeoutMs = 12000, step = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const v = await js(code);
        if (v) return v;
      } catch (_) {
        /* keep polling */
      }
      await delay(step);
    }
    return null;
  }
  const selectProject = (id) => js(`(() => { const b = document.querySelector('[data-project-id="${id}"]'); if (b) b.click(); return !!b; })()`);
  // Sync is 'finished' once the chip is neither busy nor dirty (or a conflict panel is up).
  const syncFinished = () =>
    waitForJs(
      `(() => { const busy=document.querySelector('.syncchip.is-busy'); const dirty=document.querySelector('.syncchip.is-dirty'); if (busy) return ''; if (document.querySelector('.conflictpanel')) return 'conflict'; return dirty ? '' : 'done'; })()`,
      25000
    );
  // Click Sync, wait for the busy chip to APPEAR, then for it to settle.
  async function clickSyncAndWait() {
    await js(`document.querySelector('[data-git-sync]').click()`);
    await waitForJs(`!!document.querySelector('.syncchip.is-busy')`, 4000);
    return syncFinished();
  }
  const toastText = () => js(`(document.getElementById('toast')||{}).textContent||''`);

  try {
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await delay(900);

    /* -------- T3.1 / T3.3: share panel degrades without gh auth --------- */
    process.stdout.write('\nT3.1 Share panel (degrades without gh auth):\n');
    await selectProject('pbgit');
    await waitForJs(`!!document.querySelector('.project')`);
    await js(`document.querySelector('[data-share-toggle]').click()`);
    const shareReady = await waitForJs(
      `(() => { const t=(document.querySelector('.sharepanel')||{}).textContent||''; return (t && !t.includes('載入中') && /gh auth login|未登入|未安裝|winget|未綁定|GitHub|唯讀/.test(t)) ? t : ''; })()`,
      12000
    );
    check('share panel renders and degrades with a clear message (no gh auth)', !!shareReady, (shareReady || '').slice(0, 200));
    await js(`document.querySelector('[data-share-cancel]') && document.querySelector('[data-share-cancel]').click()`);

    /* -------- T5.1: 我今日要做 filters correctly ----------------------- */
    process.stdout.write('\nT5.1 我今日要做 (my-day filter):\n');
    await js(`document.querySelector('[data-top="myday"]').click()`);
    await delay(200);
    await js(`(() => { const i = document.querySelector('[data-me-input]'); if (i) i.value='Jack'; return !!i; })()`);
    await js(`document.querySelector('[data-me-save]').click()`);
    const mydayOk = await waitForJs(`((document.querySelector('.landing')||{}).textContent||'').includes('JACKTASK')`, 8000);
    check('my-day shows my (Jack) task', !!mydayOk);
    const landed = await js(`(document.querySelector('.landing')||{}).textContent||''`);
    check('my-day excludes other owners (Dorian)', !String(landed).includes('DORIANTASK'), 'DORIANTASK leaked');
    check('my-day renders the four groups', /逾期/.test(landed) && /今日 due/.test(landed) && /本週 due/.test(landed) && /下一個 ready/.test(landed), (landed || '').slice(0, 120));

    /* -------- T4.1 / T4.2 / T4.3: history + diff + restore ------------- */
    process.stdout.write('\nT4.x Project history:\n');
    await selectProject('pb');
    await waitForJs(`!!document.querySelector('.project')`);
    await js(`document.querySelector('.tab[data-view="history"]').click()`);
    const histRows = await waitForJs(`document.querySelectorAll('.hrow').length`, 8000);
    check('history lists commits', histRows >= 1, 'rows=' + histRows);
    const histText = await js(`(document.querySelector('.hrs')||{}).textContent||''`);
    check('history shows author + message', /Harness/.test(histText) && /seed pb/.test(histText), (histText || '').slice(0, 160));

    localEdit((plan) => {
      plan.tasks[0].title = 'renamed-one';
    });
    await clickSyncAndWait();
    await selectProject('pb');
    await js(`document.querySelector('.tab[data-view="history"]').click()`);
    const histRows2 = await waitForJs(`document.querySelectorAll('.hrow').length >= 2`, 8000);
    check('history lists the new commit', !!histRows2);
    await js(`document.querySelector('[data-history-diff]').click()`);
    const diffRows = await waitForJs(`document.querySelectorAll('.diffrow').length`, 8000);
    check('T4.2 diff renders task-level rows', diffRows >= 1, 'rows=' + diffRows);
    const diffText = await js(`(document.querySelector('.difflist')||{}).textContent||''`);
    check('T4.2 diff is task-level (not raw JSON)', /標題|T1\.1|已完成|未完成/.test(diffText) && !/schema/.test(diffText), (diffText || '').slice(0, 160));

    await js(`(() => { const rows=[...document.querySelectorAll('[data-history-restore]')]; if (rows[1]) rows[1].click(); return rows.length; })()`);
    const confirmShown = await waitForJs(`!document.getElementById('confirm').hidden`, 5000);
    check('T4.3 restore opens the confirm modal', !!confirmShown);
    await js(`document.getElementById('confirm-ok').click()`);
    await delay(900);
    const titleAfterRestore = readJson(PBDIR, 'plan.json').tasks[0].title;
    check('T4.3 restore reverted the file to the commit', titleAfterRestore === 'one', titleAfterRestore);

    /* -------- T6.1: two-writer edits auto-merge ------------------------ */
    process.stdout.write('\nT6.1 two-writer field-level merge (auto):\n');
    remoteEdit((plan) => {
      plan.tasks[1].title = 'REMOTE-EDIT-T2';
    }, 'remote edits T2.1');
    localEdit((plan) => {
      plan.tasks[0].title = 'LOCAL-EDIT-T1';
    });
    await selectProject('pb');
    const sync1 = await clickSyncAndWait();
    check('T6.1 sync completes without a conflict UI', sync1 === 'done', 'sync=' + sync1 + ' toast=' + (await toastText()));
    const mergedPlan = readJson(PBDIR, 'plan.json');
    check(
      'T6.1 merged plan keeps BOTH edits',
      mergedPlan.tasks[0].title === 'LOCAL-EDIT-T1' && mergedPlan.tasks[1].title === 'REMOTE-EDIT-T2',
      JSON.stringify(mergedPlan.tasks.map((t) => t.title))
    );

    /* -------- T6.2: same-task conflict raises the UI ------------------- */
    process.stdout.write('\nT6.2 same-task conflict UI:\n');
    remoteEdit((plan) => {
      plan.tasks[0].title = 'REMOTE-SECOND';
    }, 'remote edits T1.1');
    localEdit((plan) => {
      plan.tasks[0].title = 'LOCAL-SECOND';
    });
    await selectProject('pb');
    const sync2 = await clickSyncAndWait();
    check('T6.2 same-task conflict raises the conflict UI', sync2 === 'conflict', 'sync=' + sync2 + ' toast=' + (await toastText()));
    if (sync2 !== 'conflict') {
      try { process.stdout.write('    DEBUG plan=' + fs.readFileSync(path.join(PBDIR, 'plan.json'), 'utf8').slice(0, 220).replace(/\n/g, '') + '\n'); } catch (_) {}
      try { process.stdout.write('    DEBUG log=' + git(['log', '--oneline', '-6'], PBDIR).replace(/\n/g, ' | ') + '\n'); } catch (_) {}
    }
    const crowText = await js(`(document.querySelector('.clist')||{}).textContent||''`);
    check('conflict UI shows both sides', /LOCAL-SECOND/.test(crowText) && /REMOTE-SECOND/.test(crowText), (crowText || '').slice(0, 220));

    const applied = await js(
      `(() => { const a=document.querySelector('[data-conflict-all-theirs]'); const b=document.querySelector('[data-conflict-apply]'); if(!a||!b) return false; a.click(); b.click(); return true; })()`
    );
    check('conflict UI exposes apply controls', !!applied);
    const conflictGone = await waitForJs(`!document.querySelector('.conflictpanel')`, 20000);
    check('T6.2 applying the resolution clears the conflict UI', !!conflictGone);
    const finalPlan = readJson(PBDIR, 'plan.json');
    check('T6.2 resolution took theirs (REMOTE-SECOND)', finalPlan.tasks[0].title === 'REMOTE-SECOND', finalPlan.tasks[0].title);

    process.stdout.write('\nRenderer health:\n');
    check('no renderer errors', errors.length === 0, errors.slice(0, 4).join(' | '));
  } catch (err) {
    errors.push('harness exception: ' + (err && err.stack ? err.stack : err));
    check('harness ran without throwing', false, String((err && err.message) || err));
  }

  try {
    fs.rmSync(BASE, { recursive: true, force: true });
  } catch (_) {
    /* best effort */
  }

  const failed = results.filter((r) => !r.ok).length;
  process.stdout.write('\nchecks: ' + (results.length - failed) + ' passed, ' + failed + ' failed\n');
  process.stdout.write(failed === 0 ? 'RESULT: PASS\n' : 'RESULT: FAIL\n');
  app.exit(failed === 0 ? 0 : 1);
});
