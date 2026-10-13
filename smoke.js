'use strict';

/* ==========================================================================
   smoke.js — fresh-install smoke test (no data root or fixture needed).

   Proves the three layers a NEW CLONE depends on — the class of failure that
   once shipped: the app worked on the author's machine (a local, gitignored
   project-console.config.json masked the bug) while every fresh clone died
   before the window opened.

     1. MODULE LOAD — the pure-Node modules load from a config-less copy
                      (exactly the fresh-clone condition).
     2. DATA LAYER  — scan a minimal temp fixture, tick a task, verify the write.
     3. APP BOOT    — spawn the real Electron app (`electron . --smoke-exit`)
                      against the fixture and wait for the UI to render.
                      Skipped with a note when electron is not installed
                      (run `npm install` first; CI always installs it).

   Run:  npm run smoke        exit 0 = PASS, 1 = FAIL.
   CI:   .github/workflows/ci.yml runs this on every push.
   ========================================================================== */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROOT = __dirname;
let failed = 0;
const temps = [];
function check(label, cond, detail) {
  process.stdout.write(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && detail ? ' — ' + detail : ''}\n`);
  if (!cond) failed++;
}
function mkTemp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
const tail = (s, n = 8) => String(s || '').trim().split('\n').slice(-n).join('\n    ');
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (_) {
      /* already gone */
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (_) {
      /* already gone */
    }
  }
}

console.log('Project Console — smoke test (fresh install)');
console.log('');

/* -- 1. module load from a config-less copy ------------------------------- */

console.log('Module load (fresh-clone condition, no config file):');
{
  const dir = mkTemp('pc-smoke-load-');
  for (const f of ['data.js', 'git-identity.js', 'github.js', 'gitx.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
  fs.writeFileSync(
    path.join(dir, 'load-probe.js'),
    [
      "'use strict';",
      "const assert = require('assert');",
      "const data = require('./data.js');",
      "require('./gitx.js');",
      "require('./github.js');",
      "require('./git-identity.js');",
      "assert.ok(typeof data.DEFAULT_ROOT === 'string' && data.DEFAULT_ROOT, 'DEFAULT_ROOT unresolved');",
      "assert.ok(typeof data.scanProjects === 'function', 'scanProjects missing');",
      "assert.ok(typeof data.setTaskDone === 'function', 'setTaskDone missing');",
      "process.stdout.write('LOAD-OK');",
      '',
    ].join('\n'),
    'utf8'
  );
  const env = { ...process.env };
  delete env.PROJECT_CONSOLE_ROOT;
  const r = spawnSync(process.execPath, ['load-probe.js'], { cwd: dir, env, encoding: 'utf8' });
  check(
    'all modules load with no config file (the bug that shipped)',
    r.status === 0 && String(r.stdout || '').includes('LOAD-OK'),
    tail(r.stderr || r.stdout)
  );
}

/* -- 2. data layer round-trip --------------------------------------------- */

console.log('');
console.log('Data layer (temp fixture):');

const data = require('./data.js');

const dataRoot = mkTemp('pc-smoke-data-');
const projDir = path.join(dataRoot, 'smoketest');
{
  fs.mkdirSync(projDir);
  fs.writeFileSync(
    path.join(projDir, 'plan.json'),
    JSON.stringify(
      {
        schema: 'omo-project/plan@2',
        id: 'smoketest',
        title: 'Smoke Test',
        created: '2026-01-01',
        target: '2026-12-31',
        phases: [{ id: 'P1', name: 'Phase 1' }],
        tasks: [
          {
            id: 'T1.1',
            phase: 'P1',
            title: 'task one',
            deliverable: '',
            deps: [],
            owner: '',
            start: '2026-01-01',
            estimate_days: 1,
            acceptance: '',
            outputs: [],
          },
        ],
        milestones: [],
        risks: [],
      },
      null,
      2
    ),
    'utf8'
  );
  const scan = data.scanProjects(dataRoot);
  check(
    'fixture scans to 1 project',
    scan.projects.length === 1 && scan.projects[0].id === 'smoketest',
    scan.warnings.join('; ')
  );
  const tick = data.setTaskDone(dataRoot, 'smoketest', 'T1.1', true);
  let ticked = false;
  try {
    ticked = JSON.parse(fs.readFileSync(path.join(projDir, 'progress.json'), 'utf8')).tasks['T1.1'].done === true;
  } catch (_) {
    /* ticked stays false */
  }
  check('tick round-trip writes progress.json', tick.ok === true && ticked, tick.error);
}

/* -- 3. app boot ---------------------------------------------------------- */

(async () => {
  console.log('');
  console.log('App boot (electron):');

  let electronPath = null;
  try {
    electronPath = require('electron');
  } catch (_) {
    /* not installed */
  }

  if (typeof electronPath !== 'string' || !fs.existsSync(electronPath)) {
    console.log('  skip — electron not installed (run `npm install` first; the CI job always installs it)');
  } else {
    const child = spawn(electronPath, ['.', '--smoke-exit'], {
      cwd: ROOT,
      env: { ...process.env, PROJECT_CONSOLE_ROOT: dataRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ code: null, timedOut: true }), 45000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, timedOut: false });
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: -1, timedOut: false, spawnError: e.message });
      });
    });
    if (result.timedOut) killTree(child.pid);
    check(
      'electron app boots, renders the rail and exits cleanly (--smoke-exit)',
      !result.timedOut && result.code === 0,
      result.timedOut
        ? 'timed out after 45 s'
        : `exit ${result.code}${result.spawnError ? ' (' + result.spawnError + ')' : ''}\n    stdout: ${tail(out)}\n    stderr: ${tail(err)}`
    );
  }

  /* -- summary ------------------------------------------------------------ */

  console.log('');
  for (const d of temps) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch (_) {
      /* best effort */
    }
  }
  console.log(failed === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failed} failed)`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('smoke crashed: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
