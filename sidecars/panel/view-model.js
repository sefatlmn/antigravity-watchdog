// Watchdog panel view model: the decisions the web panel (app.js) makes from the panel
// server's data (which repo is active, what each audit card and button shows). Pure
// functions with no DOM.

/** @typedef {import('../../types/index.d.ts').Dashboard} Dashboard */
/** @typedef {import('../../types/index.d.ts').Repo} Repo */
/** @typedef {import('../../types/index.d.ts').Job} Job */
/** @typedef {import('../../types/index.d.ts').Commit} Commit */
/** @typedef {import('../../types/index.d.ts').Proposal} Proposal */

export const SKIP_TAGS = ['[auto-review]', '[watchdog]', '[skip-watchdog]'];

/** @param {unknown} str @returns {string} */
export function stripEmojis(str) {
  return stripEmojiChars(str).replace(/\s+/g, ' ').trim();
}

/** Removes emoji but keeps line breaks, for Markdown. @param {unknown} str @returns {string} */
export function stripEmojiChars(str) {
  if (!str) return '';
  return String(str).replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{25A0}-\u{25FF}\u{2B50}-\u{2B55}\u{2300}-\u{23FF}]/gu, '');
}

/** @param {string} iso @param {number} [now] @returns {string} */
export function timeAgo(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.max(0, Math.round((now - then) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** @param {string} u @returns {string} */
export function normalizeWsUri(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (s.startsWith('file://')) {
    s = s.replace(/^file:\/\/(localhost)?/i, '');
  }
  try {
    s = decodeURIComponent(s);
  } catch {}
  if (/^\/[a-zA-Z]:[\\/]/.test(s)) {
    s = s.slice(1);
  }
  return s.replace(/[\\/]+$/, '').replace(/\\/g, '/');
}

/**
 * @param {Dashboard | null | undefined} data
 * @param {{ selectedRepoPath?: string, explicit?: boolean, workspaceUris?: string[] }} [options]
 * @returns {Repo | null}
 */
export function selectActiveRepo(data, { selectedRepoPath = '', explicit = false, workspaceUris = [] } = {}) {
  const repos = data?.activeRepos || [];
  if (repos.length === 0) return null;
  if (explicit && selectedRepoPath) {
    const normSelected = normalizeWsUri(selectedRepoPath);
    const found = repos.find((r) => r.repoPath === selectedRepoPath || r.repoPath === normSelected);
    if (found) return found;
  }
  if (workspaceUris.length > 0) {
    const normUris = workspaceUris.map(normalizeWsUri).filter(Boolean);
    const matched = repos.find((r) =>
      normUris.some((u) => u.includes(r.repoPath) || r.repoPath.includes(u))
    );
    if (matched) return matched;
  }
  return repos[0];
}

/** @param {Repo | null | undefined} repo @returns {string} */
export function goalText(repo) {
  const goal = repo?.goal;
  if (goal && typeof goal === 'object' && goal.goal) return goal.goal;
  if (typeof goal === 'string' && goal) return goal;
  return repo ? `Develop and maintain ${repo.repoName}` : 'Open a Git repository to set project goals';
}

/** @param {Job} job @param {Repo} repo */
const sameRepo = (job, repo) => {
  const jp = (job?.repo_path || job?.repo || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const rp = (repo?.repoPath || repo?.repo || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!jp || !rp) return false;
  return jp === rp;
};

// What one audit card shows. `badge` is the corner tag: null, or { kind: 'fix' | 'warn' | 'plain', label }.
/** @param {Job} job */
export function jobView(job) {
  const status = (job.status || 'queued').toLowerCase();
  const verdict = (job.verdict || 'PENDING').toUpperCase();
  const isRunning = status === 'running';
  const isQueued = status === 'queued';
  const isInterrupted = status === 'interrupted';
  const isFixedOnBranch = verdict === 'FIXED_ON_BRANCH';
  const fixBranch = job.fix_branch || (isFixedOnBranch ? `fix/watchdog-${job.short_sha}` : null);
  const hasFixToApply = Boolean((job.fixes_committed || isFixedOnBranch) && fixBranch && !job.fixes_applied);
  const isApplied = Boolean(job.fixes_applied);
  const isPassed = verdict === 'PASS' && !isApplied && !hasFixToApply && !isRunning && !isQueued && !isInterrupted;
  const hasReport = Boolean(job.report_path || status === 'completed');

  let badge = null;
  if (!(isRunning || isQueued || isInterrupted) && !(isApplied || verdict === 'PASS')) {
    const hasFix = Boolean(job.fixes_committed || isFixedOnBranch);
    if (hasFix && (job.fix_branch || !isApplied)) badge = { kind: 'fix', label: 'Ready' };
    else if (verdict === 'NEEDS_ATTENTION') badge = { kind: 'warn', label: 'Issues' };
    else badge = { kind: 'plain', label: verdict };
  }

  return { status, verdict, isRunning, isQueued, isInterrupted, fixBranch, hasFixToApply, isApplied, isPassed, hasReport, badge };
}

// The main audit button. `kind` is what pressing it does: 'audit', 'send-comment',
// 'continue-audit', or 'none' when it is disabled.
/**
 * @param {Dashboard | null | undefined} data
 * @param {Repo | null | undefined} repo
 * @param {string} [comment]
 */
export function auditAction(data, repo, comment = '') {
  const latest = repo ? repo.youngestCommit || repo.head : null;
  if (!repo || !latest) {
    return { kind: 'none', disabled: true, tone: 'primary', icon: 'play', label: 'Audit Latest Commit', title: '', latest: null, shortSha: '', isAppliedFix: false, runningJob: null, matchingJob: null };
  }
  const jobs = data?.jobs || [];
  const activeSha = (latest.sha || '').toLowerCase();
  const shortSha = (latest.shortSha || latest.short_sha || activeSha.slice(0, 7)).toLowerCase();
  const subject = latest.subject || '';
  /** @param {string} sha @param {string} short */
  const matchesSha = (sha, short) => (activeSha && sha === activeSha) || (shortSha && short === shortSha);

  const matchingJob = jobs.find((j) => sameRepo(j, repo) && matchesSha((j.sha || '').toLowerCase(), (j.short_sha || '').toLowerCase()));
  const hasSkipTag = Boolean(latest.isAutoReview || SKIP_TAGS.some((tag) => subject.includes(tag)));
  const isAppliedFix = Boolean(jobs.some((j) => sameRepo(j, repo) && matchesSha((j.applied_commit_sha || '').toLowerCase(), (j.applied_short_sha || '').toLowerCase())));
  const isAuditSkipped = hasSkipTag && !isAppliedFix;
  const runningJob = jobs.find((j) => sameRepo(j, repo) && (j.status === 'running' || j.status === 'queued'));

  const base = { latest, shortSha, isAppliedFix, isAuditSkipped, runningJob: runningJob || null, matchingJob: matchingJob || null };
  if (runningJob) {
    const sha = runningJob.short_sha || shortSha;
    if (comment.trim()) {
      return { ...base, kind: 'send-comment', disabled: false, tone: 'accent', icon: 'play', label: 'Send Comment to Auditor', title: `Send your comment to the active audit for commit ${sha}.` };
    }
    return { ...base, kind: 'none', disabled: true, tone: 'primary', icon: 'dots', label: `Auditing ${sha}…`, title: `An audit is currently running for commit ${sha}. Type a comment above to send guidance.` };
  }
  if (matchingJob) {
    if (matchingJob.status === 'interrupted') {
      return { ...base, kind: 'continue-audit', disabled: false, tone: 'accent', icon: 'play', label: `Continue Audit (${shortSha})`, title: `The previous audit for ${shortSha} was interrupted. Click to continue audit.` };
    }
    return { ...base, kind: 'none', disabled: true, tone: 'primary', icon: 'check', label: `Commit ${shortSha} Audited`, title: `Commit ${shortSha} has already been audited. Make a new commit to audit again.` };
  }
  if (isAppliedFix) {
    return { ...base, kind: 'none', disabled: true, tone: 'primary', icon: 'check', label: `Commit ${shortSha} Verified (Fix Applied)`, title: `The latest commit is a verified fix applied to ${repo.branch || 'main'}. Make a new commit to audit again.` };
  }
  if (isAuditSkipped) {
    return {
      ...base,
      kind: 'audit',
      disabled: false,
      tone: 'warn',
      icon: 'play',
      label: `Run Review (${shortSha})`,
      title: `Commit has skip tags (${subject}). Click to run review manually.`,
    };
  }
  if (latest.isDocsOnly) {
    return { ...base, kind: 'audit', disabled: false, tone: 'warn', icon: 'warn', label: `Audit Commit ${shortSha} (Docs Only)`, title: `Warning: Commit ${shortSha} only updated documentation/README files. Click to audit anyway.` };
  }
  return { ...base, kind: 'audit', disabled: false, tone: 'primary', icon: 'play', label: `Audit Commit ${shortSha}`, title: `Audit commit ${shortSha}` };
}

/** @param {Dashboard | null | undefined} data @returns {{ recent: Job[], archived: Job[] }} */
export function partitionJobs(data) {
  const all = data?.jobs || [];
  return { recent: all.filter((j) => !j.archived), archived: all.filter((j) => Boolean(j.archived)) };
}

// What one Next Steps proposal card shows. `action` is the execute button's state.
/** @param {Proposal & Record<string, any>} p @param {Repo | null | undefined} repo */
export function proposalView(p, repo) {
  const files = Array.isArray(p.affectedFiles) ? p.affectedFiles : (Array.isArray(p.affected_files) ? p.affected_files : []);
  const rawGoals = Array.isArray(p.goals) ? p.goals : (Array.isArray(p.objectives) ? p.objectives : []);
  const goals = rawGoals.map(stripEmojis);
  const badge = stripEmojis(p.badge || p.tag || p.category || 'Feature') || 'Feature';
  const difficulty = p.difficulty || p.archetype || 'Medium';
  const estimatedTime = p.estimatedTime || p.estimatedDuration || '';
  const title = stripEmojis(p.title || 'Next Step Plan');
  const subtitle = stripEmojis(p.subtitle || '');
  const summary = stripEmojis(p.summary || '');
  let description = subtitle || summary || '';
  if (subtitle && summary) {
    description = summary.toLowerCase().startsWith(subtitle.toLowerCase())
      ? summary
      : `${subtitle}${/[.!?]$/.test(subtitle) ? ' ' : '. '}${summary}`;
  }
  const id = p.id || 'plan-1';
  const execution = p.execution || (repo?.executions && repo.executions[id]) || null;
  const execStatus = (execution?.status || '').toLowerCase();
  const isExecRunning = execStatus === 'running' || execStatus === 'queued';
  const isExecCompleted = execStatus === 'completed';
  const isExecInterrupted = execStatus === 'interrupted';
  const action = isExecRunning
    ? { kind: 'cancel-execution', label: 'Stop' }
    : isExecInterrupted
      ? { kind: 'execute-plan', label: 'Continue Execution', tone: 'accent' }
      : isExecCompleted
        ? { kind: 'execute-plan', label: 'Execute Again', tone: 'secondary' }
        : { kind: 'execute-plan', label: 'Execute in Agent', tone: 'primary' };

  return {
    id, badge, difficulty, estimatedTime, title, description, goals, files,
    planPath: p.planPath || p.plan_absolute_path || '',
    planFile: p.planFile || p.plan_file || '',
    execSummary: execution?.summary || '',
    startedAt: execution?.startedAt || '',
    isExecRunning, isExecCompleted, isExecInterrupted, action,
  };
}
