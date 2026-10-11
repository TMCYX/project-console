'use strict';

/* ==========================================================================
   git-identity.js — resolve a git commit identity so the app NEVER hard-fails
   with "Author identity unknown".

   Resolution order (all repo-local; the user's GLOBAL config is never touched):
     1. an existing effective git identity (repo-local, global or system)
     2. else derive from the connected GitHub account (opts.account) — or, if
        none, `gh api user` → name = login,
        email = "<id>+<login>@users.noreply.github.com"  (GitHub noreply —
        the personal email is never exposed), and persist it repo-local.
     3. else fall back to a bot identity used ONLY via `-c` for that commit
        (not persisted), with needSetup=true so the UI can prompt for a real one.

   Self-contained (its own spawn); no dependency on data.js / gitx.js.
   ========================================================================== */

const { spawn } = require('child_process');

const GIT_TIMEOUT_MS = 15000;
const GH_TIMEOUT_MS = 15000;
const BOT_NAME = 'Project Console';
const BOT_EMAIL = 'project-console@localhost';

function spawnCapture(cmd, args, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env, windowsHide: true, shell: false });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(err.message) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (p) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(p);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {
        /* ignore */
      }
      finish({ ok: false, code: -1, stdout, stderr: stderr || 'timed out', timedOut: true });
    }, opts.timeoutMs || GIT_TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => finish({ ok: false, code: -1, stdout, stderr: stderr || String(err.message) }));
    child.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr }));
  });
}

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
const GH_ENV = { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };

async function cfgGet(dir, key) {
  const res = await spawnCapture('git', ['config', key], { cwd: dir, env: GIT_ENV });
  return res.ok ? res.stdout.trim() : '';
}
async function cfgSetLocal(dir, key, val) {
  const res = await spawnCapture('git', ['config', key, val], { cwd: dir, env: GIT_ENV });
  return res.ok;
}

/** Probe `gh api user` for { login, id }. Never throws; null if unavailable. */
async function probeGhUser() {
  const res = await spawnCapture('gh', ['api', 'user', '--jq', '{login:.login,id:.id}'], {
    env: GH_ENV,
    timeoutMs: GH_TIMEOUT_MS,
  });
  if (!res.ok) return null;
  try {
    const j = JSON.parse(res.stdout.trim());
    if (j && j.login) return { login: String(j.login), id: j.id != null ? String(j.id) : null };
  } catch (_) {
    /* unparseable */
  }
  return null;
}

/** GitHub noreply email — never exposes a personal address. */
function noreplyEmail(login, id) {
  return id != null ? `${id}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com`;
}

/** Normalise a connected account ({login,id}) or a bare login string. */
function normalizeAccount(a) {
  if (!a) return null;
  if (typeof a === 'string') {
    const s = a.trim();
    return s ? { login: s, id: null } : null;
  }
  if (typeof a === 'object' && a.login) {
    return { login: String(a.login), id: a.id != null ? String(a.id) : null };
  }
  return null;
}

/**
 * Ensure a usable identity for commits in `dir`.
 * opts: { account, ghUser, useGh (default true), persist (default true) }
 *   - account: the connected GitHub account { login, id } — takes priority
 *     over the gh CLI so commits use the in-app connection with no CLI.
 * Returns { ok, name, email, source: 'existing'|'github'|'gh'|'fallback', needSetup?, warning? }.
 */
async function ensureGitIdentity(dir, opts = {}) {
  const name = await cfgGet(dir, 'user.name');
  const email = await cfgGet(dir, 'user.email');
  if (name && email) return { ok: true, name, email, source: 'existing' };

  // 1. Connected GitHub account (preferred) → 2. gh CLI.
  const account = normalizeAccount(opts.account) || normalizeAccount(opts.ghUser);
  if (account && account.login) {
    const em = noreplyEmail(account.login, account.id);
    if (opts.persist !== false) {
      await cfgSetLocal(dir, 'user.name', account.login);
      await cfgSetLocal(dir, 'user.email', em);
    }
    return { ok: true, name: account.login, email: em, source: normalizeAccount(opts.account) ? 'github' : 'gh' };
  }

  if (opts.useGh !== false) {
    const u = await probeGhUser();
    if (u && u.login) {
      const em = noreplyEmail(u.login, u.id);
      if (opts.persist !== false) {
        await cfgSetLocal(dir, 'user.name', u.login);
        await cfgSetLocal(dir, 'user.email', em);
      }
      return { ok: true, name: u.login, email: em, source: 'gh' };
    }
  }

  return {
    ok: true,
    name: BOT_NAME,
    email: BOT_EMAIL,
    source: 'fallback',
    needSetup: true,
    warning: '唔夠資料自動設定 git 身份；今次 commit 用咗臨時身份。喺 app「連接 GitHub」或「設定 git 身份」輸入資料就會永久記住。',
  };
}

/** `-c user.name=… -c user.email=…` to prefix any git command (bulletproof). */
function identityArgs(id) {
  return ['-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`];
}

module.exports = { ensureGitIdentity, identityArgs, probeGhUser, noreplyEmail, BOT_NAME, BOT_EMAIL };
