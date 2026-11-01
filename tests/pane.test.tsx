import { expect, mock, test } from 'claude-code/testing'

const REPO = '/work/app'
const URL_LINE = 'WATCHDOG_PANEL_URL=http://127.0.0.1:9/?token=t\n'

const PANE = {
  plugin: 'watchdog',
  component: 'Pane',
  requestId: 'watchdog',
  props: {
    title: 'Watchdog',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const HEAD = { sha: 'abc1234def', shortSha: 'abc1234', subject: 'feat: add login', relativeTime: '2m ago' }

const DASHBOARD = {
  activeRepos: [
    {
      repoPath: REPO,
      repoName: 'app',
      branch: 'main',
      head: HEAD,
      youngestCommit: HEAD,
      goal: { goal: 'Ship v2' },
      proposals: [{ id: 'p1', badge: 'UI', difficulty: 'Low', title: 'Polish the login form', summary: 'Tidy states.' }],
      executions: {},
      synthesizing: false,
    },
  ],
  jobs: [
    {
      id: 'app-old1111',
      repo_path: REPO,
      sha: 'old1111aaa',
      short_sha: 'old1111',
      commit_msg: 'fix: crash on empty list',
      status: 'completed',
      verdict: 'FIXED_ON_BRANCH',
      summary: 'Fixed a null check.',
      fix_branch: 'fix/watchdog-old1111',
      fixes_committed: true,
      report_path: `${REPO}/.antigravity/audits/review-old1111.md`,
    },
  ],
}

const ran = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const CLAIM = {
  ok: true,
  ctl: '/plugin/scripts/watchdog_ctl.py',
  jobs: [{ id: 'app-abc1234', short_sha: 'abc1234', repo_path: REPO, worktree_path: '/wt/app-abc1234', prompt: 'Audit abc1234.' }],
}

test('the pane shows its Git project and its buttons start the work, on terminal and desktop', async ($, on) => {
  const calls: { path: string; body: any }[] = []
  const filled: string[] = []
  on('command.register', () => ({ value: { command: 'watchdog-panel' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: `${REPO}/src` }))
  // A desktop session in a Git project opens the pane, and so starts the server, by itself.
  on('session.surfaces', () => ({ value: ['desktop'] }))
  const clock = mock.clock(on)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    if (argv[0] === 'git') return ran(0, `${REPO}\n`)
    return ran(0, JSON.stringify(argv[2] === 'claim' ? CLAIM : { ok: true }))
  })
  on('fs.write', () => ({ value: undefined }))
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  // The panel server prints its URL once, then stays up: asleep on the mocked clock,
  // which the kit does not wait for.
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: URL_LINE }
    await clock.sleep(24 * 60 * 60 * 1000)
  })
  on('http.fetch', (_, e) => {
    const path = new URL(e.url).pathname
    calls.push({ path, body: JSON.parse(String(e.init?.body ?? '{}')) })
    const body =
      path === '/api/dashboard' ? DASHBOARD
      : path === '/api/trigger' ? { ok: true, job: { id: 'app-abc1234', repo_name: 'app', short_sha: 'abc1234' } }
      : { ok: true, message: 'Applied fix to main.' }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: `${REPO}/src`, surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    filled.length = 0
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /Fixed a null check/ })).toBeDefined()
    // The pane asks for exactly its project's Git root, never other repositories.
    expect(calls.find(c => c.path === '/api/dashboard')?.body).toMatchObject({ workspaceUris: [REPO], exact: true })
    expect(await ui.find({ type: 'Text', text: /^Ready$/ })).toBeDefined()

    await ui.press({ key: 'fix-app-old1111' })
    expect(calls.map(c => c.path)).toContain('/api/apply-fix')
    expect(toasts).toContain('Applied fix to main.')

    // Audit: queue the commit, then put the request that starts the auditor in the chat box.
    await ui.press({ key: 'run-audit' })
    expect(calls.map(c => c.path)).toContain('/api/trigger')
    expect(filled).toHaveLength(1)
    expect(filled[0]).toContain('watchdog:watchdog-auditor')
    expect(toasts.at(-1)).toContain('press Enter')

    await ui.press({ key: 'tab-next-steps' })
    expect(await ui.find({ type: 'Text', text: /Polish the login form/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Ship v2/ })).toBeDefined()

    await ui.press({ key: 'tab-audits' })
    await ui.unmount()
  }
})

test('outside a Git project the pane says so, and does not open by itself', async ($, on) => {
  let opened = 0
  let serverStarted = false
  on('command.register', () => ({ value: { command: 'watchdog-panel' } }))
  on('ui.open', () => {
    opened++
    return { value: { isPlaced: true } }
  })
  on('session.cwd', () => ({ value: '/home/me/notes' }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('process.run', () => ran(128, ''))
  on('process.spawn', async function* () {
    serverStarted = true
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/home/me/notes', surface: 'desktop', isInteractive: true })
  expect(opened).toBe(0)
  expect(serverStarted).toBe(false)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Watchdog works on Git projects/ })).toBeDefined()
    expect(await ui.find({ key: 'run-audit' })).toBeUndefined()
    await ui.unmount()
  }
})
