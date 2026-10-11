'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Minimal bridge. The renderer never sees Node: it gets parsed project data,
 * an update subscription, and a single write call (tick a task done).
 */
contextBridge.exposeInMainWorld('api', {
  getProjects: () => ipcRenderer.invoke('projects:get'),
  refresh: () => ipcRenderer.invoke('projects:refresh'),
  getMeta: () => ipcRenderer.invoke('app:meta'),
  setTaskDone: (projectId, taskId, done) =>
    ipcRenderer.invoke('task:setDone', { projectId, taskId, done }),
  // Plan write engine.
  addTask: (projectId, phaseId, partial) => ipcRenderer.invoke('plan:addTask', { projectId, phaseId, partial }),
  updateTask: (projectId, taskId, patch) => ipcRenderer.invoke('plan:updateTask', { projectId, taskId, patch }),
  deleteTask: (projectId, taskId) => ipcRenderer.invoke('plan:deleteTask', { projectId, taskId }),
  moveTask: (projectId, taskId, opts) => ipcRenderer.invoke('plan:moveTask', { projectId, taskId, opts }),
  addPhase: (projectId, phase) => ipcRenderer.invoke('plan:addPhase', { projectId, phase }),
  updatePhase: (projectId, phaseId, patch) => ipcRenderer.invoke('plan:updatePhase', { projectId, phaseId, patch }),
  deletePhase: (projectId, phaseId, opts) => ipcRenderer.invoke('plan:deletePhase', { projectId, phaseId, opts }),
  upsertMilestone: (projectId, milestone) => ipcRenderer.invoke('plan:upsertMilestone', { projectId, milestone }),
  deleteMilestone: (projectId, id) => ipcRenderer.invoke('plan:deleteMilestone', { projectId, id }),
  setTaskDeps: (projectId, taskId, deps) => ipcRenderer.invoke('plan:setTaskDeps', { projectId, taskId, deps }),
  reschedule: (projectId) => ipcRenderer.invoke('plan:reschedule', { projectId }),
  freezeBaseline: (projectId) => ipcRenderer.invoke('plan:freezeBaseline', { projectId }),
  getBaseline: (projectId) => ipcRenderer.invoke('plan:getBaseline', { projectId }),
  criticalPath: (projectId) => ipcRenderer.invoke('plan:criticalPath', { projectId }),
  // pass 2: export / obsidian bridge / backup
  exportPng: (opts) => ipcRenderer.invoke('export:png', opts || {}),
  exportPdf: (opts) => ipcRenderer.invoke('export:pdf', opts || {}),
  exportCsv: (projectId) => ipcRenderer.invoke('export:csv', { projectId }),
  exportMd: (projectId) => ipcRenderer.invoke('export:md', { projectId }),
  mdSync: (projectId) => ipcRenderer.invoke('md:sync', { projectId }),
  mdRead: (projectId) => ipcRenderer.invoke('md:read', { projectId }),
  mdImport: (projectId, phaseId) => ipcRenderer.invoke('md:import', { projectId, phaseId }),
  backupList: (projectId) => ipcRenderer.invoke('backup:list', { projectId }),
  backupRestore: (projectId, ts) => ipcRenderer.invoke('backup:restore', { projectId, ts }),
  restoreFile: (projectId, file, content) => ipcRenderer.invoke('file:restore', { projectId, file, content }),
  restoreFileRaw: (projectId, file, raw) => ipcRenderer.invoke('file:restoreRaw', { projectId, file, raw }),
  // team sync: git layer
  gitStatus: (projectId) => ipcRenderer.invoke('git:status', { projectId }),
  gitReadBinding: (projectId) => ipcRenderer.invoke('git:readBinding', { projectId }),
  gitPull: (projectId) => ipcRenderer.invoke('git:pull', { projectId }),
  gitCommit: (projectId, message, opts) => ipcRenderer.invoke('git:commit', { projectId, message, opts }),
  gitPush: (projectId) => ipcRenderer.invoke('git:push', { projectId }),
  gitInit: (projectId, opts) => ipcRenderer.invoke('git:init', { projectId, opts }),
  gitBind: (projectId, remote, opts) => ipcRenderer.invoke('git:bind', { projectId, remote, opts }),
  gitSync: (projectId, opts) => ipcRenderer.invoke('git:sync', { projectId, opts }),
  gitClone: (url, destDir) => ipcRenderer.invoke('git:clone', { url, destDir }),
  gitRoots: () => ipcRenderer.invoke('git:roots'),
  // P3: share & permissions
  shareInfo: (projectId) => ipcRenderer.invoke('share:info', { projectId }),
  shareAccess: (projectId) => ipcRenderer.invoke('share:access', { projectId }),
  shareInvite: (projectId, user, permission) => ipcRenderer.invoke('share:invite', { projectId, user, permission }),
  shareRemove: (projectId, user) => ipcRenderer.invoke('share:remove', { projectId, user }),
  // P4: project history
  historyLog: (projectId, opts) => ipcRenderer.invoke('history:log', { projectId, opts }),
  historyDiff: (projectId, sha) => ipcRenderer.invoke('history:diff', { projectId, sha }),
  historyRestore: (projectId, sha) => ipcRenderer.invoke('history:restore', { projectId, sha }),
  // P5: identity / my-day
  identity: () => ipcRenderer.invoke('app:identity'),
  myday: (who, today) => ipcRenderer.invoke('myday:collect', { who, today }),
  // P6: merge / conflict
  gitIntegrate: (projectId) => ipcRenderer.invoke('git:integrate', { projectId }),
  gitResolve: (projectId, choices) => ipcRenderer.invoke('git:resolve', { projectId, choices }),
  // publish to GitHub (one-click)
  publishProject: (projectId, opts) => ipcRenderer.invoke('publish:project', { projectId, opts }),
  onUpdate: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('projects:update', handler);
    return () => ipcRenderer.removeListener('projects:update', handler);
  },
});
