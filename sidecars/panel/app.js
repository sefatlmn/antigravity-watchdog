// Watchdog & Next Steps Sidecar Panel Logic

const sidecar = window.sidecar;
const $ = (id) => document.getElementById(id);

let workspaceUris = [];
let currentDashboard = null;
let selectedRepoPath = '';
let userExplicitlySelectedRepo = false;
let activeTab = 'audits';
let activeReportText = '';
let activeReportSha = '';
let activePlanModalData = null;
let archivedVisibleLimit = 10;
let isRefreshingProposals = false;
let isSyncing = false;

function stripEmojis(str) {
  if (!str) return '';
  return String(str)
    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{25A0}-\u{25FF}\u{2B50}-\u{2B55}\u{2300}-\u{23FF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const ICONS = {
  check: `<svg class="icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`,
  play: `<svg class="icon-svg" width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
  warn: `<svg class="icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  dots: `<span class="loading-dots">…</span>`,
  archive: `<svg class="icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`,
  unarchive: `<svg class="icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`,
  doc: `<svg class="icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
};

async function callApi(path, { method = 'POST', body = {} } = {}) {
  let res;
  if (sidecar?.fetch) {
    res = await sidecar.fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
  } else {
    const token = new URLSearchParams(window.location.search).get('token');
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['x-sidecar-token'] = token;
    res = await window.fetch(path, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `${res.status} ${res.statusText}`);
  }
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3600);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseInlineMd(text) {
  let s = escapeHtml(text);
  s = s.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

function renderMarkdown(md) {
  if (!md) return '';
  const lines = md.split('\n');
  let html = '';
  let inCode = false;
  let inList = false;
  let inTable = false;

  for (let line of lines) {
    if (line.startsWith('```')) {
      if (inList) { html += '</ul>\n'; inList = false; }
      if (inTable) { html += '</tbody></table>\n'; inTable = false; }
      if (inCode) {
        html += '</code></pre>\n';
        inCode = false;
      } else {
        const lang = line.slice(3).trim();
        html += `<pre><code class="lang-${escapeHtml(lang)}">`;
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      html += escapeHtml(line) + '\n';
      continue;
    }

    const trimmed = line.trim();

    // Table rows
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2) {
      if (inList) { html += '</ul>\n'; inList = false; }
      if (/^\|[-:\s|]+\|$/.test(trimmed)) {
        continue;
      }
      if (!inTable) {
        html += '<table class="md-table"><tbody>\n';
        inTable = true;
      }
      const cells = trimmed.slice(1, -1).split('|').map((c) => c.trim());
      html += `<tr>${cells.map((c) => `<td>${parseInlineMd(c)}</td>`).join('')}</tr>\n`;
      continue;
    } else if (inTable) {
      html += '</tbody></table>\n';
      inTable = false;
    }

    // List items
    if (line.startsWith('- [ ] ') || line.startsWith('- [x] ') || line.startsWith('- ')) {
      if (!inList) {
        html += '<ul class="md-list">\n';
        inList = true;
      }
      const isCheck = line.startsWith('- [ ] ') || line.startsWith('- [x] ');
      const checked = line.startsWith('- [x] ');
      const content = isCheck ? line.slice(6) : line.slice(2);
      html += `<li>${isCheck ? `<input type="checkbox" disabled ${checked ? 'checked' : ''} class="md-check"> ` : '<span class="md-bullet">•</span> '} ${parseInlineMd(content)}</li>\n`;
      continue;
    } else if (inList) {
      html += '</ul>\n';
      inList = false;
    }

    if (line.startsWith('# ')) {
      html += `<h1>${escapeHtml(line.slice(2))}</h1>\n`;
    } else if (line.startsWith('## ')) {
      html += `<h2>${escapeHtml(line.slice(3))}</h2>\n`;
    } else if (line.startsWith('### ')) {
      html += `<h3>${escapeHtml(line.slice(4))}</h3>\n`;
    } else if (line.startsWith('> ')) {
      html += `<blockquote>${escapeHtml(line.slice(2))}</blockquote>\n`;
    } else if (!trimmed) {
      html += '<br>\n';
    } else {
      html += `<p>${parseInlineMd(line)}</p>\n`;
    }
  }
  if (inList) html += '</ul>\n';
  if (inTable) html += '</tbody></table>\n';
  if (inCode) html += '</code></pre>\n';
  return html;
}

function getActiveRepo(data = currentDashboard) {
  const repos = data?.activeRepos || [];
  if (repos.length === 0) return null;
  if (userExplicitlySelectedRepo && selectedRepoPath) {
    const found = repos.find((r) => r.repoPath === selectedRepoPath);
    if (found) return found;
  }
  if (workspaceUris.length > 0) {
    const matched = repos.find((r) =>
      workspaceUris.some((u) => u.includes(r.repoPath) || r.repoPath.includes(u))
    );
    if (matched) return matched;
  }
  return repos[0];
}

function switchTab(tab) {
  activeTab = tab;
  const btnAudits = $('tab-btn-audits');
  const btnNextSteps = $('tab-btn-next-steps');
  const paneAudits = $('tab-pane-audits');
  const paneNextSteps = $('tab-pane-next-steps');

  if (!btnAudits || !btnNextSteps || !paneAudits || !paneNextSteps) return;

  if (tab === 'audits') {
    btnAudits.classList.add('active');
    btnAudits.setAttribute('aria-selected', 'true');
    btnNextSteps.classList.remove('active');
    btnNextSteps.setAttribute('aria-selected', 'false');

    paneAudits.classList.add('active');
    paneAudits.removeAttribute('hidden');
    paneAudits.style.setProperty('display', 'flex', 'important');

    paneNextSteps.classList.remove('active');
    paneNextSteps.setAttribute('hidden', '');
    paneNextSteps.style.setProperty('display', 'none', 'important');
  } else {
    btnNextSteps.classList.add('active');
    btnNextSteps.setAttribute('aria-selected', 'true');
    btnAudits.classList.remove('active');
    btnAudits.setAttribute('aria-selected', 'false');

    paneNextSteps.classList.add('active');
    paneNextSteps.removeAttribute('hidden');
    paneNextSteps.style.setProperty('display', 'flex', 'important');

    paneAudits.classList.remove('active');
    paneAudits.setAttribute('hidden', '');
    paneAudits.style.setProperty('display', 'none', 'important');

    try {
      const activeRepo = getActiveRepo();
      if (activeRepo) {
        renderNextSteps(activeRepo);
      }
    } catch (err) {
      console.error('Error switching to Next Steps tab:', err);
    }
  }
}
window.switchTab = switchTab;

function renderStatusPill(paused) {
  const pill = $('btn-status-pill');
  const text = $('status-text');
  if (!pill || !text) return;
  if (paused) {
    pill.className = 'pill warn';
    text.textContent = 'Paused';
    pill.title = 'Watchdog is paused. Click to resume automatic audits.';
  } else {
    pill.className = 'pill ok';
    text.textContent = 'Active';
    pill.title = 'Watchdog is active. Click to pause automatic audits.';
  }
}

function renderJobBadge(job) {
  const status = (job.status || 'queued').toLowerCase();
  const verdict = (job.verdict || 'PENDING').toUpperCase();

  if (status === 'running' || status === 'queued') {
    return '';
  }
  if (job.fixes_applied || verdict === 'PASS') {
    return '';
  }
  if (job.fixes_committed && job.fix_branch) {
    return '<span class="pill fix">Ready</span>';
  }
  if (verdict === 'NEEDS_ATTENTION') {
    return `<span class="pill warn">${ICONS.warn} Issues</span>`;
  }
  return `<span class="pill">${escapeHtml(verdict)}</span>`;
}

function renderDashboard(data) {
  currentDashboard = data;
  renderStatusPill(Boolean(data.paused));

  const repos = data.activeRepos || [];
  const repoSelect = $('select-repo');
  const activeRepo = getActiveRepo(data);
  selectedRepoPath = activeRepo?.repoPath || '';

  if (repoSelect) {
    if (repos.length > 1) {
      repoSelect.hidden = false;
      repoSelect.innerHTML = repos.map((r) => {
        return `<option value="${escapeHtml(r.repoPath)}" ${r.repoPath === selectedRepoPath ? 'selected' : ''}>${escapeHtml(r.repoName)}</option>`;
      }).join('');
    } else {
      repoSelect.hidden = true;
    }
  }

  const repoNameEl = $('repo-name');
  const repoBranchEl = $('repo-branch');
  const commitShaEl = $('commit-sha');
  const commitSubjectEl = $('commit-subject');
  const commitTimeEl = $('commit-time');
  const commitTagBadge = $('commit-tag-badge');
  const runBtn = $('btn-run-qa');
  const runBtnText = $('btn-run-qa-text');
  const runBtnIcon = $('btn-run-qa-icon');

  if (activeRepo) {
    if (repoNameEl) repoNameEl.textContent = activeRepo.repoName;
    if (repoBranchEl) repoBranchEl.textContent = activeRepo.branch || 'HEAD';
    const latest = activeRepo.youngestCommit || activeRepo.head;

    if (latest) {
      const activeSha = (latest.sha || '').toLowerCase();
      const activeShortSha = (latest.shortSha || latest.short_sha || activeSha.slice(0, 7)).toLowerCase();
      const subject = latest.subject || '';
      if (commitShaEl) commitShaEl.textContent = activeShortSha;
      if (commitSubjectEl) commitSubjectEl.textContent = subject || '(no message)';
      if (commitTimeEl) commitTimeEl.textContent = latest.relativeTime || latest.relative_time || '';

      const matchingJob = (data.jobs || []).find((j) => {
        const jRepo = (j.repo_path || '').trim();
        const jSha = (j.sha || '').toLowerCase();
        const jShortSha = (j.short_sha || '').toLowerCase();
        const repoMatches = !jRepo || jRepo === activeRepo.repoPath;
        const shaMatches = (activeSha && jSha === activeSha) || (activeShortSha && jShortSha === activeShortSha);
        return repoMatches && shaMatches;
      });

      const SKIP_TAGS = ['[auto-review]', '[qa-watchdog]', '[skip-qa]'];
      const hasSkipTag = latest.isAutoReview || SKIP_TAGS.some((tag) => subject.includes(tag));
      const isAppliedFix = hasSkipTag || (data.jobs || []).some((j) => {
        const jRepo = (j.repo_path || '').trim();
        const repoMatches = !jRepo || jRepo === activeRepo.repoPath;
        const appliedSha = (j.applied_commit_sha || '').toLowerCase();
        const appliedShortSha = (j.applied_short_sha || '').toLowerCase();
        return repoMatches && ((activeSha && appliedSha === activeSha) || (activeShortSha && appliedShortSha === activeShortSha));
      });

      const isIgnoredDocs = Boolean(latest.isDocsOnly);

      if (commitTagBadge) {
        commitTagBadge.hidden = !isAppliedFix;
      }

      if (runBtn) {
        runBtn.classList.remove('warn-btn');

        if (matchingJob) {
          runBtn.disabled = true;
          if (runBtnIcon) runBtnIcon.innerHTML = ICONS.check;
          if (matchingJob.status === 'running') {
            if (runBtnIcon) runBtnIcon.innerHTML = ICONS.dots;
            if (runBtnText) runBtnText.textContent = `Auditing ${activeShortSha}…`;
            runBtn.title = `An audit is currently running for commit ${activeShortSha}.`;
          } else if (matchingJob.status === 'queued') {
            if (runBtnIcon) runBtnIcon.innerHTML = ICONS.dots;
            if (runBtnText) runBtnText.textContent = `Commit ${activeShortSha} Queued`;
            runBtn.title = `Commit ${activeShortSha} is already queued for audit.`;
          } else {
            if (runBtnText) runBtnText.textContent = `Commit ${activeShortSha} Audited`;
            runBtn.title = `Commit ${activeShortSha} has already been audited. Make a new commit to audit again.`;
          }
        } else if (isAppliedFix) {
          runBtn.disabled = true;
          if (runBtnIcon) runBtnIcon.innerHTML = ICONS.check;
          if (runBtnText) runBtnText.textContent = `Commit ${activeShortSha} Verified (Fix Applied)`;
          runBtn.title = `The latest commit is a verified fix applied to ${activeRepo.branch || 'main'}. Make a new commit to audit again.`;
        } else if (isIgnoredDocs) {
          runBtn.disabled = false;
          runBtn.classList.add('warn-btn');
          if (runBtnIcon) runBtnIcon.innerHTML = ICONS.warn;
          if (runBtnText) runBtnText.textContent = `Audit Commit ${activeShortSha} (Docs Only)`;
          runBtn.title = `Warning: Commit ${activeShortSha} only updated documentation/README files. Click to audit anyway.`;
        } else {
          runBtn.disabled = false;
          if (runBtnIcon) runBtnIcon.innerHTML = ICONS.play;
          if (runBtnText) runBtnText.textContent = `Audit Commit ${activeShortSha}`;
          runBtn.title = `Audit commit ${activeShortSha}`;
        }
      }
    } else {
      if (runBtn) {
        runBtn.classList.remove('warn-btn');
        runBtn.disabled = true;
        runBtn.title = '';
        if (runBtnIcon) runBtnIcon.innerHTML = ICONS.play;
        if (runBtnText) runBtnText.textContent = 'Audit Latest Commit';
      }
      if (commitTagBadge) commitTagBadge.hidden = true;
      if (commitShaEl) commitShaEl.textContent = '–';
      if (commitSubjectEl) commitSubjectEl.textContent = 'No commits found in project';
      if (commitTimeEl) commitTimeEl.textContent = '';
    }
  } else {
    if (runBtn) {
      runBtn.classList.remove('warn-btn');
      runBtn.disabled = true;
      runBtn.title = '';
      if (runBtnIcon) runBtnIcon.innerHTML = ICONS.play;
      if (runBtnText) runBtnText.textContent = 'Audit Latest Commit';
    }
    if (commitTagBadge) commitTagBadge.hidden = true;
    if (repoNameEl) repoNameEl.textContent = 'No repository detected';
    if (repoBranchEl) repoBranchEl.textContent = '–';
    if (commitShaEl) commitShaEl.textContent = '–';
    if (commitSubjectEl) commitSubjectEl.textContent = 'Open a Git workspace to begin';
    if (commitTimeEl) commitTimeEl.textContent = '';
  }

  // Audits Partition
  const allJobs = data.jobs || [];
  const recentJobs = allJobs.filter((j) => !j.archived);
  const archivedJobs = allJobs.filter((j) => Boolean(j.archived));

  const auditsCountEl = $('audits-count');
  if (auditsCountEl) auditsCountEl.textContent = recentJobs.length;
  const archivedCountEl = $('archived-count');
  if (archivedCountEl) archivedCountEl.textContent = archivedJobs.length;

  const archiveDetails = $('archive-details');
  if (archiveDetails) {
    archiveDetails.hidden = archivedJobs.length === 0;
  }

  const currentBranch = activeRepo?.branch || 'main';

  function renderCard(job, isArchived) {
    const status = (job.status || 'queued').toLowerCase();
    const isRunning = status === 'running';
    const isQueued = status === 'queued';
    const hasFixToApply = Boolean(job.fixes_committed && job.fix_branch && !job.fixes_applied);
    const isApplied = Boolean(job.fixes_applied);
    const isPassed = (job.verdict || '').toUpperCase() === 'PASS' && !isApplied && !hasFixToApply && !isRunning && !isQueued;

    return `
      <div class="job-item">
        <div class="job-top">
          <div class="job-meta">
            <span class="job-sha">${escapeHtml(job.short_sha)}</span>
            <span class="job-msg" title="${escapeHtml(job.commit_msg || '')}">${escapeHtml(job.commit_msg || '')}</span>
          </div>
          ${renderJobBadge(job)}
        </div>
        ${job.summary ? `<p class="job-summary">${escapeHtml(job.summary)}</p>` : ''}
        ${job.user_comment ? `<p class="job-comment"><span class="comment-tag">Note:</span>${escapeHtml(job.user_comment)}</p>` : ''}
        <div class="job-actions">
          ${isRunning ? `<span class="applied-badge running"><span class="dot"></span>Auditing…</span>` : ''}
          ${isQueued ? `<span class="applied-badge running"><span class="dot"></span>Queued</span>` : ''}
          ${isApplied ? `<span class="applied-badge">${ICONS.check} Applied to ${escapeHtml(currentBranch)}</span>` : ''}
          ${isPassed ? `<span class="applied-badge">${ICONS.check} Passed</span>` : ''}
          ${hasFixToApply ? `<button type="button" class="btn small-btn accent-btn" data-action="apply-fix" data-repo="${escapeHtml(job.repo_path)}" data-sha="${escapeHtml(job.sha)}" title="Merge the bug fix commit into your active branch">Apply Fix to ${escapeHtml(currentBranch)}</button>` : ''}
          <button type="button" class="icon-btn job-report-btn" data-action="view-report" data-report="${escapeHtml(job.report_path)}" data-sha="${escapeHtml(job.short_sha)}" title="View Report" aria-label="View Report">${ICONS.doc}</button>
          ${isArchived
            ? `<button type="button" class="icon-btn job-archive-btn" data-action="unarchive" data-job-id="${escapeHtml(job.id)}" title="Restore audit from archive" aria-label="Restore audit from archive">${ICONS.unarchive}</button>`
            : `<button type="button" class="icon-btn job-archive-btn" data-action="archive" data-job-id="${escapeHtml(job.id)}" title="Archive audit" aria-label="Archive audit">${ICONS.archive}</button>`
          }
        </div>
      </div>
    `;
  }

  const listEl = $('jobs-list');
  if (listEl) {
    if (recentJobs.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <p class="muted">No recent audits.</p>
          <span class="small muted">Audits run automatically after coding turns, or click above to audit now.</span>
        </div>
      `;
    } else {
      listEl.innerHTML = recentJobs.map((j) => renderCard(j, false)).join('');
    }
  }

  const archivedListEl = $('archived-jobs-list');
  if (archivedListEl) {
    if (archivedJobs.length === 0) {
      archivedListEl.innerHTML = '';
    } else {
      const visibleArchived = archivedJobs.slice(0, archivedVisibleLimit);
      let html = visibleArchived.map((j) => renderCard(j, true)).join('');
      if (archivedJobs.length > archivedVisibleLimit) {
        html += `
          <div class="load-more-row">
            <button type="button" id="btn-load-more-archived" class="btn small-btn secondary load-more-btn">
              Load More
            </button>
          </div>
        `;
      }
      archivedListEl.innerHTML = html;
    }
  }

  // Render Next Steps
  if (activeRepo) {
    renderNextSteps(activeRepo);
  }
}

function renderNextSteps(activeRepo) {
  if (!activeRepo) return;
  if (isRefreshingProposals) return;

  try {
    // 1. Goal Banner
    const goalTextEl = $('ns-goal-text');
    const goalSourceEl = $('ns-goal-source');
    const goalData = activeRepo.goal;

    if (goalTextEl) {
      if (goalData && typeof goalData === 'object' && goalData.goal) {
        goalTextEl.textContent = goalData.goal;
        if (goalSourceEl) goalSourceEl.textContent = goalData.source || 'Auto';
      } else if (typeof goalData === 'string' && goalData) {
        goalTextEl.textContent = goalData;
        if (goalSourceEl) goalSourceEl.textContent = 'Auto';
      } else {
        goalTextEl.textContent = `Develop and maintain ${activeRepo.repoName}`;
        if (goalSourceEl) goalSourceEl.textContent = 'Auto';
      }
    }

    // 2. Proposal count badge on tab
    const proposals = Array.isArray(activeRepo.proposals) ? activeRepo.proposals : [];
    const tabBadge = $('tab-badge-proposals');
    if (tabBadge) {
      tabBadge.textContent = proposals.length || 4;
    }

    // 3. Commit context
    const contextEl = $('ns-commit-context');
    const latest = activeRepo.youngestCommit || activeRepo.head;
    if (contextEl && latest) {
      const ssha = latest.shortSha || latest.short_sha || '';
      contextEl.textContent = ssha ? `Based on: ${ssha}` : '';
    }

    // 4. Proposals List
    const proposalsList = $('proposals-list');
    if (proposalsList) {
      if (activeRepo.synthesizing) {
        proposalsList.innerHTML = `
          <div class="proposals-loading-state">
            <div class="loading-label-group">
              <span class="loading-label-title">Agent analyzing codebase &amp; goals…</span>
              <span class="loading-label-sub muted small" id="ns-loading-sub">Synthesizing 4 pragmatic implementation plans</span>
            </div>
            <div class="proposals-progress-container">
              <div class="proposals-progress-bar" id="ns-progress-bar" style="width: 15%;"></div>
            </div>
          </div>
        `;
        setTimeout(() => refreshProposals(true), 50);
        return;
      }
      if (proposals.length === 0) {
        proposalsList.innerHTML = `
          <div class="empty-state">
            <p class="muted">No proposals generated yet.</p>
            <button id="btn-synthesize-now" type="button" class="btn small-btn primary-btn" style="margin-top:8px;">Synthesize 4 Next Steps</button>
          </div>
        `;
        const synthBtn = $('btn-synthesize-now');
        if (synthBtn) {
          synthBtn.addEventListener('click', () => refreshProposals(false));
        }
      } else {
        proposalsList.innerHTML = proposals.map((p) => {
          const files = Array.isArray(p.affectedFiles) ? p.affectedFiles : (Array.isArray(p.affected_files) ? p.affected_files : []);
          const filesHtml = files.map((f) => `<span class="file-chip">${escapeHtml(f)}</span>`).join('');
          
          const goals = Array.isArray(p.goals) ? p.goals : [];
          const goalsHtml = goals.map((g) => `<div class="proposal-goal-item"><span class="check">${ICONS.check}</span><span>${escapeHtml(stripEmojis(g))}</span></div>`).join('');

          const rawBadge = p.badge || p.tag || p.category || 'Feature';
          const badge = stripEmojis(rawBadge) || 'Feature';
          const difficulty = p.difficulty || p.archetype || 'Medium';
          const estTime = p.estimatedTime || p.estimated_effort || '20m';
          const title = stripEmojis(p.title || 'Next Step Plan');
          const subtitle = stripEmojis(p.subtitle || '');
          const summary = stripEmojis(p.summary || '');
          let description = '';
          if (subtitle && summary) {
            if (summary.toLowerCase().startsWith(subtitle.toLowerCase())) {
              description = summary;
            } else {
              const sep = /[.!?]$/.test(subtitle) ? ' ' : '. ';
              description = `${subtitle}${sep}${summary}`;
            }
          } else {
            description = subtitle || summary || '';
          }
          const planPath = p.planPath || p.plan_absolute_path || '';
          const planFile = p.planFile || p.plan_file || '';
          const planId = p.id || 'plan-1';

          return `
            <div class="proposal-card" data-proposal-id="${escapeHtml(planId)}">
              <div class="proposal-meta-row">
                <div class="proposal-badge-group">
                  <span class="pill ok">${escapeHtml(badge)}</span>
                  <span class="muted small">${escapeHtml(difficulty)}</span>
                </div>
                <span class="muted small">~${escapeHtml(estTime)}</span>
              </div>

              <h3>${escapeHtml(title)}</h3>
              ${description ? `<p class="proposal-description">${escapeHtml(description)}</p>` : ''}

              ${goalsHtml ? `<div class="proposal-goals">${goalsHtml}</div>` : ''}

              <div class="proposal-actions">
                <button type="button" class="btn small-btn primary-btn" data-action="execute-plan" data-plan-id="${escapeHtml(planId)}" data-title="${escapeHtml(title)}">
                  Execute in Agent
                </button>
                <button type="button" class="icon-btn proposal-plan-btn" data-action="view-plan" data-plan-path="${escapeHtml(planPath)}" data-plan-file="${escapeHtml(planFile)}" data-plan-id="${escapeHtml(planId)}" data-title="${escapeHtml(title)}" data-badge="${escapeHtml(badge)}" title="Review Plan" aria-label="Review Plan">
                  ${ICONS.doc}
                </button>
              </div>
            </div>
          `;
        }).join('');
      }
    }
  } catch (err) {
    console.error('renderNextSteps error:', err);
  }
}

async function refreshProposals(skipDispatch = false) {
  const activeRepo = getActiveRepo();
  if (!activeRepo) {
    toast('No repository detected.', true);
    return;
  }
  if (isRefreshingProposals) {
    return;
  }
  const refreshBtn = $('btn-refresh-proposals');
  const proposalsList = $('proposals-list');
  try {
    isRefreshingProposals = true;
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.classList.add('spinning');
    }
    if (proposalsList) {
      proposalsList.innerHTML = `
        <div class="proposals-loading-state">
          <div class="loading-label-group">
            <span class="loading-label-title">Agent analyzing codebase &amp; goals…</span>
            <span class="loading-label-sub muted small" id="ns-loading-sub">Synthesizing 4 pragmatic implementation plans</span>
          </div>
          <div class="proposals-progress-container">
            <div class="proposals-progress-bar" id="ns-progress-bar" style="width: 15%;"></div>
          </div>
        </div>
      `;
    }

    if (!skipDispatch) {
      toast('Evaluating codebase and synthesizing plans…');
      const res = await callApi('/api/next-steps/refresh', { body: { repo: activeRepo.repoPath } });
      if (!res.ok) {
        toast(res.error || 'Failed to dispatch synthesis agent', true);
        return;
      }
      if (res.status === 'ready' && res.proposals) {
        const progressBar = $('ns-progress-bar');
        const progressSub = $('ns-loading-sub');
        if (progressBar) progressBar.style.width = '100%';
        if (progressSub) progressSub.textContent = 'Proposals ready!';
        await new Promise((r) => setTimeout(r, 150));
        activeRepo.proposals = res.proposals;
        if (res.goal) activeRepo.goal = res.goal;
        activeRepo.synthesizing = false;
        toast('Synthesized 4 next steps');
        return;
      }
    } else {
      toast('Agent synthesis currently in progress…');
    }

    // Background agent is synthesizing, poll for completion every 2s
    const pollInterval = 2000;
    const maxPolls = 40; // ~80s
    let finished = false;

    for (let i = 0; i < maxPolls; i++) {
      const progressBar = $('ns-progress-bar');
      const progressSub = $('ns-loading-sub');
      const pct = Math.min(92, Math.round(15 + ((i + 1) / maxPolls) * 80));
      if (progressBar) {
        progressBar.style.width = `${pct}%`;
      }
      if (progressSub) {
        if (pct < 35) {
          progressSub.textContent = 'Inspecting specifications & history…';
        } else if (pct < 65) {
          progressSub.textContent = 'Evaluating codebase architecture & entry points…';
        } else {
          progressSub.textContent = 'Formulating 4 implementation plans…';
        }
      }

      await new Promise((r) => setTimeout(r, pollInterval));
      try {
        const check = await callApi('/api/next-steps', { body: { repo: activeRepo.repoPath } });
        if (check.ok && check.synthesizing === false && Array.isArray(check.proposals) && check.proposals.length > 0) {
          if (progressBar) progressBar.style.width = '100%';
          if (progressSub) progressSub.textContent = 'Proposals ready!';
          await new Promise((r) => setTimeout(r, 200));
          activeRepo.proposals = check.proposals;
          if (check.goal) activeRepo.goal = check.goal;
          activeRepo.synthesizing = false;
          finished = true;
          toast('Synthesized 4 next steps');
          break;
        }
      } catch (pollErr) {
        console.warn('Synthesis poll error:', pollErr);
      }
    }

    if (!finished) {
      const finalCheck = await callApi('/api/next-steps', { body: { repo: activeRepo.repoPath } });
      if (finalCheck.ok && Array.isArray(finalCheck.proposals) && finalCheck.proposals.length > 0) {
        activeRepo.proposals = finalCheck.proposals;
        if (finalCheck.goal) activeRepo.goal = finalCheck.goal;
        activeRepo.synthesizing = Boolean(finalCheck.synthesizing);
      } else {
        toast('Agent synthesis is still in progress in background.', false);
      }
    }
  } catch (err) {
    toast(`Synthesis error: ${err.message}`, true);
  } finally {
    isRefreshingProposals = false;
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove('spinning');
    }
    renderNextSteps(activeRepo);
  }
}

async function openPlanModal(planPath, planFile, planId, title, badge) {
  const activeRepo = getActiveRepo();
  if (!activeRepo) return;

  try {
    toast('Loading plan…');
    const res = await callApi('/api/next-steps/plan', {
      body: { repo: activeRepo.repoPath, planPath, planFile },
    });
    if (!res.ok || !res.content) {
      toast(res.error || 'Could not load plan markdown', true);
      return;
    }

    activePlanModalData = {
      planId,
      title: title || 'Implementation Plan',
      badge: badge || 'Feature',
      content: res.content,
      repoPath: activeRepo.repoPath,
    };

    $('modal-plan-title').textContent = title || 'Implementation Plan';
    $('modal-category-badge').textContent = stripEmojis(badge) || 'Feature';
    $('modal-plan-content').innerHTML = renderMarkdown(stripEmojis(res.content));
    $('plan-modal').hidden = false;
  } catch (err) {
    toast(`Error loading plan: ${err.message}`, true);
  }
}

function closePlanModal() {
  const modal = $('plan-modal');
  if (modal) modal.hidden = true;
  activePlanModalData = null;
}

async function executePlan(planId) {
  const activeRepo = getActiveRepo();
  if (!activeRepo) {
    toast('No repository detected.', true);
    return;
  }

  try {
    toast('Dispatching agent execution…');
    const res = await callApi('/api/next-steps/execute', {
      body: { repo: activeRepo.repoPath, planId },
    });

    if (!res.ok) {
      toast(res.error || 'Execution dispatch failed', true);
      return;
    }

    closePlanModal();

    if (res.dispatched) {
      toast(`Agent conversation started for "${stripEmojis(res.title)}"`);
    } else if (sidecar?.agent?.startConversation && res.prompt) {
      await sidecar.agent.startConversation(res.prompt);
      toast(`Launched agent conversation for "${stripEmojis(res.title)}"`);
    } else if (navigator?.clipboard?.writeText && res.prompt) {
      await navigator.clipboard.writeText(res.prompt);
      toast(`Copied execution prompt for "${stripEmojis(res.title)}" to clipboard`);
    } else {
      toast(`Ready to execute "${stripEmojis(res.title)}"`);
    }
  } catch (err) {
    toast(`Execution error: ${err.message}`, true);
  }
}

async function copyPlanContent() {
  if (!activePlanModalData?.content) return;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(activePlanModalData.content);
      toast('Copied implementation plan to clipboard');
    }
  } catch (err) {
    toast(`Failed to copy: ${err.message}`, true);
  }
}

async function syncGit({ silent = false } = {}) {
  if (isSyncing) return;
  isSyncing = true;
  const syncBtn = $('btn-sync');
  try {
    if (syncBtn && !silent) {
      syncBtn.disabled = true;
      syncBtn.classList.add('spinning');
    }
    let data;
    const body = {
      workspaceUris,
      repoPath: selectedRepoPath || undefined,
    };
    try {
      // Use lightweight dashboard endpoint for silent polling; call full Python sync on user click
      if (silent) {
        data = await callApi('/api/dashboard', { body });
      } else {
        data = await callApi('/api/sync', { body });
      }
    } catch {
      data = await callApi('/api/dashboard', { body });
    }
    renderDashboard(data);
    if (!silent) {
      const repo = getActiveRepo(data);
      const latest = repo?.youngestCommit || repo?.head;
      if (latest) {
        toast(`Synced ${repo.repoName} @ ${latest.shortSha} (${latest.relativeTime})`);
      } else {
        toast('Synced Git status');
      }
    }
  } catch (err) {
    if (!silent) toast(`Sync failed: ${err.message}`, true);
  } finally {
    isSyncing = false;
    if (syncBtn && !silent) {
      syncBtn.disabled = false;
      syncBtn.classList.remove('spinning');
    }
  }
}

async function runAudit() {
  const activeRepo = getActiveRepo();
  if (!activeRepo) {
    toast('No Git repository detected.', true);
    return;
  }
  const latest = activeRepo.youngestCommit || activeRepo.head;
  const SKIP_TAGS = ['[auto-review]', '[qa-watchdog]', '[skip-qa]'];
  const subject = latest?.subject || '';
  if (latest?.isAutoReview || SKIP_TAGS.some((tag) => subject.includes(tag))) {
    toast('The latest commit is an applied fix and cannot be re-audited. Make a new commit first.', true);
    return;
  }
  const sha = latest?.sha || 'YOUNGEST';
  const repoPath = activeRepo.repoPath;
  const commentInput = $('input-audit-comment');
  const comment = commentInput ? commentInput.value.trim() : '';

  try {
    toast('Preparing isolated worktree & dispatching Watchdog…');
    const res = await callApi('/api/trigger', { body: { repoPath, sha, comment } });
    if (!res.ok || !res.job) {
      toast(res.reason || res.error || 'Could not queue review.', true);
      return;
    }

    const prompt = res.job.prompt;
    if (sidecar?.agent?.startConversation && prompt) {
      const convRes = await sidecar.agent.startConversation(prompt);
      const conversationId = convRes?.conversationId || convRes?.response?.conversationId || null;
      await callApi('/api/mark-running', { body: { jobId: res.job.id, conversationId } });
      toast(`Launched Watchdog for ${res.job.repo_name} @ ${res.job.short_sha}`);
    } else {
      try {
        const disp = await callApi('/api/dispatch', { body: { jobId: res.job.id } });
        if (disp.ok) {
          toast(`Dispatched Watchdog for ${res.job.repo_name} @ ${res.job.short_sha}`);
        } else {
          toast(`Queued Watchdog for ${res.job.short_sha}`);
        }
      } catch {
        toast(`Queued Watchdog for ${res.job.short_sha}`);
      }
    }
    if (commentInput) commentInput.value = '';
    await syncGit({ silent: true });
  } catch (err) {
    toast(`Failed to start audit: ${err.message}`, true);
  }
}

async function applyFix(repoPath, sha) {
  const activeRepo = getActiveRepo();
  const branch = activeRepo?.branch || 'current branch';
  try {
    toast(`Applying fix to ${branch}…`);
    const res = await callApi('/api/apply-fix', { body: { repoPath, sha, mode: 'cherry-pick' } });
    if (!res.ok) {
      toast(res.error || 'Could not apply fix.', true);
      return;
    }
    toast(res.message || `Successfully applied fix to ${res.branch}!`);
    await syncGit({ silent: true });
  } catch (err) {
    toast(`Failed to apply fix: ${err.message}`, true);
  }
}

async function openReport(reportPath, shortSha) {
  try {
    const res = await callApi('/api/report', { body: { reportPath } });
    if (!res.exists) {
      toast(`Report not found (${reportPath}). If an audit is running, check back shortly.`, true);
      return;
    }
    activeReportText = res.content;
    activeReportSha = shortSha;
    const rTitle = $('report-title');
    const rContent = $('report-content');
    const rCard = $('report-card');
    if (rTitle) rTitle.textContent = `Report — ${shortSha}`;
    if (rContent) rContent.innerHTML = renderMarkdown(stripEmojis(res.content));
    if (rCard) {
      rCard.hidden = false;
      rCard.scrollIntoView({ behavior: 'smooth' });
    }
  } catch (err) {
    toast(`Could not load report: ${err.message}`, true);
  }
}

async function sendReportToChat() {
  if (!activeReportText) return;
  const msg = `Here is the Watchdog audit report for commit \`${activeReportSha}\`:\n\n${activeReportText}\n\nPlease review the findings and let's address any identified issues.`;
  try {
    if (sidecar?.conversationId && sidecar?.agent?.sendMessage) {
      await sidecar.agent.sendMessage(msg);
      toast('Sent findings to active chat');
    } else if (sidecar?.agent?.startConversation) {
      await sidecar.agent.startConversation(msg);
      toast('Started new conversation with report');
    } else {
      toast('No active conversation bridge available.', true);
    }
  } catch (err) {
    toast(`Failed to send to chat: ${err.message}`, true);
  }
}

async function togglePause() {
  const next = !Boolean(currentDashboard?.paused);
  try {
    await callApi('/api/settings', { body: { paused: next } });
    renderStatusPill(next);
    toast(next ? 'Watchdog paused' : 'Watchdog active');
  } catch (err) {
    toast(`Failed to update setting: ${err.message}`, true);
  }
}

async function toggleArchiveJob(jobId, archived) {
  try {
    const res = await callApi('/api/archive-job', { body: { jobId, archived } });
    if (!res.ok) {
      toast(res.error || 'Could not update archive status.', true);
      return;
    }
    if (currentDashboard?.jobs) {
      for (const j of currentDashboard.jobs) {
        if (j.id === jobId) {
          j.archived = archived;
          break;
        }
      }
      renderDashboard(currentDashboard);
    }
    toast(archived ? 'Moved audit to archive' : 'Restored audit from archive');
  } catch (err) {
    toast(`Failed to update archive: ${err.message}`, true);
  }
}

async function init() {
  // Tabs click listeners
  const btnAudits = $('tab-btn-audits');
  const btnNextSteps = $('tab-btn-next-steps');
  if (btnAudits) btnAudits.addEventListener('click', () => switchTab('audits'));
  if (btnNextSteps) btnNextSteps.addEventListener('click', () => switchTab('next-steps'));

  // Header actions
  const btnPill = $('btn-status-pill');
  if (btnPill) btnPill.addEventListener('click', togglePause);
  const btnSync = $('btn-sync');
  if (btnSync) btnSync.addEventListener('click', () => syncGit({ silent: false }));
  const btnRunQa = $('btn-run-qa');
  if (btnRunQa) btnRunQa.addEventListener('click', runAudit);

  // Goal actions
  const btnEditGoal = $('btn-edit-goal');
  if (btnEditGoal) {
    btnEditGoal.addEventListener('click', () => {
      const activeRepo = getActiveRepo();
      if (!activeRepo) return;
      const gInput = $('input-goal');
      if (gInput) gInput.value = (typeof activeRepo.goal === 'object' ? activeRepo.goal?.goal : activeRepo.goal) || '';
      const gView = $('ns-goal-view');
      const gForm = $('ns-goal-edit-form');
      if (gView) gView.hidden = true;
      if (gForm) gForm.hidden = false;
    });
  }

  const btnCancelGoal = $('btn-cancel-goal');
  if (btnCancelGoal) {
    btnCancelGoal.addEventListener('click', () => {
      const gForm = $('ns-goal-edit-form');
      const gView = $('ns-goal-view');
      if (gForm) gForm.hidden = true;
      if (gView) gView.hidden = false;
    });
  }

  const goalForm = $('ns-goal-edit-form');
  if (goalForm) {
    goalForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const activeRepo = getActiveRepo();
      if (!activeRepo) return;
      const gInput = $('input-goal');
      const newGoal = gInput ? gInput.value.trim() : '';
      if (!newGoal) return;
      try {
        const res = await callApi('/api/next-steps/goal', {
          body: { repo: activeRepo.repoPath, goal: newGoal },
        });
        if (res.ok) {
          activeRepo.goal = res.goal;
          renderNextSteps(activeRepo);
          const gForm = $('ns-goal-edit-form');
          const gView = $('ns-goal-view');
          if (gForm) gForm.hidden = true;
          if (gView) gView.hidden = false;
          toast('Project goal updated');
        }
      } catch (err) {
        toast(`Goal update failed: ${err.message}`, true);
      }
    });
  }

  const btnClearGoal = $('btn-clear-goal');
  if (btnClearGoal) {
    btnClearGoal.addEventListener('click', async () => {
      const activeRepo = getActiveRepo();
      if (!activeRepo) return;
      try {
        const res = await callApi('/api/next-steps/goal', {
          body: { repo: activeRepo.repoPath, clear: true },
        });
        if (res.ok) {
          activeRepo.goal = res.goal;
          renderNextSteps(activeRepo);
          const gForm = $('ns-goal-edit-form');
          const gView = $('ns-goal-view');
          if (gForm) gForm.hidden = true;
          if (gView) gView.hidden = false;
          toast('Reset goal to auto-discovered');
        }
      } catch (err) {
        toast(`Reset failed: ${err.message}`, true);
      }
    });
  }

  // Next Steps refresh
  const btnRefreshProposals = $('btn-refresh-proposals');
  if (btnRefreshProposals) btnRefreshProposals.addEventListener('click', () => refreshProposals(false));

  // Proposal cards actions delegation
  const propList = $('proposals-list');
  if (propList) {
    propList.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'view-plan') {
        openPlanModal(
          btn.dataset.planPath,
          btn.dataset.planFile,
          btn.dataset.planId,
          btn.dataset.title,
          btn.dataset.badge
        );
      } else if (action === 'execute-plan') {
        executePlan(btn.dataset.planId);
      }
    });
  }

  // Modal actions
  const modalClose = $('modal-btn-close');
  if (modalClose) modalClose.addEventListener('click', closePlanModal);
  const modalCopy = $('modal-btn-copy');
  if (modalCopy) modalCopy.addEventListener('click', copyPlanContent);
  const modalExecute = $('modal-btn-execute');
  if (modalExecute) {
    modalExecute.addEventListener('click', () => {
      if (activePlanModalData?.planId) {
        executePlan(activePlanModalData.planId);
      }
    });
  }

  // Backdrop click dismissal
  const planModal = $('plan-modal');
  if (planModal) {
    planModal.addEventListener('click', (e) => {
      if (e.target === planModal) closePlanModal();
    });
  }

  // Global Escape key dismisses modal or report
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = $('plan-modal');
      if (modal && !modal.hidden) {
        closePlanModal();
        return;
      }
      const reportCard = $('report-card');
      if (reportCard && !reportCard.hidden) {
        reportCard.hidden = true;
      }
    }
  });

  // Audit comment key listener
  const commentInput = $('input-audit-comment');
  if (commentInput) {
    commentInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        runAudit();
      }
    });
  }

  const repoSelect = $('select-repo');
  if (repoSelect) {
    repoSelect.addEventListener('change', (e) => {
      userExplicitlySelectedRepo = true;
      selectedRepoPath = e.target.value;
      archivedVisibleLimit = 10;
      if (currentDashboard) renderDashboard(currentDashboard);
    });
  }

  const handleJobAction = (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'apply-fix') {
      applyFix(btn.dataset.repo, btn.dataset.sha);
    } else if (action === 'view-report') {
      openReport(btn.dataset.report, btn.dataset.sha);
    } else if (action === 'archive') {
      toggleArchiveJob(btn.dataset.jobId, true);
    } else if (action === 'unarchive') {
      toggleArchiveJob(btn.dataset.jobId, false);
    }
  };

  const jobsList = $('jobs-list');
  if (jobsList) jobsList.addEventListener('click', handleJobAction);
  const archivedListEl = $('archived-jobs-list');
  if (archivedListEl) {
    archivedListEl.addEventListener('click', (e) => {
      const loadMoreBtn = e.target.closest('#btn-load-more-archived');
      if (loadMoreBtn) {
        archivedVisibleLimit += 10;
        if (currentDashboard) renderDashboard(currentDashboard);
        return;
      }
      handleJobAction(e);
    });
  }

  const btnCloseReport = $('btn-close-report');
  if (btnCloseReport) {
    btnCloseReport.addEventListener('click', () => {
      const rCard = $('report-card');
      if (rCard) rCard.hidden = true;
    });
  }

  const btnSendChat = $('btn-send-report-chat');
  if (btnSendChat) btnSendChat.addEventListener('click', sendReportToChat);

  // Initialize workspace URIs & listeners
  if (sidecar?.getWorkspaceUris) {
    try {
      workspaceUris = await sidecar.getWorkspaceUris();
    } catch {
      workspaceUris = [];
    }
    if (sidecar.onWorkspaceChange) {
      sidecar.onWorkspaceChange((uris) => {
        workspaceUris = uris || [];
        selectedRepoPath = '';
        syncGit({ silent: true });
      });
    }
  }

  await syncGit({ silent: true });
  setInterval(() => {
    if (!document.hidden) {
      syncGit({ silent: true });
    }
  }, 8000);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      syncGit({ silent: true });
    }
  });
}

// Run init when DOM is loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
