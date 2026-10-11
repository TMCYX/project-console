'use strict';

/* ==========================================================================
   harness.js — headless acceptance harness for the in-app 使用說明 guide.
   Boots the REAL renderer (renderer/index.html + renderer.js) against a stub
   window.api, so it never reads or writes the vault / data root. Asserts the
   guide's contract, then exits 0 (PASS) or 1 (FAIL).

   Run:  ./node_modules/.bin/electron harness.js
         (make sure ELECTRON_RUN_AS_NODE is unset first)
   ========================================================================== */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated userData so the harness never sees the real app's localStorage.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'pc-harness-')));
app.disableHardwareAcceleration();

const results = [];
function check(label, cond, detail) {
  const okFlag = !!cond;
  results.push({ label, ok: okFlag });
  process.stdout.write(`  ${okFlag ? 'ok  ' : 'FAIL'} ${label}${!okFlag && detail ? ' — ' + detail : ''}\n`);
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    useContentSize: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'harness-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const warnings = [];
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
    else if (lv === 2) warnings.push(String(message));
  });
  win.webContents.on('render-process-gone', (_e, d) => errors.push('render-process-gone: ' + d.reason));
  win.webContents.on('did-fail-load', (_e, code, desc) => errors.push('did-fail-load: ' + code + ' ' + desc));
  win.webContents.on('preload-error', (_e, _p, err) => errors.push('preload-error: ' + err.message));

  const js = (code) => win.webContents.executeJavaScript(code);

  try {
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    await delay(900); // let init() + first render settle

    process.stdout.write('\nGuide harness — Project Console\n\n');
    process.stdout.write('Topbar placement:\n');
    const placement = await js(`(() => {
      const meta = document.querySelector('.topbar__meta');
      const kids = [...meta.children];
      const help = document.getElementById('help-btn');
      if (!help) return { missing: true };
      const hr = help.getBoundingClientRect();
      const last = kids[kids.length - 1];
      const rightsOk = kids.every((el) => el === help || el.getBoundingClientRect().right <= hr.right + 0.5);
      return { missing: false, isLast: last === help, rightsOk, right: hr.right, label: help.textContent.trim() };
    })()`);
    check('help button exists in the topbar', !placement.missing);
    check('help button is the rightmost (last) topbar control', !placement.missing && placement.isLast);
    check(
      'help button right edge is >= every sibling control',
      !placement.missing && placement.rightsOk,
      placement.missing ? 'missing' : `right=${placement.right}`
    );
    check('help button is labelled 使用說明', !placement.missing && /使用說明/.test(placement.label || ''), placement.label);

    process.stdout.write('\nOpen / render:\n');
    await js(`document.getElementById('help-btn').click()`);
    await delay(220);
    const opened = await js(`(() => {
      const g = document.getElementById('guide');
      if (!g || g.hidden) return { open: false };
      const panel = g.querySelector('.guide__panel');
      return {
        open: true,
        panel: !!panel,
        role: panel ? panel.getAttribute('role') : '',
        sections: g.querySelectorAll('.guide__sec').length,
        toc: g.querySelectorAll('.guide__toc-item').length,
        hasClose: !!document.getElementById('guide-close'),
        hasShortcuts: !!document.getElementById('guide-shortcuts'),
        shortcutRows: document.querySelectorAll('#guide-shortcuts tbody tr').length,
      };
    })()`);
    check('clicking the help button opens the guide', opened.open && opened.panel);
    check('guide panel is a dialog', opened.role === 'dialog', opened.role);
    check('guide renders >= 10 sections', opened.sections >= 10, 'got ' + opened.sections);
    check('guide renders a TOC with >= 10 entries', opened.toc >= 10, 'got ' + opened.toc);
    check('guide renders the shortcuts table', opened.hasShortcuts && opened.shortcutRows >= 5, 'rows=' + opened.shortcutRows);
    check('guide has a close button', opened.hasClose);

    process.stdout.write('\n900px behavior:\n');
    win.setContentSize(900, 760);
    await delay(260);
    const at900 = await js(`(() => {
      const panel = document.querySelector('.guide__panel');
      const content = document.getElementById('guide-content');
      if (!panel || !content) return { missing: true };
      const pr = panel.getBoundingClientRect();
      const overflowRight = pr.right - window.innerWidth;
      const canScroll = content.scrollHeight > content.clientHeight + 2;
      content.scrollTop = content.scrollHeight;
      const scrolledToBottom = content.scrollTop > 0;
      const reachedEnd = Math.abs((content.scrollTop + content.clientHeight) - content.scrollHeight) <= 2;
      content.scrollTop = 0;
      const noHClip = content.scrollWidth <= content.clientWidth + 2;
      return { missing: false, width: window.innerWidth, canScroll, scrolledToBottom, reachedEnd, noHClip, overflowRight };
    })()`);
    check('window content width is 900px', Math.abs((at900.width || 0) - 900) <= 2, 'width=' + at900.width);
    check('at 900px the guide content is scrollable', at900.canScroll && at900.scrolledToBottom);
    check('at 900px the guide scroll reaches the very end', at900.reachedEnd);
    check('at 900px the guide panel fits the viewport', at900.overflowRight <= 0.5, 'overflowRight=' + at900.overflowRight);
    check('at 900px the guide body has no horizontal clip', at900.noHClip);

    process.stdout.write('\nDark mode:\n');
    await js(`document.documentElement.setAttribute('data-theme', 'dark')`);
    await delay(140);
    const dark = await js(`(() => {
      const panel = document.querySelector('.guide__panel');
      const cs = getComputedStyle(panel);
      const paper = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
      return { theme: document.documentElement.getAttribute('data-theme'), paper, bg: cs.backgroundColor };
    })()`);
    check('dark theme token applied', dark.theme === 'dark' && dark.paper === '#141414', JSON.stringify(dark));
    check('guide surface repaints to the dark paper', dark.bg === 'rgb(20, 20, 20)', dark.bg);
    await js(`document.documentElement.setAttribute('data-theme', 'auto')`);

    process.stdout.write('\nClose behaviour:\n');
    await js(`document.getElementById('guide').click()`);
    await delay(140);
    check('clicking outside (backdrop) closes the guide', (await js(`document.getElementById('guide').hidden`)) === true);

    await js(`document.getElementById('help-btn').click()`);
    await delay(140);
    await js(`document.getElementById('guide-close').click()`);
    await delay(140);
    check('close button closes the guide', (await js(`document.getElementById('guide').hidden`)) === true);

    await js(`document.getElementById('help-btn').click()`);
    await delay(140);
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await delay(140);
    check('Esc closes the guide', (await js(`document.getElementById('guide').hidden`)) === true);

    process.stdout.write('\nRenderer health:\n');
    check('no renderer errors', errors.length === 0, errors.join(' | '));
    if (warnings.length) process.stdout.write('  (renderer warnings: ' + warnings.length + ')\n');
  } catch (err) {
    errors.push('harness exception: ' + (err && err.stack ? err.stack : err));
    check('harness ran without throwing', false, String((err && err.message) || err));
  }

  const failed = results.filter((r) => !r.ok).length;
  process.stdout.write('\nchecks: ' + (results.length - failed) + ' passed, ' + failed + ' failed\n');
  process.stdout.write(failed === 0 ? 'RESULT: PASS\n' : 'RESULT: FAIL\n');
  app.exit(failed === 0 ? 0 : 1);
});
