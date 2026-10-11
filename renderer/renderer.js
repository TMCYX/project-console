'use strict';

/* ==========================================================================
   Project Console — renderer (human-only model).
   Views per project: 總覽 (overview) · WBS · 進度 (progress) · 甘特 (Gantt).
   Progress is ticked by hand and written to progress.json.
   Vanilla DOM + inline SVG. No frameworks, no external resources.
   ========================================================================== */

const DAY = 86400000;
const TABS = [
  ['overview', '總覽'],
  ['wbs', 'WBS'],
  ['progress', '進度'],
  ['gantt', '甘特'],
  ['history', '歷程'],
];

const state = {
  projects: [],
  warnings: [],
  root: '',
  selectedProjectId: null,
  selectedTaskId: null,
  view: 'overview',
  collapsed: {}, // `${projectId}::${phaseId}` -> true
  railWidth: 300,
  wbsZoom: 1,
  wbsPan: { x: 0, y: 0 },
  ganttPanX: 0,
  // Pass-1: editing + planning aids.
  undoStack: [],
  redoStack: [],
  showCritical: false,
  criticalPath: [],
  showBaseline: false,
  baseline: null,
  selection: {}, // taskId -> true
  filter: { owner: '', phase: '', status: '', overdue: false },
  addingTask: null, // phaseId when the inline add form is open
  editingTask: null, // taskId when the panel is in edit mode
  editingPhase: null, // phaseId being renamed
  editingMilestone: null, // milestone id being edited
  ctx: null, // {taskId, x, y} for the context menu
  lastReschedule: null,
  // Pass-2: cross-project + appearance.
  topView: 'dashboard', // 'dashboard' | 'roadmap'
  theme: 'auto', // 'auto' | 'light' | 'dark'
  density: 'cozy', // 'cozy' | 'compact'
  panelWidth: 440,
  pins: {}, // projectId -> true
  colors: {}, // projectId -> palette index
  sort: 'name', // name | rag | target | progress
  paletteFor: null,
  showBackups: false,
  backups: [],
  focusMode: false,
  roadmapZoom: 1,
  roadmapPanX: 0,
  showMinimap: true,
  ganttRel: 1, // gantt zoom relative to the fitted baseline
  ganttBase: 1, // fitted baseline (computed per project span)
  showAllDeps: false, // show every dependency arrow (else selected/critical only)
  menuOpen: false,
  lastWriteAt: 0,
  hintDismissed: false,
  hintOn: false,
  showPhaseAdmin: false,
  showBulk: false,
  exportMenu: false,
  guideOpen: false, // 使用說明 overlay
  // Team sync (git): per-project status + flows.
  git: {}, // projectId -> git status object
  gitBusy: {}, // projectId -> true while a git op runs
  gitBindOpen: false, // project toolbar: bind-remote form
  gitCloneOpen: false, // dashboard: 加入 Git 專案 form
  gitCloneBusy: false,
  // P3: share & permissions
  shareOpen: false,
  share: null, // shareInfo result for the current project
  shareBusy: false,
  readonly: {}, // projectId -> true when the user lacks push rights
  // P4: project history
  history: [], // commit list
  historyBusy: false,
  selectedCommit: null, // sha
  diff: null, // { commit, changes } for the selected commit
  diffBusy: false,
  // P5: my-day + identity
  me: '', // task owner name ("我是誰")
  meSaved: '', // persisted value (to detect edits)
  myday: null,
  identity: { gitUser: null, ghLogin: null },
  // P6: conflict resolution
  conflicts: null, // array of conflicts awaiting a choice
  conflictBusy: false,
};

const RAG_RANK = { red: 3, amber: 2, green: 1, grey: 0 };
const ACCENTS = [null, '#dc3b1e', '#2f7a57', '#2f6fb5', '#a9821f', '#7a4fb5', '#5b5b5b'];

function colorClass(i) {
  return i > 0 && ACCENTS[i] ? ' acc-' + i : '';
}

function sortProjects(list) {
  const pins = state.pins || {};
  const arr = (list || []).slice();
  const key = state.sort;
  arr.sort((a, b) => {
    const pa = pins[a.id] ? 1 : 0;
    const pb = pins[b.id] ? 1 : 0;
    if (pa !== pb) return pb - pa;
    if (key === 'rag') {
      const r = RAG_RANK[b.summary.rag] - RAG_RANK[a.summary.rag];
      if (r) return r;
    } else if (key === 'target') {
      const c = String(a.target || '').localeCompare(String(b.target || ''));
      if (c) return c;
    } else if (key === 'progress') {
      const d = b.summary.percent - a.summary.percent;
      if (d) return d;
    }
    return String(a.title || a.id).localeCompare(String(b.title || b.id));
  });
  return arr;
}

/* ------------------------------ filters ---------------------------------- */

function passesFilter(t) {
  const f = state.filter;
  if (f.owner && (t.owner || '') !== f.owner) return false;
  if (f.phase && t.phase !== f.phase) return false;
  if (f.status && t.status !== f.status) return false;
  if (f.overdue && t.status !== 'overdue') return false;
  return true;
}

function activeFilterCount() {
  const f = state.filter;
  return (f.owner ? 1 : 0) + (f.phase ? 1 : 0) + (f.status ? 1 : 0) + (f.overdue ? 1 : 0);
}

function criticalSet() {
  return new Set(state.showCritical ? state.criticalPath || [] : []);
}

/* ------------------------------ undo/redo -------------------------------- */

const UNDO_CAP = 100;

function persistStacks() {
  try {
    localStorage.setItem('pc.undo', JSON.stringify(state.undoStack.slice(-UNDO_CAP)));
    localStorage.setItem('pc.redo', JSON.stringify(state.redoStack.slice(-UNDO_CAP)));
  } catch (_) {
    /* storage full / unavailable */
  }
}

function pushUndo(entry) {
  state.undoStack.push(entry);
  if (state.undoStack.length > UNDO_CAP) state.undoStack.shift();
  state.redoStack = [];
  persistStacks();
}

/** Record an op result (plan / progress / multi-file) as an undoable entry. */
function recordOp(res, projectId, label) {
  if (!res || !res.ok || !res.undo) return;
  state.lastWriteAt = Date.now();
  let files;
  if (Array.isArray(res.undo.files)) {
    files = res.undo.files.filter((f) => f && (f.beforeRaw !== undefined || f.before != null));
  } else if (res.undo.file) {
    const after = res.undo.file === 'plan.json' ? res.plan : res.progress;
    if (after == null) return;
    files = [{ file: res.undo.file, before: res.undo.before, after }];
  } else {
    return;
  }
  if (!files.length) return;
  pushUndo({ projectId, files, ts: Date.now(), label: label || '變更' });
  renderToolbar(); // the IPC broadcast renders before recordOp runs, so refresh Undo/Redo now
}

function entryFiles(entry) {
  if (entry.files) return entry.files;
  if (entry.file) return [{ file: entry.file, before: entry.before, after: entry.after }];
  return [];
}

async function applyEntry(entry, dirKey) {
  const files = entryFiles(entry);
  const rawKey = dirKey + 'Raw';
  for (const f of files) {
    let res;
    if (f[rawKey] !== undefined) res = await window.api.restoreFileRaw(entry.projectId, f.file, f[rawKey]);
    else res = await window.api.restoreFile(entry.projectId, f.file, f[dirKey]);
    if (!res || !res.ok) return (res && res.error) || 'unknown';
  }
  return null;
}

async function undo() {
  const entry = state.undoStack.pop();
  if (!entry) return;
  const err = await applyEntry(entry, 'before');
  if (!err) {
    state.redoStack.push(entry);
    persistStacks();
    toast('已撤銷：' + (entry.label || '變更'));
  } else {
    state.undoStack.push(entry);
    toast('Undo 失敗：' + err);
  }
  render();
}

async function redo() {
  const entry = state.redoStack.pop();
  if (!entry) return;
  const err = await applyEntry(entry, 'after');
  if (!err) {
    state.undoStack.push(entry);
    persistStacks();
    toast('已重做：' + (entry.label || '變更'));
  } else {
    state.redoStack.push(entry);
    toast('Redo 失敗：' + err);
  }
  render();
}

/* ------------------------------ helpers ---------------------------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function truncate(s, n) {
  const str = String(s == null ? '' : s);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function toDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDate(v) {
  const d = toDate(v);
  if (!d) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function fmtDateTime(v) {
  const d = toDate(v);
  if (!d) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

function currentProject() {
  return state.projects.find((p) => p.id === state.selectedProjectId) || null;
}

function groupByPhase(p, applyFilter) {
  const groups = [];
  for (const ph of p.phases || []) {
    groups.push({ id: ph.id, name: ph.name || ph.id, tasks: [] });
  }
  const orphan = { id: '_', name: '未分階段', tasks: [] };
  for (const t of p.tasks) {
    if (applyFilter && !passesFilter(t)) continue;
    const g = groups.find((x) => x.id === t.phase);
    if (g) g.tasks.push(t);
    else orphan.tasks.push(t);
  }
  if (orphan.tasks.length) groups.push(orphan);
  return groups;
}

const STATUS_LABEL = { done: '已完成', late: '遲交', overdue: '逾期', pending: '待完成' };
const STATUS_CLASS = { done: 'chip--done', late: 'chip--late', overdue: 'chip--overdue', pending: 'chip--pending' };

function statusLabel(s) {
  return STATUS_LABEL[s] || '—';
}
function statusClass(s) {
  return STATUS_CLASS[s] || '';
}
function chip(status) {
  return `<span class="chip ${statusClass(status)}">${statusLabel(status)}</span>`;
}

function ragLabel(rag) {
  return { green: '正常', amber: '注意', red: '風險', grey: '無進度' }[rag] || '—';
}
/** RAG status as an explicit labelled chip (distinct from the colour swatch). */
function ragChip(rag) {
  return `<span class="ragchip" title="狀態：${ragLabel(rag)}"><span class="dot dot--${rag}"></span><span class="ragchip__label">${ragLabel(
    rag
  )}</span></span>`;
}

function tickBox(projectId, task, extraClass) {
  const ro = !!state.readonly[projectId];
  return `<label class="tick${extraClass ? ' ' + extraClass : ''}${ro ? ' is-disabled' : ''}"${ro ? ' title="唯讀：你冇修改權限"' : ''}>
    <input type="checkbox" data-tick data-project="${esc(projectId)}" data-task="${esc(
    task.id
  )}"${task.done ? ' checked' : ''}${ro ? ' disabled' : ''}>
    <span class="tick__box"></span>
  </label>`;
}

/* ------------------------------ top-level -------------------------------- */

function render() {
  renderMeta();
  renderWarnings();
  renderRail();

  const project = currentProject();
  const landing = document.getElementById('landing');
  const pv = document.getElementById('project-view');

  if (project) {
    landing.hidden = true;
    pv.hidden = false;
    pv.innerHTML = renderProject(project);
    applyDynamicWidths(pv);
    applyTreePositions(pv);
    applyWbsTransform();
    applyWbsMinimap();
    applyGanttPositions(pv);
    applyGanttPan();
    updateZoomLabels();
    if (state.view === 'wbs') armHintTimer();
  } else {
    pv.hidden = true;
    pv.innerHTML = '';
    landing.hidden = false;
    landing.innerHTML =
      state.topView === 'roadmap' ? renderRoadmap() : state.topView === 'myday' ? renderMyDay() : renderDashboard();
    applyDynamicWidths(landing);
    applyRoadmapPositions();
  }
  applyTheme();
  applyDensity();
  applyPanelWidth();
  applyRailWidth();
  renderToolbar();
  renderTopbar();
  renderCtx();
  renderTaskPanel(project);
}

function renderTopbar() {
  const t = document.getElementById('theme-btn');
  if (t) t.textContent = state.theme === 'dark' ? '淺色' : '深色';
  const d = document.getElementById('density-btn');
  if (d) d.textContent = state.density === 'compact' ? '舒適' : '緊湊';
  const db = document.getElementById('dash-btn');
  if (db) db.classList.toggle('is-on', !state.selectedProjectId && state.topView === 'dashboard');
  const rb = document.getElementById('roadmap-btn');
  if (rb) rb.classList.toggle('is-on', !state.selectedProjectId && state.topView === 'roadmap');
  const mb = document.getElementById('myday-btn');
  if (mb) mb.classList.toggle('is-on', !state.selectedProjectId && state.topView === 'myday');
}

function renderToolbar() {
  const u = document.getElementById('undo-btn');
  const r = document.getElementById('redo-btn');
  if (u) u.disabled = state.undoStack.length === 0;
  if (r) r.disabled = state.redoStack.length === 0;
}

/** Overall baseline slip (max positive planned-end delta, in days). */
function slipSummary(p) {
  if (!state.baseline || !state.baseline.tasks) return '<span class="note">baseline 未凍結</span>';
  let worst = 0;
  let slipped = 0;
  for (const t of p.tasks) {
    const b = state.baseline.tasks[t.id];
    if (!b || !b.plannedEnd || !t.plannedEnd) continue;
    const d = Math.round((toDate(t.plannedEnd).getTime() - toDate(b.plannedEnd).getTime()) / DAY);
    if (d > 0) {
      slipped++;
      worst = Math.max(worst, d);
    }
  }
  return worst > 0
    ? `<span class="note note--alert">滑期 +${worst}日 · ${slipped} 項落後</span>`
    : '<span class="note">對齊 baseline</span>';
}

function renderMeta() {
  document.getElementById('meta-count').textContent = `${state.projects.length} project${
    state.projects.length === 1 ? '' : 's'
  }`;
  const rootEl = document.getElementById('meta-root');
  rootEl.textContent = state.root || '—';
  rootEl.title = state.root || '';
  document.getElementById('rail-count').textContent = String(state.projects.length).padStart(2, '0');
}

function renderWarnings() {
  const el = document.getElementById('warnings');
  if (!state.warnings || state.warnings.length === 0) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = 'warnings\n' + state.warnings.map((w) => '· ' + w).join('\n');
}

function renderRail() {
  const list = document.getElementById('portfolio-list');
  const all = sortProjects(state.projects);
  if (all.length === 0) {
    list.innerHTML = '<div class="empty">未發現項目<br />（子資料夾需有 plan.json）</div>';
    return;
  }
  list.innerHTML = all.map(renderRailRow).join('');
  applyDynamicWidths(list);
}

function renderRailRow(p) {
  const s = p.summary;
  const active = p.id === state.selectedProjectId ? ' is-active' : '';
  const nm = s.nextMilestone;
  return `
    <div class="pcard${active}${colorClass(state.colors[p.id])}${state.pins[p.id] ? ' is-pinned' : ''}">
      <span class="pcard__top">
        ${ragChip(s.rag)}
        <span class="pcard__id">${esc(p.id)}</span>
        <span class="cardctl">
          <button class="mini pin${state.pins[p.id] ? ' is-on' : ''}" type="button" data-pin="${esc(p.id)}" title="置頂">${state.pins[p.id] ? '★' : '☆'}</button>
          <button class="mini swatch${colorClass(state.colors[p.id])}" type="button" data-palette="${esc(p.id)}" title="專案顏色">■</button>
        </span>
      </span>
      <button class="pcard__title pcard__title--btn" type="button" data-project-id="${esc(p.id)}">${esc(p.title)}</button>
      <span class="pcard__meta">
        <span>${s.percent}% · ${s.tasksDone}/${s.tasksTotal}</span>
        <span>${nm ? esc(nm.id) + ' ' + fmtDate(nm.date) : '—'}</span>
      </span>
      <span class="pcard__bar"><i data-w="${s.percent}"></i></span>
      ${state.paletteFor === p.id ? renderPalette(p.id) : ''}
    </div>`;
}

function renderPalette(id) {
  const cur = state.colors[id] || 0;
  return `<div class="palette">${ACCENTS.map(
    (c, i) => `<button class="pswatch acc-${i}${cur === i ? ' is-active' : ''}" type="button" data-setcolor="${esc(id)}" data-ci="${i}" title="${i === 0 ? '預設' : '顏色 ' + i}"></button>`
  ).join('')}</div>`;
}

/* ------------------------------ dashboard (C) ---------------------------- */

function dueBuckets() {
  const today = hkTodayStrClient();
  const in7 = addDaysClient(today, 7);
  const in14 = addDaysClient(today, 14);
  const due = [];
  const over = [];
  const ms = [];
  for (const p of state.projects) {
    for (const t of p.tasks) {
      if (t.done) continue;
      if (t.status === 'overdue') over.push({ p, t });
      else if (t.plannedEnd && t.plannedEnd >= today && t.plannedEnd <= in7) due.push({ p, t });
    }
    for (const m of p.milestones || []) {
      if (m.date && m.date >= today && m.date <= in14) ms.push({ p, m });
    }
  }
  const byTaskDate = (a, b) => String(a.t.plannedEnd || '').localeCompare(String(b.t.plannedEnd || ''));
  due.sort(byTaskDate);
  over.sort(byTaskDate);
  ms.sort((a, b) => String(a.m.date).localeCompare(String(b.m.date)));
  return { due, over, ms };
}

function renderDashboard() {
  const all = state.projects;
  const today = hkTodayStrClient();
  const in7 = addDaysClient(today, 7);
  let open = 0;
  let done = 0;
  let overdue = 0;
  let dueWeek = 0;
  for (const p of all) {
    for (const t of p.tasks) {
      if (t.done) done++;
      else {
        open++;
        if (t.status === 'overdue') overdue++;
        else if (t.plannedEnd && t.plannedEnd >= today && t.plannedEnd <= in7) dueWeek++;
      }
    }
  }
  const { due, over, ms } = dueBuckets();
  const cards = sortProjects(all).map(renderCard).join('') || '<div class="empty">未發現項目。</div>';
  return `<div class="dash">
    <div class="dash__head">
      <div><span class="kicker">Dashboard · 儀表板</span><h1 class="display">所有項目<br />一個窗口</h1></div>
      <div class="head-controls"><span class="kicker">排序</span>
        <select class="fsel" data-sort>
          ${[['name', '名稱'], ['rag', 'RAG'], ['target', '目標日'], ['progress', '進度']]
            .map(([k, label]) => `<option value="${k}"${state.sort === k ? ' selected' : ''}>${label}</option>`)
            .join('')}
        </select>
        <button class="btn btn--ghost${state.gitCloneOpen ? ' is-on' : ''}" type="button" data-git-clone-toggle title="由 repo URL clone 一個 git 專案">＋加入 Git 專案</button>
      </div>
    </div>
    ${state.gitCloneOpen ? renderGitClonePanel() : ''}
    <div class="dash__stats">
      ${dstat('專案', all.length)}
      ${dstat('未完成', open)}
      ${dstat('已完成', done)}
      ${dstat('逾期', overdue, overdue > 0)}
      ${dstat('本週到期', dueWeek)}
    </div>
    <div class="dash__lists">
      ${dueList('本週到期 (≤7日)', due, false)}
      ${dueList('逾期', over, true)}
      ${msList('近期 Milestone (≤14日)', ms)}
    </div>
    <div class="section__head"><h2 class="section__title">項目</h2><span class="section__note">${all.length}</span></div>
    <div class="landing__cards">${cards}</div>
  </div>`;
}

function dstat(label, value, alert) {
  return `<div class="stat"><div class="stat__label">${esc(label)}</div><div class="stat__value${alert ? ' is-alert' : ''}">${value}</div></div>`;
}

function dueList(title, rows, alert) {
  const body = rows.length
    ? rows
        .map(
          ({ p, t }) => `<button class="drow" type="button" data-jump-project="${esc(p.id)}" data-jump-task="${esc(t.id)}">
        <span class="drow__date${alert ? ' is-alert' : ''}">${esc(t.plannedEnd || '—')}</span>
        <span class="drow__id">${esc(t.id)}</span>
        <span class="drow__title" title="${esc(t.title)}${t.owner ? ' — ' + esc(t.owner) : ''}">${esc(t.title)}${
            t.owner ? ' <span class="drow__owner">' + esc(t.owner) + '</span>' : ''
          }</span>
        <span class="drow__proj">${esc(p.id)}</span></button>`
        )
        .join('')
    : '<div class="empty">無</div>';
  return `<section class="dash__list"><div class="section__head"><h2 class="section__title">${esc(title)}</h2><span class="section__note">${rows.length}</span></div>${body}</section>`;
}

function msList(title, rows) {
  const body = rows.length
    ? rows
        .map(
          ({ p, m }) => `<button class="drow" type="button" data-jump-project="${esc(p.id)}">
        <span class="drow__date">${esc(m.date || '—')}</span>
        <span class="drow__id">${esc(m.id)}</span>
        <span class="drow__title" title="${esc(m.name)}"><span class="drow__owner">◆</span> ${esc(m.name)}</span>
        <span class="drow__proj">${esc(p.id)}</span></button>`
        )
        .join('')
    : '<div class="empty">無</div>';
  return `<section class="dash__list"><div class="section__head"><h2 class="section__title">${esc(title)}</h2><span class="section__note">${rows.length}</span></div>${body}</section>`;
}

function renderCard(p) {
  const s = p.summary;
  const pinned = state.pins[p.id] ? ' is-pinned' : '';
  return `<div class="lcard${colorClass(state.colors[p.id])}${pinned}">
    <div class="lcard__row">
      ${ragChip(s.rag)}
      <span class="lcard__pct">${s.percent}<small>%</small></span>
      <span class="cardctl">
        <button class="mini pin${state.pins[p.id] ? ' is-on' : ''}" type="button" data-pin="${esc(p.id)}" title="置頂">${state.pins[p.id] ? '★' : '☆'}</button>
        <button class="mini swatch${colorClass(state.colors[p.id])}" type="button" data-palette="${esc(p.id)}" title="專案顏色">■</button>
      </span>
    </div>
    <button class="lcard__title lcard__title--btn" type="button" data-project-id="${esc(p.id)}">${esc(p.title)}</button>
    <span class="lcard__meta">
      <span>id &nbsp;${esc(p.id)}</span>
      <span>完成 &nbsp;${s.tasksDone}/${s.tasksTotal}</span>
      <span>owners &nbsp;${esc((s.owners || []).join(', ') || p.owner || '—')}</span>
      <span>target &nbsp;${fmtDate(p.target)}</span>
    </span>
    ${state.paletteFor === p.id ? renderPalette(p.id) : ''}
  </div>`;
}

/* ------------------------------ roadmap (C) ------------------------------ */

function buildRoadmapSvg() {
  const all = sortProjects(state.projects);
  const todayD = toDate(hkTodayStrClient());
  const dates = [todayD || new Date()];
  for (const p of all) {
    for (const v of [p.created, p.target]) {
      const d = toDate(v);
      if (d) dates.push(d);
    }
    for (const m of p.milestones || []) {
      const d = toDate(m.date);
      if (d) dates.push(d);
    }
  }
  let t0 = Math.min(...dates.map((d) => d.getTime()));
  let t1 = Math.max(...dates.map((d) => d.getTime()));
  if (t1 <= t0) t1 = t0 + DAY;
  const padMs = (t1 - t0) * 0.03;
  t0 -= padMs;
  t1 += padMs;
  const labelW = 220;
  const rowH = 46;
  const axisH = 34;
  const chartW = 780 * state.roadmapZoom;
  const xOf = (ms) => labelW + ((ms - t0) / (t1 - t0)) * chartW;
  let y = axisH;
  const rows = [];
  for (const p of all) {
    rows.push({ p, y });
    y += rowH;
  }
  const totalW = labelW + chartW;
  const totalH = y + 10;
  const parts = [];
  for (const tk of buildTicks(t0, t1)) {
    const x = xOf(tk.getTime());
    parts.push(`<line class="g-grid" x1="${x.toFixed(1)}" y1="${axisH}" x2="${x.toFixed(1)}" y2="${totalH}"/>`);
    parts.push(`<text class="g-tick-label" x="${x.toFixed(1)}" y="${axisH - 12}" text-anchor="middle">${esc(shortDate(tk))}</text>`);
  }
  for (const r of rows) {
    const p = r.p;
    const cy = r.y + rowH / 2;
    const cd = toDate(p.created);
    const td = toDate(p.target);
    const x1 = cd ? xOf(cd.getTime()) : labelW;
    const x2 = td ? xOf(td.getTime()) : x1 + 4;
    const fill = ACCENTS[state.colors[p.id] || 0] || '#8a867c';
    parts.push(`<rect class="rm-bar" data-project-id="${esc(p.id)}" x="${x1.toFixed(1)}" y="${(cy - 9).toFixed(1)}" width="${Math.max(3, x2 - x1).toFixed(1)}" height="18" fill="${fill}"/>`);
    parts.push(`<text class="g-label" x="14" y="${cy - 1}">${esc(truncate(p.title, 24))}</text>`);
    parts.push(`<text class="g-label--dim" x="14" y="${cy + 13}">${esc(p.id)} · ${p.summary.percent}% · ${p.summary.rag}</text>`);
    for (const m of p.milestones || []) {
      const md = toDate(m.date);
      if (!md) continue;
      const mx = xOf(md.getTime());
      parts.push(`<polygon class="rm-ms" data-project-id="${esc(p.id)}" points="${mx.toFixed(1)},${(cy - 9).toFixed(1)} ${(mx + 6).toFixed(1)},${cy.toFixed(1)} ${mx.toFixed(1)},${(cy + 9).toFixed(1)} ${(mx - 6).toFixed(1)},${cy.toFixed(1)}"/>`);
    }
  }
  const now = (todayD || new Date()).getTime();
  if (now >= t0 && now <= t1) {
    const x = xOf(now);
    parts.push(`<line class="g-today" x1="${x.toFixed(1)}" y1="${axisH}" x2="${x.toFixed(1)}" y2="${totalH}"/>`);
  }
  return { svg: `<svg class="rm-svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}" role="img" aria-label="Roadmap">${parts.join('')}</svg>`, totalW, totalH };
}

function renderRoadmap() {
  const all = state.projects;
  if (!all.length) return '<div class="empty">未發現項目。</div>';
  const { svg, totalW, totalH } = buildRoadmapSvg();
  return `<div class="dash">
    <div class="dash__head">
      <div><span class="kicker">Roadmap · 路線圖</span><h1 class="display">跨項目時間線</h1></div>
      <div class="head-controls"><span class="section__note">滾輪縮放 · 拖曳平移 · 點 bar 開啟項目</span>
        <div class="zoomctl" role="group" aria-label="路線圖縮放">
          <button class="zbtn" type="button" data-roadmap-zoom="out">−</button>
          <button class="zbtn zbtn--pct" type="button" data-roadmap-zoom="reset" data-roadmap-zoom-label>100%</button>
          <button class="zbtn" type="button" data-roadmap-zoom="in">+</button>
        </div>
      </div>
    </div>
    <div class="roadmap" data-canvas="${Math.round(totalW)},${Math.round(totalH)}">${svg}</div>
  </div>`;
}

function applyRoadmapPositions() {
  const el = document.querySelector('.roadmap');
  if (el) el.scrollLeft = state.roadmapPanX || 0;
}

/* ------------------------------ project view ----------------------------- */

function renderProject(p) {
  const s = p.summary;
  const ro = !!state.readonly[p.id];
  const tabs = TABS.map(
    ([id, label]) =>
      `<button class="tab${state.view === id ? ' is-active' : ''}" type="button" data-view="${id}">${label}</button>`
  ).join('');

  let body = '';
  if (state.view === 'wbs') body = renderWBS(p);
  else if (state.view === 'progress') body = renderProgress(p);
  else if (state.view === 'gantt') body = renderGanttTab(p);
  else if (state.view === 'history') body = renderHistory(p);
  else body = renderOverview(p);

  return `
    <div class="project${ro ? ' is-readonly' : ''}">
      <div class="proj-toolbar">
        <span class="dot dot--${s.rag}"></span>
        <span class="ptb__id">${esc(p.id)}</span>
        <h1 class="ptb__title" title="${esc(p.title)}">${esc(p.title)}</h1>
        <span class="ptb__metrics" title="owner ${esc(p.owner || '—')} · target ${fmtDate(p.target)} · updated ${s.lastUpdated ? fmtDateTime(s.lastUpdated) : '—'}">
          <b>${s.percent}%</b> ${s.tasksDone}/${s.tasksTotal} · 逾期 ${s.overdue} · 遲交 ${s.late}${
    s.nextMilestone ? ' · ◆ ' + esc(s.nextMilestone.id) + ' ' + fmtDate(s.nextMilestone.date) : ''
  }
        </span>
        <span class="ptb__spacer"></span>
        ${syncChipHtml(p.id)}
        ${readonlyChipHtml(p.id)}
        <button class="btn btn--ghost" type="button" data-git-sync title="Pull → 自動 commit → Push（git sync）"${ro ? ' disabled' : ''}>Sync</button>
        <button class="btn btn--ghost${state.shareOpen ? ' is-on' : ''}" type="button" data-share-toggle title="分享 / 協作者權限（Share）">分享</button>
        <button class="btn btn--ghost${state.gitBindOpen ? ' is-on' : ''}" type="button" data-git-bind title="綁定 / 更換 git remote">Git…</button>
        <button class="btn" type="button" data-add-task title="新增任務 (n)"${ro ? ' disabled' : ''}>＋任務</button>
        <button class="btn btn--ghost" type="button" data-reschedule title="依 deps 重排 start"${ro ? ' disabled' : ''}>重排</button>
        <button class="btn btn--ghost${state.showCritical ? ' is-on' : ''}" type="button" data-toggle-critical title="關鍵路徑標示">關鍵</button>
        <button class="btn btn--ghost${state.showBaseline ? ' is-on' : ''}" type="button" data-toggle-baseline title="凍結／顯示基準線（baseline ghost bar）"${ro ? ' disabled' : ''}>基準線</button>
        <button class="btn btn--ghost${state.exportMenu ? ' is-on' : ''}" type="button" data-export-toggle title="匯出（PNG / PDF / CSV / Markdown）">匯出</button>
        <button class="btn btn--ghost${state.showBackups ? ' is-on' : ''}" type="button" data-show-backups title="備份清單 / 還原">備份</button>
        <button class="btn btn--ghost${state.menuOpen ? ' is-on' : ''}" type="button" data-menu-toggle title="更多動作（同步 / 匯入 / 凍結）">⋯</button>
      </div>
      ${state.exportMenu ? renderExportMenu() : ''}
      ${state.menuOpen ? renderOverflowMenu(p) : ''}
      ${state.gitBindOpen ? renderGitBindForm() : ''}
      ${state.shareOpen ? renderSharePanel(p) : ''}
      ${state.conflicts ? renderConflictPanel(p) : ''}
      ${ro ? readonlyBanner() : ''}
      <nav class="tabs">${tabs}</nav>
      ${state.showBackups ? renderBackups(p) : ''}
      ${body}
    </div>`;
}

function renderExportMenu() {
  return `<div class="expmenu">
    <span class="kicker">匯出格式</span>
    <button class="btn btn--ghost" type="button" data-io="png" title="PNG 截圖 (screenshot)">PNG</button>
    <button class="btn btn--ghost" type="button" data-io="pdf" title="PDF 報告 (print to PDF)">PDF</button>
    <button class="btn btn--ghost" type="button" data-io="csv" title="CSV（每 task 一行）">CSV</button>
    <button class="btn btn--ghost" type="button" data-io="md" title="Markdown（WBS checklist）">Markdown</button>
  </div>`;
}

function renderOverflowMenu(p) {
  return `<div class="ovmenu">
    <span class="kicker">同步 / 匯入 / 凍結</span>
    <button class="btn btn--ghost" type="button" data-io="sync" title="同步到 &lt;project&gt;/tasks.md (Obsidian)">同步 tasks.md</button>
    <button class="btn btn--ghost" type="button" data-io="read" title="由 tasks.md 讀回打勾 (Obsidian)">由 tasks.md 讀回</button>
    <button class="btn btn--ghost" type="button" data-io="import" title="匯入 Markdown checklist (import)">匯入清單…</button>
    <button class="btn btn--ghost" type="button" data-freeze-baseline title="凍結基準線 (freeze baseline)">凍結基準線</button>
    <button class="btn btn--ghost${state.showBackups ? ' is-on' : ''}" type="button" data-show-backups title="備份清單 / 還原 (backups)">備份清單</button>
    ${slipSummary(p)}
  </div>`;
}

/* ------------------------------ team sync: UI ---------------------------- */

/** State chip for a project's git status (未連接 / 同步中 / 有本地改動 / 落後 N / 領先 N / 已最新). */
function syncChipHtml(pid) {
  const g = state.git[pid];
  let label = '未連接';
  let cls = 'is-off';
  let title = '未連接 git';
  if (state.gitBusy[pid]) {
    label = '同步中';
    cls = 'is-busy';
    title = '同步中…';
  } else if (g && g.isRepo) {
    if (g.dirty) {
      label = '有本地改動';
      cls = 'is-dirty';
      title = '有未 commit 改動';
    } else if (g.behind > 0) {
      label = '落後 ' + g.behind;
      cls = 'is-behind';
      title = `落後 remote ${g.behind} 個 commit`;
    } else if (g.ahead > 0) {
      label = '領先 ' + g.ahead;
      cls = 'is-ahead';
      title = `領先 remote ${g.ahead} 個 commit`;
    } else {
      label = '已最新';
      cls = 'is-clean';
      title = g.remote ? 'remote: ' + g.remote : '已最新';
    }
  } else if (g && g.remote) {
    cls = 'is-off';
    label = '未連接';
    title = '未初始化 git（remote: ' + g.remote + '）';
  }
  return `<span class="syncchip ${cls}" data-sync-chip title="${esc(title)}">${esc(label)}</span>`;
}

function renderGitBindForm() {
  return `<div class="gitform">
    <span class="kicker">綁定 git remote</span>
    <input class="fin fin--wide" type="text" data-git-remote placeholder="https://github.com/&lt;owner&gt;/&lt;repo&gt;.git">
    <button class="btn" type="button" data-git-bind-go>綁定</button>
    <button class="btn btn--ghost" type="button" data-git-bind-cancel>取消</button>
    <span class="note">綁定後用 Sync 掣 pull / commit / push。</span>
  </div>`;
}

function renderGitClonePanel() {
  return `<div class="gitclone">
    <span class="kicker">加入 Git 專案</span>
    <input class="fin fin--wide" type="text" data-git-clone-url placeholder="https://github.com/&lt;owner&gt;/&lt;repo&gt;.git" autofocus>
    <input class="fin fin--wide" type="text" data-git-clone-dir placeholder="目標資料夾（預設 ~/ProjectConsole/&lt;name&gt;）">
    <button class="btn" type="button" data-git-clone-go${state.gitCloneBusy ? ' disabled' : ''}>${state.gitCloneBusy ? 'Clone 中…' : 'Clone'}</button>
    <button class="btn btn--ghost" type="button" data-git-clone-cancel>取消</button>
    <span class="note">clone 後會自動開啟該專案。</span>
  </div>`;
}

/* ------------------------------ P3: share panel -------------------------- */

function readonlyChipHtml(pid) {
  if (!state.readonly[pid]) return '';
  return `<span class="rochip" title="你冇 push 權限；app 已切換唯讀">唯讀（你冇修改權限）</span>`;
}

function readonlyBanner() {
  return `<div class="robanner">唯讀模式：你對呢個 repo 冇修改（push）權限，所以打勾 / 編輯 / 還原 / Sync 已停用。想改 → 叫 repo owner 喺「分享」加你做 collaborator（write）。</div>`;
}

function permChinese(p) {
  return p === 'ADMIN' ? '管理員' : p === 'WRITE' ? '可寫' : p === 'READ' ? '唯讀' : p === 'MAINTAIN' ? '維護' : '未知';
}

function renderSharePanel(p) {
  const sh = state.share;
  const bar = `<div class="panelbar"><span class="kicker">分享 · Share</span><span class="panelbar__spacer"></span>
      <button class="btn btn--ghost" type="button" data-share-refresh>重新載入</button>
      <button class="btn btn--ghost" type="button" data-share-cancel>關閉</button></div>`;
  let body;
  if (state.shareBusy || !sh) {
    body = '<div class="note">載入中…</div>';
  } else if (!sh.ok) {
    const remote = sh.remote ? `<div class="shline"><span class="id">remote</span><span class="mono">${esc(sh.remote)}</span></div>` : '';
    let hint = esc(sh.error || '未知錯誤');
    if (sh.code === 'gh_missing') hint = '未安裝 gh CLI。安裝：<code>winget install GitHub.cli</code>';
    if (sh.code === 'gh_not_authed') hint = 'gh 未登入。請先執行：<code>gh auth login</code>（只有 repo owner / admin 先 invite 到人）';
    if (sh.code === 'no_remote') hint = '呢個專案未綁定 git remote。先撳上面「Git…」綁定一個 GitHub repo。';
    if (sh.code === 'not_github') hint = 'remote 唔係 GitHub repo（Share 只支援 GitHub）。';
    body = `${remote}<div class="note note--alert">${hint}</div>`;
  } else {
    const repo = sh.repo || {};
    const cols = sh.collaborators || [];
    const invites = sh.invites || [];
    const myPerm = sh.permission;
    const canAdmin = myPerm === 'ADMIN';
    const rows = cols.length
      ? cols
          .map(
            (c) => `<div class="shrow"><span class="id">${esc(c.login)}</span><span class="shrow__perm">${esc(permChinese(c.permission))}</span>
        <span class="shrow__spacer"></span><button class="btn btn--ghost" type="button" data-share-remove="${esc(c.login)}"${state.readonly[p.id] || !canAdmin ? ' disabled' : ''} title="移除協作者">移除</button></div>`
          )
          .join('')
      : '<div class="empty">未有 collaborator</div>';
    const invRows = invites.length
      ? invites.map((i) => `<div class="shrow"><span class="id">${esc(i.login)}</span><span class="shrow__perm">待接受 · ${esc(permChinese(i.permission))}</span></div>`).join('')
      : '';
    body = `
      <div class="shline"><span class="kicker">repo</span><span class="id">${esc(repo.full || '')}</span>
        <span class="shpill">${repo.private ? 'private' : 'public'}</span>
        <a class="shlink" href="${esc(repo.url || '#')}" target="_blank" rel="noreferrer">${esc(repo.url || '')}</a></div>
      <div class="shline"><span class="kicker">你嘅權限</span><span class="shrow__perm">${esc(permChinese(myPerm))}</span>${sh.readOnly ? '<span class="rochip">唯讀</span>' : ''}</div>
      ${state.readonly[p.id] ? readonlyBanner() : ''}
      <div class="section__head"><h3 class="section__title">協作者</h3><span class="section__note">${cols.length}</span></div>
      <div class="shlist">${rows}</div>
      ${invRows ? `<div class="section__head"><h3 class="section__title">待接受邀請</h3><span class="section__note">${invites.length}</span></div><div class="shlist">${invRows}</div>` : ''}
      <div class="shinvite">
        <span class="kicker">邀請</span>
        <input class="fin" type="text" data-share-user placeholder="GitHub username">
        <select class="fsel" data-share-perm><option value="push">可寫（write）</option><option value="pull">唯讀（read-only）</option></select>
        <button class="btn" type="button" data-share-invite${state.shareBusy ? ' disabled' : ''}>邀請</button>
        ${!canAdmin ? '<span class="note">只有 admin 先 invite 到；你可能會收到 403。</span>' : ''}
      </div>
      ${(sh.warnings && sh.warnings.length) ? `<div class="note note--warn">${sh.warnings.map(esc).join('；')}</div>` : ''}`;
  }
  return `<div class="sharepanel">${bar}${body}</div>`;
}

/* ------------------------------ P4: history ------------------------------ */

const FIELD_LABEL = {
  title: '標題',
  owner: '負責人',
  start: '開始',
  estimate_days: '天數',
  deliverable: '交付物',
  acceptance: '驗收',
  deps: '前置任務',
  outputs: '輸出',
  phase: '階段',
  name: '名稱',
  date: '日期',
  after: '之後',
  done: '完成狀態',
  doneAt: '完成日期',
  note: '備註',
  deleted: '刪除 / 修改',
  plan: '計劃',
};

function fieldLabel(f) {
  return FIELD_LABEL[f] || f;
}

function valueText(v) {
  if (v == null || v === '') return '—';
  if (Array.isArray(v)) return v.length ? v.join('、') : '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function relTime(iso) {
  const d = toDate(iso);
  if (!d) return '—';
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  if (min < 1) return '剛剛';
  if (min < 60) return min + ' 分鐘前';
  const h = Math.round(min / 60);
  if (h < 24) return h + ' 小時前';
  const day = Math.round(h / 24);
  if (day < 30) return day + ' 日前';
  return fmtDate(iso);
}

function changeLabel(c) {
  switch (c.kind) {
    case 'task-add':
      return `<span class="chg chg--add">＋ ${esc(c.id)}</span> 新增${c.title ? ' 「' + esc(c.title) + '」' : ''}`;
    case 'task-del':
      return `<span class="chg chg--del">－ ${esc(c.id)}</span> 刪除${c.title ? '（' + esc(c.title) + '）' : ''}`;
    case 'task-field':
      return `<span class="chg chg--edit">${esc(c.id)}</span> ${esc(fieldLabel(c.field))}：<span class="from">${esc(valueText(c.from))}</span> → <span class="to">${esc(valueText(c.to))}</span>`;
    case 'tick':
      return `<span class="chg chg--tick">${esc(c.id)}</span> 未完成 → 已完成${c.owner ? ' · ' + esc(c.owner) : ''}`;
    case 'untick':
      return `<span class="chg chg--untick">${esc(c.id)}</span> 已完成 → 未完成${c.owner ? ' · ' + esc(c.owner) : ''}`;
    case 'phase-add':
      return `<span class="chg chg--add">＋ phase ${esc(c.id)}</span> ${esc(c.name || '')}`;
    case 'phase-del':
      return `<span class="chg chg--del">－ phase ${esc(c.id)}</span> ${esc(c.name || '')}`;
    case 'milestone-add':
      return `<span class="chg chg--add">＋ milestone ${esc(c.id)}</span> ${esc(c.name || '')}`;
    case 'milestone-del':
      return `<span class="chg chg--del">－ milestone ${esc(c.id)}</span> ${esc(c.name || '')}`;
    default:
      return esc(JSON.stringify(c));
  }
}

function renderDiff() {
  const d = state.diff;
  if (!d) return '';
  const ch = d.changes || [];
  const c = d.commit || {};
  const body = ch.length
    ? ch.map((x) => `<div class="diffrow">${changeLabel(x)}</div>`).join('')
    : '<div class="empty">此 commit 冇 plan / progress 嘅 task 變化（可能只改咗其他檔）。</div>';
  return `<div class="diffbox">
    <div class="section__head"><h3 class="section__title">改動</h3>
      <span class="section__note">${esc(c.short || '')} · ${esc(c.author || '')} · ${esc(relTime(c.date))} — ${esc(c.message || '')}</span></div>
    <div class="difflist">${body}</div>
  </div>`;
}

function renderHistory(p) {
  const g = state.git[p.id];
  const ro = !!state.readonly[p.id];
  const me = String(state.me || '').toLowerCase();
  const gitUser = (state.identity && state.identity.gitUser) || '';
  const commits = state.history || [];
  const rows = commits.length
    ? commits
        .map((c) => {
          const mine =
            (me && String(c.author || '').toLowerCase() === me) ||
            (gitUser && String(c.author || '') === gitUser) ||
            (state.identity && state.identity.ghLogin && String(c.author || '') === state.identity.ghLogin);
          const sel = state.selectedCommit === c.sha ? ' is-active' : '';
          return `<div class="hrow${sel}">
        <span class="hrow__sha id">${esc(c.short)}</span>
        <span class="hrow__author">${mine ? '<span class="me-dot" title="你嘅 commit"></span>' : ''}${esc(c.author)}</span>
        <span class="hrow__time" title="${esc(c.date)}">${esc(relTime(c.date))}</span>
        <span class="hrow__msg" title="${esc(c.message)}">${esc(c.message)}</span>
        <button class="btn btn--ghost" type="button" data-history-diff="${esc(c.sha)}">看改動</button>
        <button class="btn btn--ghost" type="button" data-history-restore="${esc(c.sha)}"${ro ? ' disabled' : ''} title="把 plan / progress 還原到此 commit（可 Undo）">還原</button>
      </div>`;
        })
        .join('')
    : state.historyBusy
      ? '<div class="empty">載入中…</div>'
      : `<div class="empty">${g && !g.isRepo ? '呢個專案唔係 git repo（未 bind / init）。' : '此專案未有 git 歷程。'}</div>`;
  return `<div class="hrs">
    <div class="section__head"><h2 class="section__title">專案歷程 · History</h2>
      <span class="section__note">${commits.length} commits · 最新在上</span>
      <button class="btn btn--ghost" type="button" data-history-refresh>重新載入</button></div>
    ${renderDiff()}
    <div class="hlist">${rows}</div>
  </div>`;
}

/* ------------------------------ P5: my-day ------------------------------- */

function renderMyDay() {
  const md = state.myday;
  const me = state.me;
  const dflt = (state.identity && (state.identity.gitUser || state.identity.ghLogin)) || '';
  const head = `<div class="dash__head">
      <div><span class="kicker">My Day · 我今日要做</span><h1 class="display">我今日<br />要做</h1></div>
      <div class="head-controls">
        <span class="kicker">我是誰</span>
        <input class="fin" type="text" data-me-input value="${esc(me)}" placeholder="task owner 名（例如 Jack）">
        <button class="btn" type="button" data-me-save>儲存</button>
        ${!me && dflt ? `<button class="btn btn--ghost" type="button" data-me-use="${esc(dflt)}">用 ${esc(dflt)}</button>` : ''}
      </div>
    </div>`;
  if (!me) {
    return `<div class="dash">${head}<div class="empty">未設定「我是誰」。輸入你嘅 task owner 名（例如 Jack），撳「儲存」，就會顯示你嘅任務${dflt ? '（或者撳「用 ' + esc(dflt) + '」）' : ''}。</div></div>`;
  }
  if (!md) return `<div class="dash">${head}<div class="empty">載入中…</div></div>`;
  const grp = (title, items, alert) => `<section class="dash__list"><div class="section__head"><h2 class="section__title">${esc(title)}</h2><span class="section__note">${items.length}</span></div>${
    items.length
      ? items
          .map(
            (it) => `<button class="drow" type="button" data-jump-project="${esc(it.projectId)}" data-jump-task="${esc(it.taskId)}">
      <span class="drow__date${alert ? ' is-alert' : ''}">${esc(it.plannedEnd || '—')}</span>
      <span class="drow__id">${esc(it.taskId)}</span>
      <span class="drow__title" title="${esc(it.title)}">${esc(it.title)}</span>
      <span class="drow__proj">${esc(it.projectId)}</span></button>`
          )
          .join('')
      : '<div class="empty">無</div>'
  }</section>`;
  return `<div class="dash">
    ${head}
    <div class="dash__stats">${dstat('我嘅未完成', md.count || 0)}${dstat('逾期', (md.overdue || []).length, (md.overdue || []).length > 0)}${dstat('今日', (md.today || []).length)}${dstat('本週', (md.week || []).length)}</div>
    <div class="dash__lists">
      ${grp('逾期', md.overdue || [], true)}
      ${grp('今日 due', md.today || [], false)}
      ${grp('本週 due (≤7日)', md.week || [], false)}
      ${grp('下一個 ready', md.ready || [], false)}
    </div>
  </div>`;
}

/* ------------------------------ P6: conflict UI -------------------------- */

function conflictFieldLabel(c) {
  if (c.field === 'deleted') return '刪除 vs 修改';
  const scope = c.scope === 'meta' ? '專案' : c.scope === 'task' ? '任務' : c.scope === 'phase' ? '階段' : c.scope === 'milestone' ? 'Milestone' : c.scope === 'progress' ? '進度' : '';
  return `${scope} ${fieldLabel(c.field)}`;
}

function renderConflictPanel(p) {
  const list = state.conflicts || [];
  const rows = list
    .map((c, i) => {
      const key = `${c.scope}:${c.id}:${c.field}`;
      return `<div class="crow" data-conflict-key="${esc(key)}">
      <div class="crow__head"><span class="id">${esc(c.id)}</span><span class="crow__field">${esc(conflictFieldLabel(c))}</span></div>
      <div class="crow__sides">
        <span class="crow__side crow__side--ours">本地：<b>${esc(valueText(c.ours))}</b></span>
        <span class="crow__side crow__side--theirs">對方：<b>${esc(valueText(c.theirs))}</b></span>
        ${c.base != null ? `<span class="crow__base">原始：${esc(valueText(c.base))}</span>` : ''}
      </div>
      <div class="crow__choice">
        <label><input type="radio" name="cf-${i}" value="ours" checked> 揀本地</label>
        <label><input type="radio" name="cf-${i}" value="theirs"> 揀對方</label>
        <label><input type="radio" name="cf-${i}" value="merge"> 合併</label>
      </div>
    </div>`;
    })
    .join('');
  return `<div class="conflictpanel">
    <div class="panelbar"><span class="kicker">衝突 · Conflict</span><span class="panelbar__spacer"></span>
      <button class="btn btn--ghost" type="button" data-conflict-cancel>取消（唔改）</button></div>
    <div class="note note--alert">pull 時同遠端撞咗 ${list.length} 個位（同一個 task / 同一欄位）。兩邊資料都保留喺 git 歷程，唔會冇咗。揀完再撳「套用並合併」。</div>
    <div class="clist">${rows}</div>
    <div class="panelops">
      <button class="btn" type="button" data-conflict-apply${state.conflictBusy ? ' disabled' : ''}>${state.conflictBusy ? '處理中…' : '套用並合併'}</button>
      <button class="btn btn--ghost" type="button" data-conflict-all-ours>全部揀本地</button>
      <button class="btn btn--ghost" type="button" data-conflict-all-theirs>全部揀對方</button>
    </div>
  </div>`;
}

function stat(label, valueHtml, alert) {
  return `<div class="stat">
    <div class="stat__label">${esc(label)}</div>
    <div class="stat__value${alert ? ' is-alert' : ''}">${valueHtml}</div>
  </div>`;
}

/* ------------------------------ 總覽 overview ---------------------------- */

function renderOverview(p) {
  const s = p.summary;
  const scope = p.scope || {};
  const cons = p.constraints || {};
  const people = (p.resources && p.resources.people) || [];

  return `
    ${p.definition_of_done ? section('完成定義', `<p class="field__value">${esc(p.definition_of_done)}</p>`) : ''}

    <section class="section">
      <div class="section__head"><h2 class="section__title">範圍</h2><span class="section__note">scope</span></div>
      <div class="grid-2">
        <div>
          <div class="field__label">in</div>
          ${pills(scope.in)}
        </div>
        <div>
          <div class="field__label">out</div>
          ${pills(scope.out)}
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section__head"><h2 class="section__title">限制</h2><span class="section__note">constraints</span></div>
      <table class="tbl"><tbody>
        ${consRow('time', cons.time)}
        ${consRow('resource', cons.resource)}
        ${consRow('procedure', cons.procedure)}
        ${consRow('scope', cons.scope)}
      </tbody></table>
    </section>

    <section class="section">
      <div class="section__head"><h2 class="section__title">人員</h2><span class="section__note">${people.length} 人</span></div>
      ${
        people.length
          ? `<table class="tbl"><thead><tr><th>Name</th><th>Role</th><th>Note</th><th>Weekly h</th></tr></thead><tbody>
              ${people
                .map(
                  (m) =>
                    `<tr><td class="id">${esc(m.name)}</td><td>${esc(m.role || '—')}</td><td class="muted">${esc(
                      m.note || '—'
                    )}</td><td class="id">${esc(m.weekly_hours != null ? m.weekly_hours : '—')}</td></tr>`
                )
                .join('')}
            </tbody></table>`
          : '<div class="empty">未列人員。</div>'
      }
    </section>

    ${renderMilestones(p)}
    ${renderRisks(p)}
  `;
}

function section(title, inner) {
  return `<section class="section">
    <div class="section__head"><h2 class="section__title">${esc(title)}</h2></div>
    ${inner}
  </section>`;
}

function pills(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '<span class="muted">—</span>';
  return `<span class="pills">${arr.map((x) => `<span class="pill">${esc(x)}</span>`).join('')}</span>`;
}

function consRow(k, v) {
  return `<tr><td class="id col-k">${esc(k)}</td><td>${esc(v || '—')}</td></tr>`;
}

function renderRisks(p) {
  if (!p.risks || p.risks.length === 0) return '';
  const rows = p.risks
    .map(
      (r) => `<tr>
      <td class="id">${esc(r.id)}</td>
      <td>${esc(r.risk)}</td>
      <td class="id">${esc(r.likelihood || '—')}</td>
      <td class="id">${esc(r.impact || '—')}</td>
      <td class="id">${esc(r.response || '—')}</td>
      <td class="id">${esc(r.owner || '—')}</td>
      <td class="muted">${esc(r.note || '—')}</td>
    </tr>`
    )
    .join('');
  return `<section class="section">
    <div class="section__head"><h2 class="section__title">風險</h2><span class="section__note">${p.risks.length} 項</span></div>
    <table class="tbl">
      <thead><tr><th>ID</th><th>Risk</th><th>Likelihood</th><th>Impact</th><th>Response</th><th>Owner</th><th>Note</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

/* ------------------------------ edit UI helpers -------------------------- */

function hkTodayStrClient() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function addDaysClient(s, n) {
  const d = toDate(s);
  if (!d) return null;
  const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + n * DAY);
  const p = (x) => String(x).padStart(2, '0');
  return `${r.getUTCFullYear()}-${p(r.getUTCMonth() + 1)}-${p(r.getUTCDate())}`;
}

function ownerOptions(p) {
  return [...new Set(p.tasks.map((t) => t.owner).filter(Boolean))].sort();
}

function renderFilterBar(p) {
  const f = state.filter;
  const n = activeFilterCount();
  const owners = ownerOptions(p);
  return `<div class="filterbar">
    <span class="kicker">篩選</span>
    <select class="fsel" data-filter="owner">
      <option value="">全部 owner</option>
      ${owners.map((o) => `<option value="${esc(o)}"${f.owner === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}
    </select>
    <select class="fsel" data-filter="phase">
      <option value="">全部 phase</option>
      ${p.phases.map((ph) => `<option value="${esc(ph.id)}"${f.phase === ph.id ? ' selected' : ''}>${esc(ph.id)} · ${esc(ph.name)}</option>`).join('')}
    </select>
    <select class="fsel" data-filter="status">
      <option value="">全部狀態</option>
      <option value="pending"${f.status === 'pending' ? ' selected' : ''}>未做</option>
      <option value="done"${f.status === 'done' ? ' selected' : ''}>已完成</option>
      <option value="overdue"${f.status === 'overdue' ? ' selected' : ''}>逾期</option>
    </select>
    <label class="fcheck"><input type="checkbox" data-filter-overdue${f.overdue ? ' checked' : ''}>只顯示逾期</label>
    <span class="fcount">${n ? '篩選中 ' + n : '無篩選'}</span>
    ${n ? '<button class="btn btn--ghost" type="button" data-filter-clear>清除</button>' : ''}
  </div>`;
}

function renderPhaseAdmin(p) {
  const chips = p.phases
    .map((ph, i) => {
      if (state.editingPhase === ph.id) {
        return `<span class="phase-chip is-editing">
          <input class="fin" type="text" data-phase-name="${esc(ph.id)}" value="${esc(ph.name)}">
          <button class="mini" data-phase-save="${esc(ph.id)}" title="儲存">✓</button>
          <button class="mini" data-phase-cancel="1" title="取消">✕</button>
        </span>`;
      }
      return `<span class="phase-chip">
        <span class="pc-id">${esc(ph.id)}</span><span class="pc-name">${esc(ph.name)}</span>
        <button class="mini" data-add-task-phase="${esc(ph.id)}" title="新增任務">＋</button>
        <button class="mini" data-phase-rename="${esc(ph.id)}" title="改名">✎</button>
        <button class="mini" data-phase-up="${esc(ph.id)}" title="上移"${i === 0 ? ' disabled' : ''}>↑</button>
        <button class="mini" data-phase-down="${esc(ph.id)}" title="下移"${i === p.phases.length - 1 ? ' disabled' : ''}>↓</button>
        <button class="mini" data-phase-del="${esc(ph.id)}" title="刪除">✕</button>
      </span>`;
    })
    .join('');
  const editor =
    state.editingPhase === '__new__'
      ? `<span class="phase-chip is-editing">
          <input class="fin" type="text" data-phase-name="__new__" placeholder="新 phase 名稱" autofocus>
          <button class="mini" data-phase-save="__new__" title="建立">✓</button>
          <button class="mini" data-phase-cancel="1" title="取消">✕</button>
        </span>`
      : `<button class="btn btn--ghost" type="button" data-add-phase>＋ 相位</button>`;
  return `<div class="phase-admin"><span class="kicker">Phases</span>${chips}${editor}</div>`;
}

function renderMilestones(p) {
  const rows =
    (p.milestones || [])
      .map((m) => {
        if (state.editingMilestone === m.id) {
          return `<tr>
            <td class="id">${esc(m.id)}</td>
            <td><input class="fin" type="text" data-ms-name="${esc(m.id)}" value="${esc(m.name)}"></td>
            <td><input class="fin" type="date" data-ms-date="${esc(m.id)}" value="${esc(m.date || '')}"></td>
            <td class="id"><input class="fin" type="text" data-ms-after="${esc(m.id)}" value="${esc((m.after || []).join(','))}"></td>
            <td><button class="mini" data-ms-save="${esc(m.id)}" title="儲存">✓</button><button class="mini" data-ms-cancel="1" title="取消">✕</button></td>
          </tr>`;
        }
        return `<tr>
          <td class="id">${esc(m.id)}</td><td>${esc(m.name)}</td><td class="id">${esc(m.date || '—')}</td>
          <td class="dep">${esc((m.after || []).join(', ') || '—')}</td>
          <td><button class="mini" data-ms-edit="${esc(m.id)}" title="編輯">✎</button><button class="mini" data-ms-del="${esc(m.id)}" title="刪除">✕</button></td>
        </tr>`;
      })
      .join('') || '<tr><td colspan="5" class="muted">未有 milestone</td></tr>';
  return `<section class="section">
    <div class="section__head"><h2 class="section__title">Milestones</h2><span class="section__note">${(p.milestones || []).length} 項</span></div>
    <table class="tbl">
      <thead><tr><th>ID</th><th>Name</th><th>Date</th><th>After</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr>
        <td></td>
        <td><input class="fin" type="text" data-new-ms-name placeholder="新 milestone 名稱"></td>
        <td><input class="fin" type="date" data-new-ms-date></td>
        <td><input class="fin" type="text" data-new-ms-after placeholder="after: T1.1,T2.1"></td>
        <td><button class="btn btn--ghost" type="button" data-ms-add>＋ 新增</button></td>
      </tr></tfoot>
    </table>
  </section>`;
}

function renderBulkBar() {
  const n = Object.keys(state.selection).length;
  const dis = n ? '' : ' disabled';
  return `<div class="bulkbar">
    <span class="kicker">批次</span>
    <span class="fcount">已選 ${n}</span>
    <button class="btn btn--ghost" type="button" data-bulk-done${dis}>全部完成</button>
    <button class="btn btn--ghost" type="button" data-bulk-undone${dis}>全部未完成</button>
    <button class="btn btn--ghost" type="button" data-bulk-clear${dis}>清除選取</button>
  </div>`;
}

function renderAddTaskForm() {
  return `<div class="addform">
    <span class="kicker">新增任務 → ${esc(state.addingTask)}</span>
    <input class="fin fin--wide" type="text" data-new-title placeholder="標題（必填）">
    <input class="fin" type="text" data-new-owner placeholder="owner">
    <input class="fin" type="date" data-new-start value="${hkTodayStrClient()}">
    <input class="fin" type="number" data-new-estimate value="1" min="1" title="estimate_days">
    <input class="fin" type="text" data-new-deliverable placeholder="deliverable">
    <input class="fin fin--wide" type="text" data-new-acceptance placeholder="acceptance">
    <button class="btn" type="button" data-new-save>儲存</button>
    <button class="btn btn--ghost" type="button" data-new-cancel>取消</button>
  </div>`;
}

function renderCtx() {
  const el = document.getElementById('ctx-menu');
  if (!el) return;
  if (!state.ctx) {
    el.hidden = true;
    return;
  }
  const id = state.ctx.taskId;
  el.innerHTML = `
    <button class="ctx__item" data-ctx="edit" data-task-id="${esc(id)}">編輯</button>
    <button class="ctx__item" data-ctx="up" data-task-id="${esc(id)}">上移</button>
    <button class="ctx__item" data-ctx="down" data-task-id="${esc(id)}">下移</button>
    <button class="ctx__item ctx__item--danger" data-ctx="del" data-task-id="${esc(id)}">刪除…</button>`;
  el.hidden = false;
  el.style.left = state.ctx.x + 'px';
  el.style.top = state.ctx.y + 'px';
}

/* ------------------------------ WBS -------------------------------------- */

// Top-down WBS geometry (ENG4001 lecture shape):
//   row 0 = the project (a wide box spanning the top),
//   row 1 = the phases (one box per column, left→right),
//   below each phase = that phase's tasks, stacked vertically in its column.
const WBS = {
  colW: 240, // width of a phase/task box (= column width)
  colGap: 28,
  rootH: 56,
  phaseH: 40,
  taskH: 46,
  taskGap: 16,
  rootGap: 60, // vertical gap between root and the phase row (holds the bus)
  phaseTaskGap: 46,
  pad: 28,
};

// Compact density shrinks the WBS node height/gap too (not just tables/cards).
const WBS_COMPACT = {
  colW: 200,
  colGap: 18,
  rootH: 44,
  phaseH: 30,
  taskH: 34,
  taskGap: 10,
  rootGap: 44,
  phaseTaskGap: 30,
  pad: 20,
};

function wbsSizes() {
  return state.density === 'compact' ? WBS_COMPACT : WBS;
}

function focusSet(p) {
  if (!state.focusMode || !state.selectedTaskId) return null;
  const sel = p.tasks.find((t) => t.id === state.selectedTaskId);
  if (!sel) return null;
  const set = new Set([sel.id, sel.phase]);
  for (const d of sel.deps) set.add(d);
  for (const t of p.tasks) if (t.deps.includes(sel.id)) set.add(t.id);
  return set;
}

function buildWbsTree(p, expandAll) {
  const groups = groupByPhase(p, true);
  const focus = expandAll ? null : focusSet(p);
  const totals = new Map();
  for (const t of p.tasks) {
    const a = totals.get(t.phase) || { total: 0, done: 0 };
    a.total++;
    if (t.done) a.done++;
    totals.set(t.phase, a);
  }
  const crit = criticalSet();
  return {
    kind: 'root',
    id: p.id,
    title: p.title,
    done: p.summary.tasksDone,
    total: p.summary.tasksTotal,
    percent: p.summary.percent,
    children: groups.map((g) => {
      const key = `${p.id}::${g.id}`;
      const collapsed = !expandAll && !!state.collapsed[key];
      const a = totals.get(g.id) || { total: g.tasks.length, done: g.tasks.filter((t) => t.done).length };
      const node = {
        kind: 'phase',
        id: g.id,
        name: g.name,
        key,
        done: a.done,
        total: a.total,
        collapsed,
        dim: !!focus && !focus.has(g.id) && !g.tasks.some((t) => focus.has(t.id)),
        children: [],
      };
      if (!collapsed) {
        node.children = g.tasks.map((t) => ({
          kind: 'task',
          task: t,
          critical: crit.has(t.id),
          selected: !!state.selection[t.id],
          dim: !!focus && !focus.has(t.id),
          children: [],
        }));
      }
      return node;
    }),
  };
}

function layoutWbs(root) {
  const { colW, colGap, rootH, phaseH, taskH, taskGap, rootGap, phaseTaskGap, pad } = wbsSizes();
  const phases = root.children || [];
  const nP = Math.max(1, phases.length);
  const colStep = colW + colGap;
  const phaseY = pad + rootH + rootGap;

  let maxTasks = 0;
  phases.forEach((ph, i) => {
    ph.w = colW;
    ph.h = phaseH;
    ph.x = pad + i * colStep;
    ph.cx = ph.x + colW / 2;
    ph.y = phaseY;
    ph.children.forEach((tn, k) => {
      tn.w = colW;
      tn.h = taskH;
      tn.x = ph.x;
      tn.y = phaseY + phaseH + phaseTaskGap + k * (taskH + taskGap);
    });
    maxTasks = Math.max(maxTasks, ph.children.length);
  });

  const spanW = (nP - 1) * colStep + colW;
  root.w = spanW;
  root.h = rootH;
  root.x = pad;
  root.y = pad;
  root.cx = pad + spanW / 2;

  const taskBlockH = maxTasks > 0 ? phaseTaskGap + maxTasks * (taskH + taskGap) - taskGap : 0;
  const canvasW = pad * 2 + spanW;
  const canvasH = pad + rootH + rootGap + phaseH + taskBlockH + pad;

  const busY = root.y + root.h + rootGap / 2;
  const bus = {
    y: busY,
    x0: phases.length ? phases[0].cx : root.cx,
    x1: phases.length ? phases[phases.length - 1].cx : root.cx,
  };
  const rootStub = { x: root.cx, y1: root.y + root.h, y2: busY };
  const drops = phases.map((ph) => ({ x: ph.cx, y1: busY, y2: ph.y }));
  const spines = phases
    .filter((ph) => ph.children.length > 0)
    .map((ph) => ({ x: ph.cx, y1: ph.y + ph.h, y2: ph.children[ph.children.length - 1].y }));

  const nodes = [];
  (function collect(n) {
    nodes.push(n);
    for (const c of n.children || []) collect(c);
  })(root);

  return { root, phases, nodes, rootStub, bus, drops, spines, canvasW, canvasH };
}

/** Orthogonal connectors: root→phase distributing bus, phase→task spine. */
function wbsConnectors(layout) {
  const r = (n) => Math.round(n);
  const paths = [];
  paths.push(`<path class="wbs-elbow" d="M ${r(layout.rootStub.x)} ${r(layout.rootStub.y1)} V ${r(layout.rootStub.y2)}"/>`);
  paths.push(`<path class="wbs-elbow" d="M ${r(layout.bus.x0)} ${r(layout.bus.y)} H ${r(layout.bus.x1)}"/>`);
  for (const d of layout.drops) {
    paths.push(`<path class="wbs-elbow" d="M ${r(d.x)} ${r(d.y1)} V ${r(d.y2)}"/>`);
  }
  for (const s of layout.spines) {
    paths.push(`<path class="wbs-elbow" d="M ${r(s.x)} ${r(s.y1)} V ${r(s.y2)}"/>`);
  }
  return paths.join('');
}

function wbsNodeHtml(p, n) {
  const pos = `${Math.round(n.x)},${Math.round(n.y)},${n.w},${n.h}`;
  if (n.kind === 'root') {
    return `<div class="wbs-node wbs-node--root" data-pos="${pos}">
      <span class="wbs-node__id">${esc(n.id)}</span>
      <span class="wbs-node__title" title="${esc(n.title)}">${esc(truncate(n.title, 64))}</span>
      <span class="wbs-node__meta">${n.done}/${n.total} · ${n.percent}%</span>
    </div>`;
  }
  if (n.kind === 'phase') {
    const pct = n.total ? Math.round((n.done / n.total) * 100) : 0;
    return `<div class="wbs-node wbs-node--phase${n.collapsed ? ' is-collapsed' : ''}${n.dim ? ' is-dim' : ''}" data-phase="${esc(
      n.key
    )}" data-phase-id="${esc(n.id)}" data-pos="${pos}">
      <span class="wbs-caret">${n.collapsed ? '+' : '−'}</span>
      <span class="wbs-node__id">${esc(n.id)}</span>
      <span class="wbs-node__title" title="${esc(n.name)}">${esc(n.name)}</span>
      <span class="wbs-node__count">${n.done}/${n.total}</span>
      <span class="wbs-node__pct">${pct}%</span>
      <button class="mini wbs-add" data-add-task-phase="${esc(n.id)}" title="新增任務到 ${esc(n.id)}">＋</button>
    </div>`;
  }
  const t = n.task;
  return `<div class="wbs-node wbs-node--task${t.done ? ' is-done' : ''}${n.critical ? ' is-critical' : ''}${
    n.selected ? ' is-selected' : ''
  }${n.dim ? ' is-dim' : ''}" data-task-link="${esc(t.id)}" data-pos="${pos}">
      <div class="wbs-node__head">
        <span class="wbs-drag" data-drag-task="${esc(t.id)}" title="拖曳到其他 phase">≡</span>
        ${tickBox(p.id, t)}
        <span class="wbs-node__id">${esc(t.id)}</span>
        <span class="wbs-node__title" title="${esc(t.title)}">${esc(truncate(t.title, 30))}</span>
      </div>
      <div class="wbs-node__meta" title="${esc(t.owner || '')} · ${esc(t.deliverable || '')}">${esc(
    t.owner || '—'
  )} · ${esc(truncate(t.deliverable || '—', 22))}</div>
    </div>`;
}

function renderWBS(p) {
  if (p.tasks.length === 0) return '<div class="empty">無任務。</div>';
  const tree = buildWbsTree(p);
  const layout = layoutWbs(tree);
  const nodesHtml = layout.nodes.map((n) => wbsNodeHtml(p, n)).join('');
  const pathCount = layout.drops.length + layout.spines.length + 2; // stub + bus + drops + spines
  const collapsedCount = Object.keys(state.collapsed).filter((k) => k.startsWith(p.id + '::')).length;
  const taskCount = layout.nodes.filter((n) => n.kind === 'task').length;
  const cw = Math.round(layout.canvasW);
  const ch = Math.round(layout.canvasH);

  return `<section class="section">
    <div class="section__head">
      <h2 class="section__title">WBS · 工作分解樹</h2>
      <div class="head-controls">
        <span class="section__note">由上至下 · ${layout.phases.length} 欄</span>
        <button class="btn btn--ghost${state.hintOn ? ' is-on' : ''}" type="button" data-hint-toggle title="顯示操作提示">?</button>
        <button class="btn btn--ghost${state.showMinimap ? ' is-on' : ''}" type="button" data-minimap-toggle title="顯示/隱藏迷你圖">迷你圖</button>
        <button class="btn btn--ghost${state.focusMode ? ' is-on' : ''}" type="button" data-focus title="只顯示選中任務嘅路徑 + deps">聚焦</button>
        <button class="btn btn--ghost" type="button" data-collapse-all title="收合全部">收合</button>
        <button class="btn btn--ghost" type="button" data-expand-all title="展開全部">展開</button>
        <button class="btn btn--ghost${state.showPhaseAdmin ? ' is-on' : ''}" type="button" data-phase-admin-toggle title="顯示/隱藏 PHASES 管理">管理</button>
        <button class="btn btn--ghost${state.showBulk ? ' is-on' : ''}" type="button" data-bulk-toggle title="顯示/隱藏批次操作">批次</button>
        <div class="zoomctl" role="group" aria-label="WBS 縮放">
          <button class="zbtn" type="button" data-wbs-zoom="out" title="縮小">−</button>
          <button class="zbtn zbtn--pct" type="button" data-wbs-zoom="reset" data-wbs-zoom-label title="重設 100%">100%</button>
          <button class="zbtn" type="button" data-wbs-zoom="in" title="放大">+</button>
          <button class="zbtn" type="button" data-wbs-zoom="fit" title="符合視窗">⤢</button>
        </div>
      </div>
    </div>
    ${renderFilterBar(p)}
    ${state.showPhaseAdmin ? renderPhaseAdmin(p) : ''}
    ${state.showBulk ? renderBulkBar() : ''}
    ${state.addingTask ? renderAddTaskForm() : ''}
    ${
      state.showMinimap
        ? `<div class="wbs-minibar"><div class="wbs-minimap" data-canvas="${cw},${ch}" title="迷你圖 · 拖曳或點擊導航">${buildMinimapSvg(
            layout
          )}<div class="wbs-mini-view"></div></div></div>`
        : ''
    }
    <div class="wbs-wrap">
      <div class="wbs-canvas" data-canvas="${cw},${ch}">
        <svg class="wbs-links" width="${cw}" height="${ch}">${wbsConnectors(layout)}</svg>
        ${nodesHtml}
      </div>
      ${
        state.hintOn || !state.hintDismissed
          ? '<div class="wbs-hint">滾輪縮放 · 拖曳平移</div>'
          : ''
      }
    </div>
    <div class="legend wbs-legend">
      <span>由上至下（根在上 · 欄＝階段 · 行＝層級）</span>
      <span>${layout.nodes.length} 節點 · ${taskCount} 任務 · ${layout.phases.length} 欄 · 連結 ${pathCount}</span>
      <span>收合 ${collapsedCount} · 點方格打勾 · 點階段收合 · 點任務睇詳情</span>
    </div>
  </section>`;
}

/** Post-render pass: absolute-position the tree nodes and size the canvas. */
function applyTreePositions(rootEl) {
  const canvas = rootEl.querySelector('.wbs-canvas');
  if (canvas) {
    const [w, h] = (canvas.getAttribute('data-canvas') || '0,0').split(',').map(Number);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
  }
  rootEl.querySelectorAll('[data-pos]').forEach((el) => {
    const [x, y, w, h] = (el.getAttribute('data-pos') || '0,0,0,0').split(',').map(Number);
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.width = w + 'px';
    el.style.height = h + 'px';
  });
}

/* ------------------------------ 進度 progress ---------------------------- */

function renderProgress(p) {
  const s = p.summary;
  const groups = groupByPhase(p);

  const phaseRows = groups
    .map((g) => {
      const done = g.tasks.filter((t) => t.done).length;
      const total = g.tasks.length;
      const pct = total ? Math.round((done / total) * 100) : 0;
      return prow(`${esc(g.id)} · ${esc(g.name)}`, pct, `${done}/${total}`);
    })
    .join('');

  const ownerMap = {};
  for (const t of p.tasks) {
    const o = t.owner || '(未指派)';
    ownerMap[o] = ownerMap[o] || { total: 0, done: 0 };
    ownerMap[o].total++;
    if (t.done) ownerMap[o].done++;
  }
  const ownerRows = Object.keys(ownerMap)
    .sort()
    .map((o) => {
      const { total, done } = ownerMap[o];
      const pct = total ? Math.round((done / total) * 100) : 0;
      return prow(esc(o), pct, `${done}/${total}`);
    })
    .join('');

  const delivTasks = p.tasks.filter((t) => t.outputs && t.outputs.length > 0);
  const delivCards = delivTasks
    .map((t) => {
      return `<div class="dcard">
        <div class="dcard__top">
          <span class="dcard__name" title="${esc(t.deliverable || t.title)}">${esc(t.deliverable || t.title)}</span>
          ${chip(t.status)}
        </div>
        <div class="dcard__id">${esc(t.id)} · ${esc(t.owner || '—')}</div>
        <div class="dcard__outs">${t.outputs.map((o) => esc(o)).join('<br>')}</div>
      </div>`;
    })
    .join('');

  const tvr = p.tasks
    .slice()
    .sort((a, b) => String(a.start).localeCompare(String(b.start)))
    .map((t) => {
      const planned = `${esc(t.start || '—')} → ${esc(t.plannedEnd || '—')}`;
      const actual = t.doneAt ? esc(t.doneAt) : '—';
      return `<tr class="is-clickable" data-task-link="${esc(t.id)}">
        <td class="id">${esc(t.id)}</td>
        <td>${esc(truncate(t.title, 34))}</td>
        <td class="id">${esc(t.owner || '—')}</td>
        <td class="id">${planned}</td>
        <td class="id">${actual}</td>
        <td>${chip(t.status)}</td>
      </tr>`;
    })
    .join('');

  return `
    <section class="prog-hero">
      <div>
        <div class="big-pct">${s.percent}<small>%</small></div>
        <div class="big-sub">整體完成 · ${s.tasksDone} / ${s.tasksTotal} 項</div>
      </div>
      <div>
        <div class="bar bar--v"><i data-w="${s.percent}"></i></div>
        <div class="big-sub">逾期 ${s.overdue} · 遲交 ${s.late} · 更新 ${s.lastUpdated ? fmtDateTime(s.lastUpdated) : '—'}</div>
      </div>
    </section>

    <section class="section">
      <div class="section__head"><h2 class="section__title">每階段進度</h2><span class="section__note">per phase</span></div>
      <div class="rows">${phaseRows || '<div class="empty">無階段。</div>'}</div>
    </section>

    <section class="section">
      <div class="section__head"><h2 class="section__title">每人工作量</h2><span class="section__note">per owner</span></div>
      <div class="rows">${ownerRows || '<div class="empty">未指派。</div>'}</div>
    </section>

    <section class="section">
      <div class="section__head"><h2 class="section__title">交付物</h2><span class="section__note">deliverables · ${delivTasks.length}</span></div>
      ${delivCards ? `<div class="deliv-grid">${delivCards}</div>` : '<div class="empty">未有交付物。</div>'}
    </section>

    <section class="section">
      <div class="section__head"><h2 class="section__title">時間 vs 實際</h2><span class="section__note">planned vs actual</span></div>
      <table class="tbl">
        <thead><tr><th>ID</th><th>Title</th><th>Owner</th><th>計劃</th><th>實際完成</th><th>狀態</th></tr></thead>
        <tbody>${tvr}</tbody>
      </table>
    </section>`;
}

function prow(nameHtml, pct, numHtml) {
  return `<div class="prow">
    <span class="prow__name">${nameHtml}</span>
    <span class="obar"><i data-w="${pct}"></i></span>
    <span class="prow__num">${esc(numHtml)}</span>
  </div>`;
}

/* ------------------------------ 甘特 Gantt ------------------------------- */

const LAYOUT = {
  labelW: 250,
  chartW: 780,
  rowH: 28,
  phaseH: 26,
  axisH: 34,
  msH: 46,
  barH: 12,
};

function renderGanttTab(p) {
  return `
    <section class="section">
      <div class="section__head">
        <h2 class="section__title">甘特</h2>
        <div class="head-controls">
          <span class="section__note">bars = start + estimate_days · filled = done</span>
          <button class="btn btn--ghost${state.showAllDeps ? ' is-on' : ''}" type="button" data-toggle-deps title="顯示全部依賴箭頭（預設只顯示選中任務 + 關鍵路徑）">顯示全部依賴</button>
          <div class="zoomctl" role="group" aria-label="甘特縮放">
            <button class="zbtn" type="button" data-gantt-zoom="out" title="縮小">−</button>
            <button class="zbtn zbtn--pct" type="button" data-gantt-zoom="reset" data-gantt-zoom-label title="重設 100%">100%</button>
            <button class="zbtn" type="button" data-gantt-zoom="in" title="放大">+</button>
            <button class="zbtn" type="button" data-gantt-zoom="fit" title="符合視窗">⤢</button>
          </div>
        </div>
      </div>
      ${renderFilterBar(p)}
      <div class="gantt">${buildGanttInner(p)}</div>
      ${renderLegend()}
    </section>

    <section class="section">
      <div class="section__head">
        <h2 class="section__title">任務表</h2>
        <span class="section__note">${p.tasks.filter(passesFilter).length} / ${p.tasks.length} 項 · Ctrl/Shift-點選多項</span>
      </div>
      ${renderBulkBar()}
      ${renderTaskTable(p)}
    </section>`;
}

function renderLegend() {
  return `<div class="legend">
    <span><i class="outline"></i>planned</span>
    <span><i class="done"></i>done</span>
    <span><i class="outline-overdue"></i>overdue</span>
    <span>◆ milestone</span>
    <span>→ dependency</span>
    <span>▏today</span>
  </div>`;
}

function renderTaskTable(p) {
  if (p.tasks.length === 0) return '<div class="empty">無任務。</div>';
  const tasks = p.tasks.filter(passesFilter);
  const rows =
    tasks
      .map((t) => {
        const sel = !!state.selection[t.id];
        const crit = criticalSet().has(t.id);
        return `<tr class="is-clickable${t.done ? ' is-done' : ''}${sel ? ' is-selected' : ''}${
          crit ? ' is-critical' : ''
        }" data-task-link="${esc(t.id)}">
      <td class="col-sel"><input type="checkbox" data-select="${esc(t.id)}"${sel ? ' checked' : ''} title="勾選以批次操作"></td>
      <td class="col-tick">${tickBox(p.id, t)}</td>
      <td class="id">${esc(t.id)}</td>
      <td class="col-title" title="${esc(t.title)}">${esc(t.title)}</td>
      <td class="id">${esc(t.phase || '—')}</td>
      <td class="id">${esc(t.owner || '—')}</td>
      <td class="dep">${esc(t.deps.join(', ') || '—')}</td>
      <td>${esc(t.deliverable || '—')}</td>
    </tr>`;
      })
      .join('') || '<tr><td colspan="8" class="muted">無符合篩選嘅任務</td></tr>';
  return `<table class="tbl">
    <thead><tr><th class="col-sel" title="勾選以批次標記">選取</th><th class="col-tick" title="打勾 = 完成">完成</th><th>ID</th><th>Title</th><th>Phase</th><th>Owner</th><th>Deps</th><th>Deliverable</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * Gantt inner content: a fixed (sticky) HTML label column + an absolutely
 * positioned SVG plot. The plot width scales with `state.ganttBase * state.ganttRel`, so zooming
 * re-renders the time axis; panning is native horizontal scroll, and the label
 * column stays pinned because it is `position: sticky`.
 */
function buildGanttInner(p) {
  const { labelW, rowH, phaseH, axisH, msH, barH } = LAYOUT;
  const groups = groupByPhase(p, true);
  const crit = criticalSet();
  const base = state.showBaseline && state.baseline && state.baseline.tasks ? state.baseline.tasks : null;

  const dates = [];
  const push = (v) => {
    const d = toDate(v);
    if (d) dates.push(d);
  };
  push(p.created);
  push(p.target);
  for (const t of p.tasks) {
    push(t.start);
    push(t.plannedEndExclusive);
    push(t.doneAt);
  }
  for (const m of p.milestones || []) push(m.date);
  {
    // Same basis as the bars (toDate('YYYY-MM-DD') = UTC midnight), so a task
    // starting today lines up with the "today" line.
    const td = toDate(hkTodayStrClient());
    dates.push(td || new Date());
  }

  let t0 = dates.length ? Math.min(...dates.map((d) => d.getTime())) : Date.now();
  let t1 = dates.length ? Math.max(...dates.map((d) => d.getTime())) : Date.now() + DAY * 10;
  if (t1 <= t0) t1 = t0 + DAY;
  const padMs = (t1 - t0) * 0.02;
  t0 -= padMs;
  t1 += padMs;

  // Fit-to-content baseline: widen until a 1-unit bar is ~10px so bars stay
  // readable at the default (100%) zoom.
  const spanDays = Math.max(1, (t1 - t0) / DAY);
  const estimates = (p.tasks || []).map((t) => (Number(t.estimate_days) > 0 ? Number(t.estimate_days) : 1));
  const smallest = estimates.length ? Math.min.apply(null, estimates) : 1;
  const fitBase = clamp(Math.max(1, (10 * spanDays) / (LAYOUT.chartW * smallest)), 0.4, 2.5);
  state.ganttBase = fitBase;
  const chartW = LAYOUT.chartW * fitBase * state.ganttRel;

  const xOf = (ms) => labelW + ((ms - t0) / (t1 - t0)) * chartW;
  const xOfDate = (v) => {
    const d = toDate(v);
    return d ? xOf(d.getTime()) : null;
  };

  let y = axisH;
  const rows = [];
  for (const g of groups) {
    rows.push({ type: 'phase', group: g, y });
    y += phaseH;
    for (const t of g.tasks) {
      rows.push({ type: 'task', task: t, y });
      y += rowH;
    }
  }
  const msLaneY = y;
  y += msH;
  const totalW = labelW + chartW;
  const totalH = y;

  const taskRowY = {};
  for (const it of rows) if (it.type === 'task') taskRowY[it.task.id] = it.y;

  const plot = [];
  const labels = [];

  const ticks = buildTicks(t0, t1);
  for (const tk of ticks) {
    const x = xOf(tk.getTime());
    plot.push(`<line class="g-grid" x1="${x.toFixed(1)}" y1="${axisH}" x2="${x.toFixed(1)}" y2="${totalH - msH + 8}"/>`);
    plot.push(`<text class="g-tick-label" x="${x.toFixed(1)}" y="${axisH - 12}" text-anchor="middle">${esc(shortDate(tk))}</text>`);
  }

  labels.push(`<div class="g-lab g-lab--head" data-top="0" data-h="${axisH}">PHASE / TASK</div>`);
  plot.push(`<line class="g-axis" x1="${labelW}" y1="${axisH}" x2="${totalW}" y2="${axisH}"/>`);
  plot.push(`<line class="g-grid" x1="${labelW}" y1="${axisH}" x2="${labelW}" y2="${totalH}"/>`);

  const depArrows = [];
  for (const item of rows) {
    if (item.type !== 'task') continue;
    const t = item.task;
    const cy = item.y + rowH / 2;
    const barY = cy - barH / 2;

    const x1 = xOfDate(t.start);
    const x2 = xOfDate(t.plannedEndExclusive);
    if (base && base[t.id] && base[t.id].start) {
      const b1 = xOfDate(base[t.id].start);
      const b2 = xOfDate(addDaysClient(base[t.id].start, Number(base[t.id].estimate_days) || 1));
      if (b1 != null && b2 != null) {
        plot.push(`<rect class="g-bar-ghost" x="${b1.toFixed(1)}" y="${(barY - 3).toFixed(1)}" width="${Math.max(2, b2 - b1).toFixed(1)}" height="${(barH + 6).toFixed(1)}"/>`);
      }
      const slip =
        t.plannedEnd && base[t.id].plannedEnd
          ? Math.round((toDate(t.plannedEnd).getTime() - toDate(base[t.id].plannedEnd).getTime()) / DAY)
          : 0;
      if (slip > 0 && x2 != null) {
        plot.push(`<text class="g-slip" x="${(x2 + 4).toFixed(1)}" y="${(barY + barH - 1).toFixed(1)}">+${slip}d</text>`);
      }
    }
    if (x1 != null && x2 != null) {
      const bw = Math.max(2, x2 - x1);
      const critCls = crit.has(t.id) ? ' is-critical' : '';
      const overdueCls = t.status === 'overdue' ? ' is-overdue' : '';
      plot.push(`<rect class="g-bar-outline${overdueCls}${critCls}" x="${x1.toFixed(1)}" y="${barY.toFixed(1)}" width="${bw.toFixed(1)}" height="${barH}"/>`);
      if (t.done) {
        plot.push(`<rect class="g-bar-done${critCls}" x="${x1.toFixed(1)}" y="${barY.toFixed(1)}" width="${bw.toFixed(1)}" height="${barH}"/>`);
      }
    }
    if (t.doneAt) {
      const dx = xOfDate(t.doneAt);
      if (dx != null) {
        plot.push(`<line class="g-actual-tick" x1="${dx.toFixed(1)}" y1="${(barY - 4).toFixed(1)}" x2="${dx.toFixed(1)}" y2="${(barY + barH + 4).toFixed(1)}"/>`);
      }
    }

    plot.push(`<rect class="g-row-hit" data-task-link="${esc(t.id)}" x="0" y="${item.y}" width="${totalW}" height="${rowH}"/>`);
    labels.push(
      `<div class="g-lab g-lab--task" data-top="${item.y}" data-h="${rowH}">` +
        `<span class="g-lab__id">${esc(t.id)}</span>` +
        `<span class="g-lab__title">${esc(truncate(t.title, 22))} · ${esc(t.owner || '—')}</span></div>`
    );

    if (Array.isArray(t.deps)) {
      for (const dep of t.deps) {
        const depItem = rows.find((l) => l.type === 'task' && l.task.id === dep);
        if (!depItem || taskRowY[dep] == null) continue;
        const dEnd = xOfDate(depItem.task.plannedEndExclusive);
        const aStart = x1;
        if (dEnd == null || aStart == null) continue;
        const show = state.showAllDeps || t.id === state.selectedTaskId || (crit.has(t.id) && crit.has(dep));
        depArrows.push({ x1: dEnd, y1: depItem.y + rowH / 2, x2: aStart, y2: cy, show });
      }
    }
  }

  for (const item of rows) {
    if (item.type !== 'phase') continue;
    labels.push(`<div class="g-lab g-lab--phase" data-top="${item.y}" data-h="${phaseH}">${esc(item.group.id)} · ${esc(truncate(item.group.name, 22))}</div>`);
    plot.push(`<line class="g-phase-rule" x1="${labelW}" y1="${item.y}" x2="${totalW}" y2="${item.y}"/>`);
  }

  let depIdx = 0;
  for (const a of depArrows) {
    if (!a.show) continue;
    const x1 = a.x1;
    const y1 = a.y1;
    const y2 = a.y2;
    const x2 = Math.max(a.x2, x1);
    const lane = x1 + 6 + (depIdx % 4) * 4; // separate fan-in/out lanes
    depIdx++;
    let d;
    if (x2 >= lane + 4) {
      d = `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${lane.toFixed(1)} ${y1.toFixed(1)} L ${lane.toFixed(1)} ${y2.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    } else {
      d = `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x1.toFixed(1)} ${y2.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    }
    plot.push(`<path class="g-dep" d="${d}"/>`);
    plot.push(`<polygon class="g-dep-head" points="${x2.toFixed(1)},${y2.toFixed(1)} ${(x2 - 5).toFixed(1)},${(y2 - 3).toFixed(1)} ${(x2 - 5).toFixed(1)},${(y2 + 3).toFixed(1)}"/>`);
  }

  const doneSet = new Set(p.tasks.filter((t) => t.done).map((t) => t.id));
  for (const m of p.milestones || []) {
    const x = xOfDate(m.date);
    if (x == null) continue;
    plot.push(`<line class="g-marker-line" x1="${x.toFixed(1)}" y1="${axisH}" x2="${x.toFixed(1)}" y2="${msLaneY + msH - 14}"/>`);
    const cyy = msLaneY + msH - 20;
    const allDone = Array.isArray(m.after) && m.after.length > 0 && m.after.every((a) => doneSet.has(a));
    plot.push(`<polygon class="g-marker${allDone ? ' g-marker--done' : ''}" points="${x.toFixed(1)},${(cyy - 6).toFixed(1)} ${(x + 6).toFixed(1)},${cyy.toFixed(1)} ${x.toFixed(1)},${(cyy + 6).toFixed(1)} ${(x - 6).toFixed(1)},${cyy.toFixed(1)}"/>`);
    plot.push(`<text class="g-label--dim g-ms-label" x="${x.toFixed(1)}" y="${(msLaneY + 12).toFixed(1)}" text-anchor="middle">${esc(m.id)} ${esc(truncate(m.name, 18))}</text>`);
  }

  plot.push(`<line class="g-phase-rule" x1="${labelW}" y1="${msLaneY}" x2="${totalW}" y2="${msLaneY}"/>`);
  labels.push(`<div class="g-lab g-lab--ms" data-top="${msLaneY}" data-h="${msH}">MILESTONES</div>`);

  const todayAnchor = toDate(hkTodayStrClient());
  const now = todayAnchor ? todayAnchor.getTime() : Date.now();
  if (now >= t0 && now <= t1) {
    const x = xOf(now);
    plot.push(`<line class="g-today" x1="${x.toFixed(1)}" y1="${axisH}" x2="${x.toFixed(1)}" y2="${totalH}"/>`);
  }

  const svg = `<svg class="gantt-svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}" role="img" aria-label="Gantt chart">${plot.join('')}</svg>`;
  return `<div class="gantt-inner" data-canvas="${Math.round(totalW)},${Math.round(totalH)}"><div class="gantt-labels">${labels.join('')}</div>${svg}</div>`;
}

function buildTicks(t0, t1) {
  const start = new Date(t0);
  const end = new Date(t1);
  const totalDays = (t1 - t0) / DAY;
  const ticks = [];
  if (totalDays > 110) {
    let d = new Date(start.getUTCFullYear(), start.getUTCMonth(), 1);
    while (d.getTime() <= t1) {
      if (d.getTime() >= t0) ticks.push(new Date(d));
      d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    }
  } else {
    const step = Math.max(1, Math.ceil(totalDays / 6));
    let d = new Date(t0);
    while (d.getTime() <= t1) {
      if (d.getTime() >= t0) ticks.push(new Date(d));
      d = new Date(d.getTime() + step * DAY);
    }
  }
  if (ticks.length === 0) ticks.push(start, end);
  return ticks;
}

function shortDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/* ------------------------------ task panel ------------------------------- */

function renderTaskPanel(project) {
  const panel = document.getElementById('task-panel');
  const body = document.getElementById('task-panel-body');
  const kicker = document.getElementById('task-panel-kicker');

  const task =
    project && state.selectedTaskId ? project.tasks.find((t) => t.id === state.selectedTaskId) : null;

  if (!task) {
    panel.hidden = true;
    body.innerHTML = '';
    return;
  }

  kicker.textContent = `${task.id} · ${project.id}`;
  body.innerHTML = state.editingTask === task.id ? renderTaskEditForm(project, task) : renderTaskRead(project, task);
  panel.hidden = false;
}

function renderTaskRead(project, task) {
  const phaseTasks = project.tasks.filter((t) => t.phase === task.phase);
  const pi = phaseTasks.findIndex((t) => t.id === task.id);
  const firstInPhase = pi <= 0;
  const lastInPhase = pi < 0 || pi >= phaseTasks.length - 1;
  return `
    <h2 class="panel__title">${esc(task.title)}</h2>
    <div class="panel__status">
      ${chip(task.status)}
      ${tickBox(project.id, task)}
      <span class="muted mono">${task.done ? '已完成' : '未完成'}</span>
    </div>
    <div class="panel__ops">
      <button class="btn btn--ghost${state.focusMode ? ' is-on' : ''}" type="button" data-focus title="只顯示此任務路徑 + deps（鍵盤 f）">聚焦路徑</button>
      <button class="btn" type="button" data-task-edit="${esc(task.id)}">編輯</button>
      <button class="btn btn--ghost" type="button" data-task-up="${esc(task.id)}"${firstInPhase ? ' disabled' : ''} title="${firstInPhase ? '已喺此 phase 最前' : '同 phase 內上移'}">上移</button>
      <button class="btn btn--ghost" type="button" data-task-down="${esc(task.id)}"${lastInPhase ? ' disabled' : ''} title="${lastInPhase ? '已喺此 phase 最後' : '同 phase 內下移'}">下移</button>
      <button class="btn btn--ghost" type="button" data-task-del="${esc(task.id)}">刪除…</button>
    </div>
    ${field('Deliverable', esc(task.deliverable || '—'), true)}
    ${field('Owner', esc(task.owner || '—'), true)}
    ${field('Phase', esc(task.phase || '—'), true)}
    ${field('Deps', pills(task.deps))}
    ${field('Acceptance', esc(task.acceptance || '—'))}
    ${field('Outputs', pills(task.outputs))}
    ${field('計劃', `${esc(task.start || '—')} → ${esc(task.plannedEnd || '—')} · ${task.estimate_days} 日`, true)}
    ${field('實際完成', task.doneAt ? esc(task.doneAt) : '—', true)}
    ${field('Note', esc(task.note || '—'))}
    ${field(
      '移動到 phase',
      `<select class="fin" data-task-move="${esc(task.id)}">${project.phases
        .map((ph) => `<option value="${esc(ph.id)}"${ph.id === task.phase ? ' selected' : ''}>${esc(ph.id)} · ${esc(ph.name)}</option>`)
        .join('')}</select>`
    )}
  `;
}

function renderTaskEditForm(project, task) {
  const depIds = new Set(task.deps);
  const depsList =
    project.tasks
      .filter((t) => t.id !== task.id)
      .map(
        (t) =>
          `<label class="depopt"><input type="checkbox" data-dep="${esc(t.id)}"${depIds.has(t.id) ? ' checked' : ''}> <span class="mono">${esc(
            t.id
          )}</span> ${esc(truncate(t.title, 22))}</label>`
      )
      .join('') || '<span class="muted">無其他任務</span>';
  return `
    <h2 class="panel__title">編輯 <span class="mono">${esc(task.id)}</span></h2>
    <div class="form">
      ${fld('標題', `<input class="fin fin--wide" type="text" data-edit="title" value="${esc(task.title)}">`)}
      ${fld('Owner', `<input class="fin" type="text" data-edit="owner" value="${esc(task.owner || '')}">`)}
      ${fld('Start', `<input class="fin" type="date" data-edit="start" value="${esc(task.start || '')}">`)}
      ${fld('Estimate 日', `<input class="fin" type="number" min="1" data-edit="estimate_days" value="${task.estimate_days}">`)}
      ${fld('Deliverable', `<input class="fin fin--wide" type="text" data-edit="deliverable" value="${esc(task.deliverable || '')}">`)}
      ${fld('Acceptance', `<textarea class="fin fin--wide" data-edit="acceptance" rows="2">${esc(task.acceptance || '')}</textarea>`)}
      ${fld('Outputs（逗號分隔）', `<input class="fin fin--wide" type="text" data-edit="outputs" value="${esc((task.outputs || []).join(', '))}">`)}
      ${fld(
        'Phase',
        `<select class="fin" data-edit="phase">${project.phases
          .map((ph) => `<option value="${esc(ph.id)}"${ph.id === task.phase ? ' selected' : ''}>${esc(ph.id)} · ${esc(ph.name)}</option>`)
          .join('')}</select>`
      )}
      <div class="field">
        <div class="field__label">Deps</div>
        <div class="depbox">${depsList}</div>
        <div class="cycle-warn" id="deps-warn" hidden></div>
      </div>
      <div class="panel__ops">
        <button class="btn" type="button" data-task-save>儲存</button>
        <button class="btn btn--ghost" type="button" data-task-cancel>取消</button>
      </div>
    </div>`;
}

function fld(label, inner) {
  return `<div class="field"><div class="field__label">${esc(label)}</div>${inner}</div>`;
}

function field(label, valueHtml, mono) {
  return `<div class="field">
    <div class="field__label">${esc(label)}</div>
    <div class="field__value${mono ? ' is-mono' : ''}">${valueHtml}</div>
  </div>`;
}

/* ------------------------------ dynamic widths --------------------------- */

function applyDynamicWidths(rootEl) {
  rootEl.querySelectorAll('[data-w]').forEach((el) => {
    const v = Number(el.getAttribute('data-w'));
    el.style.width = `${Math.max(0, Math.min(100, Number.isFinite(v) ? v : 0))}%`;
  });
}

/* ------------------------------ UX: persistence -------------------------- */

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

const LS = {
  rail: 'pc.railWidth',
  project: 'pc.projectId',
  view: 'pc.view',
  wbsZoom: 'pc.wbsZoom',
};

function persist(key, val) {
  try {
    localStorage.setItem(key, String(val));
  } catch (_) {
    /* storage unavailable */
  }
}

function loadUI() {
  try {
    const rw = parseFloat(localStorage.getItem(LS.rail));
    if (Number.isFinite(rw)) state.railWidth = clamp(rw, 180, 480);
    const pid = localStorage.getItem(LS.project);
    if (pid) state.selectedProjectId = pid;
    const v = localStorage.getItem(LS.view);
    if (v && TABS.some((t) => t[0] === v)) state.view = v;
    const wz = parseFloat(localStorage.getItem(LS.wbsZoom));
    if (Number.isFinite(wz)) state.wbsZoom = clamp(wz, 0.4, 2.5);
    const u = JSON.parse(localStorage.getItem('pc.undo') || '[]');
    if (Array.isArray(u)) state.undoStack = u.slice(-UNDO_CAP);
    const r = JSON.parse(localStorage.getItem('pc.redo') || '[]');
    if (Array.isArray(r)) state.redoStack = r.slice(-UNDO_CAP);
    const th = localStorage.getItem('pc.theme');
    if (th === 'light' || th === 'dark' || th === 'auto') state.theme = th;
    const de = localStorage.getItem('pc.density');
    if (de === 'cozy' || de === 'compact') state.density = de;
    const pw = parseFloat(localStorage.getItem('pc.panelWidth'));
    if (Number.isFinite(pw)) state.panelWidth = clamp(pw, 320, 720);
    const tv = localStorage.getItem('pc.topView');
    if (tv === 'dashboard' || tv === 'roadmap' || tv === 'myday') state.topView = tv;
    const meLS = localStorage.getItem('pc.me');
    if (typeof meLS === 'string') state.me = meLS;
    const so = localStorage.getItem('pc.sort');
    if (['name', 'rag', 'target', 'progress'].includes(so)) state.sort = so;
    state.pins = JSON.parse(localStorage.getItem('pc.pins') || '{}') || {};
    state.colors = JSON.parse(localStorage.getItem('pc.colors') || '{}') || {};
    const gr = parseFloat(localStorage.getItem('pc.ganttRel'));
    if (Number.isFinite(gr) && gr > 0) state.ganttRel = clamp(gr, 0.05, 6);
    const mmv = localStorage.getItem('pc.minimap');
    if (mmv === '0') state.showMinimap = false;
    if (localStorage.getItem('pc.showAllDeps') === '1') state.showAllDeps = true;
  } catch (_) {
    /* storage unavailable */
  }
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
}
function applyDensity() {
  document.documentElement.setAttribute('data-density', state.density);
}
function applyPanelWidth() {
  document.documentElement.style.setProperty('--panel-w', state.panelWidth + 'px');
}

/* ------------------------------ UX: rail --------------------------------- */

function applyRailWidth() {
  document.documentElement.style.setProperty('--rail-w', state.railWidth + 'px');
}

function railMax() {
  return Math.max(180, Math.min(480, Math.round(window.innerWidth * 0.4)));
}

function setRailWidth(w) {
  state.railWidth = clamp(w, 180, railMax());
  applyRailWidth();
  persist(LS.rail, state.railWidth);
}

function setupSplitter() {
  const sp = document.getElementById('rail-splitter');
  if (!sp) return;
  sp.addEventListener('dblclick', () => setRailWidth(300));
  sp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      setRailWidth(state.railWidth + (e.key === 'ArrowLeft' ? -16 : 16));
    }
  });
}

/* ------------------------------ UX: WBS zoom/pan ------------------------- */

function wbsZoomAround(factor, px, py) {
  const old = state.wbsZoom;
  const next = clamp(old * factor, 0.4, 2.5);
  if (next === old) return;
  const k = next / old;
  state.wbsPan.x = px - (px - state.wbsPan.x) * k;
  state.wbsPan.y = py - (py - state.wbsPan.y) * k;
  state.wbsZoom = next;
}

/** Keep a minimum margin of content visible so panning can't hide the tree. */
function clampWbsPan() {
  const wrap = document.querySelector('#project-view .wbs-wrap');
  const canvas = document.querySelector('#project-view .wbs-canvas');
  if (!wrap || !canvas) return;
  const parts = (canvas.getAttribute('data-canvas') || '0,0').split(',').map(Number);
  const cw = parts[0];
  const ch = parts[1];
  if (!cw || !ch) return;
  const z = state.wbsZoom;
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;
  const M = 40;
  const cW = cw * z;
  const cH = ch * z;
  const range = (content, view) => (content <= view ? [0, view - content] : [M - content, view - M]);
  const rx = range(cW, W);
  const ry = range(cH, H);
  state.wbsPan.x = clamp(state.wbsPan.x, rx[0], rx[1]);
  state.wbsPan.y = clamp(state.wbsPan.y, ry[0], ry[1]);
}

function applyWbsTransform() {
  const canvas = document.querySelector('#project-view .wbs-canvas');
  if (!canvas) return;
  clampWbsPan();
  canvas.style.transform = `translate(${state.wbsPan.x}px, ${state.wbsPan.y}px) scale(${state.wbsZoom})`;
}

function wbsZoomAction(action) {
  const wrap = document.querySelector('#project-view .wbs-wrap');
  if (!wrap) return;
  if (action === 'reset') {
    state.wbsZoom = 1;
    state.wbsPan = { x: 0, y: 0 };
  } else if (action === 'fit') {
    const canvas = wrap.querySelector('.wbs-canvas');
    if (!canvas) return;
    const [cw, ch] = (canvas.getAttribute('data-canvas') || '0,0').split(',').map(Number);
    const z = clamp(Math.min(wrap.clientWidth / cw, wrap.clientHeight / ch), 0.4, 2.5);
    state.wbsZoom = z;
    state.wbsPan = {
      x: Math.max(0, (wrap.clientWidth - cw * z) / 2),
      y: Math.max(0, (wrap.clientHeight - ch * z) / 2),
    };
  } else {
    const factor = action === 'in' ? 1.25 : 1 / 1.25;
    wbsZoomAround(factor, wrap.clientWidth / 2, wrap.clientHeight / 2);
  }
  applyWbsTransform();
  updateZoomLabels();
  persist(LS.wbsZoom, state.wbsZoom);
  dismissHint();
}

/* ------------------------------ UX: Gantt zoom/pan ----------------------- */

function applyGanttPositions(rootEl) {
  const inner = rootEl.querySelector('.gantt-inner');
  if (!inner) return;
  const [w, h] = (inner.getAttribute('data-canvas') || '0,0').split(',').map(Number);
  inner.style.width = w + 'px';
  inner.style.height = h + 'px';
  rootEl.querySelectorAll('.g-lab').forEach((el) => {
    el.style.top = (el.getAttribute('data-top') || 0) + 'px';
    const hh = el.getAttribute('data-h');
    if (hh) el.style.height = hh + 'px';
  });
}

function applyGanttPan() {
  const el = document.querySelector('#project-view .gantt');
  if (el) el.scrollLeft = state.ganttPanX || 0;
}

function refreshGantt() {
  const el = document.querySelector('#project-view .gantt');
  const p = currentProject();
  if (!el || !p) return;
  el.innerHTML = buildGanttInner(p);
  applyGanttPositions(el);
  el.scrollLeft = state.ganttPanX || 0;
}

function ganttZoomAround(factor, contentX) {
  const { labelW, chartW: baseCh } = LAYOUT;
  const b = state.ganttBase || 1;
  const oldAbs = b * state.ganttRel;
  // Zoom-in always works: allow up to 4× the fitted baseline (not capped by an
  // absolute 2.5 that made long-span projects un-zoomable).
  const nextRel = clamp(state.ganttRel * factor, 0.4 / b, 4);
  const newAbs = b * nextRel;
  if (newAbs === oldAbs) return state.ganttRel;
  const f = clamp((contentX - labelW) / (baseCh * oldAbs), 0, 1);
  state.ganttPanX = clamp((state.ganttPanX || 0) + (baseCh * newAbs - baseCh * oldAbs) * f, 0, Math.max(0, baseCh * newAbs - (labelW + 1)));
  state.ganttRel = nextRel;
  persist('pc.ganttRel', state.ganttRel);
  return nextRel;
}

function ganttZoomAction(action) {
  const el = document.querySelector('#project-view .gantt');
  if (!el) return;
  if (action === 'reset' || action === 'fit') {
    state.ganttRel = 1; // 100% = fitted baseline
    state.ganttPanX = 0;
  } else {
    ganttZoomAround(action === 'in' ? 1.25 : 1 / 1.25, el.clientWidth / 2 + el.scrollLeft);
  }
  persist('pc.ganttRel', state.ganttRel);
  refreshGantt();
  updateZoomLabels();
}

/* ------------------------------ UX: wheel & drag ------------------------- */

function wheelDelta(e) {
  let d = e.deltaY;
  if (e.deltaMode === 1) d *= 16;
  else if (e.deltaMode === 2) d *= 100;
  return d;
}

function onWheel(e) {
  const wrap = e.target.closest('.wbs-wrap');
  if (wrap) {
    e.preventDefault();
    const rect = wrap.getBoundingClientRect();
    wbsZoomAround(Math.exp(-wheelDelta(e) * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    applyWbsTransform();
    updateZoomLabels();
    persist(LS.wbsZoom, state.wbsZoom);
    dismissHint();
    return;
  }
  const rmap = e.target.closest('.roadmap');
  if (rmap) {
    e.preventDefault();
    const rect = rmap.getBoundingClientRect();
    const contentX = e.clientX - rect.left + rmap.scrollLeft;
    const labelW = 220;
    const base = 780;
    const oldZ = state.roadmapZoom;
    const next = clamp(oldZ * Math.exp(-wheelDelta(e) * 0.0015), 0.4, 2.5);
    if (next === oldZ) return;
    const f = clamp((contentX - labelW) / (base * oldZ), 0, 1);
    const nl = rmap.scrollLeft + (base * next - base * oldZ) * f;
    state.roadmapZoom = next;
    render();
    const el = document.querySelector('.roadmap');
    if (el) {
      el.scrollLeft = nl;
      state.roadmapPanX = el.scrollLeft;
    }
    updateZoomLabels();
    return;
  }
  const gantt = e.target.closest('.gantt');
  if (!gantt) return;
  e.preventDefault();
  if (e.shiftKey) {
    gantt.scrollLeft += wheelDelta(e) || e.deltaX;
    state.ganttPanX = gantt.scrollLeft;
    return;
  }
  const rect = gantt.getBoundingClientRect();
  const contentX = e.clientX - rect.left + gantt.scrollLeft;
  const { labelW, chartW: baseCh } = LAYOUT;
  const b = state.ganttBase || 1;
  const oldAbs = b * state.ganttRel;
  const factor = Math.exp(-wheelDelta(e) * 0.0015);
  const nextRel = clamp(state.ganttRel * factor, 0.4 / b, 4);
  const newAbs = b * nextRel;
  if (newAbs === oldAbs) return;
  const f = clamp((contentX - labelW) / (baseCh * oldAbs), 0, 1);
  const newScrollLeft = gantt.scrollLeft + (baseCh * newAbs - baseCh * oldAbs) * f;
  state.ganttRel = nextRel;
  persist('pc.ganttRel', nextRel);
  refreshGantt();
  const el2 = document.querySelector('#project-view .gantt');
  if (el2) {
    el2.scrollLeft = newScrollLeft;
    state.ganttPanX = el2.scrollLeft;
  }
  updateZoomLabels();
}

let drag = null;

function onPointerDown(e) {
  if (e.button !== 0 && e.button !== 1) return;
  if (e.target.closest('#rail-reset')) return; // reset button, not a drag
  if (e.target.closest('#rail-splitter')) {
    drag = { kind: 'rail', x: e.clientX, w: state.railWidth };
    document.body.classList.add('is-dragging-rail');
    e.preventDefault();
    return;
  }
  if (e.target.closest('.zoomctl')) return;
  if (e.target.closest('#panel-resizer')) {
    drag = { kind: 'panel', x: e.clientX, w: state.panelWidth };
    document.body.classList.add('is-dragging-panel');
    e.preventDefault();
    return;
  }
  const rmap = e.target.closest('.roadmap');
  if (rmap) {
    drag = { kind: 'roadmap', x: e.clientX, sl: rmap.scrollLeft, el: rmap, moved: false };
    rmap.classList.add('is-panning');
    e.preventDefault();
    return;
  }
  if (e.target.closest('.wbs-minimap')) {
    drag = { kind: 'minimap' };
    handleMinimap(e);
    e.preventDefault();
    return;
  }
  const handle = e.target.closest('[data-drag-task]');
  if (handle) {
    drag = { kind: 'task', taskId: handle.getAttribute('data-drag-task'), el: handle };
    handle.classList.add('is-dragging');
    e.preventDefault();
    return;
  }
  const gantt = e.target.closest('.gantt');
  if (gantt) {
    drag = { kind: 'gantt', x: e.clientX, y: e.clientY, sl: gantt.scrollLeft, st: gantt.scrollTop, el: gantt, moved: false };
    gantt.classList.add('is-panning');
    e.preventDefault();
    return;
  }
  const wrap = e.target.closest('.wbs-wrap');
  if (wrap) {
    drag = { kind: 'wbs', x: e.clientX, y: e.clientY, px: state.wbsPan.x, py: state.wbsPan.y, el: wrap, moved: false };
    wrap.classList.add('is-panning');
  }
}

function onPointerMove(e) {
  if (!drag) return;
  if (drag.kind === 'rail') {
    setRailWidth(drag.w + (e.clientX - drag.x));
    return;
  }
  if (drag.kind === 'task') {
    document.querySelectorAll('.is-drop').forEach((el) => el.classList.remove('is-drop'));
    const els = document.elementsFromPoint(e.clientX, e.clientY);
    const ph = els.map((x) => x.closest && x.closest('[data-phase-id]')).find(Boolean);
    if (ph) ph.classList.add('is-drop');
    return;
  }
  if (drag.kind === 'panel') {
    setPanelWidth(drag.w + (e.clientX - drag.x));
    return;
  }
  if (drag.kind === 'roadmap') {
    const dxr = e.clientX - drag.x;
    if (Math.abs(dxr) > 3) drag.moved = true;
    drag.el.scrollLeft = drag.sl - dxr;
    state.roadmapPanX = drag.el.scrollLeft;
    return;
  }
  if (drag.kind === 'minimap') {
    handleMinimap(e);
    return;
  }
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  if (drag.kind === 'gantt') {
    drag.el.scrollLeft = drag.sl - dx;
    drag.el.scrollTop = drag.st - dy;
    state.ganttPanX = drag.el.scrollLeft;
  } else if (drag.kind === 'wbs') {
    state.wbsPan.x = drag.px + dx;
    state.wbsPan.y = drag.py + dy;
    applyWbsTransform();
    dismissHint();
  }
}

function onPointerUp(e) {
  if (!drag) return;
  if (drag.kind === 'rail') {
    document.body.classList.remove('is-dragging-rail');
    setRailWidth(state.railWidth);
  } else if (drag.kind === 'task') {
    if (drag.el) drag.el.classList.remove('is-dragging');
    document.querySelectorAll('.is-drop').forEach((el) => el.classList.remove('is-drop'));
    const els = (e && document.elementsFromPoint(e.clientX, e.clientY)) || [];
    const ph = els.map((x) => x.closest && x.closest('[data-phase-id]')).find(Boolean);
    if (ph) {
      const phaseId = ph.getAttribute('data-phase-id');
      const p = currentProject();
      if (p) window.api.moveTask(p.id, drag.taskId, { phaseId }).then((res) => afterWrite(res, '已移到 ' + phaseId));
    }
    drag = null;
    return;
  } else if (drag.kind === 'panel') {
    document.body.classList.remove('is-dragging-panel');
    setPanelWidth(state.panelWidth);
    state._suppressClick = true; // trailing click must not close the panel
  } else if (drag.kind === 'roadmap') {
    if (drag.el) drag.el.classList.remove('is-panning');
    if (drag.moved) state._suppressClick = true;
  } else if (drag.kind === 'minimap') {
    /* handled live */
  } else {
    if (drag.el) drag.el.classList.remove('is-panning');
    if (drag.moved) state._suppressClick = true;
  }
  drag = null;
}

function onKeyDown(e) {
  const tag = (e.target && e.target.tagName) || '';
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  if (state.guideOpen) {
    // While the manual is open it swallows shortcuts; Esc closes it.
    if (e.key === 'Escape') {
      e.preventDefault();
      closeGuide();
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
    return;
  }
  if (e.key === 'Escape') {
    if (state.ctx) return closeCtx();
    if (state.menuOpen) {
      state.menuOpen = false;
      return render();
    }
    if (state.exportMenu) {
      state.exportMenu = false;
      return render();
    }
    if (state.paletteFor) {
      state.paletteFor = null;
      return render();
    }
    if (state.addingTask) {
      state.addingTask = null;
      return render();
    }
    if (state.editingTask) {
      state.editingTask = null;
      return renderTaskPanel(currentProject());
    }
    if (state.selectedTaskId) {
      state.selectedTaskId = null;
      renderTaskPanel(currentProject());
    }
    return;
  }
  if (!typing && (e.key === 'f' || e.key === 'F')) {
    state.focusMode = !state.focusMode;
    render();
    return;
  }
  if (!typing && (e.key === 'n' || e.key === 'N')) {
    const p = currentProject();
    if (p && p.phases[0]) {
      state.addingTask = p.phases[0].id;
      state.view = 'wbs';
      render();
      focusAddForm();
    }
  }
}

/* ------------------------------ UX: labels ------------------------------- */

function updateZoomLabels() {
  document.querySelectorAll('[data-wbs-zoom-label]').forEach((el) => {
    el.textContent = Math.round(state.wbsZoom * 100) + '%';
  });
  document.querySelectorAll('[data-gantt-zoom-label]').forEach((el) => {
    el.textContent = Math.round(state.ganttRel * 100) + '%';
  });
  document.querySelectorAll('[data-roadmap-zoom-label]').forEach((el) => {
    el.textContent = Math.round(state.roadmapZoom * 100) + '%';
  });
  updateGanttZoomBtns();
}

/** Disable the Gantt +/- buttons (with a hint) when a zoom limit is reached. */
function updateGanttZoomBtns() {
  const b = state.ganttBase || 1;
  const relMin = 0.4 / b;
  const relMax = 4;
  const inBtn = document.querySelector('#project-view [data-gantt-zoom="in"]');
  const outBtn = document.querySelector('#project-view [data-gantt-zoom="out"]');
  if (inBtn) {
    const atMax = state.ganttRel >= relMax - 1e-6;
    inBtn.disabled = atMax;
    inBtn.title = atMax ? '已達最大縮放（400%）' : '放大';
  }
  if (outBtn) {
    const atMin = state.ganttRel <= relMin + 1e-6;
    outBtn.disabled = atMin;
    outBtn.title = atMin ? '已達最小縮放' : '縮小';
  }
}

function roadmapZoomAction(action) {
  if (action === 'reset') state.roadmapZoom = 1;
  else if (action === 'fit') state.roadmapZoom = 1;
  else state.roadmapZoom = clamp(state.roadmapZoom * (action === 'in' ? 1.25 : 1 / 1.25), 0.4, 2.5);
  render();
  updateZoomLabels();
}

/* ------------------------------ pass-1 actions --------------------------- */

function wouldCycle(p, taskId, deps) {
  const byId = new Map(p.tasks.map((t) => [t.id, t]));
  const color = new Map();
  const depsOf = (id) => (id === taskId ? deps : (byId.get(id) && byId.get(id).deps) || []);
  const dfs = (id) => {
    color.set(id, 1);
    for (const d of depsOf(id)) {
      if (!byId.has(d)) continue;
      const c = color.get(d) || 0;
      if (c === 1) return true;
      if (c === 0 && dfs(d)) return true;
    }
    color.set(id, 2);
    return false;
  };
  for (const t of p.tasks) if ((color.get(t.id) || 0) === 0 && dfs(t.id)) return true;
  return false;
}

function afterWrite(res, okMsg, label) {
  const p = currentProject();
  if (res && res.ok) {
    state.lastWriteAt = Date.now();
    recordOp(res, p && p.id, label || okMsg);
    if (okMsg) toast(okMsg);
    if (p) loadGitStatus(p.id).then(render);
  } else {
    toast('失敗：' + ((res && res.error) || 'unknown'));
  }
  render();
  return res;
}

async function doReschedule() {
  const p = currentProject();
  if (!p) return;
  const res = await window.api.reschedule(p.id);
  if (res && res.ok) {
    state.criticalPath = res.criticalPath || [];
    state.lastReschedule = res;
    recordOp(res, p.id, '重排行程');
    toast('已重排 · 關鍵路徑 ' + (res.criticalPath || []).length + ' 節點');
  } else toast('重排失敗：' + ((res && res.error) || ''));
  render();
}

async function toggleCritical() {
  state.showCritical = !state.showCritical;
  if (state.showCritical && (!state.criticalPath || !state.criticalPath.length)) {
    const p = currentProject();
    if (p) {
      const r = await window.api.criticalPath(p.id);
      if (r && r.ok) state.criticalPath = r.chain || [];
    }
  }
  render();
}

async function doFreezeBaseline() {
  const p = currentProject();
  if (!p) return;
  state.menuOpen = false;
  const res = await window.api.freezeBaseline(p.id);
  if (res && res.ok) {
    state.baseline = res.baseline;
    state.showBaseline = true;
    toast('已凍結 baseline');
  } else toast('凍結失敗：' + ((res && res.error) || ''));
  render();
}

async function toggleBaseline() {
  state.showBaseline = !state.showBaseline;
  if (state.showBaseline && !state.baseline) {
    const p = currentProject();
    if (p) {
      const r = await window.api.getBaseline(p.id);
      if (r && r.ok && r.baseline) state.baseline = r.baseline;
      else toast('未凍結 baseline');
    }
  }
  render();
}

async function loadBaselineFor(id) {
  try {
    const r = await window.api.getBaseline(id);
    if (r && r.ok && r.baseline) {
      state.baseline = r.baseline;
      render();
    }
  } catch (_) {
    /* optional */
  }
}

async function saveNewTask() {
  const p = currentProject();
  if (!p || !state.addingTask) return;
  const q = (s) => document.querySelector(s);
  const title = q('[data-new-title]') ? q('[data-new-title]').value.trim() : '';
  if (!title) {
    toast('標題必填');
    return;
  }
  const partial = {
    title,
    owner: q('[data-new-owner]') ? q('[data-new-owner]').value.trim() : '',
    start: q('[data-new-start]') ? q('[data-new-start]').value : undefined,
    estimate_days: q('[data-new-estimate]') ? Number(q('[data-new-estimate]').value) || 1 : 1,
    deliverable: q('[data-new-deliverable]') ? q('[data-new-deliverable]').value.trim() : '',
    acceptance: q('[data-new-acceptance]') ? q('[data-new-acceptance]').value.trim() : '',
  };
  const res = await window.api.addTask(p.id, state.addingTask, partial);
  if (res && res.ok) {
    state.addingTask = null;
    if (res.task) state.selectedTaskId = res.task.id;
    recordOp(res, p.id, '新增任務 ' + (res.task && res.task.id));
    toast('已新增 ' + (res.task && res.task.id));
  } else toast('新增失敗：' + ((res && res.error) || ''));
  render();
}

async function saveTaskEdit() {
  const p = currentProject();
  if (!p || !state.editingTask) return;
  const id = state.editingTask;
  const q = (k) => document.querySelector(`[data-edit="${k}"]`);
  const deps = [...document.querySelectorAll('input[data-dep]')].filter((c) => c.checked).map((c) => c.getAttribute('data-dep'));
  const patch = {
    title: q('title') ? q('title').value.trim() : '',
    owner: q('owner') ? q('owner').value.trim() : '',
    start: q('start') ? q('start').value : undefined,
    estimate_days: Math.max(1, Number(q('estimate_days') ? q('estimate_days').value : 1) || 1),
    deliverable: q('deliverable') ? q('deliverable').value.trim() : '',
    acceptance: q('acceptance') ? q('acceptance').value.trim() : '',
    outputs: (q('outputs') ? q('outputs').value : '').split(',').map((s) => s.trim()).filter(Boolean),
    phase: q('phase') ? q('phase').value : undefined,
    deps,
  };
  if (!patch.title) {
    toast('標題必填');
    return;
  }
  if (wouldCycle(p, id, deps)) {
    toast('deps 有循環，已取消');
    return;
  }
  const res = await window.api.updateTask(p.id, id, patch);
  if (res && res.ok) {
    state.editingTask = null;
    recordOp(res, p.id, '編輯 ' + id);
    toast('已儲存');
  } else toast('儲存失敗：' + ((res && res.error) || ''));
  render();
}

async function doDeleteTask(id) {
  const p = currentProject();
  if (!p) return;
  const task = p.tasks.find((t) => t.id === id);
  const refs = p.tasks.filter((t) => t.deps.includes(id)).map((t) => t.id);
  const ms = (p.milestones || []).filter((m) => (m.after || []).includes(id)).map((m) => m.id);
  let msg = `刪除 ${id}「${task ? task.title : ''}」？`;
  if (refs.length || ms.length) msg += `\n會清理 deps: ${refs.join(', ') || '無'}；milestone after: ${ms.join(', ') || '無'}`;
  if (!(await confirmDialog(msg))) return;
  const res = await window.api.deleteTask(p.id, id);
  if (res && res.ok) {
    state.selectedTaskId = null;
    state.editingTask = null;
    delete state.selection[id];
    recordOp(res, p.id, '刪除 ' + id);
    toast('已刪除');
  } else toast('刪除失敗：' + ((res && res.error) || ''));
  render();
}

async function doTaskShift(id, dir) {
  const p = currentProject();
  if (!p) return;
  const task = p.tasks.find((t) => t.id === id);
  if (!task) return;
  const idxs = p.tasks.map((t, i) => (t.phase === task.phase ? i : -1)).filter((i) => i >= 0);
  const posInPhase = idxs.findIndex((i) => p.tasks[i].id === id);
  const target = posInPhase + dir;
  if (target < 0) {
    toast('已喺此 phase 最前');
    return;
  }
  if (target >= idxs.length) {
    toast('已喺此 phase 最後');
    return;
  }
  const res = await window.api.moveTask(p.id, id, { phaseId: task.phase, index: target });
  afterWrite(res, '已移動 ' + id);
}

async function doPhaseSave(pid) {
  const p = currentProject();
  if (!p) return;
  const el = document.querySelector(`[data-phase-name="${pid}"]`);
  const name = el ? el.value.trim() : '';
  if (pid === '__new__') {
    const res = await window.api.addPhase(p.id, { name: name || 'New Phase' });
    if (res && res.ok) state.editingPhase = null;
    afterWrite(res, '已新增 phase');
    return;
  }
  const res = await window.api.updatePhase(p.id, pid, { name });
  if (res && res.ok) state.editingPhase = null;
  afterWrite(res, '已更新 phase');
}

async function doPhaseMove(pid, dir) {
  const p = currentProject();
  if (!p) return;
  const i = p.phases.findIndex((x) => x.id === pid);
  const ni = i + dir;
  if (ni < 0 || ni >= p.phases.length) return;
  const res = await window.api.updatePhase(p.id, pid, { index: ni });
  afterWrite(res, '已調整次序');
}

async function doPhaseDelete(pid) {
  const p = currentProject();
  if (!p) return;
  const mine = p.tasks.filter((t) => t.phase === pid);
  let opts = {};
  if (mine.length) {
    const others = p.phases.filter((x) => x.id !== pid);
    if (!others.length) {
      toast('唔可以刪除唯一 phase');
      return;
    }
    if (!(await confirmDialog(`Phase ${pid} 有 ${mine.length} 個任務，會移到 ${others[0].id}。確定刪除？`))) return;
    opts = { moveToPhase: others[0].id };
  } else if (!(await confirmDialog(`刪除 phase ${pid}？`))) return;
  const res = await window.api.deletePhase(p.id, pid, opts);
  afterWrite(res, '已刪除 phase');
}

async function doMsAdd() {
  const p = currentProject();
  if (!p) return;
  const name = (document.querySelector('[data-new-ms-name]') || {}).value || '';
  const date = (document.querySelector('[data-new-ms-date]') || {}).value || '';
  const after = ((document.querySelector('[data-new-ms-after]') || {}).value || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!name.trim()) {
    toast('milestone 名稱必填');
    return;
  }
  const res = await window.api.upsertMilestone(p.id, { name: name.trim(), date, after });
  if (res && res.ok) {
    document.querySelectorAll('[data-new-ms-name],[data-new-ms-date],[data-new-ms-after]').forEach((el) => {
      el.value = '';
    });
    recordOp(res, p.id, '新增 milestone');
    toast('已新增 milestone');
  } else toast('失敗：' + ((res && res.error) || ''));
  render();
}

async function doMsSave(id) {
  const p = currentProject();
  if (!p) return;
  const g = (attr) => {
    const el = document.querySelector(`[${attr}="${id}"]`);
    return el ? el.value : '';
  };
  const res = await window.api.upsertMilestone(p.id, {
    id,
    name: g('data-ms-name').trim(),
    date: g('data-ms-date'),
    after: g('data-ms-after').split(',').map((s) => s.trim()).filter(Boolean),
  });
  if (res && res.ok) state.editingMilestone = null;
  afterWrite(res, '已更新 milestone');
}

async function doMsDelete(id) {
  const p = currentProject();
  if (!p) return;
  if (!(await confirmDialog(`刪除 milestone ${id}？`))) return;
  const res = await window.api.deleteMilestone(p.id, id);
  afterWrite(res, '已刪除 milestone');
}

async function doBulk(done) {
  const p = currentProject();
  if (!p) return;
  const ids = Object.keys(state.selection);
  if (!ids.length) return;
  for (const id of ids) {
    const res = await window.api.setTaskDone(p.id, id, done);
    if (res && res.ok) recordOp(res, p.id, done ? '批次標記完成' : '批次取消完成');
  }
  toast((done ? '已完成 ' : '已取消 ') + ids.length + ' 項');
  render();
}

function updateDepsWarning() {
  const p = currentProject();
  const warn = document.getElementById('deps-warn');
  if (!p || !state.editingTask || !warn) return;
  const deps = [...document.querySelectorAll('input[data-dep]')].filter((c) => c.checked).map((c) => c.getAttribute('data-dep'));
  const bad = wouldCycle(p, state.editingTask, deps);
  warn.hidden = !bad;
  warn.textContent = bad ? 'deps 造成循環 — 唔可以儲存' : '';
  const saveBtn = document.querySelector('[data-task-save]');
  if (saveBtn) saveBtn.disabled = bad;
}

function runCtx(action, taskId) {
  if (action === 'edit') {
    state.selectedTaskId = taskId;
    state.editingTask = taskId;
    renderTaskPanel(currentProject());
  } else if (action === 'up') doTaskShift(taskId, -1);
  else if (action === 'down') doTaskShift(taskId, +1);
  else if (action === 'del') doDeleteTask(taskId);
}

function closeCtx() {
  state.ctx = null;
  renderCtx();
}

/* ------------------------------ in-app guide (使用說明) ------------------- */

// The manual describes the real app only: real view names, real buttons, and
// the keyboard shortcuts that actually exist in onKeyDown / setupSplitter.
const GUIDE_SECTIONS = [
  {
    id: 'g-quick',
    title: '快速開始',
    html: `
      <p>Project Console 係一個本地 Electron app，將每個專案資料夾嘅 <code>plan.json</code> 同 <code>progress.json</code> 變成 <b>總覽 · WBS · 進度 · 甘特</b> 四個 view。「人手模型」：進度由上而下打勾，唔涉及 agent / session / token。</p>
      <ul>
        <li><b>開 app 見到乜</b>：頂欄顯示 data root 路徑、項目數、時鐘同工具掣；左邊 <b>rail（Portfolio）</b> 列出所有項目。規則係：data root 每個 immediate 子資料夾，只要入面有 <code>plan.json</code> 就當一個項目；冇 <code>progress.json</code> 就全部當未完成（RAG = grey）。</li>
        <li><b>揀專案</b>：撳 rail 上嘅項目、或者儀表板 / 路線圖嘅專案卡，就進入該專案。</li>
        <li><b>四個 view</b>：進入專案後，工具列下面有 tab：總覽 / WBS / 進度 / 甘特。切換 view 唔會改任何嘢，只係換個睇法。</li>
        <li><b>讀寫範圍</b>：app 讀 <code>plan.json</code>；打勾寫 <code>progress.json</code>；你㩒「編輯 / 規劃」時先寫 <code>plan.json</code>。全部只限該專案資料夾內，atomic 寫入。</li>
      </ul>`,
  },
  {
    id: 'g-daily',
    title: '每日操作',
    html: `
      <p>打勾（tick）係主動作。WBS 每個 task node、甘特下方「任務表」嘅完成欄、同任務面板都有方格，撳一下即寫入。</p>
      <ul>
        <li><b>打勾方格</b>：撳方格即寫 <code>progress.json</code>（atomic，保留其他欄位同其他 task entry），該項目 % 同 RAG 顏色跟住更新。</li>
        <li><b>開任務面板</b>：撳 WBS node 或任務表格列 → 右邊 docked 任務面板顯示詳情（狀態、deliverable、owner、deps、輸出、計劃日期…）。<kbd>Esc</kbd> 或撳 panel 以外位置可閂。</li>
        <li><b>加任務</b>：工具列「＋任務」、phase 上嘅「＋」、或鍵盤 <kbd>n</kbd> → inline 表單（標題必填）。</li>
        <li><b>改任務</b>：面板「編輯」→ 改 title / owner / start / estimate_days / deliverable / acceptance / outputs / deps / phase → 儲存。</li>
        <li><b>刪任務</b>：面板「刪除…」或右鍵選單；確認框會先講明會清理邊啲 deps / milestone after。</li>
        <li><b>上下移</b>：面板「上移 / 下移」或右鍵（限同 phase 內）。</li>
        <li><b>拖曳搬 phase</b>：將 WBS node 嘅「≡」拖去另一個 phase node；或用面板底部「移動到 phase」。</li>
        <li><b>批量 tick</b>：任務表勾「選取」欄（或 Ctrl / Shift-點 WBS node）揀多項 → 批次 bar「全部完成 / 全部未完成 / 清除選取」。</li>
        <li><b>復原</b>：<kbd>Ctrl</kbd>+<kbd>Z</kbd> 撤銷、<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd>（或 <kbd>Ctrl</kbd>+<kbd>Y</kbd>）重做；工具列亦有 Undo / Redo 掣。上限 100 步，存 localStorage，重開 app 都仲喺度。</li>
      </ul>`,
  },
  {
    id: 'g-views',
    title: '四個 view',
    html: `
      <ul>
        <li><b>總覽</b>：專案 header（完成度、任務數、逾時、遲交、下個 milestone）＋完成定義＋範圍 in/out＋限制（time / resource / procedure / scope）＋人員表＋Milestones 表＋風險表。幾時用：定義 scope、睇風險、管理 milestone。</li>
        <li><b>WBS</b>：由上至下嘅工作分解樹（ENG4001 lecture 形狀）：root 專案大框在頂，phase 一行橫向排開，每個 phase 底下垂直疊住自己嘅 task，用正交 elbow 連接線。每 task 有方格、id、title、owner、deliverable。幾時用：主要打勾介面、睇結構、收合 / 聚焦。</li>
        <li><b>進度</b>：整體 % 同 bar、每階段 %、每人工作量、交付物看板、時間 vs 實際表（逾時 / 遲交）。幾時用：匯報、睇邊個或邊個階段落後。</li>
        <li><b>甘特</b>：inline-SVG 時間軸。bar = <code>start</code> + <code>estimate_days</code>（完成實心 vermilion、未完成髮絲外框）；milestone 菱形；依賴箭嘴；today 線；下面有可打勾任務表。幾時用：睇時間、依賴、關鍵路徑。</li>
      </ul>
      <p class="guide__note">未揀專案時，landing 係「儀表板」或「路線圖」（跨專案總覽），唔屬於上面四個 project view，詳見第 6 節。</p>`,
  },
  {
    id: 'g-gestures',
    title: '手勢',
    html: `
      <ul>
        <li><b>WBS 縮放</b>：滑鼠滾輪 = 縮放，錨定游標（0.4×–2.5×）；Ctrl / ⌘ + 滾輪（trackpad pinch）一樣。</li>
        <li><b>WBS 平移</b>：背景拖曳（左 / 中鍵）。header 有 <code>−</code> / <code>100%</code>（撳一下重設）/ <code>+</code> / <code>⤢ fit</code>（縮到啱晒成棵樹）。</li>
        <li><b>甘特縮放</b>：滾輪 = 時間軸縮放，錨定游標（0.4×–2.5×）。</li>
        <li><b>甘特平移</b>：拖曳 = 水平 / 垂直平移；<kbd>Shift</kbd>+滾輪 = 水平捲動；左邊工種標籤欄 sticky，平移時保持可見；header 同款 <code>− / 100% / + / ⤢</code>。</li>
        <li><b>迷你圖</b>：WBS 右下細圖顯示 viewport 位置，click 或拖曳可導航；用 header「迷你圖」開關。</li>
        <li><b>今日線</b>：甘特上紅色垂直線 = 今日。</li>
        <li><b>依賴箭嘴</b>：預設只畫選中任務同關鍵路徑嘅箭嘴；撳「顯示全部依賴」睇全部。</li>
        <li><b>關鍵路徑</b>：撳「關鍵」→ 甘特 bar 加 vermilion 外框，WBS / 任務表同步標示。</li>
        <li>滾輪只在游標真正喺 WBS / 甘特上面才 preventDefault，唔會搶走一般頁面捲動。</li>
      </ul>`,
  },
  {
    id: 'g-planning',
    title: '規劃工具',
    html: `
      <ul>
        <li><b>重排（reschedule）</b>：工具列「重排」→ 依 <code>deps</code> 最長路徑重算所有 <code>start</code>，並計出關鍵路徑。</li>
        <li><b>關鍵路徑 toggle</b>：工具列「關鍵」（第一次開會即時計算）。</li>
        <li><b>基準線（baseline）</b>：<code>⋯</code> 選單「凍結基準線」會寫 <code>baseline.json</code>；工具列「基準線」掣 = 凍結 / 顯示嘅 toggle。顯示時甘特會畫虛線 ghost bar、每條落後 task 標 <code>+Nd</code> 滑期，<code>⋯</code> 選單顯示整體滑期摘要。</li>
        <li><b>篩選</b>（WBS + 甘特）：owner / phase / 狀態（未做 / 已完成 / 逾期）＋「只顯示逾期」；右邊顯示篩選數，撳「清除」重設。</li>
      </ul>`,
  },
  {
    id: 'g-cross',
    title: '跨專案',
    html: `
      <ul>
        <li><b>儀表板</b>（頂欄「儀表板」）：跨專案統計（專案 / 未完成 / 已完成 / 逾期 / 本週到期）；下面「本週到期（≤7日）」「逾期」「近期 Milestone（≤14日）」清單，每行撳一下即跳去該 project + task；最底係項目卡。</li>
        <li><b>路線圖</b>（頂欄「路線圖」）：所有專案由 <code>created</code> 到 <code>target</code> 一條 bar、milestone 菱形，共用時間軸；滾輪縮放、拖曳平移、撳 bar 開啟項目。</li>
        <li><b>排序</b>：儀表板右上 select（名稱 / RAG / 目標日 / 進度）。</li>
        <li><b>釘選</b>：卡片上 <code>★</code> 置頂（再撳取消）。</li>
        <li><b>顏色</b>：卡片 <code>■</code> 開 7 色 palette，顏色同時用喺路線圖 bar；釘選 / 排序 / 顏色都存 localStorage。</li>
      </ul>`,
  },
  {
    id: 'g-admin',
    title: '管理',
    html: `
      <ul>
        <li><b>Phase</b>：WBS header「管理」→ PHASES chips：<code>＋</code>（加任務去該 phase）、<code>✎</code> 改名、<code>↑</code> <code>↓</code> 排序、<code>✕</code> 刪除。刪有任務嘅 phase 要先指定 <code>moveToPhase</code>（app 會問你移去邊）；唯一一個 phase 唔准刪。</li>
        <li><b>Milestone</b>：總覽頁 Milestones 表底部可新增（name / date / after）；每行 <code>✎</code> 編輯、<code>✕</code> 刪除。</li>
        <li><b>依賴編輯</b>：任務面板「編輯」→ Deps 區勾選前置任務。揀到會造成循環（cycle）時即刻出 warning 並停用「儲存」。</li>
        <li>刪任務會自動清理指向佢嘅 <code>deps</code> 同 milestone <code>after</code>，確認框會列出。</li>
      </ul>`,
  },
  {
    id: 'g-data',
    title: '資料',
    html: `
      <p>工具列「匯出」出一條選單：<b>PNG / PDF / CSV / Markdown</b>，每次用系統儲存對話框揀位置。</p>
      <ul>
        <li><b>PDF</b>：會出<b>齊全棵 WBS + 全條甘特</b>、<b>自動用淺色 paper（唔理你 dark mode）</b>、分頁排好（A4 橫向，WBS 另起一頁）。</li>
        <li><b>CSV</b>：每個 task 一行。已加 <b>UTF-8 BOM</b>，Excel 開中文正常顯示。</li>
        <li><b>PNG</b>：現時畫面截圖。<b>Markdown</b>：WBS checklist。</li>
      </ul>
      <ul>
        <li><b>備份 / 還原</b>（<code>⋯</code> 選單或工具列「備份」）：每次寫 <code>plan.json</code> 前自動 snapshot（plan + progress）到 <code>&lt;project&gt;/.backups/&lt;ISO&gt;/</code>，保留最新 20 個。「備份清單」可列 snapshot 再還原，還原係 byte-verbatim，本身亦可以 Undo。</li>
        <li><b>tasks.md 同步</b>（<code>⋯</code> 選單）：「同步 tasks.md」寫 / 更新 <code>&lt;project&gt;/tasks.md</code>（每行 <code>- [x] T1.1 title — owner</code>）；「由 tasks.md 讀回」parse <code>[x]</code> 套返 <code>progress.json</code>。app 只管理佢自己擁有嘅 checkbox 行，<b>保留你自加嘅其他行</b>。</li>
        <li><b>匯入清單</b>（<code>⋯</code> 選單）：揀一個 Markdown 檔，parse <code>- [ ]</code> / <code>- [x]</code>，加去第一個 phase（剝走 marker，title = 行文字）。</li>
      </ul>`,
  },
  {
    id: 'g-look',
    title: '外觀',
    html: `
      <ul>
        <li><b>深色模式</b>：頂欄「深色 / 淺色」toggle；預設跟系統 <code>prefers-color-scheme</code>。</li>
        <li><b>密度</b>：頂欄「緊湊 / 舒適」toggle，收窄表格、WBS node、卡片。</li>
        <li><b>聚焦模式</b>：WBS header「聚焦」或鍵盤 <kbd>f</kbd> → 只亮起選中 task 嘅路徑（phase + 自己 + 直接 deps + 依賴佢嘅 task），其餘變暗。</li>
        <li><b>摺合 / 展開全部</b>：WBS header「收合 / 展開」；單獨 phase 可以撳 node 上嘅 <code>+ / −</code> 收合。</li>
        <li><b>側欄拖拉</b>：rail 同 main 之間嘅 6px splitter 可拖曳調 180–480px；雙擊（或撳 <code>⟲</code>）還原 300px；splitter 被 focus 時 <kbd>←</kbd> / <kbd>→</kbd> 微調。</li>
        <li><b>任務面板闊度</b>：拖面板內側邊緣。</li>
      </ul>`,
  },
  {
    id: 'g-keys',
    title: '鍵盤快捷鍵',
    html: `
      <p>以下係 app 真正支援嘅全部鍵盤快捷鍵，冇列出嘅即係未支援。</p>
      <table class="guide__tbl" id="guide-shortcuts">
        <thead><tr><th>快捷鍵</th><th>動作</th><th>備註</th></tr></thead>
        <tbody>
          <tr><td><kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>⌘</kbd>+<kbd>Z</kbd></td><td>撤銷（Undo）</td><td>還原上一次寫入（plan 或 progress）</td></tr>
          <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> / <kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>Z</kbd></td><td>重做（Redo）</td><td>最多 100 步</td></tr>
          <tr><td><kbd>Ctrl</kbd>+<kbd>Y</kbd> / <kbd>⌘</kbd>+<kbd>Y</kbd></td><td>重做（Redo 別名）</td><td>同 Ctrl+Shift+Z</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>閂最上層</td><td>右鍵選單 / 匯出 / ⋯ 選單 / palette / 新增表單 / 編輯表單 / 任務面板 / 使用說明</td></tr>
          <tr><td><kbd>n</kbd></td><td>新增任務</td><td>開去第一個 phase 嘅 inline 表單；唔喺輸入框時有效</td></tr>
          <tr><td><kbd>f</kbd></td><td>切換聚焦模式</td><td>唔喺輸入框時有效</td></tr>
          <tr><td><kbd>←</kbd> / <kbd>→</kbd></td><td>調整側欄寬度</td><td>側欄 splitter 被 focus 時</td></tr>
        </tbody>
      </table>`,
  },
  {
    id: 'g-tips',
    title: '小技巧 / FAQ',
    html: `
      <ul>
        <li><b>打錯 tick？</b>撳 <kbd>Ctrl</kbd>+<kbd>Z</kbd> 或工具列 Undo。每次寫入都記低咗 inverse op。</li>
        <li><b>PDF 想淺色？</b>已自動。匯出 PDF 時 app 會暫時切去 paper 調色，唔理你當前 dark mode。</li>
        <li><b>進度邊度嚟？</b>你 tick 幾多就幾多（done / total）。冇 <code>progress.json</code> 就全部當未完成，RAG = grey。</li>
        <li><b>app 寫唔寫我啲檔？</b>打勾只寫 <code>&lt;project&gt;/progress.json</code>；你㩒編輯 / 規劃（加改刪任務、phase、milestone、deps、重排、凍結 baseline、同步 tasks.md、還原備份）先寫 <code>plan.json</code> / <code>baseline.json</code> / <code>tasks.md</code>。全部 atomic（temp file 再 rename）、merge-preserving（保留未知欄位），而且只限 <code>&lt;dataRoot&gt;/&lt;project&gt;/</code> 內。</li>
        <li><b>Undo 會唔會連結構都還原？</b>會。Undo 會成個檔案還原到寫入前狀態（plan 或 progress）。</li>
        <li><b>篩選完唔見咗任務？</b>睇篩選 bar 嘅「篩選中 N」，撳「清除」即可。</li>
        <li><b>想一次過睇全部依賴？</b>甘特 header「顯示全部依賴」。</li>
        <li><b>想 fit 晒成張圖？</b>WBS / 甘特 / 路線圖 header 嘅 <code>⤢</code>。</li>
      </ul>`,
  },
];

function renderGuide() {
  const toc = GUIDE_SECTIONS.map((s, i) => {
    const n = String(i + 1).padStart(2, '0');
    return `<button class="guide__toc-item${i === 0 ? ' is-active' : ''}" type="button" data-guide-jump="${esc(
      s.id
    )}"><span class="guide__toc-num">${n}</span>${esc(s.title)}</button>`;
  }).join('');
  const body = GUIDE_SECTIONS.map((s, i) => {
    const n = String(i + 1).padStart(2, '0');
    return `<section class="guide__sec" id="${esc(s.id)}"><h3><span class="n">${n}</span>${esc(
      s.title
    )}</h3>${s.html}</section>`;
  }).join('');
  return `<div class="guide__panel" role="dialog" aria-modal="true" aria-label="使用說明">
    <div class="guide__bar">
      <span class="guide__mark" aria-hidden="true"></span>
      <h2 class="guide__title">使用說明</h2>
      <span class="guide__sub">Project Console · 人手打勾模型</span>
      <span class="guide__spacer"></span>
      <button class="btn btn--ghost" id="guide-close" type="button" title="關閉 (Esc)">✕ 關閉</button>
    </div>
    <div class="guide__body">
      <nav class="guide__toc" aria-label="目錄"><div class="guide__toc-title">目錄 · Contents</div>${toc}</nav>
      <div class="guide__content" id="guide-content" tabindex="-1">${body}</div>
    </div>
  </div>`;
}

function openGuide() {
  state.guideOpen = true;
  const el = document.getElementById('guide');
  if (!el) return;
  el.innerHTML = renderGuide();
  el.hidden = false;
  const content = document.getElementById('guide-content');
  if (content) {
    content.scrollTop = 0;
    try {
      content.focus();
    } catch (_) {
      /* focus is best-effort */
    }
  }
}

function closeGuide() {
  state.guideOpen = false;
  const el = document.getElementById('guide');
  if (el) {
    el.hidden = true;
    el.innerHTML = '';
  }
}

function jumpGuide(id) {
  const content = document.getElementById('guide-content');
  const target = document.getElementById(id);
  if (content && target) content.scrollTop = Math.max(0, target.offsetTop - 6);
  document.querySelectorAll('.guide__toc-item').forEach((b) => {
    b.classList.toggle('is-active', b.getAttribute('data-guide-jump') === id);
  });
}

/* ------------------------------ pass-2 actions --------------------------- */

function renderBackups(p) {
  const list = state.backups || [];
  const rows = list.length
    ? list
        .map(
          (b) => `<div class="brow"><span class="id">${esc(b.ts)}</span><span class="muted">${b.hasPlan ? 'plan' : ''}${
            b.hasProgress ? ' · progress' : ''
          }</span><button class="btn" type="button" data-backup-ts="${esc(b.ts)}" title="還原此備份（可 Undo）">⟲ 還原</button></div>`
        )
        .join('')
    : '<div class="empty">未有備份</div>';
  return `<section class="section"><div class="section__head"><h2 class="section__title">備份 · Backups</h2><span class="section__note">${list.length} · 保留最新 20</span></div><div class="backups">${rows}</div></section>`;
}

async function loadBackupList(id) {
  try {
    const r = await window.api.backupList(id);
    state.backups = (r && r.ok && r.backups) || [];
  } catch (_) {
    state.backups = [];
  }
}

async function toggleBackups() {
  state.menuOpen = false;
  state.showBackups = !state.showBackups;
  if (state.showBackups) {
    const p = currentProject();
    if (p) await loadBackupList(p.id);
  }
  render();
}

function reportExport(res) {
  if (res && res.ok) toast('已匯出 → ' + res.path);
  else if (res && res.canceled) {
    /* user cancelled */
  } else toast('匯出失敗：' + ((res && res.error) || ''));
}

async function runIo(action) {
  const p = currentProject();
  if (!p) {
    toast('先揀一個項目');
    return;
  }
  state.menuOpen = false;
  state.exportMenu = false;
  try {
    if (action === 'png') return reportExport(await window.api.exportPng({ name: p.id }));
    if (action === 'pdf') return reportExport(await window.api.exportPdf({ name: p.id }));
    if (action === 'csv') return reportExport(await window.api.exportCsv(p.id));
    if (action === 'md') return reportExport(await window.api.exportMd(p.id));
    if (action === 'sync') {
      const res = await window.api.mdSync(p.id);
      if (res && res.ok) toast(`已同步 tasks.md（更新 ${res.updated} · 新增 ${res.added}）`);
      else toast('同步失敗：' + ((res && res.error) || ''));
      return;
    }
    if (action === 'read') {
      const res = await window.api.mdRead(p.id);
      if (res && res.ok) {
        recordOp(res, p.id, '由 tasks.md 讀回');
        toast(`由 tasks.md 讀回 ${res.applied.length} 項`);
        render();
      } else toast('讀回失敗：' + ((res && res.error) || ''));
      return;
    }
    if (action === 'import') {
      const phaseId = p.phases[0] && p.phases[0].id;
      const res = await window.api.mdImport(p.id, phaseId);
      if (res && res.ok) {
        recordOp(res, p.id, '匯入清單');
        toast(`已匯入 ${res.created} 項（其中 ${res.done} 項標記完成）`);
        render();
      } else if (res && res.canceled) {
        /* cancelled */
      } else toast('匯入失敗：' + ((res && res.error) || ''));
      return;
    }
  } catch (err) {
    toast('操作失敗：' + err.message);
  }
}

function confirmDialog(msg) {
  return new Promise((resolve) => {
    const el = document.getElementById('confirm');
    const msgEl = document.getElementById('confirm-msg');
    if (!el || !msgEl) {
      resolve(window.confirm(msg));
      return;
    }
    msgEl.textContent = msg;
    el.hidden = false;
    const ok = document.getElementById('confirm-ok');
    const cancel = document.getElementById('confirm-cancel');
    const done = (v) => {
      el.hidden = true;
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      resolve(v);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
  });
}

async function doRestoreBackup(ts) {
  const p = currentProject();
  if (!p) return;
  if (!(state.backups || []).some((b) => b.ts === ts)) {
    toast('備份唔屬於此項目或已失效，請重新開啟備份清單');
    return;
  }
  const go = await confirmDialog('還原備份 ' + ts + ' ？（本身可 Undo）');
  if (!go) return;
  const res = await window.api.backupRestore(p.id, ts);
  if (res && res.ok) {
    if (res.undo) recordOp(res, p.id, '還原備份');
    toast('已還原備份');
  } else toast('還原失敗：' + ((res && res.error) || ''));
  render();
}

/* ------------------------------ team sync: actions ----------------------- */

async function loadGitStatus(pid) {
  if (!pid) return;
  try {
    const r = await window.api.gitStatus(pid);
    if (r && r.isRepo !== undefined) state.git[pid] = r;
  } catch (_) {
    /* status is best-effort */
  }
}

async function doGitBind() {
  const p = currentProject();
  if (!p) return;
  const inp = document.querySelector('[data-git-remote]');
  const remote = inp ? inp.value.trim() : '';
  if (!remote) {
    toast('請輸入 repo URL');
    return;
  }
  state.gitBusy[p.id] = true;
  render();
  try {
    const r = await window.api.gitBind(p.id, remote, { branch: 'main' });
    if (r && r.ok) {
      toast('已綁定 remote');
      state.gitBindOpen = false;
    } else {
      toast('綁定失敗：' + ((r && r.error) || ''));
    }
  } catch (err) {
    toast('綁定失敗：' + err.message);
  } finally {
    delete state.gitBusy[p.id];
    await loadGitStatus(p.id);
    render();
  }
}

async function doSync() {
  const p = currentProject();
  if (!p) return;
  if (state.readonly[p.id]) {
    toast('唯讀：你冇修改權限');
    return;
  }
  if (state.gitBusy[p.id]) return;
  state.gitBusy[p.id] = true;
  state.conflicts = null;
  render();
  try {
    const r = await window.api.gitSync(p.id, {});
    if (r && r.needsResolution && r.conflicts && r.conflicts.length) {
      state.conflicts = r.conflicts;
      toast('有 ' + r.conflicts.length + ' 個衝突待處理（見下方）');
    } else if (r && r.ok) {
      const bits = [];
      if (r.committed) bits.push(r.message ? 'commit「' + r.message + '」' : 'commit');
      if (r.merged) bits.push('已合併遠端');
      else if (r.pulled) bits.push('已 pull');
      if (r.pushed) bits.push('已 push');
      else if (!r.committed) bits.push('無新改動');
      toast('Sync 完成 · ' + bits.join(' · '));
    } else {
      toast(syncErrorMsg(r));
    }
  } catch (err) {
    toast('Sync 失敗：' + err.message);
  } finally {
    delete state.gitBusy[p.id];
    try {
      const pl = await window.api.refresh();
      applyPayload(pl);
    } catch (_) {
      /* refresh is best-effort */
    }
    await loadGitStatus(p.id);
    if (state.view === 'history') await loadHistory(p.id);
    render();
  }
}

function syncErrorMsg(r) {
  if (!r) return 'Sync 失敗';
  if (r.code === 'offline') return 'Sync 失敗：連唔到 remote（offline）— 檢查網絡後再試';
  if (r.rejected) return 'Sync 失敗：push 被拒（remote 有新 commit）— 再撳 Sync 佢會先 pull';
  if (r.phase === 'push' && /permission|denied|403|forbidden/i.test(r.error || '')) return 'Sync 失敗：冇 push 權限（唯讀）';
  if (r.phase === 'merge') return 'Sync：有衝突待處理';
  return 'Sync 失敗' + (r.phase ? '（' + r.phase + '）' : '') + '：' + (r.error || 'unknown');
}

async function doGitClone() {
  const urlEl = document.querySelector('[data-git-clone-url]');
  const dirEl = document.querySelector('[data-git-clone-dir]');
  const url = urlEl ? urlEl.value.trim() : '';
  const destDir = dirEl && dirEl.value.trim() ? dirEl.value.trim() : undefined;
  if (!url) {
    toast('請輸入 repo URL');
    return;
  }
  state.gitCloneBusy = true;
  render();
  try {
    const r = await window.api.gitClone(url, destDir);
    if (r && r.ok) {
      toast('已 clone ' + (r.name || r.projectId || ''));
      const pl = await window.api.refresh();
      applyPayload(pl);
      state.gitCloneOpen = false;
      if (r.projectId) selectProject(r.projectId);
    } else {
      toast('Clone 失敗：' + ((r && r.error) || ''));
    }
  } catch (err) {
    toast('Clone 失敗：' + err.message);
  } finally {
    state.gitCloneBusy = false;
    render();
  }
}

/* ------------------------------ P3: share actions ------------------------ */

async function loadShare(pid) {
  if (!pid) return;
  state.shareBusy = true;
  if (state.shareOpen) render();
  try {
    state.share = await window.api.shareInfo(pid);
  } catch (err) {
    state.share = { ok: false, code: 'error', error: err.message };
  } finally {
    state.shareBusy = false;
  }
  if (state.share && state.share.readOnly) state.readonly[pid] = true;
  render();
}

async function toggleShare() {
  const p = currentProject();
  if (!p) return;
  state.shareOpen = !state.shareOpen;
  if (state.shareOpen) await loadShare(p.id);
  else state.share = null;
  render();
}

function shareErrMsg(r) {
  if (!r) return '失敗：unknown';
  if (r.code === 'gh_missing') return '未安裝 gh CLI（winget install GitHub.cli）';
  if (r.code === 'gh_not_authed') return 'gh 未登入（請先 gh auth login）';
  if (r.code === 'no_admin') return '冇 admin 權限（只有 repo owner / admin 先 invite 到）';
  return '失敗：' + (r.error || r.code || '');
}

async function doShareInvite() {
  const p = currentProject();
  if (!p) return;
  const u = ((document.querySelector('[data-share-user]') || {}).value || '').trim();
  const perm = (document.querySelector('[data-share-perm]') || {}).value || 'push';
  if (!u) {
    toast('請輸入 GitHub username');
    return;
  }
  state.shareBusy = true;
  render();
  try {
    const r = await window.api.shareInvite(p.id, u, perm);
    toast(r && r.ok ? '已邀請 ' + u + '（' + (perm === 'pull' ? '唯讀' : '可寫') + '）' : shareErrMsg(r));
  } catch (err) {
    toast('邀請失敗：' + err.message);
  } finally {
    state.shareBusy = false;
    await loadShare(p.id);
  }
}

async function doShareRemove(login) {
  const p = currentProject();
  if (!p) return;
  const go = await confirmDialog('移除協作者 ' + login + '？');
  if (!go) return;
  state.shareBusy = true;
  render();
  try {
    const r = await window.api.shareRemove(p.id, login);
    toast(r && r.ok ? '已移除 ' + login : shareErrMsg(r));
  } catch (err) {
    toast('移除失敗：' + err.message);
  } finally {
    state.shareBusy = false;
    await loadShare(p.id);
  }
}

/** Lightweight read-only detection (gh permission, else dry-run push). */
async function loadAccess(pid) {
  if (!pid) return;
  try {
    const r = await window.api.shareAccess(pid);
    if (r && r.ok) {
      if (r.readOnly) state.readonly[pid] = true;
      else delete state.readonly[pid];
      render();
    }
  } catch (_) {
    /* best effort */
  }
}

/* ------------------------------ P4: history actions ---------------------- */

async function loadHistory(pid) {
  if (!pid) return;
  state.historyBusy = true;
  render();
  try {
    const r = await window.api.historyLog(pid, { limit: 100 });
    state.history = (r && r.ok && r.commits) || [];
    if (r && !r.ok) toast('載入歷程失敗：' + (r.error || ''));
  } catch (err) {
    state.history = [];
    toast('載入歷程失敗：' + err.message);
  } finally {
    state.historyBusy = false;
    render();
  }
}

async function loadDiff(sha) {
  const p = currentProject();
  if (!p) return;
  state.diffBusy = true;
  state.selectedCommit = sha;
  render();
  try {
    const r = await window.api.historyDiff(p.id, sha);
    if (r && r.ok) state.diff = r;
    else {
      state.diff = null;
      toast('讀改動失敗：' + ((r && r.error) || ''));
    }
  } catch (err) {
    state.diff = null;
    toast('讀改動失敗：' + err.message);
  } finally {
    state.diffBusy = false;
    render();
  }
}

async function doRestoreCommit(sha) {
  const p = currentProject();
  if (!p) return;
  if (state.readonly[p.id]) {
    toast('唯讀：你冇修改權限');
    return;
  }
  const c = (state.history || []).find((x) => x.sha === sha);
  const short = (c && c.short) || String(sha).slice(0, 7);
  const go = await confirmDialog('還原 plan.json + progress.json 到 commit ' + short + '？（現狀會備份，仲可以 Undo）');
  if (!go) return;
  state.historyBusy = true;
  render();
  try {
    const r = await window.api.historyRestore(p.id, sha);
    if (r && r.ok) {
      if (r.undo) recordOp(r, p.id, '還原 commit ' + short);
      toast('已還原到 ' + short + '（' + (r.restored || []).join(' + ') + '）');
      const pl = await window.api.refresh();
      applyPayload(pl);
      await loadHistory(p.id);
    } else {
      toast('還原失敗：' + ((r && r.error) || ''));
    }
  } catch (err) {
    toast('還原失敗：' + err.message);
  } finally {
    state.historyBusy = false;
    render();
  }
}

/* ------------------------------ P5: my-day actions ----------------------- */

async function loadMyDay() {
  const who = state.me;
  if (!who) {
    state.myday = null;
    if (state.topView === 'myday' && !state.selectedProjectId) render();
    return;
  }
  try {
    state.myday = await window.api.myday(who, hkTodayStrClient());
  } catch (_) {
    state.myday = { overdue: [], today: [], week: [], ready: [], count: 0 };
  }
  if (state.topView === 'myday' && !state.selectedProjectId) render();
}

function setMe(v) {
  state.me = v;
  persist('pc.me', v);
  loadMyDay();
}

async function loadIdentity() {
  try {
    const id = await window.api.identity();
    if (id && id.ok) state.identity = id;
    if (!state.me) {
      const dflt = (id && (id.gitUser || id.ghLogin)) || '';
      if (dflt) {
        state.me = dflt;
        persist('pc.me', dflt);
      }
    }
  } catch (_) {
    /* optional */
  }
  if (state.topView === 'myday') loadMyDay();
}

/* ------------------------------ P6: conflict actions --------------------- */

function setAllConflicts(choice) {
  (state.conflicts || []).forEach((_, i) => {
    const el = document.querySelector(`input[name="cf-${i}"][value="${choice}"]`);
    if (el) el.checked = true;
  });
}

async function doResolveConflicts() {
  const p = currentProject();
  if (!p || !state.conflicts) return;
  const choices = state.conflicts.map((c, i) => {
    const el = document.querySelector(`input[name="cf-${i}"]:checked`);
    return { scope: c.scope, id: c.id, field: c.field, choice: el ? el.value : 'ours' };
  });
  state.conflictBusy = true;
  render();
  try {
    const r = await window.api.gitResolve(p.id, choices);
    if (r && r.ok) {
      state.conflicts = null;
      const push = await window.api.gitPush(p.id);
      toast(push && push.ok ? '已合併並 push 到 remote' : '已合併（local），push 未成功：' + ((push && push.error) || ''));
      const pl = await window.api.refresh();
      applyPayload(pl);
      await loadGitStatus(p.id);
    } else {
      toast('合併失敗' + (r && r.phase ? '（' + r.phase + '）' : '') + '：' + ((r && r.error) || ''));
    }
  } catch (err) {
    toast('合併失敗：' + err.message);
  } finally {
    state.conflictBusy = false;
    render();
  }
}

function setPanelWidth(w) {
  state.panelWidth = clamp(w, 320, 720);
  applyPanelWidth();
  persist('pc.panelWidth', state.panelWidth);
}

let hintTimer = null;
function armHintTimer() {
  if (hintTimer || state.hintOn || state.hintDismissed) return;
  hintTimer = setTimeout(() => {
    hintTimer = null;
    state.hintDismissed = true;
    if (state.view === 'wbs' && state.selectedProjectId) render();
  }, 4000);
}
function dismissHint() {
  if (state.hintDismissed || state.hintOn) return;
  state.hintDismissed = true;
  if (hintTimer) {
    clearTimeout(hintTimer);
    hintTimer = null;
  }
  if (state.view === 'wbs' && state.selectedProjectId) render();
}

/** Focus + reveal the inline add-task form (it can open below the fold). */
function focusAddForm() {
  const inp = document.querySelector('[data-new-title]');
  if (!inp) return;
  const form = inp.closest('.addform');
  if (form && form.scrollIntoView) form.scrollIntoView({ block: 'nearest' });
  try {
    inp.focus();
  } catch (_) {
    /* ignore */
  }
}



/* -------- WBS mini-map -------- */

function wbsViewportInfo() {
  const wrap = document.querySelector('#project-view .wbs-wrap');
  const canvas = document.querySelector('#project-view .wbs-canvas');
  if (!wrap || !canvas) return null;
  const [cw, ch] = (canvas.getAttribute('data-canvas') || '0,0').split(',').map(Number);
  return { wrap, cw, ch, wrapW: wrap.clientWidth, wrapH: wrap.clientHeight, zoom: state.wbsZoom, pan: state.wbsPan };
}

/** Miniature thumbnail of the whole tree (scaled phase/task boxes). */
function buildMinimapSvg(layout) {
  const MM_W = 160;
  const MM_H = 120;
  const s = Math.min(MM_W / layout.canvasW, MM_H / layout.canvasH) || 0.01;
  const parts = layout.nodes.map((n) => {
    const cls =
      n.kind === 'root' ? 'mm-root' : n.kind === 'phase' ? 'mm-phase' : n.task && n.task.done ? 'mm-done' : 'mm-task';
    return `<rect class="${cls}" x="${(n.x * s).toFixed(1)}" y="${(n.y * s).toFixed(1)}" width="${Math.max(
      1.5,
      n.w * s
    ).toFixed(1)}" height="${Math.max(1.5, n.h * s).toFixed(1)}"/>`;
  });
  return `<svg class="mm-svg" width="${MM_W}" height="${MM_H}" viewBox="0 0 ${MM_W} ${MM_H}">${parts.join('')}</svg>`;
}

function applyWbsMinimap() {
  const mm = document.querySelector('#project-view .wbs-minimap');
  const view = document.querySelector('#project-view .wbs-mini-view');
  const info = wbsViewportInfo();
  if (!mm || !view || !info || !info.cw) return;
  const mmW = mm.clientWidth || 160;
  const mmH = mm.clientHeight || 120;
  const s = Math.min(mmW / info.cw, mmH / info.ch) || 0.01;
  view.style.left = ((-info.pan.x / info.zoom) * s) + 'px';
  view.style.top = ((-info.pan.y / info.zoom) * s) + 'px';
  view.style.width = Math.max(4, (info.wrapW / info.zoom) * s) + 'px';
  view.style.height = Math.max(4, (info.wrapH / info.zoom) * s) + 'px';
}

function handleMinimap(e) {
  const mm = document.querySelector('#project-view .wbs-minimap');
  const info = wbsViewportInfo();
  if (!mm || !info || !info.cw) return;
  const rect = mm.getBoundingClientRect();
  const mmW = mm.clientWidth || 160;
  const mmH = mm.clientHeight || 120;
  const s = Math.min(mmW / info.cw, mmH / info.ch) || 0.01;
  const cx = (e.clientX - rect.left) / s;
  const cy = (e.clientY - rect.top) / s;
  state.wbsPan = { x: info.wrapW / 2 - cx * info.zoom, y: info.wrapH / 2 - cy * info.zoom };
  applyWbsTransform();
  applyWbsMinimap();
  dismissHint();
}

/* ------------------------------ print export ----------------------------- */

let __pcPrintState = null;

/** Full (un-clipped) export document: the whole Gantt, then the whole WBS. */
function buildPrintRoot() {
  const p = currentProject();
  if (!p) return '';
  const savedRel = state.ganttRel;
  state.ganttRel = 1; // natural fitted zoom -> whole time axis
  const gInner = buildGanttInner(p);
  state.ganttRel = savedRel;

  const savedCollapsed = state.collapsed;
  const savedFocus = state.focusMode;
  const savedSel = state.selectedTaskId;
  state.collapsed = {};
  state.focusMode = false;
  state.selectedTaskId = null;
  const tree = buildWbsTree(p, true); // fully expanded
  const layout = layoutWbs(tree);
  const nodesHtml = layout.nodes.map((n) => wbsNodeHtml(p, n)).join('');
  state.collapsed = savedCollapsed;
  state.focusMode = savedFocus;
  state.selectedTaskId = savedSel;

  const cw = Math.round(layout.canvasW);
  const ch = Math.round(layout.canvasH);
  const s = p.summary;
  return `<div class="print-doc">
    <header class="print-head"><span class="mark"></span><span class="print-title">${esc(p.title)}</span><span class="print-meta">${esc(
    p.id
  )} · ${s.tasksDone}/${s.tasksTotal} · ${s.percent}% · target ${fmtDate(p.target)}</span></header>
    <section class="print-sec print-sec--gantt">
      <h2 class="print-h">甘特圖</h2>
      <div class="print-scale" data-kind="gantt"><div class="gantt print-gantt-host">${gInner}</div></div>
    </section>
    <section class="print-sec print-sec--wbs">
      <h2 class="print-h">WBS 工作分解樹</h2>
      <div class="print-scale" data-kind="wbs"><div class="wbs-canvas print-wbs-canvas" data-canvas="${cw},${ch}"><svg class="wbs-links" width="${cw}" height="${ch}">${wbsConnectors(
    layout
  )}</svg>${nodesHtml}</div></div>
    </section>
  </div>`;
}

const PRINT_PAGE_W = 1040; // A4 landscape content width @96dpi (297mm - 2*8mm) with margin

/** Shrink-to-fit using CSS `zoom`, which scales the element's LAYOUT box too. */
function applyPrintScale(root, kind, contentW) {
  const el = root.querySelector('.print-scale[data-kind="' + kind + '"]');
  if (!el || !contentW) return;
  el.style.zoom = String(Math.min(1, PRINT_PAGE_W / contentW));
  el.style.width = contentW + 'px'; // pre-zoom width -> rendered = contentW * zoom, centred by margin:auto
}

function __pcEnterPrintExport() {
  const root = document.getElementById('print-root');
  if (!root || !currentProject()) return;
  root.innerHTML = buildPrintRoot();
  root.hidden = false;
  applyTreePositions(root);
  applyGanttPositions(root);
  const gi = root.querySelector('.print-gantt-host .gantt-inner');
  const wi = root.querySelector('.print-wbs-canvas');
  const gW = gi ? Number((gi.getAttribute('data-canvas') || '0,0').split(',')[0]) : 0;
  const wW = wi ? Number((wi.getAttribute('data-canvas') || '0,0').split(',')[0]) : 0;
  applyPrintScale(root, 'gantt', gW);
  applyPrintScale(root, 'wbs', wW);
  window.__pcPrintW = PRINT_PAGE_W;
  __pcPrintState = { theme: document.documentElement.getAttribute('data-theme') };
  document.documentElement.setAttribute('data-theme', 'light'); // paper palette for print
  document.documentElement.classList.add('print-export');
}

function __pcExitPrintExport() {
  document.documentElement.classList.remove('print-export');
  if (__pcPrintState && __pcPrintState.theme) document.documentElement.setAttribute('data-theme', __pcPrintState.theme);
  __pcPrintState = null;
  const root = document.getElementById('print-root');
  if (root) {
    root.hidden = true;
    root.innerHTML = '';
  }
}
window.__pcEnterPrintExport = __pcEnterPrintExport;
window.__pcExitPrintExport = __pcExitPrintExport;

/* ------------------------------ events ----------------------------------- */

function selectProject(id) {
  state.selectedProjectId = id;
  state.selectedTaskId = null;
  state.editingTask = null;
  state.selection = {};
  state.wbsPan = { x: 24, y: 16 }; // initial margin so the root isn't flush to the edge
  state.ganttPanX = 0;
  state.criticalPath = [];
  state.baseline = null;
  state.addingTask = null;
  state.backups = []; // list is per-project; never show another project's snapshots
  state.shareOpen = false;
  state.share = null;
  state.history = [];
  state.selectedCommit = null;
  state.diff = null;
  state.conflicts = null;
  persist(LS.project, id);
  render();
  loadBaselineFor(id);
  loadGitStatus(id).then(render);
  loadAccess(id);
  if (state.view === 'history') loadHistory(id);
  if (state.showBackups) loadBackupList(id).then(render);
  const main = document.getElementById('main');
  if (main) main.scrollTop = 0;
}

function toggleCollapse(key) {
  state.collapsed[key] = !state.collapsed[key];
  render();
}

document.addEventListener('click', (e) => {
  if (state._suppressClick) {
    state._suppressClick = false; // swallow the click that ended a pan/drag
    return;
  }
  if (e.target.closest('#help-btn')) return openGuide();
  if (state.guideOpen) {
    // The guide overlay owns every click while it is open.
    if (e.target.closest('#guide-close') || e.target.id === 'guide') return closeGuide();
    const gj = e.target.closest('[data-guide-jump]');
    if (gj) return jumpGuide(gj.getAttribute('data-guide-jump'));
    return;
  }
  if (e.target.closest('.tick')) return; // the checkbox handles its own change
  if (e.target.closest('.col-sel') || e.target.closest('input[data-select]')) return; // row selection, not task-open
  if (e.target.closest('#confirm')) return; // confirm modal clicks must not close the panel
  if (state.ctx && !e.target.closest('#ctx-menu')) closeCtx();
  if (state.paletteFor && !e.target.closest('.palette') && !e.target.closest('[data-palette]')) {
    state.paletteFor = null;
    render();
    return;
  }
  if (state.menuOpen && !e.target.closest('.ovmenu') && !e.target.closest('[data-menu-toggle]')) {
    state.menuOpen = false;
    render();
    return;
  }
  if (state.exportMenu && !e.target.closest('.expmenu') && !e.target.closest('[data-export-toggle]')) {
    state.exportMenu = false;
    render();
    return;
  }

  const wz = e.target.closest('[data-wbs-zoom]');
  if (wz) return wbsZoomAction(wz.getAttribute('data-wbs-zoom'));
  const gz = e.target.closest('[data-gantt-zoom]');
  if (gz) return ganttZoomAction(gz.getAttribute('data-gantt-zoom'));

  const rz = e.target.closest('[data-roadmap-zoom]');
  if (rz) return roadmapZoomAction(rz.getAttribute('data-roadmap-zoom'));
  const topBtn = e.target.closest('[data-top]');
  if (topBtn) {
    state.selectedProjectId = null;
    state.topView = topBtn.getAttribute('data-top');
    persist('pc.topView', state.topView);
    render();
    const main = document.getElementById('main');
    if (main) main.scrollTop = 0;
    return;
  }
  if (e.target.closest('#theme-btn')) {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    persist('pc.theme', state.theme);
    render();
    return;
  }
  if (e.target.closest('#density-btn')) {
    state.density = state.density === 'compact' ? 'cozy' : 'compact';
    persist('pc.density', state.density);
    render();
    return;
  }
  // Team sync (git)
  if (e.target.closest('[data-git-sync]')) return doSync();
  if (e.target.closest('[data-git-bind-go]')) return doGitBind();
  if (e.target.closest('[data-git-bind]')) {
    state.gitBindOpen = !state.gitBindOpen;
    render();
    return;
  }
  if (e.target.closest('[data-git-bind-cancel]')) {
    state.gitBindOpen = false;
    render();
    return;
  }
  if (e.target.closest('[data-git-clone-go]')) return doGitClone();
  if (e.target.closest('[data-git-clone-toggle]')) {
    state.gitCloneOpen = !state.gitCloneOpen;
    render();
    return;
  }
  if (e.target.closest('[data-git-clone-cancel]')) {
    state.gitCloneOpen = false;
    render();
    return;
  }
  // P3: share & permissions
  if (e.target.closest('[data-share-toggle]')) return toggleShare();
  if (e.target.closest('[data-share-cancel]')) {
    state.shareOpen = false;
    state.share = null;
    render();
    return;
  }
  if (e.target.closest('[data-share-refresh]')) {
    const p = currentProject();
    if (p) loadShare(p.id);
    return;
  }
  if (e.target.closest('[data-share-invite]')) return doShareInvite();
  const srm = e.target.closest('[data-share-remove]');
  if (srm) return doShareRemove(srm.getAttribute('data-share-remove'));
  // P4: history
  if (e.target.closest('[data-history-refresh]')) {
    const p = currentProject();
    if (p) loadHistory(p.id);
    return;
  }
  const hd = e.target.closest('[data-history-diff]');
  if (hd) return loadDiff(hd.getAttribute('data-history-diff'));
  const hr = e.target.closest('[data-history-restore]');
  if (hr) return doRestoreCommit(hr.getAttribute('data-history-restore'));
  // P5: identity
  if (e.target.closest('[data-me-save]')) {
    const el = document.querySelector('[data-me-input]');
    setMe(el ? el.value.trim() : '');
    toast('已設定「我是誰」');
    return;
  }
  const mu = e.target.closest('[data-me-use]');
  if (mu) {
    setMe(mu.getAttribute('data-me-use'));
    return;
  }
  // P6: conflicts
  if (e.target.closest('[data-conflict-apply]')) return doResolveConflicts();
  if (e.target.closest('[data-conflict-cancel]')) {
    state.conflicts = null;
    render();
    return;
  }
  if (e.target.closest('[data-conflict-all-ours]')) {
    setAllConflicts('ours');
    return;
  }
  if (e.target.closest('[data-conflict-all-theirs]')) {
    setAllConflicts('theirs');
    return;
  }
  if (e.target.closest('#rail-reset')) {
    setRailWidth(300);
    toast('已還原側欄寬度');
    return;
  }
  if (e.target.closest('[data-export-toggle]')) {
    state.exportMenu = !state.exportMenu;
    state.menuOpen = false;
    render();
    return;
  }
  if (e.target.closest('[data-menu-toggle]')) {
    state.menuOpen = !state.menuOpen;
    state.exportMenu = false;
    render();
    return;
  }
  if (e.target.closest('[data-phase-admin-toggle]')) {
    state.showPhaseAdmin = !state.showPhaseAdmin;
    render();
    return;
  }
  if (e.target.closest('[data-bulk-toggle]')) {
    state.showBulk = !state.showBulk;
    render();
    return;
  }
  const pin = e.target.closest('[data-pin]');
  if (pin) {
    const id = pin.getAttribute('data-pin');
    if (state.pins[id]) delete state.pins[id];
    else state.pins[id] = true;
    persist('pc.pins', JSON.stringify(state.pins));
    render();
    return;
  }
  const pal = e.target.closest('[data-palette]');
  if (pal) {
    const id = pal.getAttribute('data-palette');
    state.paletteFor = state.paletteFor === id ? null : id;
    render();
    return;
  }
  const sc = e.target.closest('[data-setcolor]');
  if (sc) {
    const id = sc.getAttribute('data-setcolor');
    const ci = Number(sc.getAttribute('data-ci')) || 0;
    if (ci > 0) state.colors[id] = ci;
    else delete state.colors[id];
    persist('pc.colors', JSON.stringify(state.colors));
    state.paletteFor = null;
    render();
    return;
  }
  const jump = e.target.closest('[data-jump-project]');
  if (jump) {
    selectProject(jump.getAttribute('data-jump-project'));
    const tid = jump.getAttribute('data-jump-task');
    if (tid) {
      state.selectedTaskId = tid;
      renderTaskPanel(currentProject());
    }
    return;
  }
  if (e.target.closest('[data-toggle-deps]')) {
    state.showAllDeps = !state.showAllDeps;
    persist('pc.showAllDeps', state.showAllDeps ? '1' : '0');
    render();
    return;
  }
  if (e.target.closest('[data-hint-toggle]')) {
    state.hintOn = !state.hintOn;
    if (state.hintOn) state.hintDismissed = false;
    render();
    return;
  }
  if (e.target.closest('[data-minimap-toggle]')) {
    state.showMinimap = !state.showMinimap;
    persist('pc.minimap', state.showMinimap ? '1' : '0');
    render();
    return;
  }
  if (e.target.closest('[data-focus]')) {
    state.focusMode = !state.focusMode;
    render();
    return;
  }
  if (e.target.closest('[data-collapse-all]')) {
    const p = currentProject();
    if (p) for (const ph of p.phases) state.collapsed[`${p.id}::${ph.id}`] = true;
    render();
    return;
  }
  if (e.target.closest('[data-expand-all]')) {
    const p = currentProject();
    if (p) for (const ph of p.phases) delete state.collapsed[`${p.id}::${ph.id}`];
    render();
    return;
  }
  const ioBtn = e.target.closest('[data-io]');
  if (ioBtn) return runIo(ioBtn.getAttribute('data-io'));
  const bkTs = e.target.closest('[data-backup-ts]');
  if (bkTs) return doRestoreBackup(bkTs.getAttribute('data-backup-ts'));
  if (e.target.closest('[data-show-backups]')) return toggleBackups();

  const ctxItem = e.target.closest('[data-ctx]');
  if (ctxItem) {
    const a = ctxItem.getAttribute('data-ctx');
    const id = ctxItem.getAttribute('data-task-id');
    closeCtx();
    runCtx(a, id);
    return;
  }

  // Header / planning actions
  if (e.target.closest('[data-add-task]')) {
    const p = currentProject();
    if (p && p.phases[0]) {
      state.addingTask = p.phases[0].id;
      state.view = 'wbs';
      render();
      focusAddForm();
    }
    return;
  }
  if (e.target.closest('[data-reschedule]')) return doReschedule();
  if (e.target.closest('[data-toggle-critical]')) return toggleCritical();
  if (e.target.closest('[data-freeze-baseline]')) return doFreezeBaseline();
  if (e.target.closest('[data-toggle-baseline]')) return toggleBaseline();

  const atp = e.target.closest('[data-add-task-phase]');
  if (atp) {
    state.addingTask = atp.getAttribute('data-add-task-phase');
    state.view = 'wbs';
    render();
    focusAddForm();
    return;
  }
  if (e.target.closest('[data-new-cancel]')) {
    state.addingTask = null;
    render();
    return;
  }
  if (e.target.closest('[data-new-save]')) return saveNewTask();

  // Phase admin
  if (e.target.closest('[data-add-phase]')) {
    state.editingPhase = '__new__';
    render();
    return;
  }
  const pr = e.target.closest('[data-phase-rename]');
  if (pr) {
    state.editingPhase = pr.getAttribute('data-phase-rename');
    render();
    return;
  }
  if (e.target.closest('[data-phase-cancel]')) {
    state.editingPhase = null;
    render();
    return;
  }
  const ps = e.target.closest('[data-phase-save]');
  if (ps) return doPhaseSave(ps.getAttribute('data-phase-save'));
  const pu = e.target.closest('[data-phase-up]');
  if (pu) return doPhaseMove(pu.getAttribute('data-phase-up'), -1);
  const pd = e.target.closest('[data-phase-down]');
  if (pd) return doPhaseMove(pd.getAttribute('data-phase-down'), 1);
  const pdel = e.target.closest('[data-phase-del]');
  if (pdel) return doPhaseDelete(pdel.getAttribute('data-phase-del'));

  // Milestones
  if (e.target.closest('[data-ms-add]')) return doMsAdd();
  const mse = e.target.closest('[data-ms-edit]');
  if (mse) {
    state.editingMilestone = mse.getAttribute('data-ms-edit');
    render();
    return;
  }
  if (e.target.closest('[data-ms-cancel]')) {
    state.editingMilestone = null;
    render();
    return;
  }
  const mss = e.target.closest('[data-ms-save]');
  if (mss) return doMsSave(mss.getAttribute('data-ms-save'));
  const msd = e.target.closest('[data-ms-del]');
  if (msd) return doMsDelete(msd.getAttribute('data-ms-del'));

  // Bulk / filters
  if (e.target.closest('[data-bulk-done]')) return doBulk(true);
  if (e.target.closest('[data-bulk-undone]')) return doBulk(false);
  if (e.target.closest('[data-bulk-clear]')) {
    state.selection = {};
    render();
    return;
  }
  if (e.target.closest('[data-filter-clear]')) {
    state.filter = { owner: '', phase: '', status: '', overdue: false };
    render();
    return;
  }

  // Task panel actions
  const te = e.target.closest('[data-task-edit]');
  if (te) {
    state.editingTask = te.getAttribute('data-task-edit');
    renderTaskPanel(currentProject());
    return;
  }
  if (e.target.closest('[data-task-cancel]')) {
    state.editingTask = null;
    renderTaskPanel(currentProject());
    return;
  }
  if (e.target.closest('[data-task-save]')) return saveTaskEdit();
  const td = e.target.closest('[data-task-del]');
  if (td) return doDeleteTask(td.getAttribute('data-task-del'));
  const tu = e.target.closest('[data-task-up]');
  if (tu) return doTaskShift(tu.getAttribute('data-task-up'), -1);
  const tdn = e.target.closest('[data-task-down]');
  if (tdn) return doTaskShift(tdn.getAttribute('data-task-down'), 1);

  const tab = e.target.closest('.tab');
  if (tab) {
    state.view = tab.getAttribute('data-view');
    persist(LS.view, state.view);
    render();
    const p = currentProject();
    if (state.view === 'history' && p) loadHistory(p.id);
    const main = document.getElementById('main');
    if (main) main.scrollTop = 0; // every view switch starts at the top (no half-hidden rows)
    return;
  }
  const phase = e.target.closest('[data-phase]');
  if (phase) {
    toggleCollapse(phase.getAttribute('data-phase'));
    return;
  }
  const taskHit = e.target.closest('[data-task-link]');
  if (taskHit) {
    const id = taskHit.getAttribute('data-task-link');
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      state.selection[id] = !state.selection[id];
      render();
    } else {
      state.selectedTaskId = id;
      state.editingTask = null;
      renderTaskPanel(currentProject());
    }
    return;
  }
  const projHit = e.target.closest('[data-project-id]');
  if (projHit) {
    selectProject(projHit.getAttribute('data-project-id'));
    return;
  }
  if (e.target.closest('#task-close')) {
    state.selectedTaskId = null;
    state.editingTask = null;
    renderTaskPanel(currentProject());
    return;
  }
  if (state.selectedTaskId && !e.target.closest('#task-panel')) {
    state.selectedTaskId = null;
    state.editingTask = null;
    renderTaskPanel(currentProject());
  }
});

document.addEventListener('contextmenu', (e) => {
  const taskHit = e.target.closest('[data-task-link]');
  if (!taskHit) {
    if (state.ctx) closeCtx();
    return;
  }
  e.preventDefault();
  state.ctx = { taskId: taskHit.getAttribute('data-task-link'), x: e.clientX, y: e.clientY };
  renderCtx();
});

// Filters, selection, moves, deps picker and manual ticking.
document.addEventListener('change', async (e) => {
  const srt = e.target.closest('select[data-sort]');
  if (srt) {
    state.sort = srt.value;
    persist('pc.sort', state.sort);
    render();
    return;
  }
  const sel = e.target.closest('input[data-select]');
  if (sel) {
    const id = sel.getAttribute('data-select');
    if (sel.checked) state.selection[id] = true;
    else delete state.selection[id];
    render();
    return;
  }
  const fs = e.target.closest('select[data-filter]');
  if (fs) {
    state.filter[fs.getAttribute('data-filter')] = fs.value;
    render();
    return;
  }
  const fo = e.target.closest('input[data-filter-overdue]');
  if (fo) {
    state.filter.overdue = fo.checked;
    render();
    return;
  }
  const mv = e.target.closest('select[data-task-move]');
  if (mv) {
    const p = currentProject();
    if (p) {
      const res = await window.api.moveTask(p.id, mv.getAttribute('data-task-move'), { phaseId: mv.value });
      afterWrite(res, '已移動到 ' + mv.value);
    }
    return;
  }
  if (e.target.closest('input[data-dep]')) {
    updateDepsWarning();
    return;
  }
  const cb = e.target.closest('input[data-tick]');
  if (!cb) return;
  const projectId = cb.getAttribute('data-project');
  const taskId = cb.getAttribute('data-task');
  const done = cb.checked;
  if (state.readonly[projectId]) {
    cb.checked = !done;
    toast('唯讀：你冇修改權限');
    return;
  }
  cb.disabled = true;
  try {
    const res = await window.api.setTaskDone(projectId, taskId, done);
    if (!res || !res.ok) {
      cb.checked = !done;
      toast('寫入失敗：' + ((res && res.error) || 'unknown'));
    } else {
      recordOp(res, projectId, done ? '標記完成 ' + taskId : '取消完成 ' + taskId);
      toast(done ? `已標記完成 ${taskId}` : `已取消 ${taskId}`);
      loadGitStatus(projectId).then(render);
    }
  } catch (err) {
    cb.checked = !done;
    toast('寫入失敗：' + err.message);
  } finally {
    cb.disabled = false;
  }
});

const refreshBtn = document.getElementById('refresh-btn');
refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  try {
    const payload = await window.api.refresh();
    applyPayload(payload);
    toast('已重新掃描');
  } catch (err) {
    toast('Refresh 失敗: ' + err.message);
  } finally {
    refreshBtn.disabled = false;
  }
});

/* ------------------------------ data binding ----------------------------- */

function applyPayload(payload) {
  if (!payload) return;
  state.projects = payload.projects || [];
  state.warnings = payload.warnings || [];
  state.root = payload.root || state.root;

  if (state.selectedProjectId && !state.projects.some((p) => p.id === state.selectedProjectId)) {
    state.selectedProjectId = null;
    state.selectedTaskId = null;
  }
  const proj = currentProject();
  if (proj && state.selectedTaskId && !proj.tasks.some((t) => t.id === state.selectedTaskId)) {
    state.selectedTaskId = null;
  }
  render();
  if (state.topView === 'myday' && state.me && !state.selectedProjectId) loadMyDay();
}

function showUpdated() {
  const el = document.getElementById('meta-updated');
  if (!el) return;
  el.hidden = false;
  clearTimeout(showUpdated._t);
  showUpdated._t = setTimeout(() => {
    el.hidden = true;
  }, 2500);
}

/** Show the latest action toast immediately (replace-in-place, no backlog). */
function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 1700);
}

function tickClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  document.getElementById('meta-clock').textContent =
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
      d.getMinutes()
    )}:${p(d.getSeconds())}`;
}

async function init() {
  loadUI();
  applyRailWidth();
  setupSplitter();
  window.addEventListener('resize', () => setRailWidth(state.railWidth)); // re-clamp to ≤40%
  document.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerUp);
  document.addEventListener('keydown', onKeyDown);
  const ub = document.getElementById('undo-btn');
  if (ub) ub.addEventListener('click', undo);
  const rb = document.getElementById('redo-btn');
  if (rb) rb.addEventListener('click', redo);

  tickClock();
  setInterval(tickClock, 1000);

  window.api.onUpdate((payload) => {
    applyPayload(payload);
    const reason = payload.reason;
    // Background poll/fs updates never raise a toast (they would clobber user
    // action feedback); they flash a subtle inline indicator instead.
    if (reason === 'fs' || reason === 'poll') showUpdated();
  });

  try {
    const meta = await window.api.getMeta();
    if (meta && meta.root) state.root = meta.root;
  } catch (_) {
    /* meta is optional */
  }
  try {
    const payload = await window.api.getProjects();
    applyPayload(payload);
    if (state.selectedProjectId) {
      loadGitStatus(state.selectedProjectId).then(render);
      loadAccess(state.selectedProjectId);
    }
  } catch (err) {
    const l = document.getElementById('landing');
    if (l) l.innerHTML = '<div class="empty">讀取失敗: ' + esc(err.message) + '</div>';
  }
  loadIdentity();
}

init();
