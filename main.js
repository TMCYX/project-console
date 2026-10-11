'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  scanProjects,
  scanRoots,
  setTaskDone,
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
  restoreFileRaw,
  computeCriticalPath,
  syncTasksMd,
  readTasksMd,
  importChecklist,
  planToCsv,
  planToMarkdown,
  listBackups,
  restoreBackup,
  gitStatus,
  gitPull,
  gitCommit,
  gitPush,
  gitInit,
  gitBind,
  gitClone,
  gitSync,
  readBinding,
  validateCloneUrl,
} = require('./data');

app.setName('Project Console');
if (process.platform === 'win32') app.setAppUserModelId('com.jack.projectconsole');

/**
 * Project Console — main process (human-only model).
 * Reads plan.json + progress.json, watches the data root, pushes parsed data
 * over IPC, and performs the single sanctioned write: toggling a task's done
 * flag in <project>/progress.json (atomic, merge-preserving).
 */

const PRIMARY_ROOT = process.env.PROJECT_CONSOLE_ROOT || DEFAULT_ROOT;

/* Roots scanned by the app: the primary root plus any extra roots persisted
 * from previously cloned projects (dashboard → 加入 Git 專案). */
const dataRoots = [path.resolve(PRIMARY_ROOT)];

function rootsConfigPath() {
  try {
    return path.join(app.getPath('userData'), 'roots.json');
  } catch (_) {
    return path.join(os.homedir(), '.project-console', 'roots.json');
  }
}

function loadExtraRoots() {
  try {
    const p = rootsConfigPath();
    if (!fs.existsSync(p)) return;
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(arr)) return;
    for (const r of arr) {
      if (typeof r === 'string' && r) {
        const resolved = path.resolve(r);
        if (!dataRoots.includes(resolved)) dataRoots.push(resolved);
      }
    }
  } catch (_) {
    /* config is optional */
  }
}

function saveExtraRoots() {
  try {
    const p = rootsConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const extra = dataRoots.filter((r) => r !== path.resolve(PRIMARY_ROOT));
    fs.writeFileSync(p, JSON.stringify(extra, null, 2) + '\n', 'utf8');
  } catch (_) {
    /* best effort */
  }
}

/** Register an additional data root (e.g. the parent of a freshly cloned project). */
function addRoot(dir) {
  const resolved = path.resolve(dir);
  if (dataRoots.includes(resolved)) return false;
  dataRoots.push(resolved);
  saveExtraRoots();
  if (watching) watchRoot(resolved);
  return true;
}
const POLL_INTERVAL_MS = 5000;
const WATCH_DEBOUNCE_MS = 300;

let mainWindow = null;
let watchers = [];
let watching = false;
let pollTimer = null;
let debounceTimer = null;
let lastSignature = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f3f1ec',
    title: 'Project Console',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function broadcast(reason) {
  const payload = scanRoots(dataRoots);
  const signature = JSON.stringify(payload.projects);
  if (signature !== lastSignature) {
    lastSignature = signature;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('projects:update', { ...payload, reason });
    }
  }
  return payload;
}

function scheduleBroadcast(reason) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    broadcast(reason);
  }, WATCH_DEBOUNCE_MS);
}

function watchRoot(root) {
  try {
    const w = fs.watch(root, { recursive: true }, () => scheduleBroadcast('fs'));
    w.on('error', (err) => console.warn('[project-console] watcher error:', err.message));
    watchers.push(w);
  } catch (err) {
    console.warn(`[project-console] fs.watch unavailable for ${root}: ${err.message}`);
  }
}

function startWatcher() {
  watching = true;
  for (const root of dataRoots) watchRoot(root);
  pollTimer = setInterval(() => broadcast('poll'), POLL_INTERVAL_MS);
}

ipcMain.handle('projects:get', () => {
  const payload = scanRoots(dataRoots);
  lastSignature = JSON.stringify(payload.projects);
  return payload;
});

ipcMain.handle('projects:refresh', () => broadcast('manual'));

ipcMain.handle('app:meta', () => ({ root: dataRoots[0], roots: dataRoots.slice(), version: app.getVersion() }));

/** Run a write op, broadcast on success, log on failure. */
function respond(name, res) {
  if (res && res.ok) broadcast('plan');
  else if (res && res.error) console.warn(`[project-console] ${name} failed: ${res.error}`);
  return res;
}

// Progress write (tick).
ipcMain.handle('task:setDone', (_event, arg = {}) =>
  respond('setTaskDone', setTaskDone(dataRoots, arg.projectId, arg.taskId, !!arg.done))
);

// Plan write engine.
ipcMain.handle('plan:addTask', (_e, a = {}) => respond('addTask', addTask(dataRoots, a.projectId, a.phaseId, a.partial)));
ipcMain.handle('plan:updateTask', (_e, a = {}) => respond('updateTask', updateTask(dataRoots, a.projectId, a.taskId, a.patch)));
ipcMain.handle('plan:deleteTask', (_e, a = {}) => respond('deleteTask', deleteTask(dataRoots, a.projectId, a.taskId)));
ipcMain.handle('plan:moveTask', (_e, a = {}) => respond('moveTask', moveTask(dataRoots, a.projectId, a.taskId, a.opts)));
ipcMain.handle('plan:addPhase', (_e, a = {}) => respond('addPhase', addPhase(dataRoots, a.projectId, a.phase)));
ipcMain.handle('plan:updatePhase', (_e, a = {}) => respond('updatePhase', updatePhase(dataRoots, a.projectId, a.phaseId, a.patch)));
ipcMain.handle('plan:deletePhase', (_e, a = {}) => respond('deletePhase', deletePhase(dataRoots, a.projectId, a.phaseId, a.opts)));
ipcMain.handle('plan:upsertMilestone', (_e, a = {}) => respond('upsertMilestone', upsertMilestone(dataRoots, a.projectId, a.milestone)));
ipcMain.handle('plan:deleteMilestone', (_e, a = {}) => respond('deleteMilestone', deleteMilestone(dataRoots, a.projectId, a.id)));
ipcMain.handle('plan:setTaskDeps', (_e, a = {}) => respond('setTaskDeps', setTaskDeps(dataRoots, a.projectId, a.taskId, a.deps)));
ipcMain.handle('plan:reschedule', (_e, a = {}) => respond('reschedule', reschedule(dataRoots, a.projectId)));
ipcMain.handle('plan:freezeBaseline', (_e, a = {}) => respond('freezeBaseline', freezeBaseline(dataRoots, a.projectId)));
ipcMain.handle('plan:getBaseline', (_e, a = {}) => getBaseline(dataRoots, a && a.projectId));
ipcMain.handle('plan:criticalPath', (_e, a = {}) => {
  const proj = scanProjects(dataRoots).projects.find((p) => p.id === (a && a.projectId));
  if (!proj) return { ok: false, error: 'project not found' };
  const cp = computeCriticalPath({ tasks: proj.tasks });
  return { ok: true, chain: cp.chain, totalDays: cp.totalDays };
});
ipcMain.handle('file:restore', (_e, a = {}) => respond('restoreFile', restoreFile(dataRoots, a.projectId, a.file, a.content)));
ipcMain.handle('file:restoreRaw', (_e, a = {}) => respond('restoreFileRaw', restoreFileRaw(dataRoots, a.projectId, a.file, a.raw)));

/* -------- pass 2: export / obsidian bridge / backup --------------------- */

function activeWindow() {
  return BrowserWindow.getFocusedWindow() || mainWindow;
}

ipcMain.handle('export:png', async (_e, a = {}) => {
  const win = activeWindow();
  if (!win) return { ok: false, error: 'no window' };
  let img;
  try {
    img = await win.webContents.capturePage(a.rect || undefined);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: (a.name || 'project-console') + '-screenshot.png',
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    const buf = img.toPNG();
    fs.writeFileSync(filePath, buf);
    return { ok: true, path: filePath, bytes: buf.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('export:pdf', async (_e, a = {}) => {
  const win = activeWindow();
  if (!win) return { ok: false, error: 'no window' };
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: (a.name || 'project-console') + '-report.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    // Render the FULL export layout (whole Gantt + whole WBS, un-clipped) then print.
    await win.webContents.executeJavaScript('window.__pcEnterPrintExport && window.__pcEnterPrintExport();');
    await new Promise((r) => setTimeout(r, 450)); // let the export layout settle
    const data = await win.webContents.printToPDF({ landscape: true, printBackground: true, preferCSSPageSize: true });
    await win.webContents.executeJavaScript('window.__pcExitPrintExport && window.__pcExitPrintExport();');
    fs.writeFileSync(filePath, data);
    return { ok: true, path: filePath, bytes: data.length };
  } catch (err) {
    try {
      await win.webContents.executeJavaScript('window.__pcExitPrintExport && window.__pcExitPrintExport();');
    } catch (_) {
      /* ignore */
    }
    return { ok: false, error: err.message };
  }
});

async function exportText(win, content, filename, ext, name) {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: filename,
    filters: [{ name, extensions: [ext] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true, path: filePath, bytes: Buffer.byteLength(content) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

ipcMain.handle('export:csv', async (_e, a = {}) => {
  const win = activeWindow();
  if (!win) return { ok: false, error: 'no window' };
  const r = planToCsv(dataRoots, a.projectId);
  if (!r.ok) return r;
  return exportText(win, r.content, r.filename, 'csv', 'CSV');
});

ipcMain.handle('export:md', async (_e, a = {}) => {
  const win = activeWindow();
  if (!win) return { ok: false, error: 'no window' };
  const r = planToMarkdown(dataRoots, a.projectId);
  if (!r.ok) return r;
  return exportText(win, r.content, r.filename, 'md', 'Markdown');
});

ipcMain.handle('md:sync', (_e, a = {}) => respond('syncTasksMd', syncTasksMd(dataRoots, a.projectId)));
ipcMain.handle('md:read', (_e, a = {}) => respond('readTasksMd', readTasksMd(dataRoots, a.projectId)));

ipcMain.handle('md:import', async (_e, a = {}) => {
  const win = activeWindow();
  if (!win) return { ok: false, error: 'no window' };
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
  });
  if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };
  let text;
  try {
    text = fs.readFileSync(filePaths[0], 'utf8');
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return respond('importChecklist', importChecklist(dataRoots, a.projectId, a.phaseId, text));
});

ipcMain.handle('backup:list', (_e, a = {}) => listBackups(dataRoots, a && a.projectId));
ipcMain.handle('backup:restore', (_e, a = {}) => respond('restoreBackup', restoreBackup(dataRoots, a.projectId, a.ts)));

/* -------- team sync: git layer ------------------------------------------- */

// Read-only status: never broadcasts (polling status must not clobber UI).
ipcMain.handle('git:status', (_e, a = {}) => gitStatus(dataRoots, a.projectId));
ipcMain.handle('git:readBinding', (_e, a = {}) => readBinding(dataRoots, a.projectId));

ipcMain.handle('git:pull', async (_e, a = {}) => {
  const r = await gitPull(dataRoots, a.projectId);
  if (r.ok) broadcast('git');
  else console.warn('[project-console] gitPull failed:', r.error);
  return r;
});
ipcMain.handle('git:commit', async (_e, a = {}) => {
  const r = await gitCommit(dataRoots, a.projectId, a.message, a.opts);
  if (r.ok) broadcast('git');
  return r;
});
ipcMain.handle('git:push', async (_e, a = {}) => {
  const r = await gitPush(dataRoots, a.projectId);
  if (r.ok) broadcast('git');
  else console.warn('[project-console] gitPush failed:', r.error);
  return r;
});
ipcMain.handle('git:init', async (_e, a = {}) => {
  const r = await gitInit(dataRoots, a.projectId, a.opts);
  if (r.ok) broadcast('git');
  return r;
});
ipcMain.handle('git:bind', async (_e, a = {}) => {
  const r = await gitBind(dataRoots, a.projectId, a.remote, a.opts);
  if (r.ok) broadcast('git');
  else console.warn('[project-console] gitBind failed:', r.error);
  return r;
});
ipcMain.handle('git:sync', async (_e, a = {}) => {
  const r = await gitSync(dataRoots, a.projectId, a.opts || {});
  if (r.ok) broadcast('git');
  else console.warn('[project-console] gitSync failed:', r.error);
  return r;
});

// T2.4: clone a repo (default ~/ProjectConsole/<name>) and register its parent
// dir as a data root so the app can open it immediately.
ipcMain.handle('git:clone', async (_e, a = {}) => {
  const v = validateCloneUrl(a && a.url);
  if (v.error) return { ok: false, error: v.error };
  let dest = a && a.destDir;
  if (!dest) {
    const name = (path.basename(v.url.replace(/[\\/]+$/, '')).replace(/\.git$/i, '') || 'project').replace(
      /[\\/:*?"<>|]/g,
      '-'
    );
    if (!name || name === '.' || name === '..') return { ok: false, error: 'cannot derive a project name from the url' };
    dest = path.join(os.homedir(), 'ProjectConsole', name);
  }
  const r = await gitClone(v.url, dest);
  if (r.ok && r.dir) {
    addRoot(path.dirname(r.dir));
    broadcast('git');
  }
  return r;
});

ipcMain.handle('git:roots', () => dataRoots.slice());
ipcMain.handle('git:addRoot', (_e, a = {}) => {
  const ok = a && a.dir ? addRoot(a.dir) : false;
  if (ok) broadcast('git');
  return { ok, roots: dataRoots.slice() };
});

app.whenReady().then(() => {
  loadExtraRoots();
  createWindow();
  startWatcher();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (pollTimer) clearInterval(pollTimer);
  if (debounceTimer) clearTimeout(debounceTimer);
  for (const w of watchers) {
    try {
      w.close();
    } catch (_) {
      /* ignore */
    }
  }
  watchers = [];
  if (process.platform !== 'darwin') app.quit();
});
