import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function syncSleep(ms) {
  if (!ms || ms <= 0) return;
  try {
    Atomics.wait(sleepBuffer, 0, 0, ms);
  } catch {}
}
// Antigravity launches sidecars with ANTIGRAVITY_SIDECAR_WEB_PORT and provides `sidecar_sdk`;
// anywhere else (a plain browser) the bundled stand-in serves the same routes.
const isStandaloneMode = !process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
const { SidecarApp, Response } = isStandaloneMode
  ? await import('./standalone_sdk.mjs')
  : await import('sidecar_sdk');

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..', '..');
const WATCHDOG_CTL_SCRIPT = join(PLUGIN_ROOT, 'scripts', 'watchdog_ctl.py');
// Same data directory as watchdog_ctl.py, so both hosts read one state file.
const WATCHDOG_DIR = join(process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(), '.gemini', 'antigravity'), 'watchdog');
const STATE_FILE = join(WATCHDOG_DIR, 'state.json');

const app = new SidecarApp();

function normalizeFsPath(uriOrPath) {
  if (!uriOrPath) return '';
  let s = String(uriOrPath).trim();
  if (s.startsWith('file://')) {
    try {
      if (!s.includes('#') || s.includes('%23')) {
        s = fileURLToPath(s);
      } else {
        s = s.replace(/^file:\/\/(localhost)?/i, '');
        try { s = decodeURIComponent(s); } catch {}
      }
    } catch {
      s = s.replace(/^file:\/\/(localhost)?/i, '');
      try { s = decodeURIComponent(s); } catch {}
    }
  } else if (/%[0-9a-fA-F]{2}/.test(s)) {
    try { s = decodeURIComponent(s); } catch {}
  }
  if (/^\/[a-zA-Z]:([\\/]|$)/.test(s)) {
    s = s.slice(1);
  }
  if (/^[a-zA-Z]:[/\\]*$/.test(s)) {
    return s.slice(0, 2) + '\\';
  }
  return s.replace(/[/\\]+$/, '');
}

function getRealPath(p) {
  try {
    if (typeof realpathSync.native === 'function') {
      return realpathSync.native(p);
    }
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function isPathInside(parentDir, targetPath) {
  if (!parentDir || !targetPath) return false;
  try {
    const parentResolved = resolve(parentDir);
    const targetResolved = resolve(targetPath);

    if (existsSync(parentResolved) && existsSync(targetResolved)) {
      const parentReal = getRealPath(parentResolved);
      const targetReal = getRealPath(targetResolved);
      const relReal = relative(parentReal, targetReal);
      return relReal === '' || (relReal !== '..' && !relReal.startsWith('../') && !relReal.startsWith('..\\') && !isAbsolute(relReal));
    }

    const rel = relative(parentResolved, targetResolved);
    return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel));
  } catch {
    return false;
  }
}

function getActiveWorkspacePaths() {
  const ws = new Set();
  for (const pw of discoverActiveProjectWorkspaces()) {
    if (pw) ws.add(resolve(pw));
  }
  for (const sw of activeStandaloneWorkspaces) {
    if (sw && existsSync(sw)) ws.add(resolve(sw));
  }
  for (const kr of knownDiscoveredRepos) {
    if (kr && existsSync(kr)) ws.add(resolve(kr));
  }
  try {
    const state = loadState();
    if (state.active_workspace && existsSync(state.active_workspace)) {
      ws.add(resolve(state.active_workspace));
    }
    if (state.repos && typeof state.repos === 'object') {
      for (const r of Object.keys(state.repos)) {
        if (existsSync(r)) ws.add(resolve(r));
      }
    }
  } catch {}
  return Array.from(ws);
}

function extractJson(text) {
  const str = String(text || '').trim();
  try {
    return JSON.parse(str);
  } catch {}
  const firstBrace = str.indexOf('{');
  const lastBrace = str.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(str.slice(firstBrace, lastBrace + 1));
    } catch {}
  }
  const firstBracket = str.indexOf('[');
  const lastBracket = str.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      return JSON.parse(str.slice(firstBracket, lastBracket + 1));
    } catch {}
  }
  return null;
}

const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SKIP_SCAN_DIRS = new Set([
  '.git',
  'node_modules',
  '.antigravity',
  '.venv',
  'venv',
  'dist',
  'build',
  '__pycache__',
  '.next',
  '.nuxt',
  'target',
  'coverage',
  '.turbo',
  '.cache',
  'tmp',
  'temp',
  'vendor',
  'Pods',
  'DerivedData',
  '.output',
  '.svelte-kit',
]);
const SKIP_TAGS = ['[auto-review]', '[watchdog]', '[skip-watchdog]'];

const readLocal = (name) => readFileSync(join(HERE, name), 'utf8');

let activeStandaloneWorkspaces = process.env.WATCHDOG_REPO ? [resolve(process.env.WATCHDOG_REPO)] : [];
const knownDiscoveredRepos = new Set();
let cachedIndexHtml = { mtimeKey: '', html: '' };

const STANDALONE_PRELOAD_JS = `// Watchdog Host Bridge (Antigravity Webview / Standalone Browser)
if (!window.sidecar) {
  let _listeners = [];
  let _lastUrisKey = '';
  async function _fetchWorkspaces() {
    try {
      const r = await window.fetch('/api/active-workspace', { method: 'GET' });
      const d = await r.json();
      return Array.isArray(d.workspaceUris) ? d.workspaceUris : [];
    } catch {
      return [];
    }
  }
  window.sidecar = {
    isStandalone: true,
    getWorkspaceUris: async () => {
      const uris = await _fetchWorkspaces();
      _lastUrisKey = uris.join('|');
      return uris;
    },
    onWorkspaceChange: (cb) => {
      if (typeof cb === 'function') _listeners.push(cb);
    }
  };
  setInterval(async () => {
    if (document.hidden || _listeners.length === 0) return;
    const uris = await _fetchWorkspaces();
    const key = uris.join('|');
    if (key && key !== _lastUrisKey) {
      _lastUrisKey = key;
      for (const fn of _listeners) {
        try { fn(uris); } catch {}
      }
    }
  }, 4000);
}
`;

function renderIndexHtml() {
  const assetFiles = ['index.html', 'styles.css', 'app.js'];
  const mtimeKey = assetFiles
    .map((f) => {
      try {
        return String(statSync(join(HERE, f)).mtimeMs);
      } catch {
        return '0';
      }
    })
    .join(':');
  if (cachedIndexHtml.html && cachedIndexHtml.mtimeKey === mtimeKey) {
    return cachedIndexHtml.html;
  }

  let html = readLocal('index.html');
  html = html.replace(
    /<script(?:\s+type="module")?\s+src="\/preload\.js[^"]*"><\/script>/,
    () => `<script>\n${STANDALONE_PRELOAD_JS}\n</script>`
  );
  try {
    const css = readLocal('styles.css');
    html = html.replace(
      /<link\s+rel="stylesheet"\s+href="\/styles\.css[^"]*">/,
      () => `<style>\n${css}\n</style>`
    );
  } catch {}
  try {
    const js = readLocal('app.js');
    html = html.replace(
      /<script(?:\s+type="module")?\s+src="\/app\.js[^"]*"><\/script>/,
      () => `<script>\n${js}\n</script>`
    );
  } catch {}

  cachedIndexHtml = { mtimeKey, html };
  return html;
}

app.page('/', () => renderIndexHtml());
app.page('/app.js', () => readLocal('app.js'));
app.page('/view-model.js', () => readLocal('view-model.js'));
app.api('/preload.js', () => new Response(STANDALONE_PRELOAD_JS, { contentType: 'application/javascript' }), 'GET');
app.page('/preload.js', () => new Response(STANDALONE_PRELOAD_JS, { contentType: 'application/javascript' }));
app.api('/styles.css', () => new Response(readLocal('styles.css'), { contentType: 'text/css' }), 'GET');
app.api('/api/health', () => ({ ok: true, standalone: isStandaloneMode, host: 'antigravity', pid: process.pid }), 'GET');
const isGitRepoDir = (dirPath) => {
  if (!dirPath || dirPath === '/' || /^[a-zA-Z]:[/\\]*$/.test(dirPath)) return false;
  let cur = dirPath;
  while (cur && cur !== '/' && !/^[a-zA-Z]:[/\\]*$/.test(cur)) {
    if (existsSync(join(cur, '.git'))) return true;
    const parent = dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  return false;
};

const handleActiveWorkspace = (data, method = 'GET') => {
  if (method === 'POST' && data?.repoPath) {
    const resolved = resolve(normalizeFsPath(String(data.repoPath)));
    if (resolved && existsSync(resolved) && isGitRepoDir(resolved)) {
      activeStandaloneWorkspaces = [resolved, ...activeStandaloneWorkspaces.filter((p) => p !== resolved)].slice(0, 5);
      knownDiscoveredRepos.add(resolved);
      saveStatePatch({ active_workspace: resolved });
    }
  }
  const state = loadState();
  const uris = [];
  for (const pw of discoverActiveProjectWorkspaces()) {
    if (!uris.includes(pw)) uris.push(pw);
  }
  for (const sw of activeStandaloneWorkspaces) {
    if (!uris.includes(sw) && existsSync(sw)) uris.push(sw);
  }
  if (state.active_workspace && !uris.includes(state.active_workspace) && existsSync(state.active_workspace)) {
    uris.push(state.active_workspace);
  }
  return { ok: true, workspaceUris: uris };
};
app.api('/api/active-workspace', (data) => handleActiveWorkspace(data, 'GET'), 'GET');
app.api('/api/active-workspace', (data) => handleActiveWorkspace(data, 'POST'), 'POST');

let resolvedPythonBin = null;
let resolvedGitBin = null;

function getGitBin() {
  if (resolvedGitBin) return resolvedGitBin;
  const candidates = [
    process.env.GIT_BIN,
    '/opt/homebrew/bin/git',
    '/usr/local/bin/git',
    '/usr/bin/git',
    'git',
  ].filter(Boolean);
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' });
      resolvedGitBin = bin;
      return bin;
    } catch {}
  }
  return 'git';
}

async function runPythonCtl(args, hostOverride = '') {
  const candidates = resolvedPythonBin
    ? [resolvedPythonBin]
    : [process.env.PYTHON_BIN, '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3', 'python3', 'python'].filter(Boolean);
  const effectiveHost = String(hostOverride || process.env.WATCHDOG_HOST || 'antigravity').trim();
  const fullArgs = [WATCHDOG_CTL_SCRIPT, ...args];
  if (!fullArgs.includes('--json')) {
    fullArgs.push('--json');
  }
  if (effectiveHost && !fullArgs.includes('--host')) {
    fullArgs.push('--host', effectiveHost);
  }
  const childEnv = {
    ...process.env,
    PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
    WATCHDOG_HOST: effectiveHost,
  };
  let lastErr = null;
  for (const bin of candidates) {
    try {
      const { stdout } = await execFileAsync(bin, fullArgs, {
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 20 * 1024 * 1024,
        env: childEnv,
      });
      resolvedPythonBin = bin;
      const parsed = extractJson(stdout);
      return parsed !== null ? parsed : {};
    } catch (err) {
      if (err.code === 'ENOENT') {
        lastErr = err;
        continue;
      }
      if (err.stdout) {
        const parsed = extractJson(String(err.stdout));
        if (parsed !== null) return parsed;
      }
      throw new Error(err.stderr ? String(err.stderr).trim() : err.message);
    }
  }
  throw lastErr || new Error('Python not found');
}

async function runGit(repoPath, args) {
  try {
    const gitBin = getGitBin();
    const { stdout } = await execFileAsync(gitBin, ['-C', repoPath, ...args], {
      encoding: 'utf8',
      timeout: 12000,
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
      },
    });
    return (stdout || '').trim();
  } catch {
    return '';
  }
}

function loadState() {
  mkdirSync(WATCHDOG_DIR, { recursive: true });
  if (!existsSync(STATE_FILE)) {
    return {
      auto_dispatch: true,
      skip_docs_only: true,
      repos: {},
      jobs: [],
    };
  }
  let state = null;
  for (let r = 0; r < 5; r++) {
    try {
      const content = readFileSync(STATE_FILE, 'utf8').trim();
      if (content) {
        state = JSON.parse(content);
        break;
      }
    } catch {}
    syncSleep(15);
  }
  if (!state || typeof state !== 'object') {
    state = {
      auto_dispatch: true,
      skip_docs_only: true,
      repos: {},
      jobs: [],
    };
  }
  return state;
}

// All job / execution / synthesis state transitions live in watchdog_ctl.py. The panel only
// asks it to reconcile (throttled, one run at a time) and then reads the files it wrote.
const RECONCILE_MIN_INTERVAL_MS = 4000;
let reconcileInFlight = null;
let lastReconcileAt = 0;
async function reconcileViaPython(repoPaths = [], { force = false } = {}) {
  if (reconcileInFlight) return reconcileInFlight;
  if (!force && Date.now() - lastReconcileAt < RECONCILE_MIN_INTERVAL_MS) return null;
  reconcileInFlight = (async () => {
    try {
      const jobs = [runPythonCtl(['reconcile-jobs'])];
      for (const repo of repoPaths) {
        jobs.push(runPythonCtl(['reconcile-executions', '--repo', repo]));
        jobs.push(runPythonCtl(['check-synthesis', '--repo', repo]));
      }
      await Promise.allSettled(jobs);
    } finally {
      lastReconcileAt = Date.now();
      reconcileInFlight = null;
    }
  })();
  return reconcileInFlight;
}

function atomicWriteJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
  try {
    writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmpFile, filePath);
  } catch (err) {
    try {
      if (existsSync(tmpFile)) rmSync(tmpFile, { force: true });
    } catch {}
    throw err;
  }
}

function saveStatePatch(patchOrUpdater) {
  mkdirSync(WATCHDOG_DIR, { recursive: true });
  const lockDir = `${STATE_FILE}.lock`;
  let acquired = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      mkdirSync(lockDir);
      acquired = true;
      try {
        writeFileSync(join(lockDir, 'pid'), String(process.pid), 'utf8');
      } catch {}
      break;
    } catch {
      try {
        const stats = statSync(lockDir);
        if (Date.now() - stats.mtimeMs > 1500) {
          const pidFile = join(lockDir, 'pid');
          let isAlive = false;
          try {
            if (existsSync(pidFile)) {
              const pidStr = readFileSync(pidFile, 'utf8').trim();
              const pid = parseInt(pidStr, 10);
              if (Number.isInteger(pid) && pid > 0) {
                try {
                  process.kill(pid, 0);
                  isAlive = true;
                } catch (err) {
                  isAlive = err?.code === 'EPERM';
                }
              }
            }
          } catch {}
          if (!isAlive) {
            const staleLockDir = `${lockDir}.stale.${process.pid}.${Date.now()}`;
            try {
              renameSync(lockDir, staleLockDir);
              rmSync(staleLockDir, { recursive: true, force: true });
            } catch {}
            continue;
          }
        }
      } catch {}
      syncSleep(25);
    }
  }

  if (!acquired) {
    throw new Error(`Timed out waiting for state lock: ${lockDir}`);
  }

  try {
    let current = {};
    for (let r = 0; r < 5; r++) {
      try {
        current = loadState();
        if (current && typeof current === 'object' && Object.keys(current).length > 0) break;
      } catch {}
      syncSleep(20);
    }
    const next = typeof patchOrUpdater === 'function'
      ? patchOrUpdater(current)
      : { ...current, ...patchOrUpdater };
    const tmpFile = `${STATE_FILE}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
    try {
      writeFileSync(tmpFile, JSON.stringify(next, null, 2), 'utf8');
      renameSync(tmpFile, STATE_FILE);
    } catch (writeErr) {
      try {
        if (existsSync(tmpFile)) rmSync(tmpFile, { force: true });
      } catch {}
      throw writeErr;
    }
    return next;
  } catch (err) {
    console.error('Failed to save state patch:', err);
    return typeof patchOrUpdater === 'function' ? {} : patchOrUpdater;
  } finally {
    if (acquired) {
      try { rmSync(lockDir, { recursive: true, force: true }); } catch {}
    }
  }
}

async function getRepoRecentCommits(repoPath, limit = 12) {
  const fmt = '%H\x1f%h\x1f%ct\x1f%cr\x1f%an\x1f%T\x1f%s';
  const raw = await runGit(repoPath, [
    'log',
    '--exclude=fix/watchdog-*',
    '--branches',
    '--tags',
    'HEAD',
    '--date-order',
    `-n${limit * 2}`,
    `--format=${fmt}`,
  ]);
  if (!raw) return [];

  const commits = [];
  const seen = new Set();
  for (const line of raw.split('\n')) {
    const parts = line.trim().split('\x1f');
    if (parts.length < 7) continue;
    const [sha, shortSha, tsStr, relativeTime, author, treeHash, subject] = parts;
    if (!sha || seen.has(sha)) continue;
    seen.add(sha);
    const timestamp = parseInt(tsStr, 10) || 0;
    const isEmptyTree = treeHash === EMPTY_TREE_HASH;
    const isAutoReview = SKIP_TAGS.some((tag) => subject.includes(tag));
    commits.push({
      sha,
      shortSha,
      timestamp,
      committedAt: timestamp ? new Date(timestamp * 1000).toISOString() : '',
      relativeTime,
      author,
      treeHash,
      isEmptyTree,
      subject,
      isAutoReview,
      isDocsOnly: false,
    });
  }

  commits.sort((a, b) => {
    const neA = a.isEmptyTree ? 0 : 1;
    const neB = b.isEmptyTree ? 0 : 1;
    if (neA !== neB) return neB - neA;
    return b.timestamp - a.timestamp;
  });

  return commits.slice(0, limit);
}

const gitRootsCache = new Map();
const GIT_ROOTS_CACHE_TTL_MS = 15000;

function clearGitRootsCache() {
  gitRootsCache.clear();
}

async function discoverCandidateGitRoots(uriOrPath) {
  if (!uriOrPath) return [];
  const fsPath = normalizeFsPath(uriOrPath);
  if (!fsPath || !existsSync(fsPath)) return [];

  let dir = fsPath;
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) {
      dir = dirname(dir);
    }
  } catch {
    return [];
  }

  const resolvedDir = resolve(dir);
  const cached = gitRootsCache.get(resolvedDir);
  if (cached && Date.now() - cached.ts < GIT_ROOTS_CACHE_TTL_MS) {
    return [...cached.roots];
  }

  const candidates = [];
  const seen = new Set();

  const directRoot = await runGit(dir, ['rev-parse', '--show-toplevel']);
  if (directRoot) {
    const resolved = resolve(directRoot);
    if (!resolved.includes('watchdog/worktrees') && !resolved.includes('.antigravity/worktrees')) {
      candidates.push(resolved);
      seen.add(resolved);
      if (resolved === resolvedDir) {
        const headTree = await runGit(resolved, ['rev-parse', '--verify', 'HEAD^{tree}']);
        if (headTree && headTree !== EMPTY_TREE_HASH) {
          if (gitRootsCache.size > 100) gitRootsCache.clear();
          gitRootsCache.set(resolvedDir, { ts: Date.now(), roots: candidates });
          return [...candidates];
        }
      }
    }
  }

  const scanDir = (dirPath, depth) => {
    if (depth > 3) return;
    try {
      for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_SCAN_DIRS.has(entry.name)) {
          continue;
        }
        const childPath = join(dirPath, entry.name);
        if (existsSync(join(childPath, '.git'))) {
          const resolved = resolve(childPath);
          if (!seen.has(resolved) && !resolved.includes('watchdog/worktrees') && !resolved.includes('.antigravity/worktrees')) {
            seen.add(resolved);
            candidates.push(resolved);
          }
        } else {
          scanDir(childPath, depth + 1);
        }
      }
    } catch {
      // ignore
    }
  };

  scanDir(resolvedDir, 1);
  if (gitRootsCache.size > 100) gitRootsCache.clear();
  gitRootsCache.set(resolvedDir, { ts: Date.now(), roots: candidates });
  return [...candidates];
}

const DOC_EXTS = new Set([
  '.md', '.markdown', '.mdown', '.mkdn', '.txt', '.rst', '.adoc', '.asciidoc',
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp'
]);
const DOC_FILENAMES = new Set([
  'readme', 'license', 'licence', 'copying', 'changelog', 'changes', 'history',
  'contributing', 'code_of_conduct', 'security', 'authors', 'contributors',
  '.gitignore', '.gitattributes', '.gitmodules', '.editorconfig',
  '.prettierignore', '.eslintignore', '.npmignore', '.dockerignore', '.mailmap'
]);

async function isDocsOnlyCommit(repoPath, sha, subject = '') {
  const s = (subject || '').trim().toLowerCase();
  const isDocsConventionalCommit = /^docs?(\([^)]+\))?:/i.test(s);

  const out = await runGit(repoPath, ['show', '--pretty=', '--name-only', sha]);
  if (!out) return false;
  const files = out.split('\n').map((str) => str.trim()).filter(Boolean);
  if (files.length === 0) return true;

  for (const f of files) {
    if (f.startsWith('.antigravity/')) continue;
    const baseName = f.split('/').pop().toLowerCase();
    const nameWithoutExt = baseName.replace(/\.[^.]+$/, '');
    const ext = baseName.includes('.') ? '.' + baseName.split('.').pop() : '';

    if (DOC_FILENAMES.has(baseName) || DOC_FILENAMES.has(nameWithoutExt)) continue;
    if (ext && DOC_EXTS.has(ext)) continue;

    if (baseName === 'package.json' && isDocsConventionalCommit) {
      const pkgDiff = await runGit(repoPath, ['diff', '-U0', `${sha}~1..${sha}`, '--', f]);
      if (pkgDiff) {
        const addedRemoved = pkgDiff
          .split('\n')
          .filter((l) => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'))
          .join('\n');
        const touchesCode = /"(dependencies|devDependencies|peerDependencies|scripts|main|module|exports)"/i.test(addedRemoved);
        if (!touchesCode) continue;
      }
    }

    return false;
  }
  return true;
}

async function inspectSingleRepo(topLevel) {
  try {
    const isGit = (await runGit(topLevel, ['rev-parse', '--is-inside-work-tree'])) === 'true';
    if (!isGit) return null;

    const recentCommits = await getRepoRecentCommits(topLevel, 12);
    const branch = (await runGit(topLevel, ['rev-parse', '--abbrev-ref', 'HEAD'])) || 'HEAD';
    const fixBranchesRaw = await runGit(topLevel, ['branch', '--list', 'fix/watchdog-*', '--format=%(refname:short)']);
    const fixBranches = fixBranchesRaw ? fixBranchesRaw.split('\n').map((s) => s.trim()).filter(Boolean) : [];

    const auditsDir = join(topLevel, '.antigravity', 'audits');
    const reports = [];
    if (existsSync(auditsDir)) {
      try {
        const files = readdirSync(auditsDir)
          .filter((f) => f.startsWith('review-') && f.endsWith('.md'))
          .map((f) => {
            const full = join(auditsDir, f);
            const st = statSync(full);
            return {
              name: f,
              shortSha: f.replace(/^review-/, '').replace(/\.md$/, ''),
              path: full,
              updatedAt: st.mtime.toISOString(),
              mtimeMs: st.mtimeMs,
            };
          })
          .sort((a, b) => b.mtimeMs - a.mtimeMs);
        reports.push(...files.slice(0, 15));
      } catch {
        // ignore
      }
    }

    const nextStepsDir = join(topLevel, '.antigravity', 'next_steps');
    const proposalsFile = join(nextStepsDir, 'proposals.json');
    let proposals = [];
    let goal = null;
    const goalFile = join(nextStepsDir, 'goal.json');
    if (existsSync(goalFile)) {
      try {
        goal = JSON.parse(readFileSync(goalFile, 'utf8'));
      } catch {
        // ignore
      }
    }
    if (existsSync(proposalsFile)) {
      try {
        const pData = JSON.parse(readFileSync(proposalsFile, 'utf8'));
        proposals = Array.isArray(pData.proposals) ? pData.proposals : [];
        if (!goal && pData.goal) goal = pData.goal;
      } catch {
        // ignore
      }
    }

    const execFile = join(nextStepsDir, 'execution_state.json');
    let executions = {};
    if (existsSync(execFile)) {
      try {
        const eData = JSON.parse(readFileSync(execFile, 'utf8'));
        executions = eData.executions || eData || {};
      } catch {
        // ignore
      }
    }

    for (const p of proposals) {
      if (p.id && executions[p.id]) {
        p.execution = executions[p.id];
      }
    }
    // State transitions (timeouts, completion) are owned by watchdog_ctl.py; read the result only.
    let synthesizing = false;
    let synthesisError = null;
    const synthStateFile = join(nextStepsDir, 'synthesis_state.json');
    if (existsSync(synthStateFile)) {
      try {
        const sData = JSON.parse(readFileSync(synthStateFile, 'utf8'));
        if (sData.error) synthesisError = sData.error;
        synthesizing = sData.status === 'synthesizing';
      } catch (err) {
        synthesisError = err.message || 'Synthesis state read error';
      }
    }

    if (recentCommits.length === 0) {
      return {
        repoPath: topLevel,
        repoName: topLevel.split(/[\\/]/).pop() || topLevel,
        branch,
        head: null,
        youngestCommit: null,
        recentCommits: [],
        fixBranches,
        reports,
        goal,
        proposals,
        executions,
        synthesizing,
        synthesis_status: synthesizing ? 'synthesizing' : 'idle',
        synthesis_error: synthesisError,
      };
    }

    const youngest = recentCommits[0];
    const isDocsOnly = await isDocsOnlyCommit(topLevel, youngest.sha, youngest.subject);
    youngest.isDocsOnly = isDocsOnly;

    return {
      repoPath: topLevel,
      repoName: topLevel.split(/[\\/]/).pop() || topLevel,
      branch,
      head: {
        sha: youngest.sha,
        shortSha: youngest.shortSha,
        subject: youngest.subject,
        relativeTime: youngest.relativeTime,
        committedAt: youngest.committedAt,
        timestamp: youngest.timestamp,
        author: youngest.author,
        isEmptyTree: youngest.isEmptyTree,
        isAutoReview: Boolean(youngest.isAutoReview),
        isDocsOnly: Boolean(isDocsOnly),
      },
      youngestCommit: youngest,
      recentCommits,
      fixBranches,
      reports,
      goal,
      proposals,
      executions,
      synthesizing,
      synthesis_status: synthesizing ? 'synthesizing' : 'idle',
      synthesis_error: synthesisError,
    };
  } catch (err) {
    console.error(`Error inspecting repo at ${topLevel}:`, err);
    return null;
  }
}

function discoverActiveProjectWorkspaces() {
  const ws = [];
  const geminiProjectsDir = join(homedir(), '.gemini', 'config', 'projects');
  if (process.env.ANTIGRAVITY_PROJECT_ID && existsSync(geminiProjectsDir)) {
    const projFile = join(geminiProjectsDir, `${process.env.ANTIGRAVITY_PROJECT_ID}.json`);
    if (existsSync(projFile)) {
      try {
        const pData = JSON.parse(readFileSync(projFile, 'utf8'));
        const resources = pData?.projectResources?.resources || [];
        for (const res of resources) {
          const rawUri = res?.folderUri || res?.gitFolder?.folderUri;
          if (rawUri) {
            const norm = normalizeFsPath(rawUri);
            if (norm && existsSync(norm) && !ws.includes(norm)) ws.push(norm);
          }
        }
      } catch {}
    }
  }
  if (existsSync(geminiProjectsDir)) {
    try {
      const files = readdirSync(geminiProjectsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const full = join(geminiProjectsDir, f);
          try {
            return { full, mtimeMs: statSync(full).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      for (const item of files.slice(0, 10)) {
        try {
          const pData = JSON.parse(readFileSync(item.full, 'utf8'));
          const resources = pData?.projectResources?.resources || [];
          for (const res of resources) {
            const rawUri = res?.folderUri || res?.gitFolder?.folderUri;
            if (rawUri) {
              const norm = normalizeFsPath(rawUri);
              if (norm && existsSync(norm) && !ws.includes(norm)) ws.push(norm);
            }
          }
        } catch {}
      }
    } catch {}
  }
  return ws;
}

async function collectActiveRepos(uris, state, targetRepo = '') {
  const roots = [];
  const seen = new Set();

  const effectiveUris = [];
  for (const u of (uris || [])) {
    const norm = normalizeFsPath(u);
    if (norm && !effectiveUris.includes(norm)) effectiveUris.push(norm);
  }

  if (effectiveUris.length === 0) {
    for (const pw of discoverActiveProjectWorkspaces()) {
      if (!effectiveUris.includes(pw)) effectiveUris.push(pw);
    }
  }

  for (const u of effectiveUris) {
    for (const root of await discoverCandidateGitRoots(u)) {
      if (!seen.has(root)) {
        seen.add(root);
        roots.push(root);
      }
    }
  }

  if (roots.length === 0 && state.repos) {
    for (const repoPath of Object.keys(state.repos)) {
      for (const root of await discoverCandidateGitRoots(repoPath)) {
        if (!seen.has(root)) {
          seen.add(root);
          roots.push(root);
        }
      }
    }
  }

  // Fallback 1: inspect repo_path recorded on previous jobs
  if (roots.length === 0 && Array.isArray(state.jobs)) {
    for (const j of state.jobs) {
      if (j.repo_path) {
        for (const root of await discoverCandidateGitRoots(j.repo_path)) {
          if (!seen.has(root)) {
            seen.add(root);
            roots.push(root);
          }
        }
      }
    }
  }

  // Fallback 2: inspect process environment and current working directory
  if (roots.length === 0) {
    const envCandidates = [
      process.env.WORKSPACE_ROOT,
      process.env.PROJECT_DIR,
      process.env.PWD,
      process.cwd(),
    ].filter(Boolean);
    for (const ec of envCandidates) {
      for (const root of await discoverCandidateGitRoots(ec)) {
        if (!seen.has(root)) {
          seen.add(root);
          roots.push(root);
        }
      }
    }
  }

  for (const r of roots) {
    if (r && existsSync(r)) knownDiscoveredRepos.add(resolve(r));
  }

  const inspected = await Promise.all(roots.map((r) => inspectSingleRepo(r)));
  let repos = inspected.filter(Boolean);

  // Drop empty-tree outer wrapper repos if any non-empty repo exists
  const hasNonEmpty = repos.some((r) => r.head && !r.head.isEmptyTree);
  if (hasNonEmpty) {
    repos = repos.filter((r) => !r.head?.isEmptyTree);
  }

  const normUris = effectiveUris.map(normalizeFsPath).filter(Boolean);
  const normTarget = targetRepo ? normalizeFsPath(targetRepo) : '';
  const pathsOverlapFs = (a, b) => {
    const na = String(a || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const nb = String(b || '').replace(/\\/g, '/').replace(/\/+$/, '');
    return Boolean(na && nb && (na === nb || na.startsWith(`${nb}/`) || nb.startsWith(`${na}/`)));
  };

  // Sort: explicit target repo first, workspace repos first, non-empty tree first, youngest commit timestamp DESC
  repos.sort((a, b) => {
    if (normTarget) {
      const matchA = pathsOverlapFs(normTarget, a.repoPath) ? 1 : 0;
      const matchB = pathsOverlapFs(normTarget, b.repoPath) ? 1 : 0;
      if (matchA !== matchB) return matchB - matchA;
    }

    const inWsA = normUris.length > 0 && normUris.some((u) => pathsOverlapFs(u, a.repoPath)) ? 1 : 0;
    const inWsB = normUris.length > 0 && normUris.some((u) => pathsOverlapFs(u, b.repoPath)) ? 1 : 0;
    if (inWsA !== inWsB) return inWsB - inWsA;

    const neA = a.head?.isEmptyTree ? 0 : 1;
    const neB = b.head?.isEmptyTree ? 0 : 1;
    if (neA !== neB) return neB - neA;
    return (b.head?.timestamp || 0) - (a.head?.timestamp || 0);
  });

  return repos;
}

// POST /api/dashboard { workspaceUris?, repoPath?, repo? }
const handleDashboard = async (data) => {
  try {
    const uris = [];
    const targetRepo = data?.repoPath || data?.repo;
    if (targetRepo) {
      const norm = normalizeFsPath(targetRepo);
      if (norm) uris.push(norm);
    }
    let rawUris = data?.workspaceUris;
    if (typeof rawUris === 'string') {
      try {
        rawUris = JSON.parse(rawUris);
      } catch {
        rawUris = rawUris.split(/[,|]/).map((s) => s.trim()).filter(Boolean);
      }
    }
    if (Array.isArray(rawUris)) {
      for (const u of rawUris) {
        const norm = normalizeFsPath(u);
        if (norm && !uris.includes(norm)) uris.push(norm);
      }
    }
    await reconcileViaPython([...new Set([...knownDiscoveredRepos, ...uris])]);
    const state = loadState();
    const activeRepos = await collectActiveRepos(uris, state, targetRepo);

    return {
      ok: true,
      auto_dispatch: state.auto_dispatch !== false,
      skip_docs_only: state.skip_docs_only !== false,
      activeRepos,
      jobs: Array.isArray(state.jobs) ? state.jobs : [],
    };
  } catch (err) {
    console.error('Error in /api/dashboard:', err);
    return {
      ok: false,
      auto_dispatch: true,
      skip_docs_only: true,
      activeRepos: [],
      jobs: [],
      error: String(err?.message || err),
    };
  }
};
app.api('/api/dashboard', handleDashboard);
app.api('/api/dashboard', handleDashboard, 'GET');

// POST /api/sync & /api/git-state & /api/git_state { repoPath?, workspaceUris?, repo? }
const handleGitState = async (data) => {
  try {
    clearGitRootsCache();
    const uris = [];
    const targetRepo = data?.repoPath || data?.repo;
    if (targetRepo) {
      const norm = normalizeFsPath(targetRepo);
      if (norm) uris.push(norm);
    }
    let rawUris = data?.workspaceUris;
    if (typeof rawUris === 'string') {
      try {
        rawUris = JSON.parse(rawUris);
      } catch {
        rawUris = rawUris.split(/[,|]/).map((s) => s.trim()).filter(Boolean);
      }
    }
    if (Array.isArray(rawUris)) {
      for (const u of rawUris) {
        const norm = normalizeFsPath(u);
        if (norm && !uris.includes(norm)) uris.push(norm);
      }
    }

    const ctlArgs = ['sync'];
    for (const u of uris) {
      ctlArgs.push('--repo', u);
    }
    let syncRes = {};
    try {
      syncRes = await runPythonCtl(ctlArgs);
    } catch (pythonErr) {
      console.warn('Python ctl sync warning:', pythonErr.message);
    }
    const state = loadState();
    const activeRepos = await collectActiveRepos(uris, state, targetRepo);

    return {
      ok: true,
      syncedAt: syncRes.syncedAt || new Date().toISOString(),
      bestRepo: activeRepos[0] || syncRes.bestRepo || null,
      youngestCommit: activeRepos[0]?.youngestCommit || syncRes.youngestCommit || null,
      recentCommits: activeRepos[0]?.recentCommits || syncRes.recentCommits || [],
      activeRepos,
      prunedWrapperRepos: syncRes.prunedWrapperRepos || [],
      jobs: Array.isArray(state.jobs) ? state.jobs : [],
    };
  } catch (err) {
    console.error('Error in /api/sync or /api/git-state:', err);
    let state = { auto_dispatch: true, skip_docs_only: true, jobs: [] };
    try {
      state = loadState();
    } catch {}
    return {
      ok: false,
      error: String(err?.message || err),
      syncedAt: new Date().toISOString(),
      activeRepos: [],
      jobs: Array.isArray(state.jobs) ? state.jobs : [],
    };
  }
};

app.api('/api/sync', handleGitState);
app.api('/api/sync', handleGitState, 'GET');
app.api('/api/git-state', handleGitState);
app.api('/api/git-state', handleGitState, 'GET');
app.api('/api/git_state', handleGitState);
app.api('/api/git_state', handleGitState, 'GET');

// POST /api/settings { auto_dispatch?, skip_docs_only? }
app.api('/api/settings', (data) => {
  const patch = {};
  if (typeof data.auto_dispatch === 'boolean') patch.auto_dispatch = data.auto_dispatch;
  if (typeof data.skip_docs_only === 'boolean') patch.skip_docs_only = data.skip_docs_only;
  const updated = saveStatePatch(patch);
  return {
    ok: true,
    auto_dispatch: updated.auto_dispatch !== false,
    skip_docs_only: updated.skip_docs_only !== false,
  };
});

// POST /api/trigger { repoPath, sha, comment?, host? }
app.api('/api/trigger', async (data) => {
  const repoPath = String(data?.repoPath || '').trim();
  const sha = String(data?.sha || 'YOUNGEST').trim();
  const comment = String(data?.comment || '').trim();
  const host = String(data?.host || '').trim();
  if (!repoPath) {
    return new Response(JSON.stringify({ error: 'Missing repoPath' }), {
      status: 400,
      contentType: 'application/json',
    });
  }

  // Prevent double auditing if an audit is already running for this repo
  await reconcileViaPython([], { force: true });
  const samePath = (a, b) => Boolean(a && b && (a === b || resolve(String(a)) === resolve(String(b))));
  const state = loadState();
  const running = (state.jobs || []).find(
    (j) => Boolean(j.repo_path && samePath(j.repo_path, repoPath)) && (j.status === 'running' || j.status === 'queued')
  );

  if (running) {
    if (comment) {
      await runPythonCtl(['send-comment', '--repo', repoPath, '--comment', comment, '--job-id', running.id || ''], host);
      return {
        ok: true,
        alreadyRunning: true,
        commentSent: true,
        job: running,
        shortSha: running.short_sha || '',
        message: `An audit for commit ${running.short_sha || 'current'} is already running. Comment forwarded to auditor.`,
      };
    }
    return {
      ok: false,
      alreadyRunning: true,
      job: running,
      error: `An audit for commit ${running.short_sha || 'current'} is already running. Double auditing prevented.`,
    };
  }

  const ctlArgs = ['queue', '--repo', repoPath, '--sha', sha, '--no-dispatch', '--force'];
  if (comment) {
    ctlArgs.push('--comment', comment);
  }
  const result = await runPythonCtl(ctlArgs, host);
  return result;
});

// POST /api/mark-running { jobId, conversationId? }
app.api('/api/mark-running', (data) => {
  const jobId = String(data?.jobId || '');
  const convId = data?.conversationId ? String(data.conversationId) : null;
  saveStatePatch((state) => {
    const jobs = Array.isArray(state.jobs) ? state.jobs.map((j) => ({ ...j })) : [];
    for (const j of jobs) {
      if (j.id === jobId) {
        j.status = 'running';
        j.started_at = new Date().toISOString();
        j.summary = 'Autonomous Watchdog review in progress…';
        if (convId) j.conversation_id = convId;
        break;
      }
    }
    const next = { ...state, jobs };
    if (convId) {
      const activeWatchdog = Array.isArray(state.active_watchdog_conversations) ? state.active_watchdog_conversations : [];
      if (!activeWatchdog.includes(convId)) {
        next.active_watchdog_conversations = [...activeWatchdog, convId];
      }
    }
    return next;
  });
  return { ok: true };
});

// POST /api/dispatch { jobId?, host? }
app.api('/api/dispatch', async (data) => {
  const jobId = data?.jobId ? String(data.jobId).trim() : '';
  const host = String(data?.host || '').trim();
  const args = ['dispatch'];
  if (jobId) args.push('--job-id', jobId);
  return await runPythonCtl(args, host);
});

// POST /api/continue-audit { jobId?, repoPath?, sha?, host? }
app.api('/api/continue-audit', async (data) => {
  const jobId = String(data?.jobId || '').trim();
  const repoPath = String(data?.repoPath || '').trim();
  const sha = String(data?.sha || '').trim();
  const host = String(data?.host || '').trim();

  const ctlArgs = ['continue-job'];
  if (jobId) ctlArgs.push('--job-id', jobId);
  if (repoPath) ctlArgs.push('--repo', repoPath);
  if (sha) ctlArgs.push('--sha', sha);

  return await runPythonCtl(ctlArgs, host);
});

// POST /api/send-comment { repoPath?, comment, jobId?, host? }
app.api('/api/send-comment', async (data) => {
  const repoPath = String(data?.repoPath || '').trim();
  const comment = String(data?.comment || '').trim();
  const jobId = String(data?.jobId || '').trim();
  const host = String(data?.host || '').trim();

  if (!comment) {
    return new Response(JSON.stringify({ error: 'Missing comment' }), {
      status: 400,
      contentType: 'application/json',
    });
  }

  const ctlArgs = ['send-comment', '--comment', comment];
  if (repoPath) ctlArgs.push('--repo', repoPath);
  if (jobId) ctlArgs.push('--job-id', jobId);

  return await runPythonCtl(ctlArgs, host);
});

function isAllowedArtifactPath(filePath) {
  if (!filePath) return false;
  const resolved = resolve(String(filePath).trim());
  if (!resolved.endsWith('.md') && !resolved.endsWith('.json')) {
    return false;
  }
  const baseName = resolved.split(/[\\/]/).pop()?.toLowerCase() || '';
  if (
    baseName === 'ls_env.json' ||
    baseName === 'state.json' ||
    baseName.startsWith('state.json.') ||
    baseName === 'state.lock'
  ) {
    return false;
  }
  if (isPathInside(WATCHDOG_DIR, resolved)) {
    return true;
  }
  const activeRoots = getActiveWorkspacePaths();
  for (const root of activeRoots) {
    const antigravityDir = join(root, '.antigravity');
    if (isPathInside(antigravityDir, resolved)) {
      return true;
    }
  }
  return false;
}

// POST /api/report { reportPath }
app.api('/api/report', (data) => {
  const reportPath = String(data?.reportPath || '').trim();
  if (!reportPath || !isAllowedArtifactPath(reportPath) || !existsSync(reportPath)) {
    return { exists: false, content: '' };
  }
  try {
    const resolved = resolve(reportPath);
    return {
      exists: true,
      reportPath: resolved,
      content: readFileSync(resolved, 'utf8'),
    };
  } catch (err) {
    return { exists: false, error: err.message, content: '' };
  }
});

// POST /api/apply-fix { repoPath, sha, mode }
app.api('/api/apply-fix', async (data) => {
  const repoPath = String(data?.repoPath || '').trim();
  const sha = String(data?.sha || '').trim();
  const mode = data?.mode === 'merge' ? 'merge' : 'cherry-pick';
  if (!repoPath || !sha) {
    return new Response(JSON.stringify({ error: 'Missing repoPath or sha' }), {
      status: 400,
      contentType: 'application/json',
    });
  }
  return await runPythonCtl(['apply-fix', '--repo', repoPath, '--sha', sha, '--mode', mode]);
});

// POST /api/archive-job { jobId, archived }
app.api('/api/archive-job', (data) => {
  const jobId = String(data?.jobId || '').trim();
  const archived = data?.archived !== false;
  if (!jobId) {
    return new Response(JSON.stringify({ error: 'Missing jobId' }), {
      status: 400,
      contentType: 'application/json',
    });
  }
  saveStatePatch((state) => {
    const jobs = Array.isArray(state.jobs) ? state.jobs.map((j) => (j.id === jobId ? { ...j, archived } : j)) : [];
    return { ...state, jobs };
  });
  return { ok: true, jobId, archived };
});

// POST /api/next-steps { repo }
app.api('/api/next-steps', async (data) => {
  const repo = String(data?.repo || '').trim();
  if (!repo) {
    return new Response(JSON.stringify({ error: 'Missing repo' }), {
      status: 400,
      contentType: 'application/json',
    });
  }
  return await runPythonCtl(['check-synthesis', '--repo', repo]);
});

// POST /api/next-steps/refresh { repo, host? }
app.api('/api/next-steps/refresh', async (data) => {
  const repo = String(data?.repo || '').trim();
  const host = String(data?.host || '').trim();
  if (!repo) {
    return new Response(JSON.stringify({ error: 'Missing repo' }), {
      status: 400,
      contentType: 'application/json',
    });
  }
  try {
    return await runPythonCtl(['dispatch-synthesis', '--repo', repo], host);
  } catch (err) {
    const nextStepsDir = join(repo, '.antigravity', 'next_steps');
    const synthStateFile = join(nextStepsDir, 'synthesis_state.json');
    try {
      if (existsSync(synthStateFile)) {
        const sData = JSON.parse(readFileSync(synthStateFile, 'utf8'));
        sData.status = 'idle';
        sData.error = err.message || 'Synthesis dispatch failed';
        atomicWriteJson(synthStateFile, sData);
      }
    } catch {}
    return { ok: false, error: err.message || 'Synthesis dispatch failed', status: 'idle' };
  }
});

// POST /api/next-steps/cancel { repo, host? }
app.api('/api/next-steps/cancel', async (data) => {
  const repo = String(data?.repo || '').trim();
  const host = String(data?.host || '').trim();
  if (!repo) {
    return new Response(JSON.stringify({ error: 'Missing repo' }), {
      status: 400,
      contentType: 'application/json',
    });
  }
  return await runPythonCtl(['cancel-synthesis', '--repo', repo], host);
});

// POST /api/next-steps/goal { repo, goal?, clear?, refresh? }
app.api('/api/next-steps/goal', async (data) => {
  const repo = String(data?.repo || '').trim();
  const host = String(data?.host || '').trim();
  if (!repo) {
    return new Response(JSON.stringify({ error: 'Missing repo' }), {
      status: 400,
      contentType: 'application/json',
    });
  }
  const args = ['goal', '--repo', repo];
  if (data?.refresh) {
    args.push('--refresh');
  } else if (data?.clear) {
    args.push('--clear');
  } else if (data?.goal) {
    args.push('--set', String(data.goal).trim());
  }
  try {
    return await runPythonCtl(args, host);
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Failed to update goal' }), {
      status: 500,
      contentType: 'application/json',
    });
  }
});

// POST /api/next-steps/conversations { repo }
app.api('/api/next-steps/conversations', async (data) => {
  const repo = String(data?.repo || '').trim();
  if (!repo) {
    return new Response(JSON.stringify({ error: 'Missing repo' }), {
      status: 400,
      contentType: 'application/json',
    });
  }
  return await runPythonCtl(['conversations', '--repo', repo, '--json']);
});

// POST /api/next-steps/transcript { conversationId, limit? }
app.api('/api/next-steps/transcript', async (data) => {
  const cid = String(data?.conversationId || '').trim();
  if (!cid) {
    return new Response(JSON.stringify({ error: 'Missing conversationId' }), {
      status: 400,
      contentType: 'application/json',
    });
  }
  const limit = parseInt(data?.limit, 10) || 5;
  return await runPythonCtl(['transcript', '--conversation-id', cid, '--limit', String(limit)]);
});

// POST /api/next-steps/plan { repo, planPath?, planFile? }
app.api('/api/next-steps/plan', (data) => {
  const repo = String(data?.repo || '').trim();
  const planPath = String(data?.planPath || '').trim();
  const planFile = String(data?.planFile || '').trim();
  let target = '';
  if (planPath && existsSync(planPath)) {
    target = resolve(planPath);
  } else if (repo && planFile && existsSync(join(repo, planFile))) {
    target = resolve(join(repo, planFile));
  }
  if (!target || !isAllowedArtifactPath(target) || !existsSync(target)) {
    return { ok: false, error: 'Plan file not found' };
  }
  try {
    return {
      ok: true,
      path: target,
      content: readFileSync(target, 'utf8'),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// POST /api/next-steps/execute { repo, planId, host?, noSpawn? }
app.api('/api/next-steps/execute', async (data) => {
  const repo = String(data?.repo || '').trim();
  const planId = String(data?.planId || '').trim();
  const host = String(data?.host || '').trim();
  if (!repo || !planId) {
    return new Response(JSON.stringify({ error: 'Missing repo or planId' }), {
      status: 400,
      contentType: 'application/json',
    });
  }
  const args = ['execute-plan', '--repo', repo, '--plan-id', planId];
  if (data?.noSpawn) {
    args.push('--no-spawn');
  }
  return await runPythonCtl(args, host);
});

// POST /api/next-steps/cancel-execution { repo, planId }
app.api('/api/next-steps/cancel-execution', async (data) => {
  const repo = String(data?.repo || '').trim();
  const planId = String(data?.planId || '').trim();
  if (!repo || !planId) {
    return new Response(JSON.stringify({ error: 'Missing repo or planId' }), {
      status: 400,
      contentType: 'application/json',
    });
  }
  return await runPythonCtl(['cancel-execution', '--repo', repo, '--plan-id', planId]);
});

// POST /api/next-steps/mark-running { repo, planId, conversationId }
app.api('/api/next-steps/mark-running', async (data) => {
  const repo = String(data?.repo || '').trim();
  const planId = String(data?.planId || '').trim();
  const convId = String(data?.conversationId || '').trim();
  if (!repo || !planId) {
    return new Response(JSON.stringify({ error: 'Missing repo or planId' }), {
      status: 400,
      contentType: 'application/json',
    });
  }
  const args = ['mark-execution-running', '--repo', repo, '--plan-id', planId];
  if (convId) args.push('--conversation-id', convId);
  return await runPythonCtl(args);
});

const DANGEROUS_OPEN_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.sh', '.app', '.ps1',
  '.bin', '.com', '.msi', '.vbs', '.vbe', '.wsf',
  '.wsh', '.scr', '.pif', '.cpl', '.command', '.tool',
  '.bash', '.zsh', '.csh', '.fish', '.desktop',
  '.jar', '.hta', '.reg', '.scpt', '.applescript',
  '.psm1', '.psd1', '.inf', '.ins', '.isp', '.msc',
  '.lnk', '.url', '.js', '.jse', '.mjs', '.cjs',
  '.py', '.pyw', '.chm', '.library-ms', '.scf'
]);

// POST /api/open-file { uri | path }
app.api('/api/open-file', (data) => {
  const uri = String(data?.uri || data?.path || '').trim();
  if (!uri) return { ok: false, error: 'No URI provided' };
  const isFileUri = /^file:\/\//i.test(uri);
  let filePath = uri.replace(/^file:\/\/(localhost)?/i, '');
  if (isFileUri) {
    filePath = filePath.replace(/#.*$/, '');
  }
  try {
    filePath = decodeURIComponent(filePath);
  } catch {}
  if (/^\/[a-zA-Z]:([\\/]|$)/.test(filePath)) {
    filePath = filePath.slice(1);
  }
  if (!isFileUri && !existsSync(resolve(filePath)) && /#L\d+(?:-L?\d+)?$/i.test(filePath)) {
    filePath = filePath.replace(/#L\d+(?:-L?\d+)?$/i, '');
  }
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    return { ok: false, error: `File not found: ${filePath}` };
  }

  const ext = extname(resolved).toLowerCase();
  const realExt = extname(getRealPath(resolved)).toLowerCase();
  if (DANGEROUS_OPEN_EXTENSIONS.has(ext) || DANGEROUS_OPEN_EXTENSIONS.has(realExt)) {
    return { ok: false, error: `Opening executable files (${ext || realExt}) is disallowed for security reasons.` };
  }

  const allowedRoots = [WATCHDOG_DIR, ...getActiveWorkspacePaths()];
  const isAllowed = allowedRoots.some((root) => isPathInside(root, resolved));
  if (!isAllowed) {
    return { ok: false, error: 'Access denied: path is outside active workspaces and watchdog directory' };
  }

  try {
    let child;
    if (process.platform === 'win32') {
      child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', resolved], { detached: true, stdio: 'ignore' });
    } else {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      child = spawn(opener, [resolved], { detached: true, stdio: 'ignore' });
    }
    child.on('error', () => {});
    child.unref();
    return { ok: true, path: resolved };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

app.run();
