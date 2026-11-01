// Types for the Watchdog plugin's code. Commit, Job, Proposal, Repo and Dashboard are what
// the panel server (sidecars/panel/main.mjs) returns from /api/dashboard, as the shared
// view model (sidecars/panel/view-model.js) reads them; only the fields it reads are named.
// AgentGrant and the state below belong to the Claude Code hooks module (hooks/agents.ts).

export type Commit = {
  sha: string
  shortSha?: string
  subject?: string
  relativeTime?: string
  isDocsOnly?: boolean
  isAutoReview?: boolean
}

export type Job = {
  id: string
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
  report_path?: string
  conversation_id?: string | null
  archived?: boolean
}

export type Proposal = { id?: string; title?: string; [field: string]: unknown }

export type Repo = {
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

// What one Watchdog audit agent running in the session may do (hooks/agents.ts): the
// folders it may write in (the first is where it may also `git add` and `git commit`), and
// the controller it reports back to.
export type AgentGrant = {
  roots: string[]
  ctl: string
  jobId: string
}

declare module 'claude-code' {
  interface PluginState {
    watchdog: {
      agents: Record<string, AgentGrant>
      pending: Record<string, AgentGrant>
    }
  }
}
