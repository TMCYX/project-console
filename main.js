'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const {
  scanProjects,
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
} = require('./data');

app.setName('Project Console');
if (process.platform === 'win32') app.setAppUserModelId('com.jack.projectconsole');

/**
 * Project Console — main process (human-only model).
 * Reads plan.json + progress.json, watches the data root, pushes parsed data
 * over IPC, and performs the single sanctioned write: toggling a task's done
 * flag in <project>/progress.json (atomic, merge-preserving).
 */

const DATA_ROOT = process.env.PROJECT_CONSOLE_ROOT || DEFAULT_ROOT;
const POLL_INTERVAL_MS = 5000;
const WATCH_DEBOUNCE_MS = 300;

let mainWindow = null;
let watcher = null;
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
  const payload = scanProjects(DATA_ROOT);
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

function startWatcher() {
  try {
    watcher = fs.watch(DATA_ROOT, { recursive: true }, () => scheduleBroadcast('fs'));
    watcher.on('error', (err) => console.warn('[project-console] watcher error:', err.message));
  } catch (err) {
    console.warn('[project-console] fs.watch unavailable:', err.message);
  }
  pollTimer = setInterval(() => broadcast('poll'), POLL_INTERVAL_MS);
}

ipcMain.handle('projects:get', () => {
  const payload = scanProjects(DATA_ROOT);
  lastSignature = JSON.stringify(payload.projects);
  return payload;
});

ipcMain.handle('projects:refresh', () => broadcast('manual'));

ipcMain.handle('app:meta', () => ({ root: DATA_ROOT, version: app.getVersion() }));

/** Run a write op, broadcast on success, log on failure. */
function respond(name, res) {
  if (res && res.ok) broadcast('plan');
  else if (res && res.error) console.warn(`[project-console] ${name} failed: ${res.error}`);
  return res;
}

// Progress write (tick).
ipcMain.handle('task:setDone', (_event, arg = {}) =>
  respond('setTaskDone', setTaskDone(DATA_ROOT, arg.projectId, arg.taskId, !!arg.done))
);

// Plan write engine.
ipcMain.handle('plan:addTask', (_e, a = {}) => respond('addTask', addTask(DATA_ROOT, a.projectId, a.phaseId, a.partial)));
ipcMain.handle('plan:updateTask', (_e, a = {}) => respond('updateTask', updateTask(DATA_ROOT, a.projectId, a.taskId, a.patch)));
ipcMain.handle('plan:deleteTask', (_e, a = {}) => respond('deleteTask', deleteTask(DATA_ROOT, a.projectId, a.taskId)));
ipcMain.handle('plan:moveTask', (_e, a = {}) => respond('moveTask', moveTask(DATA_ROOT, a.projectId, a.taskId, a.opts)));
ipcMain.handle('plan:addPhase', (_e, a = {}) => respond('addPhase', addPhase(DATA_ROOT, a.projectId, a.phase)));
ipcMain.handle('plan:updatePhase', (_e, a = {}) => respond('updatePhase', updatePhase(DATA_ROOT, a.projectId, a.phaseId, a.patch)));
ipcMain.handle('plan:deletePhase', (_e, a = {}) => respond('deletePhase', deletePhase(DATA_ROOT, a.projectId, a.phaseId, a.opts)));
ipcMain.handle('plan:upsertMilestone', (_e, a = {}) => respond('upsertMilestone', upsertMilestone(DATA_ROOT, a.projectId, a.milestone)));
ipcMain.handle('plan:deleteMilestone', (_e, a = {}) => respond('deleteMilestone', deleteMilestone(DATA_ROOT, a.projectId, a.id)));
ipcMain.handle('plan:setTaskDeps', (_e, a = {}) => respond('setTaskDeps', setTaskDeps(DATA_ROOT, a.projectId, a.taskId, a.deps)));
ipcMain.handle('plan:reschedule', (_e, a = {}) => respond('reschedule', reschedule(DATA_ROOT, a.projectId)));
ipcMain.handle('plan:freezeBaseline', (_e, a = {}) => respond('freezeBaseline', freezeBaseline(DATA_ROOT, a.projectId)));
ipcMain.handle('plan:getBaseline', (_e, a = {}) => getBaseline(DATA_ROOT, a && a.projectId));
ipcMain.handle('plan:criticalPath', (_e, a = {}) => {
  const proj = scanProjects(DATA_ROOT).projects.find((p) => p.id === (a && a.projectId));
  if (!proj) return { ok: false, error: 'project not found' };
  const cp = computeCriticalPath({ tasks: proj.tasks });
  return { ok: true, chain: cp.chain, totalDays: cp.totalDays };
});
ipcMain.handle('file:restore', (_e, a = {}) => respond('restoreFile', restoreFile(DATA_ROOT, a.projectId, a.file, a.content)));
ipcMain.handle('file:restoreRaw', (_e, a = {}) => respond('restoreFileRaw', restoreFileRaw(DATA_ROOT, a.projectId, a.file, a.raw)));

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
  const r = planToCsv(DATA_ROOT, a.projectId);
  if (!r.ok) return r;
  return exportText(win, r.content, r.filename, 'csv', 'CSV');
});

ipcMain.handle('export:md', async (_e, a = {}) => {
  const win = activeWindow();
  if (!win) return { ok: false, error: 'no window' };
  const r = planToMarkdown(DATA_ROOT, a.projectId);
  if (!r.ok) return r;
  return exportText(win, r.content, r.filename, 'md', 'Markdown');
});

ipcMain.handle('md:sync', (_e, a = {}) => respond('syncTasksMd', syncTasksMd(DATA_ROOT, a.projectId)));
ipcMain.handle('md:read', (_e, a = {}) => respond('readTasksMd', readTasksMd(DATA_ROOT, a.projectId)));

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
  return respond('importChecklist', importChecklist(DATA_ROOT, a.projectId, a.phaseId, text));
});

ipcMain.handle('backup:list', (_e, a = {}) => listBackups(DATA_ROOT, a && a.projectId));
ipcMain.handle('backup:restore', (_e, a = {}) => respond('restoreBackup', restoreBackup(DATA_ROOT, a.projectId, a.ts)));

app.whenReady().then(() => {
  createWindow();
  startWatcher();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (pollTimer) clearInterval(pollTimer);
  if (debounceTimer) clearTimeout(debounceTimer);
  if (watcher) {
    try {
      watcher.close();
    } catch (_) {
      /* ignore */
    }
  }
  if (process.platform !== 'darwin') app.quit();
});
