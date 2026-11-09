// Types for the Antigravity Watchdog plugin. Commit, Job, Proposal, Repo and Dashboard are
// what the panel server (sidecars/panel/main.mjs) returns from /api/dashboard, and what
// the shared view model (sidecars/panel/view-model.js) reads.

export type Commit = {
  sha: string
  shortSha?: string
  short_sha?: string
  subject?: string
  relativeTime?: string
  isDocsOnly?: boolean
  isAutoReview?: boolean
}

export type Job = {
  id: string
  repo?: string
  repo_path?: string
  repo_name?: string
  sha?: string
  short_sha: string
  commit_msg?: string
  status?: string
  verdict?: string
  summary?: string
  user_comment?: string
  fix_branch?: string | null
  fixes_committed?: boolean
  fixes_applied?: boolean
  applied_commit_sha?: string
  applied_short_sha?: string
  report_path?: string
  conversation_id?: string | null
  archived?: boolean
}

export type Proposal = { id?: string; title?: string; [field: string]: unknown }

export type Repo = {
  repo?: string
  repoPath: string
  repoName: string
  branch?: string
  head?: Commit | null
  youngestCommit?: Commit | null
  goal?: { goal?: string } | string | null
  proposals?: Proposal[]
  executions?: Record<string, { status?: string; summary?: string; startedAt?: string }>
  synthesizing?: boolean
}

export type Dashboard = { activeRepos: Repo[]; jobs: Job[]; error?: string }
