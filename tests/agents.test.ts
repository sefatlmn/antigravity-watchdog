import { expect, test } from 'claude-code/testing'

const REPO = '/work/app'
const WORKTREE = '/data/worktrees/app-abc1234'
const CTL = '/plugin/scripts/watchdog_ctl.py'

const CLAIM = {
  ok: true,
  ctl: CTL,
  jobs: [{ id: 'app-abc1234', short_sha: 'abc1234', repo_path: REPO, worktree_path: WORKTREE, prompt: 'Audit abc1234.' }],
}

const ran = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

test('/watchdog audit claims the queued audit and asks Claude to start it, with the tool result', async ($, on) => {
  const ctlCalls: string[][] = []
  const written: Record<string, string> = {}
  on('session.cwd', () => ({ value: REPO }))
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    if (argv[0] === 'git') return ran(`${REPO}\n`)
    ctlCalls.push(argv.slice(2))
    return ran(JSON.stringify(argv[2] === 'claim' ? CLAIM : { ok: true }))
  })
  on('fs.write', (_, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  on('tool.call', () => ({ result: { text: 'Queued Watchdog audit.' } }))

  const result = (await $.tool.call({ tool: 'mcp__plugin_watchdog_watchdog__watchdog_audit', input: {} } as never)) as { context?: string[] }

  const taskFile = `${REPO}/.antigravity/tasks/audit-abc1234.md`
  expect(ctlCalls.map(c => c[0])).toEqual(['claim'])
  expect(written[taskFile]).toBe('Audit abc1234.')
  expect(result.context?.[0]).toContain('watchdog:watchdog-auditor')
  expect(result.context?.[0]).toContain(taskFile)
})

test('a Watchdog audit agent may do only what an audit needs', async ($, on) => {
  // The grant launchQueuedAudits stores for a started auditor.
  on('state.get', (_, e, next) =>
    e.plugin === 'watchdog' && e.key === 'agents'
      ? { value: { value: { 'agent-1': { kind: 'audit', roots: [WORKTREE, `${REPO}/.antigravity/audits`], ctl: CTL, jobId: 'app-abc1234' } }, version: 1 } }
      : next(e),
  )
  on('tool.check', () => ({ decision: 'ask' as const }))
  const check = (tool: string, input: unknown, agentId?: string) =>
    $.tool.check({ tool, input, agentId } as never).then(r => (r as { decision: string }).decision)

  // Allowed: its worktree and report folder, read-only git, checks, git commit in the worktree, reporting back.
  expect(await check('Write', { file_path: `${WORKTREE}/src/fix.ts` }, 'agent-1')).toBe('allow')
  expect(await check('Write', { file_path: `${REPO}/.antigravity/audits/review-abc1234.md` }, 'agent-1')).toBe('allow')
  expect(await check('Bash', { command: `cd "${WORKTREE}" && git diff HEAD~1 && npm test` }, 'agent-1')).toBe('allow')
  expect(await check('Bash', { command: `git -C ${WORKTREE} commit -m "fix: x [auto-review]"` }, 'agent-1')).toBe('allow')
  expect(await check('Bash', { command: `python3 "${CTL}" complete --repo "${REPO}" --sha abc --verdict PASS` }, 'agent-1')).toBe('allow')
  expect(await check('Bash', { command: 'npm run dev -- --port 4399 > /dev/null 2>&1 &' }, 'agent-1')).toBe('allow')
  expect(await check('Read', { file_path: '/etc/hosts' }, 'agent-1')).toBe('allow')

  // Denied: the main checkout, pushing, the network, deleting, sneaking a command in, other tools.
  expect(await check('Write', { file_path: `${REPO}/src/app.ts` }, 'agent-1')).toBe('deny')
  expect(await check('Write', { file_path: `${WORKTREE}/../../escape.ts` }, 'agent-1')).toBe('deny')
  expect(await check('Bash', { command: 'git commit -m "in the main checkout"' }, 'agent-1')).toBe('deny')
  expect(await check('Bash', { command: `cd ${WORKTREE} && git push origin HEAD` }, 'agent-1')).toBe('deny')
  expect(await check('Bash', { command: 'curl -s https://example.com' }, 'agent-1')).toBe('deny')
  expect(await check('Bash', { command: `rm -rf ${REPO}` }, 'agent-1')).toBe('deny')
  expect(await check('Bash', { command: 'git status; npm install left-pad' }, 'agent-1')).toBe('deny')
  expect(await check('Bash', { command: 'echo $(cat ~/.ssh/id_rsa)' }, 'agent-1')).toBe('deny')
  expect(await check('Bash', { command: 'echo hi > ~/.bashrc' }, 'agent-1')).toBe('deny')
  expect(await check('Bash', { command: 'find . -name x -delete' }, 'agent-1')).toBe('deny')
  expect(await check('WebFetch', { url: 'https://example.com' }, 'agent-1')).toBe('deny')

  // The main session and other agents are left to the person's own settings.
  expect(await check('Bash', { command: 'git push' })).toBe('ask')
  expect(await check('Bash', { command: 'git push' }, 'someone-else')).toBe('ask')
})

test('starting an agent is left to the session\'s own permission checks', async ($, on) => {
  // Beneath: what the session's own settings would answer.
  on('tool.check', () => ({ decision: 'allow' as const }))
  const check = (subagentType: string) =>
    $.tool.check({ tool: 'Agent', input: { subagent_type: subagentType, prompt: 'x' } } as never).then(r => (r as { decision: string }).decision)

  // Raised by the test, not by Watchdog: the session's answer stands, even for Watchdog's own types.
  expect(await check('watchdog:watchdog-auditor')).toBe('allow')
  expect(await check('general-purpose')).toBe('allow')
})
