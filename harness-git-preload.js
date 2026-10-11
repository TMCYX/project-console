'use strict';

/* ==========================================================================
   harness-git-preload.js — REAL data-layer api for the git acceptance harness
   ONLY. Unlike harness-preload.js (inert stubs), this wires window.api to the
   real ./data.js git layer, operating on a TEMP root passed via PC_HARNESS_ROOT
   and a temp bare "origin" passed via PC_HARNESS_ORIGIN. Never touches the
   vault or the real app repo.
   ========================================================================== */

const path = require('path');
const { contextBridge } = require('electron');
const data = require('./data');
const gitx = require('./gitx');

// A full git identity for the harness so commits never fail on this machine.
process.env.GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || 'Harness';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || 'harness@example.com';
process.env.GIT_COMMITTER_NAME = process.env.GIT_COMMITTER_NAME || 'Harness';
process.env.GIT_COMMITTER_EMAIL = process.env.GIT_COMMITTER_EMAIL || 'harness@example.com';

const ROOT = process.env.PC_HARNESS_ROOT;
const roots = [ROOT];
const ok = (extra) => Object.assign({ ok: true }, extra || {});

/**
 * Fake `gh` runner for the harness: simulates `repo create`, and failure modes
 * keyed off the repo name (contains "harness-taken" / "-needauth" / "-noght").
 * It never touches the network or GitHub, so no real repo is ever created.
 */
async function harnessGh(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const text = args.join(' ');
  const m = /harness-(taken|needauth|noght)/.exec(text);
  if (m) {
    if (m[1] === 'taken') return { ok: false, code: 1, stdout: '', stderr: 'GraphQL: Name already exists on this account (createRepository)' };
    if (m[1] === 'needauth') return { ok: false, code: 1, stdout: '', stderr: 'To get started with GitHub CLI, please run: gh auth login' };
    if (m[1] === 'noght') return { ok: false, code: 1, stdout: '', stderr: 'gh: command not found' };
  }
  if (args[0] === 'repo' && args[1] === 'create') {
    return { ok: true, code: 0, stdout: '✓ Created repository ' + (args[2] || 'harnessuser/repo') + ' on GitHub\n', stderr: '' };
  }
  return { ok: true, code: 0, stdout: '', stderr: '' };
}

function payload() {
  const p = data.scanRoots(roots);
  return { root: roots[0], roots: roots.slice(), warnings: p.warnings, projects: p.projects };
}

contextBridge.exposeInMainWorld('api', {
  getProjects: async () => payload(),
  refresh: async () => payload(),
  getMeta: async () => ({ root: roots[0], roots: roots.slice(), version: 'harness-git' }),
  onUpdate: () => () => {},

  // writes the harness exercises
  setTaskDone: async (projectId, taskId, done) => data.setTaskDone(roots, projectId, taskId, done),

  // real git layer
  gitStatus: async (projectId) => data.gitStatus(roots, projectId),
  gitReadBinding: async (projectId) => data.readBinding(roots, projectId),
  gitPull: async (projectId) => data.gitPull(roots, projectId),
  gitCommit: async (projectId, message, opts) => data.gitCommit(roots, projectId, message, opts),
  gitPush: async (projectId) => data.gitPush(roots, projectId),
  gitInit: async (projectId, opts) => data.gitInit(roots, projectId, opts),
  gitBind: async (projectId, remote, opts) => data.gitBind(roots, projectId, remote, opts),
  gitSync: async (projectId, opts) => gitx.syncProject(roots, projectId, opts),
  gitClone: async (url, destDir) => {
    const r = await data.gitClone(url, destDir);
    if (r && r.ok && r.dir) {
      const parent = path.dirname(r.dir);
      if (!roots.includes(parent)) roots.push(parent);
    }
    return r;
  },
  gitRoots: async () => roots.slice(),

  // P3-P6 (real)
  shareInfo: async (projectId) => gitx.shareInfo(roots, projectId),
  shareAccess: async (projectId) => gitx.checkAccess(roots, projectId),
  shareInvite: async (projectId, user, permission) => gitx.inviteCollaborator(roots, projectId, user, permission),
  shareRemove: async (projectId, user) => gitx.removeCollaborator(roots, projectId, user),
  historyLog: async (projectId, opts) => gitx.historyLog(roots, projectId, opts),
  historyDiff: async (projectId, sha) => gitx.commitDiff(roots, projectId, sha),
  historyRestore: async (projectId, sha) => gitx.restoreCommit(roots, projectId, sha),
  identity: async () => ({ ok: true, gitUser: 'Harness', ghLogin: 'harnessuser', ghInstalled: true }),
  myday: async (who, today) => gitx.collectMyTasks(data.scanRoots(roots).projects, who, today),
  gitIntegrate: async (projectId) => gitx.integrateRemote(roots, projectId, {}),
  gitResolve: async (projectId, choices) => gitx.resolveMerge(roots, projectId, choices),

  // Publish: real git (init/bind) but a FAKE gh runner — creates no real repo.
  publishProject: async (projectId, opts) => gitx.publishProject(roots, projectId, { ...(opts || {}), runGh: harnessGh }),

  // inert stubs for paths the harness never triggers
  addTask: async () => ok({ task: { id: 'T9.9' } }),
  updateTask: async () => ok(),
  deleteTask: async () => ok(),
  moveTask: async () => ok(),
  addPhase: async () => ok({ phase: { id: 'P9' } }),
  updatePhase: async () => ok(),
  deletePhase: async () => ok(),
  upsertMilestone: async () => ok({ milestone: { id: 'M9' } }),
  deleteMilestone: async () => ok(),
  setTaskDeps: async () => ok(),
  reschedule: async () => ok({ criticalPath: [] }),
  freezeBaseline: async () => ok({ baseline: { schema: 'omo-project/baseline@1', tasks: {} } }),
  getBaseline: async () => ({ ok: true, baseline: null }),
  criticalPath: async () => ok({ chain: [] }),
  exportPng: async () => ({ ok: false, canceled: true }),
  exportPdf: async () => ({ ok: false, canceled: true }),
  exportCsv: async () => ({ ok: false, canceled: true }),
  exportMd: async () => ({ ok: false, canceled: true }),
  mdSync: async () => ok({ updated: 0, added: 0 }),
  mdRead: async () => ok({ applied: [] }),
  mdImport: async () => ({ ok: false, canceled: true }),
  backupList: async () => ok({ backups: [] }),
  backupRestore: async () => ok(),
  restoreFile: async () => ok(),
  restoreFileRaw: async () => ok(),
});
