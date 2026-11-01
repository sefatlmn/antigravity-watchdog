// Watchdog pane for Claude Code: the Antigravity side panel, drawn with Claude Code's
// own elements. It runs the same panel server (sidecars/panel/main.mjs) and makes its
// decisions with the same view model (sidecars/panel/view-model.js) as the web panel,
// so only the drawing differs between the two hosts.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  auditAction,
  goalText,
  jobView,
  partitionJobs,
  proposalView,
  timeAgo,
} from '../sidecars/panel/view-model.js'
import type { Dashboard, Doc, GoalEdit, Job, Project, Repo, Server, Tab } from '../types'
import { fillChatBox, registerAgentHooks, repoRoot, requestQueuedAudits, requestSynthesis } from './agents'

const PANE = 'watchdog'
const TITLE = 'Watchdog'
const POLL_MS = 5000
const ARCHIVED_SHOWN = 10
const SEND_HINT = 'is in your chat box: press Enter to start it.'
const RESTARTS = 3

const EMPTY_DOC: Doc = { kind: 'none', title: '', badge: '', content: '', planId: '' }

const server = atom({ plugin: 'watchdog', key: 'server' } as const, { url: '', error: '' } as Server)
const dashboard = atom({ plugin: 'watchdog', key: 'dashboard' } as const, { activeRepos: [], jobs: [] } as Dashboard, {
  shape: 'dashboard-1',
})
const tab = atom({ plugin: 'watchdog', key: 'tab' } as const, 'audits' as Tab)
// The session's Git project, looked up for the folder `cwd`: `root` is '' outside one.
const project = atom({ plugin: 'watchdog', key: 'project' } as const, { cwd: '', root: '', checked: false } as Project)
const comment = atom({ plugin: 'watchdog', key: 'comment' } as const, '')
const doc = atom({ plugin: 'watchdog', key: 'doc' } as const, EMPTY_DOC)
const archiveOpen = atom({ plugin: 'watchdog', key: 'archiveOpen' } as const, false)
const goalEdit = atom({ plugin: 'watchdog', key: 'goalEdit' } as const, { editing: false, text: '' } as GoalEdit)

// Calls the panel server the way app.js's callApi does: POST, JSON, the host named.
async function api($: EngineInterface, path: string, body: Record<string, unknown> = {}): Promise<any> {
  const { url } = await read($, server)
  if (!url) throw new Error('the Watchdog panel server is not running')
  const at = new URL(url)
  const res = await $.http.fetch(`${at.origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sidecar-token': at.searchParams.get('token') ?? '' },
    body: JSON.stringify({ host: 'claude', ...body }),
  })
  const data = res.text ? JSON.parse(res.text) : {}
  if (!res.ok) throw new Error(data.error || `${res.status}`)
  return data
}

// Watchdog works on the session's own Git project, and only on that one.
async function projectRoot($: EngineInterface): Promise<string> {
  const cwd = await $.session.cwd()
  const known = await read($, project)
  if (known.checked && known.cwd === cwd) return known.root
  const root = await repoRoot($, cwd)
  await update($, project, () => ({ cwd, root, checked: true }))
  return root
}

async function workspace($: EngineInterface) {
  return { workspaceUris: [await projectRoot($)], exact: true }
}

async function refresh($: EngineInterface, path = '/api/dashboard') {
  try {
    const data = await api($, path, await workspace($))
    await update($, dashboard, () => ({ activeRepos: data.activeRepos ?? [], jobs: data.jobs ?? [], error: data.error }))
    return data as Dashboard
  } catch (err) {
    await update($, dashboard, d => ({ ...d, error: String((err as Error).message) }))
    return null
  }
}

async function activeRepo($: EngineInterface): Promise<Repo | null> {
  return (await read($, dashboard)).activeRepos[0] ?? null
}

// Runs one panel action: toasts its message or error, then redraws from fresh data.
async function act($: EngineInterface, run: () => Promise<string | undefined>) {
  try {
    const message = await run()
    if (message) $.ui.toast(message)
  } catch (err) {
    $.ui.toast(`Watchdog: ${(err as Error).message}`)
  }
  await refresh($)
}

let serverStarted = false

// Runs the shared panel server for this session, restarting it when it exits as
// Antigravity does for the sidecar (restart_policy "always"), a few times at most.
function ensureServer($: EngineInterface) {
  if (serverStarted) return
  serverStarted = true
  void (async () => {
    for (let attempt = 1; attempt <= RESTARTS; attempt++) {
      const child = $.process.spawn({
        argv: ['node', `${$.plugin.root}/sidecars/panel/main.mjs`],
        cwd: $.plugin.root,
        env: { WATCHDOG_HOST: 'claude', WATCHDOG_IN_SESSION: '1', WATCHDOG_REPO: await $.session.cwd() },
      })
      let error = 'The Watchdog panel server stopped.'
      try {
        for await (const { text } of child) {
          const found = /WATCHDOG_PANEL_URL=(\S+)/.exec(text)
          if (found?.[1]) {
            const url = found[1]
            await update($, server, () => ({ url, error: '' }))
            await refresh($)
          }
        }
      } catch (err) {
        error = `Could not run the Watchdog panel server (Node.js 18+ is required): ${(err as Error).message}`
      }
      await update($, server, () => ({ url: '', error }))
      await $.clock.sleep(attempt * 2000)
    }
  })()
  $.clock.every(POLL_MS, () => void refresh($))
}

async function openPane($: EngineInterface) {
  if (await projectRoot($)) ensureServer($)
  return $.ui.open({ id: PANE, title: TITLE })
}

// Re-queues an interrupted audit; the request that starts its agent again goes in the chat box.
async function continueAudit($: EngineInterface, job: Job, repoPath: string) {
  const res = await api($, '/api/continue-audit', { jobId: job.id, repoPath: job.repo_path || repoPath, sha: job.sha })
  if (res.completed) return `Audit for ${res.shortSha || job.short_sha} already completed.`
  await fillChatBox($, await requestQueuedAudits($, job.repo_path || repoPath))
  return `The audit of ${res.shortSha || job.short_sha} ${SEND_HINT}`
}

async function refreshNextSteps($: EngineInterface, repo: string) {
  const res = await api($, '/api/next-steps/refresh', { repo })
  if (!res.ok) throw new Error(res.error || 'Failed to dispatch synthesis agent')
  if (!res.inSession || !res.prompt) return 'Evaluating codebase and synthesizing plans…'
  await fillChatBox($, [await requestSynthesis($, repo, String(res.prompt), String(res.ctl))])
  return `The Next Steps refresh ${SEND_HINT}`
}

async function runAudit($: EngineInterface) {
  const repo = await activeRepo($)
  if (!repo) return $.ui.toast('No Git repository detected.')
  const note = await read($, comment)
  const action = auditAction(await read($, dashboard), repo, note)
  await act($, async () => {
    if (action.kind === 'continue-audit' && action.matchingJob) {
      return continueAudit($, action.matchingJob, repo.repoPath)
    }
    if (action.kind === 'send-comment' && action.runningJob) {
      const res = await api($, '/api/send-comment', { repoPath: repo.repoPath, comment: note.trim(), jobId: action.runningJob.id })
      // An audit agent running in this session also gets the note directly, as Antigravity's does.
      const conv = action.runningJob.conversation_id ?? ''
      if (conv.startsWith('claude-agent-')) await $.session.send({ to: { agentId: conv.slice('claude-agent-'.length) }, text: note.trim() })
      await update($, comment, () => '')
      return `Comment sent to in-progress audit for ${res.short_sha || 'commit'}.`
    }
    if (action.kind !== 'audit') return undefined
    const res = await api($, '/api/trigger', { repoPath: repo.repoPath, sha: action.latest?.sha || 'YOUNGEST', comment: note.trim() })
    await update($, comment, () => '')
    if (res.alreadyRunning) return res.message || res.error
    if (!res.ok || !res.job) throw new Error(res.reason || res.error || 'Could not queue review.')
    const requests = await requestQueuedAudits($, repo.repoPath)
    await fillChatBox($, requests)
    return requests.length > 0 ? `The audit of ${res.job.short_sha} ${SEND_HINT}` : `Queued Watchdog for ${res.job.short_sha}.`
  })
}

async function openPlan($: EngineInterface, planId: string, title: string, badge: string, planPath: string, planFile: string) {
  const repo = await activeRepo($)
  if (!repo) return
  await act($, async () => {
    const res = await api($, '/api/next-steps/plan', { repo: repo.repoPath, planPath, planFile })
    if (!res.ok || !res.content) throw new Error(res.error || 'Could not load plan markdown.')
    await update($, doc, () => ({ kind: 'plan' as const, title, badge, content: String(res.content), planId }))
    return undefined
  })
}

async function executePlan($: EngineInterface, planId: string) {
  const repo = await activeRepo($)
  if (!repo) return
  await act($, async () => {
    const res = await api($, '/api/next-steps/execute', { repo: repo.repoPath, planId })
    if (!res.ok) throw new Error(res.error || 'Execution dispatch failed.')
    await update($, doc, () => EMPTY_DOC)
    if (res.dispatched) return `Agent session started for "${res.title}".`
    if (res.prompt) {
      await $.prompt.fill({ text: String(res.prompt) })
      return `The plan for "${res.title}" is in the prompt box.`
    }
    return `Ready to execute "${res.title}".`
  })
}

export const register: Register = on => {
  registerAgentHooks(on)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'watchdog-panel',
      description: 'Open the Watchdog panel: audits, fix branches and Next Steps',
    })
    // Opened unasked only in a Git project and where it docks beside the chat;
    // elsewhere /watchdog-panel opens it.
    const docks = (await $.session.surfaces()).some(s => s !== 'terminal')
    if (docks && (await projectRoot($))) void openPane($)

    return next(e)
  })

  on('command.run', { command: 'watchdog-panel' }, async $ => {
    await openPane($)

    return { text: 'Watchdog panel opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Link, Markdown } = ui
    // The mobile app draws no fields yet: there the comment box and goal editor are left out.
    const Input = 'Input' in ui ? ui.Input : null
    const where = await read($, project)
    if (where.checked && !where.root) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text weight="semibold">Watchdog</Text>
          <Text>Watchdog works on Git projects, and this session's folder is not in a Git repository.</Text>
          <Text dimColor>{await $.session.cwd()}</Text>
          <Text dimColor>Open a project that has a Git repository, or run git init here, then reopen the panel.</Text>
        </Box>
      )
    }
    const srv = await read($, server)
    const data = await read($, dashboard)
    const repo = data.activeRepos[0] ?? null
    const current = await read($, tab)
    const shown = await read($, doc)
    const latest = repo ? repo.youngestCommit || repo.head : null
    const note = await read($, comment)
    const action = auditAction(data, repo, note)
    const branch = repo?.branch || 'main'
    const proposals = Array.isArray(repo?.proposals) ? repo.proposals : []
    const { recent, archived } = partitionJobs(data)

    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text weight="semibold">Watchdog</Text>
        <Box flexDirection="row" gap={1}>
          {srv.url !== '' && <Link href={`${srv.url}&repo=${encodeURIComponent(where.root)}`} label="Open full panel" />}
          <Button key="sync" onPress={() => act($, async () => {
            const synced = await refresh($, '/api/sync')
            const at = synced?.activeRepos[0]
            const head = at ? at.youngestCommit || at.head : null
            return at && head ? `Synced ${at.repoName} @ ${head.shortSha} (${head.relativeTime})` : 'Synced Git status'
          })}>
            Sync
          </Button>
        </Box>
      </Box>
    )

    const projectCard = (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text weight="semibold">
            {repo ? repo.repoName : 'Starting Watchdog…'}{' '}
            {repo && <Text dimColor>{branch}</Text>}
          </Text>
        </Box>
        {latest ? (
          <Text>
            <Text dimColor>Latest: </Text>
            <Text mono>{action.shortSha}</Text> {action.isAppliedFix && <Text color="success">Applied Fix </Text>}
            {latest.subject || '(no message)'} <Text dimColor>{latest.relativeTime ?? ''}</Text>
          </Text>
        ) : (
          <Text dimColor>{srv.error || data.error || (repo ? 'No commits found in project' : '')}</Text>
        )}
      </Box>
    )

    const tabs = (
      <Box flexDirection="row" gap={1}>
        <Button key="tab-audits" variant={current === 'audits' ? 'primary' : 'secondary'} onPress={() => update($, tab, () => 'audits' as Tab)}>
          Audits
        </Button>
        <Button key="tab-next-steps" variant={current === 'next-steps' ? 'primary' : 'secondary'} onPress={() => update($, tab, () => 'next-steps' as Tab)}>
          Next Steps {proposals.length > 0 && <Text dimColor>{proposals.length}</Text>}
        </Button>
      </Box>
    )

    if (shown.kind !== 'none') {
      const close = () => update($, doc, () => EMPTY_DOC)
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Text weight="semibold">
              {shown.badge !== '' && <Text dimColor>{shown.badge} </Text>}
              {shown.title}
            </Text>
            <Box flexDirection="row" gap={1}>
              {shown.kind === 'report' ? (
                <Button key="send-chat" onPress={async () => {
                  await $.prompt.fill({
                    text: `Here is the Watchdog audit report for commit \`${shown.planId}\`:\n\n${shown.content}\n\nPlease review the findings and let's address any identified issues.`,
                  })
                  $.ui.toast('Report placed in the prompt box.')
                }}>
                  Send to Chat
                </Button>
              ) : (
                <Button key="doc-execute" variant="primary" onPress={() => executePlan($, shown.planId)}>
                  Execute in Agent
                </Button>
              )}
              <Button key="doc-close" role="dismiss" onPress={close}>
                Close
              </Button>
            </Box>
          </Box>
          <Markdown text={shown.content} />
        </Box>
      )
    }

    const card = (job: Job, isArchived: boolean) => {
      const view = jobView(job)
      const badgeColor = view.badge?.kind === 'fix' ? 'success' : view.badge?.kind === 'warn' ? 'warning' : 'subtle'
      return (
        <Box key={`job-${job.id}`} flexDirection="column" borderStyle="round" paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Text>
              <Text mono weight="semibold">{job.short_sha}</Text> {(job.commit_msg || '').split('\n')[0]}
            </Text>
            {view.badge && <Text color={badgeColor}>{view.badge.label}</Text>}
          </Box>
          {job.summary && <Text dimColor>{job.summary}</Text>}
          {job.user_comment && <Text dimColor>Note: {job.user_comment}</Text>}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {view.isRunning && <Text color="warning">Auditing…</Text>}
            {view.isQueued && <Text color="warning">Queued</Text>}
            {view.isInterrupted && <Text color="warning">Interrupted</Text>}
            {view.isApplied && <Text color="success">Applied to {branch}</Text>}
            {view.isPassed && <Text color="success">Passed</Text>}
            {view.isInterrupted && (
              <Button key={`continue-${job.id}`} onPress={() => act($, () => continueAudit($, job, repo?.repoPath ?? ''))}>
                Continue Audit
              </Button>
            )}
            {view.hasFixToApply && (
              <Button key={`fix-${job.id}`} variant="primary" onPress={() => act($, async () => {
                const res = await api($, '/api/apply-fix', { repoPath: job.repo_path, sha: job.sha, mode: 'cherry-pick' })
                if (!res.ok) throw new Error(res.error || 'Could not apply fix.')
                return res.message || `Applied fix to ${res.branch}.`
              })}>
                Apply Fix to {branch}
              </Button>
            )}
            {view.hasReport && (
              <Button key={`report-${job.id}`} onPress={() => act($, async () => {
                const res = await api($, '/api/report', { reportPath: job.report_path || '' })
                if (!res.exists) throw new Error(`Report not found (${job.report_path}). If an audit is running, check back shortly.`)
                await update($, doc, () => ({ kind: 'report' as const, title: `Report — ${job.short_sha}`, badge: '', content: String(res.content), planId: job.short_sha }))
                return undefined
              })}>
                Report
              </Button>
            )}
            <Button key={`archive-${job.id}`} onPress={() => act($, async () => {
              await api($, '/api/archive-job', { jobId: job.id, archived: !isArchived })
              return isArchived ? 'Restored audit from archive' : 'Moved audit to archive'
            })}>
              {isArchived ? 'Restore' : 'Archive'}
            </Button>
          </Box>
        </Box>
      )
    }

    if (current === 'audits') {
      const isOpen = await read($, archiveOpen)
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          {projectCard}
          {tabs}
          {Input && (<Input
            key="comment"
            value={note}
            placeholder={action.runningJob
              ? `Send comment/guidance to in-progress audit (${action.runningJob.short_sha || action.shortSha})…`
              : 'Add a comment or focus note for this audit…'}
            onInput={value => update($, comment, () => value)}
            onSubmit={() => runAudit($)}
          />)}
          <Button
            key="run-audit"
            variant={action.disabled ? 'secondary' : 'primary'}
            onPress={() => (action.disabled ? undefined : runAudit($))}
          >
            {action.tone === 'warn' ? <Text color="warning">{action.label}</Text> : action.label}
          </Button>
          <Box flexDirection="row" justifyContent="space-between">
            <Text weight="semibold">Recent Audits</Text>
            <Text dimColor>{recent.length}</Text>
          </Box>
          {recent.length === 0 && (
            <Box flexDirection="column">
              <Text dimColor>No recent audits.</Text>
              <Text dimColor>Click above to audit the latest commit.</Text>
            </Box>
          )}
          {recent.map(job => card(job, false))}
          {archived.length > 0 && (
            <Button key="archive-toggle" plain onPress={() => update($, archiveOpen, open => !open)}>
              {isOpen ? '▾' : '▸'} Archived Audits <Text dimColor>{archived.length}</Text>
            </Button>
          )}
          {isOpen && archived.slice(0, ARCHIVED_SHOWN).map(job => card(job, true))}
        </Box>
      )
    }

    const editing = await read($, goalEdit)
    const repoKey = repo?.repoPath ?? ''
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {projectCard}
        {tabs}
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Text weight="semibold">Project Goal &amp; Direction</Text>
            {Input && repo && !editing.editing && (
              <Box flexDirection="row" gap={1}>
                <Button key="goal-refresh" onPress={() => act($, async () => {
                  const res = await api($, '/api/next-steps/goal', { repo: repoKey, refresh: true })
                  if (!res.ok) throw new Error(res.error || 'Could not refresh project goal.')
                  return 'Project goal updated from codebase'
                })}>
                  Review
                </Button>
                <Button key="goal-edit" onPress={() => update($, goalEdit, () => ({ editing: true, text: goalText(repo) }))}>
                  Edit
                </Button>
              </Box>
            )}
          </Box>
          {Input && editing.editing ? (
            <Box flexDirection="column" gap={1}>
              <Input
                key="goal-input"
                rows={2}
                value={editing.text}
                placeholder="Define the primary goal or milestone for this project…"
                onInput={value => update($, goalEdit, g => ({ ...g, text: value }))}
                onSubmit={value => act($, async () => {
                  if (!value.trim()) return undefined
                  await api($, '/api/next-steps/goal', { repo: repoKey, goal: value.trim() })
                  await update($, goalEdit, () => ({ editing: false, text: '' }))
                  return 'Project goal updated'
                })}
                submitLabel="Save Goal"
              />
              <Box flexDirection="row" gap={1}>
                <Button key="goal-cancel" onPress={() => update($, goalEdit, () => ({ editing: false, text: '' }))}>
                  Cancel
                </Button>
                <Button key="goal-reset" onPress={() => act($, async () => {
                  await api($, '/api/next-steps/goal', { repo: repoKey, clear: true })
                  await update($, goalEdit, () => ({ editing: false, text: '' }))
                  return 'Project goal reset'
                })}>
                  Reset
                </Button>
              </Box>
            </Box>
          ) : (
            <Text>{goalText(repo)}</Text>
          )}
        </Box>
        <Box flexDirection="row" justifyContent="space-between">
          <Text weight="semibold">Proposed Next Steps</Text>
          {repo && (repo.synthesizing ? (
            <Button key="synth-stop" onPress={() => act($, async () => {
              await api($, '/api/next-steps/cancel', { repo: repoKey })
              return 'Synthesis cancelled'
            })}>
              Stop
            </Button>
          ) : (
            <Button key="synth-refresh" onPress={() => act($, () => refreshNextSteps($, repoKey))}>
              Refresh
            </Button>
          ))}
        </Box>
        {!repo && <Text dimColor>No repository detected. Open a Git workspace to view and synthesize next steps.</Text>}
        {repo?.synthesizing && (
          <Box flexDirection="column">
            <Text color="warning">Agent analyzing codebase &amp; goals…</Text>
            <Text dimColor>Synthesizing 4 pragmatic implementation plans</Text>
          </Box>
        )}
        {repo && !repo.synthesizing && proposals.length === 0 && (
          <Box flexDirection="column" gap={1}>
            <Text dimColor>No proposals generated yet.</Text>
            <Button key="synth-now" variant="primary" onPress={() => act($, () => refreshNextSteps($, repoKey))}>
              Synthesize 4 Next Steps
            </Button>
          </Box>
        )}
        {repo && !repo.synthesizing && proposals.map(p => {
          const view = proposalView(p, repo)
          const started = view.startedAt ? timeAgo(view.startedAt) : ''
          return (
            <Box key={`proposal-${view.id}`} flexDirection="column" borderStyle="round" paddingX={1}>
              <Box flexDirection="row" justifyContent="space-between">
                <Text dimColor>{view.badge}  {view.difficulty}</Text>
                {started !== '' && <Text dimColor>{started}</Text>}
              </Box>
              <Text weight="semibold">{view.title}</Text>
              {view.description !== '' && <Text dimColor>{view.description}</Text>}
              {view.goals.map((goal, i) => (
                <Text key={`goal-${view.id}-${i}`}>
                  <Text color="success">✓</Text> {goal}
                </Text>
              ))}
              {view.execSummary !== '' && <Text dimColor>{view.execSummary}</Text>}
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                {view.isExecRunning && <Text color="warning">Executing…</Text>}
                {view.isExecCompleted && <Text color="success">Executed</Text>}
                {view.isExecInterrupted && <Text color="warning">Interrupted</Text>}
                {view.action.kind === 'cancel-execution' ? (
                  <Button key={`stop-${view.id}`} onPress={() => act($, async () => {
                    await api($, '/api/next-steps/cancel-execution', { repo: repoKey, planId: view.id })
                    return 'Execution stopped.'
                  })}>
                    Stop
                  </Button>
                ) : (
                  <Button key={`exec-${view.id}`} variant={view.action.tone === 'secondary' ? 'secondary' : 'primary'} onPress={() => executePlan($, view.id)}>
                    {view.action.label}
                  </Button>
                )}
                <Button key={`plan-${view.id}`} onPress={() => openPlan($, view.id, view.title, view.badge, view.planPath, view.planFile)}>
                  Review Plan
                </Button>
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}
