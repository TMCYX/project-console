'use strict';

/* ==========================================================================
   harness-git.js — headless acceptance harness for the team-sync layer
   (P2: T2.3 sync chip + auto commit message, T2.4 加入 Git 專案 clone flow).

   Boots the REAL renderer with harness-git-preload.js, which wires window.api
   to the REAL ./data.js git layer against a TEMP data root and a TEMP bare
   "origin" repo. Nothing here touches the vault or the real app repo.

   Run:  ./node_modules/.bin/electron harness-git.js
   ========================================================================== */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'pc-git-harness-user-')));
app.disableHardwareAcceleration();

const results = [];
function check(label, cond, detail) {
  const okFlag = !!cond;
  results.push({ label, ok: okFlag });
  process.stdout.write(`  ${okFlag ? 'ok  ' : 'FAIL'} ${label}${!okFlag && detail ? ' — ' + detail : ''}\n`);
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- temp repos --------------------------------------------------------- */

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-git-harness-'));
const DATA_ROOT = path.join(BASE, 'projects');
const SEED = path.join(BASE, 'seed');
const ORIGIN = path.join(BASE, 'origin.git');
const CLONE_BASE = path.join(BASE, 'ProjectConsole');
const CLONE_DIR = path.join(CLONE_BASE, 'harnessdemo');

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

function setupRepos() {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  fs.mkdirSync(SEED, { recursive: true });
  const plan = {
    schema: 'omo-project/plan@2',
    id: 'harnessdemo',
    title: 'Harness Demo',
    owner: 'Jack',
    created: '2026-10-11',
    target: '2026-10-20',
    protocol: 'agile',
    definition_of_done: 'done',
    scope: { in: ['x'], out: [] },
    constraints: {},
    phases: [{ id: 'P1', name: 'Do' }],
    tasks: [
      {
        id: 'T1.1',
        phase: 'P1',
        title: 'First task',
        deliverable: '',
        deps: [],
        owner: 'Jack',
        start: '2026-10-11',
        estimate_days: 1,
        acceptance: '',
        outputs: [],
      },
    ],
    milestones: [],
    risks: [],
  };
  const progress = { schema: 'omo-project/progress@1', project: 'harnessdemo', updated: null, tasks: {} };
  fs.writeFileSync(path.join(SEED, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(SEED, 'progress.json'), JSON.stringify(progress, null, 2) + '\n', 'utf8');

  git(['init', '-b', 'main'], SEED);
  git(['config', 'user.name', 'Harness'], SEED);
  git(['config', 'user.email', 'harness@example.com'], SEED);
  git(['init', '--bare', '-b', 'main', ORIGIN], BASE);
  fs.writeFileSync(
    path.join(SEED, '.pcproject.json'),
    JSON.stringify({ remote: ORIGIN, branch: 'main', projectId: 'harnessdemo' }, null, 2) + '\n',
    'utf8'
  );
  git(['add', '-A'], SEED);
  git(['commit', '-m', 'seed: initial project'], SEED);
  git(['remote', 'add', 'origin', ORIGIN], SEED);
  git(['push', '-u', 'origin', 'main'], SEED);
}

/* ---- run ---------------------------------------------------------------- */

app.whenReady().then(async () => {
  let setupErr = null;
  try {
    setupRepos();
  } catch (err) {
    setupErr = err;
  }

  process.stdout.write('\nGit-sync harness — Project Console\n\n');
  if (setupErr) {
    check('temp repos set up', false, setupErr.message);
    process.stdout.write('\nRESULT: FAIL\n');
    app.exit(1);
    return;
  }
  check('temp origin repo created', fs.existsSync(path.join(ORIGIN, 'HEAD')));

  process.env.PC_HARNESS_ROOT = DATA_ROOT;
  process.env.PC_HARNESS_ORIGIN = ORIGIN;

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
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
    let level, message;
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
  async function waitForJs(code, timeoutMs = 10000, step = 150) {
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

  try {
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await delay(900);

    // --- T2.4a: dashboard hosts the 加入 Git 專案 entry ---------------------
    process.stdout.write('\nT2.4 加入 Git 專案 (clone flow):\n');
    const hasEntry = await js(`!!document.querySelector('[data-git-clone-toggle]')`);
    check('dashboard shows 加入 Git 專案 button', hasEntry);
    await js(`document.querySelector('[data-git-clone-toggle]').click()`);
    await delay(200);
    const formOpen = await js(`!!document.querySelector('[data-git-clone-url]')`);
    check('clicking it reveals the clone form (URL + target dir)', formOpen);

    // Fill URL + target dir, submit.
    await js(`(() => {
      document.querySelector('[data-git-clone-url]').value = ${JSON.stringify(ORIGIN)};
      document.querySelector('[data-git-clone-dir]').value = ${JSON.stringify(CLONE_DIR)};
      return true;
    })()`);
    await js(`document.querySelector('[data-git-clone-go]').click()`);

    const cloned = await waitForJs(`!!document.querySelector('.project')`, 15000);
    check('after Clone the app opens the cloned project (project view renders)', !!cloned);
    check('clone landed on disk with .pcproject.json', fs.existsSync(path.join(CLONE_DIR, '.pcproject.json')));
    const railHas = await js(
      `((document.getElementById('portfolio-list')||{}).textContent||'').includes('Harness Demo')`
    );
    check('cloned project appears in the portfolio rail', !!railHas);

    // --- T2.3a: sync chip renders with the right state ----------------------
    process.stdout.write('\nT2.3 sync chip:\n');
    const chipExists = await waitForJs(`!!document.querySelector('.syncchip')`, 8000);
    check('sync chip renders for the opened project', !!chipExists);
    const cleanState = await waitForJs(`(document.querySelector('.syncchip')||{}).textContent === '已最新'`, 10000);
    check(
      'fresh clone reads 已最新',
      !!cleanState,
      await js(`(document.querySelector('.syncchip')||{}).textContent`)
    );

    // --- T2.3b: tick flips the chip to 有本地改動 --------------------------
    await js(`(() => { const t = document.querySelector('.tab[data-view="wbs"]'); if (t) t.click(); return true; })()`);
    await delay(300);
    const ticked = await js(
      `(() => { const cb = document.querySelector('.tick input[data-tick]'); if (!cb) return false; cb.click(); return true; })()`
    );
    check('a task tick box is present in WBS', !!ticked);
    const dirtyState = await waitForJs(`(document.querySelector('.syncchip')||{}).textContent === '有本地改動'`, 10000);
    check(
      'after a tick the chip reads 有本地改動',
      !!dirtyState,
      await js(`(document.querySelector('.syncchip')||{}).textContent`)
    );

    // --- T2.3c: Sync = pull → auto-commit → push ---------------------------
    process.stdout.write('\nT2.3 Sync (pull → commit → push):\n');
    await js(`document.querySelector('[data-git-sync]').click()`);
    const afterSync = await waitForJs(
      `(document.querySelector('.syncchip')||{}).textContent === '已最新'`,
      15000
    );
    check('after Sync the chip returns to 已最新', !!afterSync);
    const toastText = await js(`(document.getElementById('toast')||{}).textContent || ''`);
    check('Sync surfaces a toast describing the commit', /commit/.test(toastText), toastText);

    const subject = git(['-C', ORIGIN, 'log', '-1', '--format=%s'], BASE);
    check('origin received a commit with the auto message', subject === 'tick: T1.1 done by Jack', subject);

    process.stdout.write('\nRenderer health:\n');
    check('no renderer errors', errors.length === 0, errors.join(' | '));
  } catch (err) {
    errors.push('harness exception: ' + (err && err.stack ? err.stack : err));
    check('harness ran without throwing', false, String((err && err.message) || err));
  }

  try {
    fs.rmSync(BASE, { recursive: true, force: true });
  } catch (_) {
    /* best effort cleanup */
  }

  const failed = results.filter((r) => !r.ok).length;
  process.stdout.write('\nchecks: ' + (results.length - failed) + ' passed, ' + failed + ' failed\n');
  process.stdout.write(failed === 0 ? 'RESULT: PASS\n' : 'RESULT: FAIL\n');
  app.exit(failed === 0 ? 0 : 1);
});
