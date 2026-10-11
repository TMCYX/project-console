'use strict';

/* ==========================================================================
   harness-preload.js — stub window.api for the acceptance harness ONLY.
   Returns a fixed in-memory payload so the real renderer boots without any
   access to the vault / data root. Never loaded by the real app.
   ========================================================================== */

const { contextBridge } = require('electron');

const payload = {
  root: 'C:\\harness\\projects',
  warnings: [],
  projects: [
    {
      id: '_demo',
      title: 'Demo — Product Launch Video',
      schema: 'omo-project/plan@2',
      owner: 'Jack',
      created: '2026-10-11',
      target: '2026-10-21',
      definition_of_done: '最終 MP4 上載到 YouTube 並取得連結。',
      scope: { in: ['腳本', '旁白'], out: ['3D 動畫'] },
      constraints: { time: '10 日', resource: '2 人', procedure: 'CapCut', scope: '凍結' },
      resources: { people: [{ name: 'Jack', role: 'Lead', note: '', weekly_hours: 8 }] },
      phases: [
        { id: 'P1', name: 'Script' },
        { id: 'P2', name: 'Assets' },
        { id: 'P3', name: 'Edit' },
      ],
      tasks: [
        {
          id: 'T1.1', phase: 'P1', title: 'Write script + storyboard', deliverable: 'script.md',
          deps: [], owner: 'Jack', start: '2026-10-11', estimate_days: 1, acceptance: '三段式腳本',
          outputs: ['artifacts/script.md'], done: false, status: 'pending',
          plannedEnd: '2026-10-12', plannedEndExclusive: '2026-10-12', note: '',
        },
        {
          id: 'T2.1', phase: 'P2', title: 'Source product shots', deliverable: '5 張產品圖',
          deps: ['T1.1'], owner: 'Dorian', start: '2026-10-12', estimate_days: 1, acceptance: '1080p+',
          outputs: ['artifacts/shots/'], done: true, status: 'done',
          plannedEnd: '2026-10-13', plannedEndExclusive: '2026-10-13', doneAt: '2026-10-13', note: '',
        },
        {
          id: 'T3.1', phase: 'P3', title: 'Cut the video', deliverable: 'video.mp4',
          deps: ['T2.1'], owner: 'Jack', start: '2026-10-14', estimate_days: 3, acceptance: '順',
          outputs: ['artifacts/video.mp4'], done: false, status: 'pending',
          plannedEnd: '2026-10-17', plannedEndExclusive: '2026-10-17', note: '',
        },
      ],
      milestones: [{ id: 'M1', name: 'Rough cut', date: '2026-10-15', after: ['T2.1'] }],
      risks: [{ id: 'R1', risk: '素材延遲', likelihood: 'medium', impact: 'high', response: '提早拍', owner: 'Jack', note: '' }],
      summary: {
        percent: 33, tasksDone: 1, tasksTotal: 3, overdue: 0, late: 0, rag: 'amber',
        owners: ['Dorian', 'Jack'], nextMilestone: { id: 'M1', date: '2026-10-15' },
        lastUpdated: '2026-10-13T10:00:00+08:00',
      },
      progress: { schema: 'omo-project/progress@1' },
      danglingRefs: [],
    },
  ],
};

const ok = (extra) => Object.assign({ ok: true }, extra || {});

contextBridge.exposeInMainWorld('api', {
  getProjects: async () => payload,
  refresh: async () => payload,
  getMeta: async () => ({ root: payload.root, version: 'harness' }),
  onUpdate: () => () => {},
  setTaskDone: async () => ok({ progress: {} }),
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
  // team sync (git) — inert stubs so the renderer boots without a real repo
  gitStatus: async () => ({
    ok: true, isRepo: false, remote: null, branch: null, ahead: 0, behind: 0,
    dirty: false, lastCommit: null, bound: false, hasUpstream: false, binding: null,
  }),
  gitReadBinding: async () => ({ ok: true, binding: null }),
  gitPull: async () => ok({ stdout: '' }),
  gitCommit: async () => ok({ committed: false }),
  gitPush: async () => ok({ stdout: '' }),
  gitInit: async () => ok({ committed: true }),
  gitBind: async () => ok({ binding: { remote: 'stub', branch: 'main' } }),
  gitSync: async () => ok({ committed: false, pulled: false, pushed: false, message: 'sync' }),
  gitClone: async () => ({ ok: false, error: 'stub: no real clone in this harness' }),
  gitRoots: async () => [],
  // P3-P6 stubs
  shareInfo: async () => ({ ok: false, code: 'no_remote', error: 'stub', remote: null, readOnly: false }),
  shareAccess: async () => ({ ok: true, readOnly: false, permission: null, source: 'stub' }),
  shareInvite: async () => ({ ok: false, code: 'gh_not_authed', error: 'stub' }),
  shareRemove: async () => ({ ok: false, code: 'gh_not_authed', error: 'stub' }),
  historyLog: async () => ok({ commits: [] }),
  historyDiff: async () => ok({ changes: [], commit: {} }),
  historyRestore: async () => ({ ok: false, error: 'stub' }),
  identity: async () => ({ ok: true, gitUser: 'Harness', ghLogin: null, ghInstalled: false }),
  myday: async () => ({ overdue: [], today: [], week: [], ready: [], count: 0 }),
  gitIntegrate: async () => ok({ upToDate: true }),
  gitResolve: async () => ({ ok: false, error: 'stub' }),
});
