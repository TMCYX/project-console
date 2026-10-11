'use strict';

/* ==========================================================================
   github.js — GitHub REST API client + encrypted token store.

   Pure Node (no Electron, no new npm deps): the API calls use the runtime's
   global `fetch` (Node >= 18 / Electron), and the token store's encryption is
   injected as a `safeStorage` adapter by the main process (Electron's
   safeStorage), so the whole module is testable headlessly.

   Responsibilities:
     - createTokenStore({ dir, safeStorage }) — encrypted token persistence
       (falls back to a plain 0600 file when encryption is unavailable).
     - REST helpers: getUser / listCollaborators / addCollaborator /
       removeCollaborator / createRepo / repoPermissions (+ listInvitations).
     - authedRemoteUrl() — build a per-command authenticated git URL so the
       token is NEVER written into .git/config.
     - Constants: TOKEN_URL (pre-filled scopes) and NO_AUTH_MSG (the friendly
       "connect GitHub in-app, or install gh" fallback message).

   Security: the token is only ever read by the main process and passed to the
   GitHub API / an explicit per-command git URL. It is never returned to the
   renderer and never logged.
   ========================================================================== */

const fs = require('fs');
const os = require('os');
const path = require('path');

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'Project-Console';

/** GitHub token page with the scopes + description pre-filled. */
const TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=repo,read:user&description=Project%20Console';

/** Shown when there is neither a stored token nor a working gh CLI. */
const NO_AUTH_MSG =
  '請喺 app 內『連接 GitHub』（一個 link + 貼 token），或者裝 `gh` CLI';

/* ============================ token store =============================== */

const TOKEN_FILE = 'github-token.json';

function tokenFilePath(dir) {
  return path.join(dir, TOKEN_FILE);
}

/**
 * Encrypted token store.
 * opts.dir         — directory to hold the token file (main passes userData).
 * opts.safeStorage — Electron safeStorage adapter (optional). When it reports
 *                    isEncryptionAvailable() === true the token is encrypted;
 *                    otherwise a plain file is written with mode 0600.
 */
function createTokenStore(opts = {}) {
  const dir = opts.dir || path.join(os.homedir(), '.project-console');
  const safeStorage = opts.safeStorage || null;

  function encryptionAvailable() {
    try {
      return !!(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable());
    } catch (_) {
      return false;
    }
  }

  function read() {
    try {
      const p = tokenFilePath(dir);
      if (!fs.existsSync(p)) return null;
      let j;
      try {
        j = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (_) {
        return null;
      }
      if (!j || typeof j !== 'object') return null;
      if (j.encrypted) {
        if (!encryptionAvailable()) return null;
        const buf = Buffer.from(String(j.data || ''), 'base64');
        const tok = safeStorage.decryptString(buf);
        return tok ? String(tok) : null;
      }
      return j.token ? String(j.token) : null;
    } catch (_) {
      return null;
    }
  }

  function write(token) {
    const tok = String(token == null ? '' : token).trim();
    if (!tok) return { ok: false, error: 'empty token' };
    try {
      fs.mkdirSync(dir, { recursive: true });
      const encrypted = encryptionAvailable();
      let payload;
      if (encrypted) {
        const enc = safeStorage.encryptString(tok);
        payload = { v: 1, encrypted: true, data: Buffer.from(enc).toString('base64') };
      } else {
        payload = { v: 1, encrypted: false, token: tok };
      }
      const p = tokenFilePath(dir);
      fs.writeFileSync(p, JSON.stringify(payload) + '\n', { encoding: 'utf8', mode: 0o600 });
      try {
        fs.chmodSync(p, 0o600);
      } catch (_) {
        /* chmod is a no-op on some platforms (Windows) */
      }
      return { ok: true, encrypted };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  function clear() {
    try {
      const p = tokenFilePath(dir);
      if (fs.existsSync(p)) fs.rmSync(p, { force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  return {
    path: () => tokenFilePath(dir),
    encryptionAvailable,
    read,
    write,
    clear,
    /** Non-secret metadata for diagnostics (never includes the token). */
    info: () => ({ path: tokenFilePath(dir), encrypted: encryptionAvailable(), present: read() != null }),
  };
}

/* ============================ REST helpers ============================== */

function classifyHttp(status) {
  if (status === 401) return 'bad_token';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 422) return 'validation';
  return 'http_' + status;
}

function friendlyHttpError(status, value) {
  const apiMsg = value && typeof value === 'object' && value.message ? String(value.message) : '';
  if (status === 401) return 'token 無效或已失效，請「斷開連接」再貼新 token';
  if (status === 403) return '權限不足（token 可能欠缺 repo scope，或者你唔係 repo admin）';
  if (status === 404) return '搵唔到（repo 唔存在，或者 token 冇權限睇）';
  if (status === 422) return apiMsg || 'GitHub 拒絕咗呢個請求（參數唔啱）';
  return apiMsg || `GitHub API 錯誤（HTTP ${status}）`;
}

/**
 * Low-level request. opts: { token, fetch, body, headers }
 * Returns { ok, status?, value?, code?, error? } — never throws.
 */
async function api(method, apiPath, opts = {}) {
  const f = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  if (typeof f !== 'function') return { ok: false, code: 'no_fetch', error: 'fetch unavailable' };
  const token = opts.token ? String(opts.token) : '';
  if (!token) return { ok: false, code: 'no_token', error: 'no GitHub token' };

  const url = /^https?:\/\//i.test(apiPath) ? apiPath : API_BASE + apiPath;
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': USER_AGENT,
    ...(opts.headers || {}),
  };
  const init = { method, headers };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }

  let res;
  try {
    res = await f(url, init);
  } catch (err) {
    return { ok: false, code: 'network', error: err && err.message ? err.message : String(err) };
  }

  let text = '';
  try {
    text = await res.text();
  } catch (_) {
    text = '';
  }
  let value = null;
  if (text) {
    try {
      value = JSON.parse(text);
    } catch (_) {
      value = text;
    }
  }
  if (!res.ok) {
    return { ok: false, code: classifyHttp(res.status), status: res.status, error: friendlyHttpError(res.status, value), value };
  }
  return { ok: true, status: res.status, value };
}

/** owner/name from a repo object or "owner/name" string. */
function splitRepo(repo) {
  if (repo && typeof repo === 'object') {
    return { owner: repo.owner != null ? String(repo.owner) : null, name: repo.name != null ? String(repo.name) : null };
  }
  const s = String(repo == null ? '' : repo)
    .trim()
    .replace(/\.git$/i, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length >= 2) return { owner: parts[parts.length - 2], name: parts[parts.length - 1] };
  return { owner: null, name: parts[0] || '' };
}

/** Map a GitHub `permissions` object → 'ADMIN' | 'WRITE' | 'READ' | null. */
function permissionsToPerm(perms) {
  if (!perms || typeof perms !== 'object') return null;
  if (perms.admin === true) return 'ADMIN';
  if (perms.maintain === true || perms.push === true) return 'WRITE';
  if (perms.pull === true || perms.read === true) return 'READ';
  return null;
}

/** GET /user → { ok, login, id, name, avatarUrl }. */
async function getUser(opts = {}) {
  const r = await api('GET', '/user', opts);
  if (!r.ok) return r;
  const v = r.value || {};
  if (!v.login) return { ok: false, code: 'bad_response', error: 'GitHub 冇回傳 login' };
  return {
    ok: true,
    login: String(v.login),
    id: v.id != null ? String(v.id) : null,
    name: v.name ? String(v.name) : null,
    avatarUrl: v.avatar_url ? String(v.avatar_url) : null,
  };
}

/** GET /repos/:owner/:name → permissions + push capability. */
async function repoPermissions(repo, opts = {}) {
  const { owner, name } = splitRepo(repo);
  if (!owner || !name) return { ok: false, code: 'bad_repo', error: 'repo 需要 owner/name' };
  const r = await api('GET', `/repos/${owner}/${name}`, opts);
  if (!r.ok) return r;
  const v = r.value || {};
  const permissions = v.permissions || null;
  const perm = permissionsToPerm(permissions);
  return {
    ok: true,
    permissions,
    permission: perm,
    canPush: perm === 'ADMIN' || perm === 'WRITE',
    readOnly: perm === 'READ',
    private: v.private === true,
    fullName: v.full_name || `${owner}/${name}`,
    defaultBranch: v.default_branch || null,
    htmlUrl: v.html_url || `https://github.com/${owner}/${name}`,
  };
}

/** GET /repos/:owner/:name/collaborators → { collaborators: [{login, permission, role}] }. */
async function listCollaborators(repo, opts = {}) {
  const { owner, name } = splitRepo(repo);
  if (!owner || !name) return { ok: false, code: 'bad_repo', error: 'repo 需要 owner/name' };
  const r = await api('GET', `/repos/${owner}/${name}/collaborators?per_page=100`, opts);
  if (!r.ok) return r;
  const arr = Array.isArray(r.value) ? r.value : [];
  return {
    ok: true,
    collaborators: arr.map((x) => ({
      login: x && x.login,
      permission: permissionsToPerm(x && x.permissions),
      role: (x && x.role_name) || null,
    })),
  };
}

/** GET /repos/:owner/:name/invitations → { invites: [{login, permission}] } (best effort). */
async function listInvitations(repo, opts = {}) {
  const { owner, name } = splitRepo(repo);
  if (!owner || !name) return { ok: false, code: 'bad_repo', error: 'repo 需要 owner/name' };
  const r = await api('GET', `/repos/${owner}/${name}/invitations?per_page=100`, opts);
  if (!r.ok) return r;
  const arr = Array.isArray(r.value) ? r.value : [];
  return {
    ok: true,
    invites: arr.map((x) => ({
      login: (x && x.invitee && x.invitee.login) || (x && x.login) || '?',
      permission: permissionsToPerm(x && x.permissions),
    })),
  };
}

/** PUT /repos/:owner/:name/collaborators/:user { permission: 'push'|'pull' }. */
async function addCollaborator(repo, user, permission, opts = {}) {
  const { owner, name } = splitRepo(repo);
  const u = String(user == null ? '' : user).trim();
  if (!owner || !name) return { ok: false, code: 'bad_repo', error: 'repo 需要 owner/name' };
  if (!u) return { ok: false, code: 'bad_user', error: '請輸入 GitHub username' };
  const perm = permission === 'read' || permission === 'pull' ? 'pull' : 'push';
  const r = await api('PUT', `/repos/${owner}/${name}/collaborators/${encodeURIComponent(u)}`, {
    ...opts,
    body: { permission: perm },
  });
  if (!r.ok) return r;
  return { ok: true, user: u, permission: perm, invitation: r.value || null };
}

/** DELETE /repos/:owner/:name/collaborators/:user. */
async function removeCollaborator(repo, user, opts = {}) {
  const { owner, name } = splitRepo(repo);
  const u = String(user == null ? '' : user).trim();
  if (!owner || !name || !u) return { ok: false, code: 'bad_user', error: 'repo + username required' };
  const r = await api('DELETE', `/repos/${owner}/${name}/collaborators/${encodeURIComponent(u)}`, opts);
  if (!r.ok) return r;
  return { ok: true, user: u };
}

/**
 * Create a repo. options: { private, description, owner }
 * opts: { token, fetch, login }  — `login` lets us route to /orgs/<owner>/repos
 * only when the owner is not the authenticated user.
 */
async function createRepo(name, options = {}, opts = {}) {
  const repo = String(name == null ? '' : name).trim();
  if (!repo) return { ok: false, code: 'bad_name', error: 'repo 名 required' };
  const isPrivate = options.private !== false; // private by default
  const owner = String(opts.owner || options.owner || '').trim();
  const login = String(opts.login || '').trim();
  const useOrg = !!owner && (!login || owner.toLowerCase() !== login.toLowerCase());

  const body = { name: repo, private: isPrivate, auto_init: false };
  if (options.description) body.description = String(options.description);

  const apiPath = useOrg ? `/orgs/${owner}/repos` : '/user/repos';
  const r = await api('POST', apiPath, { ...opts, body });
  if (!r.ok) {
    if (r.status === 422 && /already exists|name already exists|taken/i.test(String(r.value && r.value.message))) {
      return { ok: false, code: 'repo_exists', status: r.status, error: `repo 名「${repo}」已經有人用咗，改個名再試。`, value: r.value };
    }
    return r;
  }
  const v = r.value || {};
  return {
    ok: true,
    fullName: v.full_name || (owner ? `${owner}/${repo}` : repo),
    name: v.name || repo,
    owner: (v.owner && v.owner.login) || owner || login || null,
    htmlUrl: v.html_url || null,
    cloneUrl: v.clone_url || null,
    sshUrl: v.ssh_url || null,
    private: v.private === true,
  };
}

/* ============================ git auth URLs ============================ */

/** Parse a github remote (https / ssh / git / ssh://) → { host, owner, name } (else null). */
function parseGitHubRemote(url) {
  if (!url || typeof url !== 'string') return null;
  const s = url.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!s) return null;
  let m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)$/i.exec(s);
  if (m) return /(^|\.)github\.com$/i.test(m[1]) ? { host: m[1], owner: m[2], name: m[3] } : null;
  m = /^git@([^:]+):([^/]+)\/([^/]+)$/i.exec(s);
  if (m) return /(^|\.)github\.com$/i.test(m[1]) ? { host: m[1], owner: m[2], name: m[3] } : null;
  m = /^ssh:\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/]+)$/i.exec(s);
  if (m) return /(^|\.)github\.com$/i.test(m[1]) ? { host: m[1], owner: m[2], name: m[3] } : null;
  m = /^git:\/\/([^/]+)\/([^/]+)\/([^/]+)$/i.exec(s);
  if (m) return /(^|\.)github\.com$/i.test(m[1]) ? { host: m[1], owner: m[2], name: m[3] } : null;
  return null;
}

/**
 * Build a single-command authenticated https URL for a github remote.
 * Returns null when the remote is not github or there is no token — callers
 * must then fall back to the untokened remote. The token is passed per command
 * so it is never persisted into .git/config.
 */
function authedRemoteUrl(remote, token) {
  const tok = String(token == null ? '' : token).trim();
  if (!tok) return null;
  const r = parseGitHubRemote(remote);
  if (!r) return null;
  return `https://x-access-token:${tok}@${r.host}/${r.owner}/${r.name}.git`;
}

module.exports = {
  API_BASE,
  TOKEN_URL,
  NO_AUTH_MSG,
  createTokenStore,
  api,
  splitRepo,
  permissionsToPerm,
  getUser,
  repoPermissions,
  listCollaborators,
  listInvitations,
  addCollaborator,
  removeCollaborator,
  createRepo,
  parseGitHubRemote,
  authedRemoteUrl,
  classifyHttp,
};
