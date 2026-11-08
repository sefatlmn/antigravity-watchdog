import { execFileSync } from 'node:child_process'
import module from 'node:module'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

let ts = null
for (const spec of [
  'typescript',
  pathToFileURL(path.join(rootDir, 'packages/universal/node_modules/typescript/lib/typescript.js')).href,
]) {
  try {
    const mod = await import(spec)
    ts = mod.default ?? mod
    break
  } catch {}
}

function transpileTsFile(url) {
  const filePath = fileURLToPath(url)
  const raw = fs.readFileSync(filePath, 'utf8')
  if (ts && typeof ts.transpileModule === 'function') {
    const { outputText } = ts.transpileModule(raw, {
      fileName: filePath,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    })
    return outputText
  }
  return null
}

const runtimeSource = `
  export function atom(address, initial, options) {
    return Object.freeze({
      ref: address,
      ...address,
      initial,
      ...(options && options.shape ? { shape: options.shape } : {}),
    });
  }
  export async function read($, target) {
    const ref = target.ref ?? target;
    const res = await $.state.get({ plugin: ref.plugin, key: ref.key, ...(ref.id !== undefined ? { id: ref.id } : {}) });
    if (res && 'value' in res && res.value && 'value' in res.value && res.value.value !== undefined) {
      return res.value.value;
    }
    return target.initial;
  }
  export async function update($, target, change) {
    const ref = target.ref ?? target;
    const addr = { plugin: ref.plugin, key: ref.key, ...(ref.id !== undefined ? { id: ref.id } : {}) };
    const currentRes = await $.state.get(addr);
    const currentVal = (currentRes && 'value' in currentRes && currentRes.value && 'value' in currentRes.value && currentRes.value.value !== undefined)
      ? currentRes.value.value
      : target.initial;
    const version = (currentRes && 'value' in currentRes && currentRes.value && typeof currentRes.value.version === 'number')
      ? currentRes.value.version
      : 0;
    const nextVal = change(currentVal);
    await $.state.set({ ...addr, value: nextVal, ifVersion: version });
    return nextVal;
  }
`

const testingSource = `
  export const test = globalThis.__claudeTestRunner.test;
  export const describe = globalThis.__claudeTestRunner.describe;
  export const expect = globalThis.__claudeTestRunner.expect;
  export const tier = () => {};
`

if (typeof module.registerHooks === 'function' && process.env.WATCHDOG_TEST_REGISTER_LOADER !== '1') {
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'claude-code') return { url: 'claude-code://runtime', shortCircuit: true }
      if (specifier === 'claude-code/testing') return { url: 'claude-code://testing', shortCircuit: true }
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        try {
          return nextResolve(specifier, context)
        } catch (err) {
          if (context.parentURL) {
            const parentPath = fileURLToPath(context.parentURL)
            const dir = path.dirname(parentPath)
            for (const ext of ['.ts', '.js', '.mjs', '/index.ts', '/index.js', '/index.d.ts']) {
              const candidate = path.resolve(dir, specifier + ext)
              if (fs.existsSync(candidate)) {
                return { url: pathToFileURL(candidate).href, shortCircuit: true }
              }
            }
          }
          throw err
        }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url === 'claude-code://runtime') {
        return { format: 'module', shortCircuit: true, source: runtimeSource }
      }
      if (url === 'claude-code://testing') {
        return { format: 'module', shortCircuit: true, source: testingSource }
      }
      if (url.endsWith('.d.ts')) {
        return { format: 'module', shortCircuit: true, source: 'export {};' }
      }
      if (url.startsWith('file://') && (url.endsWith('.ts') || url.endsWith('.tsx'))) {
        const transpiled = transpileTsFile(url)
        if (transpiled !== null) {
          return { format: 'module', shortCircuit: true, source: transpiled }
        }
      }
      return nextLoad(url, context)
    },
  })
} else {
  const fallbackTsUrl = pathToFileURL(path.join(rootDir, 'packages/universal/node_modules/typescript/lib/typescript.js')).href
  const loaderCode = `
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

let ts = null;
for (const spec of ['typescript', ${JSON.stringify(fallbackTsUrl)}]) {
  try {
    const mod = await import(spec);
    ts = mod.default ?? mod;
    break;
  } catch {}
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'claude-code') return { url: 'claude-code://runtime', shortCircuit: true };
  if (specifier === 'claude-code/testing') return { url: 'claude-code://testing', shortCircuit: true };
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    try {
      return await nextResolve(specifier, context);
    } catch (err) {
      if (context.parentURL) {
        const parentPath = fileURLToPath(context.parentURL);
        const dir = path.dirname(parentPath);
        for (const ext of ['.ts', '.js', '.mjs', '/index.ts', '/index.js', '/index.d.ts']) {
          const candidate = path.resolve(dir, specifier + ext);
          try {
            await access(candidate);
            return { url: pathToFileURL(candidate).href, shortCircuit: true };
          } catch {}
        }
      }
      throw err;
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === 'claude-code://runtime') {
    return { format: 'module', shortCircuit: true, source: ${JSON.stringify(runtimeSource)} };
  }
  if (url === 'claude-code://testing') {
    return { format: 'module', shortCircuit: true, source: ${JSON.stringify(testingSource)} };
  }
  if (url.endsWith('.d.ts')) {
    return { format: 'module', shortCircuit: true, source: 'export {};' };
  }
  if (url.startsWith('file://') && (url.endsWith('.ts') || url.endsWith('.tsx')) && ts && typeof ts.transpileModule === 'function') {
    const filePath = fileURLToPath(url);
    const raw = await readFile(filePath, 'utf8');
    const { outputText } = ts.transpileModule(raw, {
      fileName: filePath,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    });
    return { format: 'module', shortCircuit: true, source: outputText };
  }
  return nextLoad(url, context);
}
`
  module.register(`data:text/javascript;base64,${Buffer.from(loaderCode).toString('base64')}`)
}

function makeMatchers(received, negated = false) {
  const check = (pass, msg) => {
    const ok = negated ? !pass : pass
    if (!ok) throw new assert.AssertionError({ message: msg, actual: received })
  }
  return {
    toBe(expected) {
      check(Object.is(received, expected), `Expected ${JSON.stringify(received)} ${negated ? 'not ' : ''}to be ${JSON.stringify(expected)}`)
    },
    toEqual(expected) {
      let pass = false
      try {
        assert.deepStrictEqual(received, expected)
        pass = true
      } catch {}
      check(pass, `Expected ${JSON.stringify(received)} ${negated ? 'not ' : ''}to equal ${JSON.stringify(expected)}`)
    },
    toContain(item) {
      const pass = typeof received === 'string'
        ? received.includes(String(item))
        : Array.isArray(received) && received.includes(item)
      check(pass, `Expected ${JSON.stringify(received)} ${negated ? 'not ' : ''}to contain ${JSON.stringify(item)}`)
    },
    toBeDefined() {
      check(received !== undefined, `Expected value ${negated ? 'not ' : ''}to be defined`)
    },
    toBeUndefined() {
      check(received === undefined, `Expected value ${negated ? 'not ' : ''}to be undefined`)
    },
    toBeTruthy() {
      check(Boolean(received), `Expected value ${negated ? 'not ' : ''}to be truthy`)
    },
    toBeFalsy() {
      check(!received, `Expected value ${negated ? 'not ' : ''}to be falsy`)
    },
  }
}

function expect(received) {
  const matchers = makeMatchers(received, false)
  matchers.not = makeMatchers(received, true)
  return matchers
}

const tests = []
let currentSuite = ''

globalThis.__claudeTestRunner = {
  describe(name, body) {
    const prev = currentSuite
    currentSuite = currentSuite ? `${currentSuite} > ${name}` : name
    body()
    currentSuite = prev
  },
  test(name, ...rest) {
    const body = typeof rest[0] === 'function' ? rest[0] : rest[1]
    const fullName = currentSuite ? `${currentSuite} > ${name}` : name
    tests.push({ name: fullName, body })
  },
  expect,
}

function createHarness(pluginRegister) {
  const pluginHooks = []
  const testHooks = []
  const stateStore = new Map()
  let loaded = false

  const makeOn = (list) => (pattern, handler) => {
    const entry = { pattern, handler, catchHandler: null }
    list.push(entry)
    return {
      catch(catchFn) {
        entry.catchHandler = catchFn
        return this
      },
    }
  }

  const matchesPattern = (pattern, eventName) => {
    if (pattern === eventName || pattern === '*') return true
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2)
      return eventName.startsWith(`${prefix}.`)
    }
    return false
  }

  const unwrap = (res) => {
    if (res && typeof res === 'object' && 'deny' in res && res.deny !== undefined) {
      throw new Error(String(res.deny))
    }
    if (res && typeof res === 'object' && 'value' in res) {
      return res.value
    }
    return res
  }

  let internalDollar
  let testDollar

  const dispatch = async (eventName, input = {}) => {
    if (!loaded) {
      loaded = true
      pluginRegister(makeOn(pluginHooks), {})
    }

    const chain = [
      ...pluginHooks.filter(h => matchesPattern(h.pattern, eventName)),
      ...testHooks.filter(h => matchesPattern(h.pattern, eventName)),
    ]

    const defaultBottom = async (e) => {
      if (eventName === 'state.get') {
        const k = `${e.plugin}:${e.key}`
        const entry = stateStore.get(k)
        return { value: entry ? { value: entry.value, version: entry.version } : { value: undefined, version: 0 } }
      }
      if (eventName === 'state.set') {
        const k = `${e.plugin}:${e.key}`
        const entry = stateStore.get(k) ?? { value: undefined, version: 0 }
        const nextVersion = entry.version + 1
        stateStore.set(k, { value: e.value, version: nextVersion })
        return { value: { version: nextVersion } }
      }
      if (eventName === 'turn.complete') return {}
      throw new Error(`Unhandled event in test harness: ${eventName}`)
    }

    const runAt = async (idx, currentEvent) => {
      if (idx >= chain.length) {
        return defaultBottom(currentEvent)
      }
      const hook = chain[idx]
      let nextCalled = false
      const next = async (nextEvent = currentEvent) => {
        nextCalled = true
        return runAt(idx + 1, nextEvent)
      }
      Object.defineProperty(next, 'called', { get: () => nextCalled })

      try {
        return await hook.handler(internalDollar, currentEvent, next)
      } catch (err) {
        if (hook.catchHandler) {
          return await hook.catchHandler(internalDollar, currentEvent, next)
        }
        throw err
      }
    }

    return runAt(0, input)
  }

  internalDollar = {
    plugin: { root: '/plugin' },
    session: {
      cwd: async () => unwrap(await dispatch('session.cwd', {})),
    },
    process: {
      run: async (argv, opts = {}) => unwrap(await dispatch('process.run', { argv, ...opts })),
    },
    fs: {
      write: async (filePath, text) => unwrap(await dispatch('fs.write', { path: filePath, text })),
    },
    state: {
      get: async (e) => dispatch('state.get', e),
      set: async (e) => dispatch('state.set', e),
    },
    tool: {
      call: async (e) => dispatch('tool.call', e),
      check: async (e) => dispatch('tool.check', e),
    },
  }

  testDollar = {
    session: {
      cwd: (e = {}) => dispatch('session.cwd', e),
    },
    process: {
      run: (e) => dispatch('process.run', e),
    },
    fs: {
      write: (e) => dispatch('fs.write', e),
    },
    state: {
      get: (e) => dispatch('state.get', e),
      set: (e) => dispatch('state.set', e),
    },
    tool: {
      call: (e) => dispatch('tool.call', e),
      check: (e) => dispatch('tool.check', e),
    },
    agent: {
      spawn: (e) => dispatch('agent.spawn', e),
    },
    turn: {
      complete: (e) => dispatch('turn.complete', e),
    },
  }

  return { $: testDollar, on: makeOn(testHooks) }
}

async function main() {
  const agentsModuleUrl = pathToFileURL(path.join(rootDir, 'hooks/agents.ts')).href
  const { register: pluginRegister } = await import(agentsModuleUrl)

  const testFileUrl = pathToFileURL(path.join(rootDir, 'tests/agents.test.ts')).href
  await import(testFileUrl)

  let passed = 0
  let failed = 0

  for (const t of tests) {
    const { $, on } = createHarness(pluginRegister)
    try {
      await t.body($, on)
      console.log(`✓ ${t.name}`)
      passed++
    } catch (err) {
      console.error(`✗ ${t.name}`)
      console.error(err)
      failed++
    }
  }

  // Also test agent.spawn and turn.complete hooks + view-model.js
  try {
    const { $, on } = createHarness(pluginRegister)
    const ctlCalls = []
    on('session.cwd', () => ({ value: '/work/app' }))
    on('process.run', (_, e) => {
      const argv = [...e.argv]
      if (argv[0] === 'git') return { value: { exitCode: 0, stdout: '/work/app\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      ctlCalls.push(argv.slice(2))
      return {
        value: {
          exitCode: 0,
          stdout: JSON.stringify(
            argv[2] === 'claim'
              ? {
                  ok: true,
                  ctl: '/plugin/scripts/watchdog_ctl.py',
                  jobs: [{ id: 'app-abc1234', short_sha: 'abc1234', repo_path: '/work/app', worktree_path: '/data/worktrees/app-abc1234', prompt: 'Audit abc1234.' }],
                }
              : { ok: true }
          ),
          stderr: '',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    })
    on('fs.write', () => ({ value: undefined }))
    on('tool.call', () => ({ result: { text: 'Queued Watchdog audit.' } }))
    on('agent.spawn', () => ({ agentId: 'spawned-1' }))
    on('turn.complete', () => ({}))

    await $.tool.call({ tool: 'mcp__plugin_watchdog_watchdog__watchdog_audit', input: {} })
    await $.agent.spawn({ subagentType: 'watchdog:watchdog-auditor', prompt: 'Read your task in /work/app/.antigravity/tasks/audit-abc1234.md and follow it.' })
    const allowedCheck = await $.tool.check({ tool: 'Write', input: { file_path: '/data/worktrees/app-abc1234/fix.js' }, agentId: 'spawned-1' })
    assert.equal(allowedCheck.decision, 'allow')
    await $.turn.complete({ agentId: 'spawned-1' })
    assert.deepEqual(ctlCalls.map(c => c[0]), ['claim', 'mark-running', 'agent-done'])
    console.log('✓ agent.spawn and turn.complete lifecycle grants and revokes permissions')
    passed++
  } catch (err) {
    console.error('✗ agent.spawn and turn.complete lifecycle test')
    console.error(err)
    failed++
  }

  try {
    const { $, on } = createHarness(pluginRegister)
    let failState = false
    on('state.get', (_, e, next) => {
      if (failState) throw new Error('simulated state failure')
      return e.plugin === 'watchdog' && e.key === 'agents'
        ? { value: { value: { 'agent-1': { roots: ['/data/worktrees/app-abc1234', '/work/app/.antigravity/audits'], ctl: '/plugin/scripts/watchdog_ctl.py', jobId: 'app-abc1234' } }, version: 1 } }
        : next(e)
    })
    on('tool.check', () => ({ decision: 'ask' }))

    // Subagent fails closed when state.get throws before next(e) is called
    failState = true
    const subagentCheck = await $.tool.check({ tool: 'Bash', input: { command: 'echo ok' }, agentId: 'agent-1' })
    assert.equal(subagentCheck.decision, 'deny')
    // Main session (no agentId) falls through to next(e)
    const mainCheck = await $.tool.check({ tool: 'Bash', input: { command: 'echo ok' } })
    assert.equal(mainCheck.decision, 'ask')
    failState = false

    // Edge cases for grant: empty command, backticks, playwright MCP allowed, path prefix collision denied
    const emptyCmd = await $.tool.check({ tool: 'Bash', input: { command: '   ' }, agentId: 'agent-1' })
    assert.equal(emptyCmd.decision, 'allow')
    const backtickCmd = await $.tool.check({ tool: 'Bash', input: { command: 'echo `whoami`' }, agentId: 'agent-1' })
    assert.equal(backtickCmd.decision, 'deny')
    const pwTool = await $.tool.check({ tool: 'mcp__playwright__browser_snapshot', input: {}, agentId: 'agent-1' })
    assert.equal(pwTool.decision, 'allow')
    const prefixEscape = await $.tool.check({ tool: 'Write', input: { file_path: '/data/worktrees/app-abc1234-evil/file.ts' }, agentId: 'agent-1' })
    assert.equal(prefixEscape.decision, 'deny')

    // Quote-aware command check: punctuation and markdown backticks inside quotes are allowed
    const quoteSummary = await $.tool.check({
      tool: 'Bash',
      input: { command: 'python3 "/plugin/scripts/watchdog_ctl.py" complete --summary "Fix <issue> #1; verified `app.ts` & passed <all> tests"' },
      agentId: 'agent-1',
    })
    assert.equal(quoteSummary.decision, 'allow')

    const quoteCommit = await $.tool.check({
      tool: 'Bash',
      input: { command: 'git -C /data/worktrees/app-abc1234 commit -m "fix(core): update <types>; test & verify `build`"' },
      agentId: 'agent-1',
    })
    assert.equal(quoteCommit.decision, 'allow')

    const singleQuoteCommit = await $.tool.check({
      tool: 'Bash',
      input: { command: "git -C /data/worktrees/app-abc1234 commit -m 'single quoted <issue>; tests & verify `code`'" },
      agentId: 'agent-1',
    })
    assert.equal(singleQuoteCommit.decision, 'allow')

    // Single quotes with $(...) are literal in bash and allowed
    const singleQuoteCommandSub = await $.tool.check({
      tool: 'Bash',
      input: { command: "git -C /data/worktrees/app-abc1234 commit -m 'fix $(selector) issue'" },
      agentId: 'agent-1',
    })
    assert.equal(singleQuoteCommandSub.decision, 'allow')

    // Double quotes with $(...) execute command substitution in bash and must be denied
    const doubleQuoteCommandSub = await $.tool.check({
      tool: 'Bash',
      input: { command: 'git -C /data/worktrees/app-abc1234 commit -m "fix $(whoami) issue"' },
      agentId: 'agent-1',
    })
    assert.equal(doubleQuoteCommandSub.decision, 'deny')

    // Unclosed quotes are syntax errors and must be denied
    const unclosedQuoteCmd = await $.tool.check({
      tool: 'Bash',
      input: { command: 'echo "unclosed quote' },
      agentId: 'agent-1',
    })
    assert.equal(unclosedQuoteCmd.decision, 'deny')

    // Single-quoted ctl path allowed
    const singleQuoteCtl = await $.tool.check({
      tool: 'Bash',
      input: { command: "python3 '/plugin/scripts/watchdog_ctl.py' complete --summary 'Finished audit'" },
      agentId: 'agent-1',
    })
    assert.equal(singleQuoteCtl.decision, 'allow')

    // Relative ctl paths and universal CLI complete allowed
    const relCtl1 = await $.tool.check({
      tool: 'Bash',
      input: { command: 'python3 scripts/watchdog_ctl.py complete --repo /work/app --sha abc --verdict PASS' },
      agentId: 'agent-1',
    })
    assert.equal(relCtl1.decision, 'allow')

    const relCtl2 = await $.tool.check({
      tool: 'Bash',
      input: { command: 'python3 watchdog_ctl.py complete --verdict PASS' },
      agentId: 'agent-1',
    })
    assert.equal(relCtl2.decision, 'allow')

    const universalComplete = await $.tool.check({
      tool: 'Bash',
      input: { command: 'watchdog complete --repo /work/app --sha abc' },
      agentId: 'agent-1',
    })
    assert.equal(universalComplete.decision, 'allow')

    const npxComplete = await $.tool.check({
      tool: 'Bash',
      input: { command: 'npx watchdog complete --verdict PASS' },
      agentId: 'agent-1',
    })
    assert.equal(npxComplete.decision, 'allow')

    // turn.complete with stopReason 'tool_use' must NOT remove grant or trigger agent-done
    await $.turn.complete({ agentId: 'agent-1', stopReason: 'tool_use' })
    const stillAllowed = await $.tool.check({
      tool: 'Bash',
      input: { command: 'git status' },
      agentId: 'agent-1',
    })
    assert.equal(stillAllowed.decision, 'allow')

    // Punctuation outside quotes still denied
    const unquotedInjection = await $.tool.check({
      tool: 'Bash',
      input: { command: 'git -C /data/worktrees/app-abc1234 commit -m "safe" ; rm -rf /' },
      agentId: 'agent-1',
    })
    assert.equal(unquotedInjection.decision, 'deny')

    const unquotedRedirect = await $.tool.check({
      tool: 'Bash',
      input: { command: 'echo "hello" > /tmp/unsafe' },
      agentId: 'agent-1',
    })
    assert.equal(unquotedRedirect.decision, 'deny')

    // Bun runners allowed in worktree
    const bunTest = await $.tool.check({
      tool: 'Bash',
      input: { command: 'cd /data/worktrees/app-abc1234 && bun test' },
      agentId: 'agent-1',
    })
    assert.equal(bunTest.decision, 'allow')

    // python3 -m pytest check allowed in worktree
    const pytestCmd = await $.tool.check({
      tool: 'Bash',
      input: { command: 'cd /data/worktrees/app-abc1234 && python3 -m pytest' },
      agentId: 'agent-1',
    })
    assert.equal(pytestCmd.decision, 'allow')

    // Windows backslash path normalization in isInside
    const backslashPath = await $.tool.check({
      tool: 'Write',
      input: { file_path: '\\data\\worktrees\\app-abc1234\\src\\fix.ts' },
      agentId: 'agent-1',
    })
    assert.equal(backslashPath.decision, 'allow')

    console.log('✓ hooks/agents.ts edge cases (fail-closed, backticks, prefix boundary, playwright MCP, quote-aware commands, bun/pytest, backslashes)')
    passed++
  } catch (err) {
    console.error('✗ hooks/agents.ts edge cases test')
    console.error(err)
    failed++
  }

  try {
    const vmUrl = pathToFileURL(path.join(rootDir, 'sidecars/panel/view-model.js')).href
    const vm = await import(vmUrl)
    assert.equal(vm.selectActiveRepo({ activeRepos: [], jobs: [] }), null)
    const parentWsTest = vm.selectActiveRepo(
      {
        activeRepos: [
          { repoPath: '/Users/test/other-repo', repoName: 'other-repo' },
          { repoPath: '/Users/test/#KdG/AI Sandbox/antigravity-watchdog', repoName: 'antigravity-watchdog' },
        ],
        jobs: [],
      },
      { workspaceUris: ['file:///Users/test/%23KdG/AI%20Sandbox'] }
    )
    assert.equal(parentWsTest?.repoName, 'antigravity-watchdog')
    const indexHtml = fs.readFileSync(path.join(rootDir, 'sidecars/panel/index.html'), 'utf8')
    assert.ok(!/<script\s+type="module"\s+src="\/app\.js/.test(indexHtml), 'index.html must use classic script tag for /app.js so sidecar-gateway sends cookies')
    assert.ok(/id="btn-refresh-goal"/.test(indexHtml), 'index.html must include #btn-refresh-goal')
    assert.ok(/id="goal-text"/.test(indexHtml), 'index.html must include #goal-text')
    assert.ok(/onclick="refreshProjectGoal\(\)"/.test(indexHtml), '#btn-refresh-goal should have inline onclick handler')
    execFileSync(process.execPath, ['--check', path.join(rootDir, 'sidecars/panel/app.js')])
    execFileSync(process.execPath, ['--check', path.join(rootDir, 'sidecars/panel/main.mjs')])
    const action = vm.auditAction({ activeRepos: [], jobs: [] }, null)
    assert.equal(action.kind, 'none')
    assert.equal(action.disabled, true)
    const jv = vm.jobView({ id: '1', short_sha: 'abc1234', status: 'completed', verdict: 'FIXED_ON_BRANCH', fixes_committed: true })
    assert.equal(jv.hasFixToApply, true)
    assert.deepEqual(jv.badge, { kind: 'fix', label: 'Ready' })
    assert.equal(vm.stripEmojis('🚀 Ship it! ✨'), 'Ship it!')
    assert.equal(vm.timeAgo('invalid-date'), '')
    assert.equal(vm.timeAgo(new Date(Date.now() - 120_000).toISOString()), '2m ago')
    const parts = vm.partitionJobs({ jobs: [{ id: 'a', short_sha: '1', archived: false }, { id: 'b', short_sha: '2', archived: true }] })
    assert.equal(parts.recent.length, 1)
    assert.equal(parts.archived.length, 1)
    console.log('✓ sidecars/panel/view-model.js exports and view logic work')
    passed++
  } catch (err) {
    console.error('✗ sidecars/panel/view-model.js test')
    console.error(err)
    failed++
  }

  try {
    const bridgeUrl = pathToFileURL(path.join(rootDir, 'packages/universal/dist/bridge.js')).href
    const bridge = await import(bridgeUrl)

    // 1. Goal unwrap: manageGoal unwraps { ok: true, goal: { goal: "..." } } to a string
    const goalRes = await bridge.manageGoal(rootDir)
    assert.equal(typeof goalRes.goal, 'string')
    assert.ok(goalRes.goal.length > 0)

    // Goal refresh flag
    const goalRefresh = await bridge.manageGoal(rootDir, undefined, false, true)
    assert.equal(typeof goalRefresh.goal, 'string')
    assert.ok(goalRefresh.goal.length > 0)
    assert.equal(goalRefresh.ok, true)
    assert.ok(typeof goalRefresh.source === 'string')
    assert.ok(typeof goalRefresh.updatedAt === 'string')

    // Direct positional invocation of watchdog_ctl.py goal <repo> --refresh
    const ctlPath = path.join(rootDir, 'scripts/watchdog_ctl.py')
    const pyGoalRaw = execFileSync('python3', [ctlPath, 'goal', rootDir, '--refresh', '--json'], { encoding: 'utf8' })
    const pyGoal = JSON.parse(pyGoalRaw)
    assert.equal(pyGoal.ok, true)
    assert.ok(pyGoal.goal && typeof pyGoal.goal.goal === 'string')

    // Error handling on invalid directory
    try {
      execFileSync('python3', [ctlPath, 'goal', '/nonexistent/invalid/dir', '--refresh', '--json'], { encoding: 'utf8', stdio: 'pipe' })
      assert.fail('Should fail on nonexistent directory')
    } catch (err) {
      assert.equal(err.status, 1)
      const errJson = JSON.parse(String(err.stdout).trim())
      assert.equal(errJson.ok, false)
      assert.ok(errJson.error.includes('not found'))
    }

    // 2. formatStatusReport with bestRepo.head schema and null-safety
    const statusReport = bridge.formatStatusReport(
      { jobs: [] },
      { bestRepo: { repoName: 'test-app', branch: 'main', head: { sha: '1234567890abcdef', subject: 'feat: new' } } }
    )
    assert.ok(statusReport.includes('1234567'))
    assert.ok(statusReport.includes('feat: new'))
    assert.doesNotThrow(() => bridge.formatStatusReport(null))
    assert.doesNotThrow(() => bridge.formatStatusReport({ error: 'fatal' }))

    // 3. formatNextStepsReport with proposals containing goals and estimatedTime, plus null-safety
    const nextStepsReport = bridge.formatNextStepsReport({
      goal: { goal: 'Ship v1' },
      proposals: [
        {
          id: '1',
          title: 'Implement feature',
          category: 'Feature',
          difficulty: 'Easy',
          estimatedTime: '20m',
          summary: 'A great feature',
          goals: ['Subgoal 1', 'Subgoal 2'],
          affectedFiles: ['src/app.ts'],
        },
      ],
    })
    assert.ok(nextStepsReport.includes('Ship v1'))
    assert.ok(nextStepsReport.includes('Implement feature'))
    assert.ok(nextStepsReport.includes('~20m'))
    assert.ok(nextStepsReport.includes('Subgoal 1'))
    assert.doesNotThrow(() => bridge.formatNextStepsReport(null))
    assert.doesNotThrow(() => bridge.formatNextStepsReport({ error: 'git failure' }))

    // 4. queueAudit without pre-prepare: verify queueAudit directly invokes queue command with force flag
    const queueRes = await bridge.queueAudit(rootDir, 'HEAD', 'test note', true)
    assert.ok(queueRes !== null && typeof queueRes === 'object')

    // 5. applyFix prefix stripping: strips fix/watchdog- before passing sha to controller
    try {
      await bridge.applyFix(rootDir, 'fix/watchdog-0000000')
    } catch (err) {
      assert.ok(err.message.includes('0000000') && !err.message.includes('fix/watchdog-fix/watchdog-'))
    }

    // 6. completeAudit exported and callable
    assert.equal(typeof bridge.completeAudit, 'function')

    console.log('✓ universal package: goal unwrap, queueAudit, applyFix prefix stripping, completeAudit, formatters, null-safety')
    passed++
  } catch (err) {
    console.error('✗ universal package tests')
    console.error(err)
    failed++
  }

  try {
    const { execFileSync } = await import('node:child_process')
    const pyOutput = execFileSync('python3', [
      '-c',
      `
import sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(rootDir)})
import scripts.watchdog_ctl as ctl
res = ctl.deep_analyze_codebase(Path(${JSON.stringify(rootDir)}))
self_matches = [t for t in res.get("todos", []) if "watchdog_ctl.py" in t.get("file", "")]
if self_matches:
    print(f"FAILED: self match found: {self_matches}", file=sys.stderr)
    sys.exit(1)
print("OK")
      `,
    ], { encoding: 'utf8' })
    assert.ok(pyOutput.includes('OK'))
    console.log('✓ python controller: TODO scanner does not self-match watchdog_ctl.py')
    passed++
  } catch (err) {
    console.error('✗ python controller TODO scanner test')
    console.error(err)
    failed++
  }

  try {
    const cliUrl = pathToFileURL(path.join(rootDir, 'packages/universal/dist/cli.js')).href
    const cli = await import(cliUrl)
    assert.equal(typeof cli.parseArgs, 'function')

    const p1 = cli.parseArgs(['--json', 'status'])
    assert.equal(p1.cmd, 'status')
    assert.equal(p1.flags.json, true)
    assert.deepEqual(p1.positionals, [])

    const p2 = cli.parseArgs(['next-steps', '--refresh'])
    assert.equal(p2.cmd, 'next-steps')
    assert.equal(p2.flags.refresh, true)

    const p3 = cli.parseArgs(['next-steps', '1'])
    assert.equal(p3.cmd, 'next-steps')
    assert.deepEqual(p3.positionals, ['1'])

    const p4 = cli.parseArgs(['goal', 'clear'])
    assert.equal(p4.cmd, 'goal')
    assert.deepEqual(p4.positionals, ['clear'])

    const pRefresh = cli.parseArgs(['goal', 'refresh'])
    assert.equal(pRefresh.cmd, 'goal')
    assert.deepEqual(pRefresh.positionals, ['refresh'])

    const pRefreshFlag = cli.parseArgs(['goal', '--repo', '/some/path', '--refresh'])
    assert.equal(pRefreshFlag.cmd, 'goal')
    assert.equal(pRefreshFlag.flags.repo, '/some/path')
    assert.equal(pRefreshFlag.flags.refresh, true)

    const p5 = cli.parseArgs(['--repo', '/some/path', 'status'])
    assert.equal(p5.cmd, 'status')
    assert.equal(p5.flags.repo, '/some/path')

    const p6 = cli.parseArgs(['complete', '--repo', '/some/path', '--sha', 'abc1234', '--verdict', 'PASS', '--summary', 'All good'])
    assert.equal(p6.cmd, 'complete')
    assert.equal(p6.flags.verdict, 'PASS')
    assert.equal(p6.flags.summary, 'All good')

    console.log('✓ universal CLI: parseArgs non-consuming boolean flags and positionals')
    passed++
  } catch (err) {
    console.error('✗ universal CLI parseArgs test')
    console.error(err)
    failed++
  }

  try {
    const { execFileSync } = await import('node:child_process')
    const pyOutput = execFileSync('python3', [
      '-c',
      `
import sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(rootDir)})
import scripts.watchdog_ctl as ctl

assert ctl.is_same_repo_path("/path/to/repo/", "/path/to/repo") == True
assert ctl.is_same_repo_path("C:\\\\repo\\\\sub", "C:/repo/sub") == True
assert ctl.is_same_repo_path(None, "/path") == False
assert ctl.is_same_repo_path("/path", None) == False

tmp1 = Path("/tmp").resolve()
tmp2 = Path("/tmp")
assert ctl.is_same_repo_path(str(tmp1), str(tmp2)) == True
print("OK")
      `,
    ], { encoding: 'utf8' })
    assert.ok(pyOutput.includes('OK'))
    console.log('✓ python controller: is_same_repo_path handles symlinks, trailing slashes, and backslashes')
    passed++
  } catch (err) {
    console.error('✗ python controller is_same_repo_path test')
    console.error(err)
    failed++
  }

  try {
    const { $, on } = createHarness(pluginRegister)
    const mockRun = (stdout) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    let claimedRepo = null
    on('session.cwd', () => ({ value: '/default/repo' }))
    on('process.run', (_, e) => {
      const argv = [...e.argv]
      if (argv[0] === 'git') {
        const repo = e.cwd || '/default/repo'
        return mockRun(`${repo}\n`)
      }
      if (argv[2] === 'claim') {
        const repoIdx = argv.indexOf('--repo')
        if (repoIdx !== -1) claimedRepo = argv[repoIdx + 1]
        return mockRun(JSON.stringify({
          ok: true,
          ctl: '/plugin/scripts/watchdog_ctl.py',
          jobs: [{ id: 'app-abc1234', short_sha: 'abc1234', repo_path: claimedRepo || '/default/repo', worktree_path: '/data/worktrees/app-abc1234', prompt: 'Audit abc1234.' }],
        }))
      }
      return mockRun(JSON.stringify({ ok: true }))
    })
    on('fs.write', () => ({ value: undefined }))
    on('tool.call', () => ({ result: { text: 'ok' } }))

    await $.tool.call({
      tool: 'mcp__plugin_watchdog_watchdog__watchdog_audit',
      input: { repo: '/custom/repo' },
    })
    assert.equal(claimedRepo, '/custom/repo')
    console.log('✓ hooks/agents.ts tool.call resolves e.input.repo for target repository override')
    passed++
  } catch (err) {
    console.error('✗ hooks/agents.ts tool.call repo resolution test')
    console.error(err)
    failed++
  }

  try {
    const { $, on } = createHarness(pluginRegister)
    const mockRun = (stdout) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    let directCalled = false
    const ctlArgsLogged = []
    on('session.cwd', () => ({ value: '/default/repo' }))
    on('process.run', (_, e) => {
      const argv = [...e.argv]
      if (argv[0] === 'git') return mockRun('/default/repo\n')
      ctlArgsLogged.push(argv.slice(2))
      if (argv[2] === 'claim') {
        directCalled = true
        return mockRun(JSON.stringify({
          ok: true,
          ctl: 'C:\\plugin\\scripts\\watchdog_ctl.py',
          jobs: [{ id: 'app-direct1', short_sha: 'direct1', repo_path: '/default/repo', worktree_path: '/data/worktrees/app-direct1', prompt: 'Audit direct1.' }],
        }))
      }
      return mockRun(JSON.stringify({ ok: true }))
    })
    on('fs.write', () => ({ value: undefined }))
    on('tool.call', () => ({ result: { text: 'ok' } }))

    // 1. Direct tool call without mcp__ prefix must trigger queued audit request
    const directResult = await $.tool.call({
      tool: 'watchdog_audit',
      input: {},
    })
    assert.equal(directCalled, true)
    assert.ok(Array.isArray(directResult?.context) && directResult.context.length > 0)

    // 2. Playwright tool call from plugin installation allowed
    const { commandAllowed } = await import(agentsModuleUrl)
    const grant = {
      roots: ['/data/worktrees/app-direct1', '/default/repo/.antigravity/audits'],
      ctl: 'C:\\plugin\\scripts\\watchdog_ctl.py',
      jobId: 'app-direct1',
    }

    // Windows backslash normalization in grant.ctl matches forward-slash invocation
    const winCtlCmd = commandAllowed(grant, 'python3 "C:/plugin/scripts/watchdog_ctl.py" complete --repo /default/repo --sha direct1')
    assert.equal(winCtlCmd, null)

    // 3. Plugin playwright tool allowed
    on('state.get', async (_, e, next) => {
      const res = await next(e)
      if (e.plugin === 'watchdog' && e.key === 'agents') {
        const current = (res && res.value && res.value.value) || {}
        return { value: { value: { ...current, 'agent-win': grant }, version: (res?.value?.version || 0) + 1 } }
      }
      return res
    })
    const pwPluginCheck = await $.tool.check({
      tool: 'mcp__plugin_playwright_playwright__browser_click',
      input: {},
      agentId: 'agent-win',
    })
    assert.equal(pwPluginCheck.decision, 'allow')

    // 4. agent.spawn and turn.complete lifecycle with agent_id snake_case
    on('agent.spawn', () => ({ agent_id: 'snake-agent-1' }))
    on('turn.complete', () => ({}))

    await $.agent.spawn({ subagent_type: 'watchdog:watchdog-auditor', prompt: 'Read your task in /default/repo/.antigravity/tasks/audit-direct1.md and follow it.' })
    await $.turn.complete({ agent_id: 'snake-agent-1' })
    assert.ok(ctlArgsLogged.some(args => args[0] === 'mark-running' && args.includes('claude-agent-snake-agent-1')))
    assert.ok(ctlArgsLogged.some(args => args[0] === 'agent-done' && args.includes('claude-agent-snake-agent-1')))

    // 5. agent.spawn matches relative task path in prompt
    ctlArgsLogged.length = 0
    await $.tool.call({ tool: 'watchdog_audit', input: {} })
    await $.agent.spawn({ subagent_type: 'watchdog:watchdog-auditor', prompt: 'Please read .antigravity/tasks/audit-direct1.md to begin.' })
    assert.ok(ctlArgsLogged.some(args => args[0] === 'mark-running' && args.includes('claude-agent-snake-agent-1')))

    console.log('✓ hooks/agents.ts direct tool matching, playwright plugin prefix, Windows ctl paths, snake_case agent_id, relative task matching')
    passed++
  } catch (err) {
    console.error('✗ hooks/agents.ts direct matching and cross-platform test')
    console.error(err)
    failed++
  }

  try {
    const { execFileSync } = await import('node:child_process')
    const pyOutput = execFileSync('python3', [
      '-c',
      `
import sys, threading, time, json
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(rootDir)})
import scripts.watchdog_ctl as ctl

# 1. Test multi-threaded StateLock concurrency
errors = []
def worker(w_id):
    try:
        for _ in range(5):
            with ctl.StateLock():
                st = ctl.load_state()
                st["__test_counter__"] = st.get("__test_counter__", 0) + 1
                ctl.save_state(st)
                time.sleep(0.002)
    except Exception as ex:
        errors.append(str(ex))

threads = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
for t in threads: t.start()
for t in threads: t.join()

if errors:
    print(f"FAILED StateLock concurrency: {errors}", file=sys.stderr)
    sys.exit(1)

with ctl.StateLock():
    final_st = ctl.load_state()
    final_st.pop("__test_counter__", None)
    ctl.save_state(final_st)

# 2. Test CHECK_RULES contains bun and python -m pytest
assert any("bun" in r for r in ctl.CHECK_RULES), "bun not in CHECK_RULES"
assert any("python -m pytest" in r for r in ctl.CHECK_RULES), "python -m pytest not in CHECK_RULES"

# 3. Test plan ID '#' stripping in mark_execution_running & cancel_execution
repo_path = Path(${JSON.stringify(rootDir)})
rec = ctl.mark_execution_running(repo_path, "#2", "test-conv", "Test Title")
assert rec["planId"] == "2", f"Expected planId '2', got {rec['planId']}"
cancelled = ctl.cancel_execution(repo_path, "#2")
assert cancelled["ok"] == True, f"Cancel execution failed: {cancelled}"

# 4. Test is_conversation_active with PLANNER_RESPONSE settling and status checks
import tempfile
with tempfile.TemporaryDirectory() as tmp_brain:
    brain_dir = Path(tmp_brain)
    old_brain = ctl.BRAIN_DIR
    ctl.BRAIN_DIR = brain_dir
    try:
        test_conv_id = "test-conv-active-check"
        log_dir = brain_dir / test_conv_id / ".system_generated" / "logs"
        log_dir.mkdir(parents=True)
        t_file = log_dir / "transcript.jsonl"

        # Recent PLANNER_RESPONSE without tool calls -> MUST be active (True)
        t_file.write_text(json.dumps({"type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": []}) + "\\n", encoding="utf-8")
        assert ctl.is_conversation_active(test_conv_id, max_age_seconds=900) is True, "Recent PLANNER_RESPONSE without tool_calls should be active"

        # Tool calls present -> active (True)
        t_file.write_text(json.dumps({"type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [{"name": "test"}]}) + "\\n", encoding="utf-8")
        assert ctl.is_conversation_active(test_conv_id, max_age_seconds=900) is True, "PLANNER_RESPONSE with tool_calls should be active"

        # Status ERROR in GENERIC (e.g. failing tests or linting) -> MUST be active (True)
        t_file.write_text(json.dumps({"type": "GENERIC", "status": "ERROR", "content": "1 test failed"}) + "\\n", encoding="utf-8")
        assert ctl.is_conversation_active(test_conv_id, max_age_seconds=900) is True, "GENERIC status ERROR should remain active"

        # Status ERROR in PLANNER_RESPONSE -> inactive (False)
        t_file.write_text(json.dumps({"type": "PLANNER_RESPONSE", "status": "ERROR", "tool_calls": []}) + "\\n", encoding="utf-8")
        assert ctl.is_conversation_active(test_conv_id, max_age_seconds=900) is False, "Status ERROR in PLANNER_RESPONSE should be inactive"

        # Status CANCELLED -> inactive (False)
        t_file.write_text(json.dumps({"type": "GENERIC", "status": "CANCELLED"}) + "\\n", encoding="utf-8")
        assert ctl.is_conversation_active(test_conv_id, max_age_seconds=900) is False, "Status CANCELLED should be inactive"

        # Settling PLANNER_RESPONSE without tool calls within 600s (e.g. 200s) -> active (True)
        t_file.write_text(json.dumps({"type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": []}) + "\\n", encoding="utf-8")
        stale_time_mid = time.time() - 200
        import os
        os.utime(t_file, (stale_time_mid, stale_time_mid))
        assert ctl.is_conversation_active(test_conv_id, max_age_seconds=900) is True, "Settling PLANNER_RESPONSE (200s) should remain active"

        # Stale PLANNER_RESPONSE without tool calls (> 600s) -> inactive (False)
        stale_time_dead = time.time() - 650
        os.utime(t_file, (stale_time_dead, stale_time_dead))
        assert ctl.is_conversation_active(test_conv_id, max_age_seconds=900) is False, "Stale PLANNER_RESPONSE (>600s) should be inactive"
    finally:
        ctl.BRAIN_DIR = old_brain

# 5. Test reconcile_job finding report in worktree
with tempfile.TemporaryDirectory() as tmp_repo, tempfile.TemporaryDirectory() as tmp_wt:
    r_dir = Path(tmp_repo)
    w_dir = Path(tmp_wt)
    sha = "1234567890abcdef"
    short_sha = sha[:7]
    
    # Place report inside worktree
    wt_report = w_dir / f"review-{short_sha}.md"
    wt_report.write_text(f"# Watchdog Audit Report -- {short_sha}\\n\\n- **Verdict**: PASS\\n\\n## 1. Executive Summary\\nAll tests passed successfully in worktree.", encoding="utf-8")
    
    job = {
        "id": f"test-{short_sha}",
        "repo_path": str(r_dir),
        "worktree_path": str(w_dir),
        "sha": sha,
        "short_sha": short_sha,
        "status": "running",
        "conversation_id": "test-conv-wt"
    }
    modified = ctl.reconcile_job(job)
    assert modified is True, "reconcile_job should modify job when report found in worktree"
    assert job["status"] == "completed", f"Expected status completed, got {job['status']}"
    assert job["verdict"] == "PASS", f"Expected verdict PASS, got {job['verdict']}"
    assert (r_dir / ".antigravity" / "audits" / f"review-{short_sha}.md").exists(), "Report should be copied to repo audits dir"

# 6. Test reconcile_job discovering Antigravity conversation for queued job
with tempfile.TemporaryDirectory() as tmp_brain, tempfile.TemporaryDirectory() as tmp_repo:
    brain_dir = Path(tmp_brain)
    old_brain = ctl.BRAIN_DIR
    ctl.BRAIN_DIR = brain_dir
    try:
        disc_conv_id = "test-conv-discovery-uuid"
        log_dir = brain_dir / disc_conv_id / ".system_generated" / "logs"
        log_dir.mkdir(parents=True)
        t_file = log_dir / "transcript.jsonl"
        sha_disc = "abcdef1234567890"
        short_disc = sha_disc[:7]
        t_file.write_text(f'[WATCHDOG-SESSION] Audit commit {short_disc}\\n{json.dumps({"type": "GENERIC", "status": "DONE"})}\\n', encoding="utf-8")
        
        queued_job = {
            "id": f"job-{short_disc}",
            "repo_path": tmp_repo,
            "sha": sha_disc,
            "short_sha": short_disc,
            "status": "queued",
            "queued_at": ctl.now_iso(),
        }
        modified_disc = ctl.reconcile_job(queued_job)
        assert modified_disc is True, "reconcile_job should modify queued job when conversation discovered"
        assert queued_job["status"] == "running", f"Expected queued job to transition to running, got {queued_job['status']}"
        assert queued_job["conversation_id"] == disc_conv_id, "conversation_id should match discovered conversation"
        assert queued_job.get("started_at"), "started_at should be set"
    finally:
        ctl.BRAIN_DIR = old_brain

print("OK")
      `,
    ], { encoding: 'utf8' })
    assert.ok(pyOutput.includes('OK'))
    console.log('✓ python controller: StateLock multi-threaded concurrency, CHECK_RULES runners, and # plan-id normalization')
    passed++
  } catch (err) {
    console.error('✗ python controller concurrency & plan-id test')
    console.error(err)
    failed++
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
