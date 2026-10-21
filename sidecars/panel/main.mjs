import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..', '..');
const QA_CTL_SCRIPT = join(PLUGIN_ROOT, 'scripts', 'qa_ctl.py');
const WATCHDOG_DIR = join(homedir(), '.gemini', 'antigravity', 'qa_watchdog');
const STATE_FILE = join(WATCHDOG_DIR, 'state.json');

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
const SKIP_TAGS = ['[auto-review]', '[qa-watchdog]', '[skip-qa]'];

const app = new SidecarApp();

const readLocal = (name) => readFileSync(join(HERE, name), 'utf8');

app.page('/', () => readLocal('index.html'));
app.page('/app.js', () => readLocal('app.js'));
app.api('/preload.js', () => new Response('// preload stub\n', { contentType: 'application/javascript' }), 'GET');
app.api('/styles.css', () => new Response(readLocal('styles.css'), { contentType: 'text/css' }), 'GET');

let resolvedPythonBin = null;

function runPythonCtl(args) {
  const candidates = resolvedPythonBin
    ? [resolvedPythonBin]
    : ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3', 'python3'];
  let lastErr = null;
  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, [QA_CTL_SCRIPT, ...args], {
        encoding: 'utf8',
        timeout: 25000,
      });
      resolvedPythonBin = bin;
      return JSON.parse(out.trim() || '{}');
    } catch (err) {
      if (err.code === 'ENOENT') {
        lastErr = err;
        continue;
      }
      if (err.stdout) {
        try {
          return JSON.parse(String(err.stdout).trim());
        } catch {
          // fall through
        }
      }
      throw new Error(err.stderr ? String(err.stderr).trim() : err.message);
    }
  }
  throw lastErr || new Error('python3 not found');
}

function runGit(repoPath, args) {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      timeout: 8000,
    }).trim();
  } catch {
    return '';
  }
}

function loadState(skipReconcile = false) {
  mkdirSync(WATCHDOG_DIR, { recursive: true });
  if (!existsSync(STATE_FILE)) {
    return {
      auto_dispatch: true,
      skip_docs_only: true,
      repos: {},
      jobs: [],
    };
  }
  let state;
  try {
    state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    state = {
      auto_dispatch: true,
      skip_docs_only: true,
      repos: {},
      jobs: [],
    };
  }
  if (!skipReconcile) {
    state = reconcileJobs(state);
  }
  return state;
}

function reconcileJobs(state) {
  let modified = false;
  const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
  for (const j of jobs) {
    const isUnfinished = j.status === 'running' || j.status === 'interrupted' || j.status === 'queued';
    const isStaleCompleted = j.status === 'completed' && (!j.fixes_committed && (j.verdict === 'FIXED_ON_BRANCH' || (j.summary && j.summary.includes('in progress'))));
    if (isUnfinished || isStaleCompleted) {
      const repoPath = j.repo_path;
      const shortSha = j.short_sha || (j.sha ? j.sha.slice(0, 7) : '');
      if (!repoPath || !shortSha) continue;

      const auditsDir = join(repoPath, '.antigravity', 'audits');
      const jsonReport = join(auditsDir, `review-${shortSha}.json`);
      const mdReport = join(auditsDir, `review-${shortSha}.md`);

      // 1. JSON report exists -> mark completed
      if (existsSync(jsonReport)) {
        try {
          const rData = JSON.parse(readFileSync(jsonReport, 'utf8'));
          j.status = 'completed';
          j.verdict = rData.verdict || 'PASS';
          j.summary = rData.summary || j.summary || 'Audit completed.';
          j.bugs_count = typeof rData.bugs_count === 'number' ? rData.bugs_count : (j.bugs_count || 0);
          const hasFixes = Boolean(rData.fixes_committed || j.verdict === 'FIXED_ON_BRANCH');
          j.fixes_committed = hasFixes;
          j.fix_branch = rData.fix_branch || (hasFixes ? `fix/qa-${shortSha}` : null);
          j.completed_at = rData.completed_at || j.completed_at || new Date().toISOString();
          j.report_path = existsSync(mdReport) ? mdReport : jsonReport;
          modified = true;
          continue;
        } catch {}
      }

      // 2. Markdown report exists -> mark completed
      if (existsSync(mdReport)) {
        try {
          const content = readFileSync(mdReport, 'utf8');
          if (content.length > 80) {
            let verdict = 'PASS';
            const vMatch = content.match(/\*\*Verdict\*\*:\s*`?([A-Za-z0-9_]+)`?/i);
            if (vMatch && vMatch[1]) {
              verdict = vMatch[1].toUpperCase();
            }
            let summary = j.summary;
            if (!summary || summary.includes('in progress')) {
              const sMatch = content.match(/##\s*1\.\s*Executive Summary\s*\n+([^\n#]+)/i);
              if (sMatch && sMatch[1]) {
                summary = sMatch[1].trim();
              } else {
                summary = 'QA review completed.';
              }
            }
            const fixBranch = `fix/qa-${shortSha}`;
            const hasFixes = verdict === 'FIXED_ON_BRANCH' || content.includes(fixBranch);

            j.status = 'completed';
            j.verdict = verdict;
            j.summary = summary;
            j.fixes_committed = Boolean(hasFixes);
            j.fix_branch = hasFixes ? fixBranch : null;
            j.completed_at = j.completed_at || new Date().toISOString();
            j.report_path = mdReport;
            modified = true;
            continue;
          }
        } catch {}
      }

      // 3. Check for interruption if no report exists and status is 'running'
      if (j.status === 'running') {
        const convId = j.conversation_id;
        if (convId) {
          const tFile = join(homedir(), '.gemini', 'antigravity', 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
          if (existsSync(tFile)) {
            try {
              const stat = statSync(tFile);
              const age = (Date.now() - stat.mtimeMs) / 1000;
              if (age > 45) {
                let chunkText = '';
                if (stat.size > 65536) {
                  const fd = openSync(tFile, 'r');
                  const buffer = Buffer.alloc(65536);
                  readSync(fd, buffer, 0, 65536, stat.size - 65536);
                  closeSync(fd);
                  chunkText = buffer.toString('utf8');
                } else {
                  chunkText = readFileSync(tFile, 'utf8');
                }
                const chunk = chunkText.trim().split('\n');
                for (let i = chunk.length - 1; i >= 0; i--) {
                  const line = chunk[i].trim();
                  if (line.startsWith('{')) {
                    const parsed = JSON.parse(line);
                    if (parsed.status === 'ERROR' || parsed.status === 'CANCELLED' || parsed.status === 'CANCELED') {
                      j.status = 'interrupted';
                      j.summary = 'Audit subagent was interrupted or encountered an error.';
                      modified = true;
                      break;
                    }
                    if (parsed.type === 'PLANNER_RESPONSE' && (!parsed.tool_calls || parsed.tool_calls.length === 0)) {
                      j.status = 'interrupted';
                      j.summary = 'Audit subagent stopped before generating report.';
                      modified = true;
                      break;
                    }
                    if (age > 180) {
                      j.status = 'interrupted';
                      j.summary = 'Audit conversation timed out with no recent activity.';
                      modified = true;
                      break;
                    }
                    break;
                  }
                }
              }
            } catch {}
          }
        } else if (j.started_at) {
          const elapsed = (Date.now() - new Date(j.started_at).getTime()) / 1000;
          if (elapsed > 180) {
            j.status = 'interrupted';
            j.summary = 'Audit process stopped with no report produced.';
            modified = true;
          }
        }
      }
    }
  }

  if (modified) {
    saveStatePatch({ jobs: state.jobs });
  }
  return state;
}

function saveStatePatch(patch) {
  const current = loadState(true);
  const next = { ...current, ...patch };
  mkdirSync(WATCHDOG_DIR, { recursive: true });
  const tmpFile = `${STATE_FILE}.tmp.${process.pid}`;
  writeFileSync(tmpFile, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tmpFile, STATE_FILE);
  return next;
}

function getRepoRecentCommits(repoPath, limit = 12) {
  const fmt = '%H\x1f%h\x1f%ct\x1f%cr\x1f%an\x1f%T\x1f%s';
  const raw = runGit(repoPath, [
    'log',
    '--exclude=fix/qa-*',
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

function discoverCandidateGitRoots(uriOrPath) {
  if (!uriOrPath) return [];
  let fsPath = String(uriOrPath);
  if (fsPath.startsWith('file://')) {
    try {
      fsPath = fileURLToPath(fsPath);
    } catch {
      return [];
    }
  }
  if (!existsSync(fsPath)) return [];

  try {
    const st = statSync(fsPath);
    if (!st.isDirectory()) {
      fsPath = dirname(fsPath);
    }
  } catch {
    return [];
  }

  const candidates = [];
  const seen = new Set();

  const directRoot = runGit(fsPath, ['rev-parse', '--show-toplevel']);
  if (directRoot) {
    const resolved = resolve(directRoot);
    if (!resolved.includes('qa_watchdog/worktrees') && !resolved.includes('.antigravity/worktrees')) {
      candidates.push(resolved);
      seen.add(resolved);
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
          if (!seen.has(resolved) && !resolved.includes('qa_watchdog/worktrees')) {
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

  scanDir(resolve(fsPath), 1);
  return candidates;
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

function isDocsOnlyCommit(repoPath, sha, subject = '') {
  const s = (subject || '').trim().toLowerCase();
  const isDocsConventionalCommit = /^docs?(\([^)]+\))?:/i.test(s);

  const out = runGit(repoPath, ['show', '--pretty=', '--name-only', sha]);
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
      const pkgDiff = runGit(repoPath, ['diff', '-U0', `${sha}~1..${sha}`, '--', f]);
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

function inspectSingleRepo(topLevel) {
  try {
    const isGit = runGit(topLevel, ['rev-parse', '--is-inside-work-tree']) === 'true';
    if (!isGit) return null;

    const recentCommits = getRepoRecentCommits(topLevel, 12);
    const branch = runGit(topLevel, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'HEAD';
    const fixBranchesRaw = runGit(topLevel, ['branch', '--list', 'fix/qa-*', '--format=%(refname:short)']);
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
    if (existsSync(proposalsFile)) {
      try {
        const pData = JSON.parse(readFileSync(proposalsFile, 'utf8'));
        proposals = Array.isArray(pData.proposals) ? pData.proposals : [];
        if (pData.goal) goal = pData.goal;
      } catch {
        // ignore
      }
    }
    const goalFile = join(nextStepsDir, 'goal.json');
    if (!goal && existsSync(goalFile)) {
      try {
        goal = JSON.parse(readFileSync(goalFile, 'utf8'));
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

    // Reconcile executions: check running items against git commits or transcript
    let execsModified = false;
    const brainDir = join(homedir(), '.gemini', 'antigravity', 'brain');
    const latestSha = recentCommits.length > 0 ? recentCommits[0].sha : '';

    for (const [id, item] of Object.entries(executions)) {
      if (!item || typeof item !== 'object') continue;
      if (item.status === 'running') {
        const initSha = item.initialHeadSha;
        if (latestSha && initSha && latestSha !== initSha) {
          item.status = 'completed';
          item.completedAt = new Date().toISOString();
          item.summary = 'Plan execution completed (changes committed to repository).';
          item.completedSha = latestSha.slice(0, 7);
          execsModified = true;
          continue;
        }

        const convId = item.conversationId;
        if (convId) {
          const transcriptPath = join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
          if (existsSync(transcriptPath)) {
            try {
              const stat = statSync(transcriptPath);
              const ageSec = (Date.now() - stat.mtimeMs) / 1000;
              if (ageSec > 120) {
                const content = readFileSync(transcriptPath, 'utf8').trim();
                const lastLine = content.slice(content.lastIndexOf('\n') + 1);
                if (lastLine.startsWith('{')) {
                  const parsed = JSON.parse(lastLine);
                  if (parsed.status === 'ERROR' || parsed.status === 'CANCELLED') {
                    item.status = 'interrupted';
                    item.completedAt = new Date().toISOString();
                    item.summary = 'Agent execution was interrupted or cancelled. Click Continue Execution to resume.';
                    execsModified = true;
                  } else if (parsed.type === 'PLANNER_RESPONSE' && (!parsed.tool_calls || parsed.tool_calls.length === 0)) {
                    item.status = 'completed';
                    item.completedAt = new Date().toISOString();
                    item.summary = 'Plan execution completed by agent.';
                    execsModified = true;
                  }
                }
              }
            } catch {
              // ignore
            }
          }
        }
      }
    }
    if (execsModified) {
      try {
        writeFileSync(execFile, JSON.stringify({ executions }, null, 2), 'utf8');
      } catch {
        // ignore
      }
    }

    for (const p of proposals) {
      if (p.id && executions[p.id]) {
        p.execution = executions[p.id];
      }
    }
    let synthesizing = false;
    const synthStateFile = join(nextStepsDir, 'synthesis_state.json');
    if (existsSync(synthStateFile)) {
      try {
        const sData = JSON.parse(readFileSync(synthStateFile, 'utf8'));
        if (sData.status === 'synthesizing') {
          const startedTs = sData.startedAt ? new Date(sData.startedAt).getTime() : 0;
          const elapsed = startedTs ? Date.now() - startedTs : 0;
          const propFile = join(nextStepsDir, 'proposals.json');
          let proposalsFresh = false;
          if (existsSync(propFile) && startedTs) {
            const mtime = statSync(propFile).mtimeMs;
            if (mtime >= startedTs - 2000) {
              proposalsFresh = true;
            }
          }
          if (proposalsFresh || elapsed > 15 * 60 * 1000) {
            synthesizing = false;
          } else {
            synthesizing = true;
          }
        }
      } catch {
        // ignore
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
      };
    }

    const youngest = recentCommits[0];
    const isDocsOnly = isDocsOnlyCommit(topLevel, youngest.sha, youngest.subject);
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
    };
  } catch (err) {
    console.error(`Error inspecting repo at ${topLevel}:`, err);
    return null;
  }
}

function collectActiveRepos(uris, state) {
  const roots = [];
  const seen = new Set();

  for (const u of uris) {
    for (const root of discoverCandidateGitRoots(u)) {
      if (!seen.has(root)) {
        seen.add(root);
        roots.push(root);
      }
    }
  }

  if (roots.length === 0 && state.repos) {
    for (const repoPath of Object.keys(state.repos)) {
      for (const root of discoverCandidateGitRoots(repoPath)) {
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
        for (const root of discoverCandidateGitRoots(j.repo_path)) {
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
      for (const root of discoverCandidateGitRoots(ec)) {
        if (!seen.has(root)) {
          seen.add(root);
          roots.push(root);
        }
      }
    }
  }

  let repos = roots.map((r) => inspectSingleRepo(r)).filter(Boolean);

  // Drop empty-tree outer wrapper repos if any non-empty repo exists
  const hasNonEmpty = repos.some((r) => r.head && !r.head.isEmptyTree);
  if (hasNonEmpty) {
    repos = repos.filter((r) => !r.head?.isEmptyTree);
  }

  // Sort: workspace repos first, non-empty tree first, youngest commit timestamp DESC
  repos.sort((a, b) => {
    const inWsA = uris.length > 0 && uris.some((u) => u.includes(a.repoPath) || a.repoPath.includes(u)) ? 1 : 0;
    const inWsB = uris.length > 0 && uris.some((u) => u.includes(b.repoPath) || b.repoPath.includes(u)) ? 1 : 0;
    if (inWsA !== inWsB) return inWsB - inWsA;

    const neA = a.head?.isEmptyTree ? 0 : 1;
    const neB = b.head?.isEmptyTree ? 0 : 1;
    if (neA !== neB) return neB - neA;
    return (b.head?.timestamp || 0) - (a.head?.timestamp || 0);
  });

  return repos;
}

// POST /api/dashboard { workspaceUris }
app.api('/api/dashboard', (data) => {
  try {
    const state = loadState();
    const uris = Array.isArray(data?.workspaceUris) ? data.workspaceUris : [];
    const activeRepos = collectActiveRepos(uris, state);

    return {
      auto_dispatch: state.auto_dispatch !== false,
      skip_docs_only: state.skip_docs_only !== false,
      activeRepos,
      jobs: Array.isArray(state.jobs) ? state.jobs : [],
    };
  } catch (err) {
    console.error('Error in /api/dashboard:', err);
    return {
      auto_dispatch: true,
      skip_docs_only: true,
      activeRepos: [],
      jobs: [],
      error: String(err?.message || err),
    };
  }
});

// POST /api/sync { repoPath?, workspaceUris? }
app.api('/api/sync', (data) => {
  try {
    const uris = [];
    if (data?.repoPath) uris.push(String(data.repoPath).trim());
    if (Array.isArray(data?.workspaceUris)) {
      for (const u of data.workspaceUris) {
        if (!u) continue;
        let p = String(u);
        if (p.startsWith('file://')) {
          try {
            p = fileURLToPath(p);
          } catch {
            continue;
          }
        }
        if (!uris.includes(p)) uris.push(p);
      }
    }

    const ctlArgs = ['sync'];
    for (const u of uris) {
      ctlArgs.push('--repo', u);
    }
    let syncRes = {};
    try {
      syncRes = runPythonCtl(ctlArgs);
    } catch (pythonErr) {
      console.warn('Python ctl sync warning:', pythonErr.message);
    }
    const state = loadState();
    const activeRepos = collectActiveRepos(uris, state);

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
    console.error('Error in /api/sync:', err);
    let state = { auto_dispatch: true, skip_docs_only: true, jobs: [] };
    try {
      state = loadState(true);
    } catch {}
    return {
      ok: false,
      error: String(err?.message || err),
      syncedAt: new Date().toISOString(),
      activeRepos: [],
      jobs: Array.isArray(state.jobs) ? state.jobs : [],
    };
  }
});

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

// POST /api/trigger { repoPath, sha, comment? }
app.api('/api/trigger', (data) => {
  const repoPath = String(data?.repoPath || '').trim();
  const sha = String(data?.sha || 'YOUNGEST').trim();
  const comment = String(data?.comment || '').trim();
  if (!repoPath) {
    return new Response(JSON.stringify({ error: 'Missing repoPath' }), {
      status: 400,
      contentType: 'application/json',
    });
  }

  // Prevent double auditing if an audit is already running for this repo
  const state = loadState();
  const running = (state.jobs || []).find(
    (j) => (!j.repo_path || j.repo_path === repoPath) && (j.status === 'running' || j.status === 'queued')
  );

  if (running) {
    if (comment) {
      const ctlRes = runPythonCtl(['send-comment', '--repo', repoPath, '--comment', comment, '--job-id', running.id || '']);
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
  const result = runPythonCtl(ctlArgs);
  return result;
});

// POST /api/mark-running { jobId, conversationId? }
app.api('/api/mark-running', (data) => {
  const jobId = String(data?.jobId || '');
  const convId = data?.conversationId ? String(data.conversationId) : null;
  const state = loadState();
  for (const j of state.jobs || []) {
    if (j.id === jobId) {
      j.status = 'running';
      j.started_at = new Date().toISOString();
      j.summary = 'Autonomous Watchdog review in progress…';
      if (convId) j.conversation_id = convId;
      break;
    }
  }
  const patch = { jobs: state.jobs };
  if (convId) {
    const active = Array.isArray(state.active_qa_conversations) ? state.active_qa_conversations : [];
    if (!active.includes(convId)) {
      patch.active_qa_conversations = [...active, convId];
    }
  }
  saveStatePatch(patch);
  return { ok: true };
});

// POST /api/dispatch { jobId? }
app.api('/api/dispatch', (data) => {
  const jobId = data?.jobId ? String(data.jobId).trim() : '';
  const args = ['dispatch'];
  if (jobId) args.push('--job-id', jobId);
  return runPythonCtl(args);
});

// POST /api/continue-audit { jobId?, repoPath?, sha? }
app.api('/api/continue-audit', (data) => {
  const jobId = String(data?.jobId || '').trim();
  const repoPath = String(data?.repoPath || '').trim();
  const sha = String(data?.sha || '').trim();

  const ctlArgs = ['continue-job'];
  if (jobId) ctlArgs.push('--job-id', jobId);
  if (repoPath) ctlArgs.push('--repo', repoPath);
  if (sha) ctlArgs.push('--sha', sha);

  return runPythonCtl(ctlArgs);
});

// POST /api/send-comment { repoPath?, comment, jobId? }
app.api('/api/send-comment', (data) => {
  const repoPath = String(data?.repoPath || '').trim();
  const comment = String(data?.comment || '').trim();
  const jobId = String(data?.jobId || '').trim();

  if (!comment) {
    return new Response(JSON.stringify({ error: 'Missing comment' }), {
      status: 400,
      contentType: 'application/json',
    });
  }

  const ctlArgs = ['send-comment', '--comment', comment];
  if (repoPath) ctlArgs.push('--repo', repoPath);
  if (jobId) ctlArgs.push('--job-id', jobId);

  return runPythonCtl(ctlArgs);
});

// POST /api/report { reportPath }
app.api('/api/report', (data) => {
  const reportPath = String(data?.reportPath || '').trim();
  if (!reportPath || !existsSync(reportPath)) {
    return { exists: false, content: '' };
  }
  try {
    return {
      exists: true,
      reportPath,
      content: readFileSync(reportPath, 'utf8'),
    };
  } catch (err) {
    return { exists: false, error: err.message, content: '' };
  }
});

// POST /api/apply-fix { repoPath, sha, mode }
app.api('/api/apply-fix', (data) => {
  const repoPath = String(data?.repoPath || '').trim();
  const sha = String(data?.sha || '').trim();
  const mode = data?.mode === 'merge' ? 'merge' : 'cherry-pick';
  if (!repoPath || !sha) {
    return new Response(JSON.stringify({ error: 'Missing repoPath or sha' }), {
      status: 400,
      contentType: 'application/json',
    });
  }
  return runPythonCtl(['apply-fix', '--repo', repoPath, '--sha', sha, '--mode', mode]);
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
  const state = loadState();
  let found = false;
  for (const j of state.jobs || []) {
    if (j.id === jobId) {
      j.archived = archived;
      found = true;
      break;
    }
  }
  if (found) {
    saveStatePatch({ jobs: state.jobs });
  }
  return { ok: true, jobId, archived };
});

// POST /api/next-steps { repo }
app.api('/api/next-steps', (data) => {
  const repo = String(data?.repo || '').trim();
  if (!repo) {
    return new Response(JSON.stringify({ error: 'Missing repo' }), {
      status: 400,
      contentType: 'application/json',
    });
  }
  return runPythonCtl(['check-synthesis', '--repo', repo]);
});

// POST /api/next-steps/refresh { repo }
app.api('/api/next-steps/refresh', (data) => {
  const repo = String(data?.repo || '').trim();
  if (!repo) {
    return new Response(JSON.stringify({ error: 'Missing repo' }), {
      status: 400,
      contentType: 'application/json',
    });
  }
  return runPythonCtl(['dispatch-synthesis', '--repo', repo]);
});

// POST /api/next-steps/cancel { repo }
app.api('/api/next-steps/cancel', (data) => {
  const repo = String(data?.repo || '').trim();
  if (!repo) {
    return new Response(JSON.stringify({ error: 'Missing repo' }), {
      status: 400,
      contentType: 'application/json',
    });
  }
  return runPythonCtl(['cancel-synthesis', '--repo', repo]);
});

// POST /api/next-steps/goal { repo, goal?, clear?, refresh? }
app.api('/api/next-steps/goal', (data) => {
  const repo = String(data?.repo || '').trim();
  if (!repo) {
    return new Response(JSON.stringify({ error: 'Missing repo' }), {
      status: 400,
      contentType: 'application/json',
    });
  }
  const args = ['goal', '--repo', repo];
  if (data?.clear) {
    args.push('--clear');
  } else if (data?.refresh) {
    args.push('--refresh');
  } else if (data?.goal) {
    args.push('--set', String(data.goal).trim());
  }
  return runPythonCtl(args);
});

// POST /api/next-steps/conversations { repo }
app.api('/api/next-steps/conversations', (data) => {
  const repo = String(data?.repo || '').trim();
  if (!repo) {
    return new Response(JSON.stringify({ error: 'Missing repo' }), {
      status: 400,
      contentType: 'application/json',
    });
  }
  return runPythonCtl(['conversations', '--repo', repo, '--json']);
});

// POST /api/next-steps/transcript { conversationId, limit? }
app.api('/api/next-steps/transcript', (data) => {
  const cid = String(data?.conversationId || '').trim();
  if (!cid) {
    return new Response(JSON.stringify({ error: 'Missing conversationId' }), {
      status: 400,
      contentType: 'application/json',
    });
  }
  const limit = parseInt(data?.limit, 10) || 5;
  return runPythonCtl(['transcript', '--conversation-id', cid, '--limit', String(limit)]);
});

// POST /api/next-steps/plan { repo, planPath?, planFile? }
app.api('/api/next-steps/plan', (data) => {
  const repo = String(data?.repo || '').trim();
  const planPath = String(data?.planPath || '').trim();
  const planFile = String(data?.planFile || '').trim();
  let target = '';
  if (planPath && existsSync(planPath)) {
    target = planPath;
  } else if (repo && planFile && existsSync(join(repo, planFile))) {
    target = join(repo, planFile);
  }
  if (!target || !existsSync(target)) {
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

// POST /api/next-steps/execute { repo, planId }
app.api('/api/next-steps/execute', (data) => {
  const repo = String(data?.repo || '').trim();
  const planId = String(data?.planId || '').trim();
  if (!repo || !planId) {
    return new Response(JSON.stringify({ error: 'Missing repo or planId' }), {
      status: 400,
      contentType: 'application/json',
    });
  }
  return runPythonCtl(['execute-plan', '--repo', repo, '--plan-id', planId]);
});

// POST /api/next-steps/cancel-execution { repo, planId }
app.api('/api/next-steps/cancel-execution', (data) => {
  const repo = String(data?.repo || '').trim();
  const planId = String(data?.planId || '').trim();
  if (!repo || !planId) {
    return new Response(JSON.stringify({ error: 'Missing repo or planId' }), {
      status: 400,
      contentType: 'application/json',
    });
  }
  return runPythonCtl(['cancel-execution', '--repo', repo, '--plan-id', planId]);
});

// POST /api/next-steps/mark-running { repo, planId, conversationId }
app.api('/api/next-steps/mark-running', (data) => {
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
  return runPythonCtl(args);
});

app.run();
