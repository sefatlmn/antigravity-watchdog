// State contract for the Claude Code pane (hooks/register.tsx). The data shapes are
// what the shared panel server (sidecars/panel/main.mjs) returns from /api/dashboard;
// only the fields the pane reads are named.

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

export type Server = { url: string; error: string }

export type Tab = 'audits' | 'next-steps'

export type Project = { cwd: string; root: string; checked: boolean }

// The document shown over the tabs: an audit report or a Next Steps plan, as the
// web panel's report card and plan modal.
export type Doc = {
  kind: 'none' | 'report' | 'plan'
  title: string
  badge: string
  content: string
  planId: string
}

export type GoalEdit = { editing: boolean; text: string }

// What one Watchdog agent running in the session may do (hooks/agents.ts): the folders
// it may write in (the first is where it may also `git add` and `git commit`), and the
// controller it reports back to.
export type AgentGrant = {
  kind: 'audit' | 'synthesis'
  roots: string[]
  ctl: string
  jobId: string
}

declare module 'claude-code' {
  interface PluginState {
    watchdog: {
      server: Server
      dashboard: Shaped<Dashboard>
      tab: Tab
      project: Project
      comment: string
      doc: Doc
      archiveOpen: boolean
      goalEdit: GoalEdit
      agents: Record<string, AgentGrant>
      pending: Record<string, AgentGrant>
    }
  }
}
