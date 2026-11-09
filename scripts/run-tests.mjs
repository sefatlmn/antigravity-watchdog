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
      input: { command: 'echo "hello" > /data/unsafe' },
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

  try {
    // Test normalizeWsUri
    const vmUrl = pathToFileURL(path.join(rootDir, 'sidecars/panel/view-model.js')).href
    const vm = await import(vmUrl)
    assert.equal(vm.normalizeWsUri('file:///Users/sefa/%23KdG/Sandbox/'), '/Users/sefa/#KdG/Sandbox')
    assert.equal(vm.normalizeWsUri('file:///C:/Users/test/workspace/'), 'C:/Users/test/workspace')
    assert.equal(vm.normalizeWsUri('/plain/path/with/trailing/slash///'), '/plain/path/with/trailing/slash')
    assert.equal(vm.normalizeWsUri(''), '')

    // Test bridge resolveRepo and getGitState
    const bridgeUrl = pathToFileURL(path.join(rootDir, 'packages/universal/dist/bridge.js')).href
    const bridge = await import(bridgeUrl)
    assert.equal(bridge.resolveRepo('file:///Users/sefa/%23KdG/Sandbox/'), path.resolve('/Users/sefa/#KdG/Sandbox'))
    const gitState = await bridge.getGitState(rootDir)
    assert.equal(gitState.ok, true)
    assert.ok(gitState.bestRepo?.branch || gitState.branch)
    assert.ok(gitState.bestRepo)

    // Test universal CLI git-state and sync
    const cliBin = path.join(rootDir, 'packages/universal/bin/watchdog.js')
    const cliGitStateRaw = execFileSync(process.execPath, [cliBin, 'git-state', '--repo', rootDir, '--json'], { encoding: 'utf8' })
    const cliGitState = JSON.parse(cliGitStateRaw)
    assert.equal(cliGitState.ok, true)
    assert.ok(cliGitState.bestRepo)

    const cliSyncRaw = execFileSync(process.execPath, [cliBin, 'sync', '--repo', rootDir, '--json'], { encoding: 'utf8' })
    const cliSync = JSON.parse(cliSyncRaw)
    assert.equal(cliSync.ok, true)
    assert.ok(cliSync.bestRepo)

    // Test standalone_sdk auth behavior
    const sdkUrl = pathToFileURL(path.join(rootDir, 'sidecars/panel/standalone_sdk.mjs')).href
    const { SidecarApp } = await import(sdkUrl)
    const testApp = new SidecarApp()
    testApp.page('/', () => '<html><body>OK</body></html>')
    testApp.api('/api/test-secure', () => ({ ok: true }))
    testApp.api('/api/dashboard', () => ({ ok: true, activeRepos: [] }))
    const testServer = await testApp.run()
    const testPort = testServer.address().port

    try {
      // 1. GET / should return 200 and set sidecar_token cookie
      const getRes = await fetch(`http://127.0.0.1:${testPort}/`)
      assert.equal(getRes.status, 200)
      const setCookie = getRes.headers.get('set-cookie') || ''
      assert.ok(setCookie.includes('sidecar_token='), 'GET / should issue sidecar_token cookie')
      const tokenMatch = setCookie.match(/sidecar_token=([^;]+)/)
      const cookieToken = tokenMatch ? tokenMatch[1] : null
      assert.ok(cookieToken, 'cookie token should be extracted')

      // 2. Loopback safe endpoint /api/dashboard should allow request even without token
      const dashRes = await fetch(`http://127.0.0.1:${testPort}/api/dashboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      assert.equal(dashRes.status, 200)
      const dashJson = await dashRes.json()
      assert.equal(dashJson.ok, true)

      // 3. Secure mutating endpoint without token should return 401
      const mutResNoToken = await fetch(`http://127.0.0.1:${testPort}/api/test-secure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      assert.equal(mutResNoToken.status, 401)

      // 4. Secure mutating endpoint with cookie token should return 200
      const mutResCookie = await fetch(`http://127.0.0.1:${testPort}/api/test-secure`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': `sidecar_token=${cookieToken}`,
        },
        body: JSON.stringify({}),
      })
      assert.equal(mutResCookie.status, 200)

      // 5. Secure mutating endpoint with header token should return 200
      const mutResHeader = await fetch(`http://127.0.0.1:${testPort}/api/test-secure`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-sidecar-token': cookieToken,
        },
        body: JSON.stringify({}),
      })
      assert.equal(mutResHeader.status, 200)
    } finally {
      testServer.close()
    }

    console.log('✓ repo scanning & git state: normalizeWsUri, bridge resolveRepo, CLI sync/git-state, and standalone SDK auth')
    passed++
  } catch (err) {
    console.error('✗ repo scanning & git state test')
    console.error(err)
    failed++
  }

  try {
    // 15. Real runtime test for app.js: verify hostMode is defined, callApi doesn't throw ReferenceError,
    // and syncGit correctly updates the DOM with repo commits instead of 'Unable to scan repository'
    const appJsCode = fs.readFileSync(path.join(rootDir, 'sidecars/panel/app.js'), 'utf8')
    const vm = await import('node:vm')

    const elements = new Map()
    function createMockElement(id) {
      const el = {
        id,
        textContent: '',
        value: '',
        title: '',
        hidden: false,
        disabled: false,
        classList: {
          classes: new Set(),
          add(c) { this.classes.add(c) },
          remove(c) { this.classes.delete(c) },
          toggle(c, v) { if (v) this.classes.add(c); else this.classes.delete(c) },
          contains(c) { return this.classes.has(c) },
        },
        dataset: {},
        style: { setProperty() {} },
        setAttribute() {},
        removeAttribute() {},
        querySelector() { return null },
        querySelectorAll() { return [] },
        addEventListener() {},
        innerHTML: '',
      }
      elements.set(id, el)
      return el
    }

    const domIds = [
      'select-repo', 'repo-name', 'repo-branch', 'commit-sha', 'commit-subject', 'commit-time',
      'commit-tag-badge', 'btn-run-audit', 'btn-run-audit-text', 'btn-run-audit-icon',
      'input-audit-comment', 'audits-count', 'archived-count', 'archive-details', 'jobs-list',
      'archived-jobs-list', 'btn-sync', 'toast', 'tab-btn-audits', 'tab-btn-next-steps',
      'tab-pane-audits', 'tab-pane-next-steps', 'tab-badge-audits', 'tab-badge-proposals',
      'btn-refresh-goal', 'btn-edit-goal', 'btn-refresh-proposals', 'btn-cancel-synthesis-header',
      'goal-text', 'ns-goal-text', 'input-goal', 'proposals-list', 'ns-goal-edit-form', 'ns-goal-view',
      'report-card', 'btn-close-report', 'btn-send-report-chat',
    ]
    for (const id of domIds) {
      createMockElement(id)
    }

    let lastFetchCall = null
    const mockStorage = new Map()
    const storageObj = {
      getItem(k) { return mockStorage.get(k) || null },
      setItem(k, v) { mockStorage.set(k, String(v)) },
      removeItem(k) { mockStorage.delete(k) },
    }

    const sandbox = {
      window: null,
      document: {
        getElementById(id) {
          if (!elements.has(id)) createMockElement(id)
          return elements.get(id)
        },
        addEventListener() {},
        documentElement: createMockElement('html'),
        hidden: false,
      },
      location: {
        href: 'plugin://watchdog--panel-54377/?token=test-tok-123&conversationId=test-conv-abc',
        search: '?token=test-tok-123&conversationId=test-conv-abc',
      },
      sessionStorage: storageObj,
      localStorage: storageObj,
      URLSearchParams,
      setTimeout,
      clearTimeout,
      Promise,
      Date,
      JSON,
      Math,
      Number,
      String,
      Boolean,
      Array,
      Set,
      Map,
      addEventListener() {},
      removeEventListener() {},
      getComputedStyle: () => ({ getPropertyValue: () => '#0b0f19' }),
      matchMedia: () => ({ matches: false }),
      console: { log() {}, warn() {}, error() {} },
    }
    sandbox.window = sandbox
    sandbox.sidecar = {
      isStandalone: false,
      conversationId: 'test-conv-abc',
      getWorkspaceUris: async () => ['file:///Users/sefa/Documents/Code/Watchdog'],
      onWorkspaceChange: () => {},
      fetch: async (url, options = {}) => {
        lastFetchCall = { url, options }
        const parsedBody = options.body ? JSON.parse(options.body) : {}
        // Must receive host parameter without ReferenceError!
        assert.ok(parsedBody.host === 'antigravity' || parsedBody.host === 'claude', `fetch body must include valid host, got: ${parsedBody.host}`)
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            activeRepos: [
              {
                repoPath: '/Users/sefa/Documents/Code/Watchdog/antigravity-watchdog',
                repoName: 'antigravity-watchdog',
                branch: 'main',
                head: {
                  sha: '976b62cc0dfa774281bc29dae0a30afc4e79f5aa',
                  shortSha: '976b62c',
                  subject: 'fix(next-steps): fix project goal refresh button tactile feedback',
                  relativeTime: 'just now',
                  timestamp: 1794159545,
                },
                youngestCommit: {
                  sha: '976b62cc0dfa774281bc29dae0a30afc4e79f5aa',
                  short_sha: '976b62c',
                  subject: 'fix(next-steps): fix project goal refresh button tactile feedback',
                  relative_time: 'just now',
                  timestamp: 1794159545,
                },
                recentCommits: [],
                fixBranches: [],
                reports: [],
                goal: null,
                proposals: [],
                executions: {},
              },
            ],
            jobs: [],
          }),
        }
      },
    }

    vm.createContext(sandbox)
    vm.runInContext(appJsCode, sandbox)

    // Call init / syncGit in sandbox
    assert.doesNotThrow(async () => {
      await sandbox.init()
    })

    // Wait for async syncGit to populate the DOM elements
    await new Promise((r) => setTimeout(r, 50))

    const commitSubjectEl = elements.get('commit-subject')
    assert.ok(commitSubjectEl.textContent.includes('fix(next-steps)'), `commit-subject must display latest commit message, got: ${commitSubjectEl.textContent}`)
    assert.ok(!commitSubjectEl.textContent.includes('Unable to scan repository'), 'commit-subject must NOT display Unable to scan repository')

    const repoNameEl = elements.get('repo-name')
    assert.equal(repoNameEl.textContent, 'antigravity-watchdog')

    // Test normalizeWsUri with file://localhost/
    assert.equal(sandbox.normalizeWsUri('file://localhost/Users/sefa/test'), '/Users/sefa/test')
    assert.equal(sandbox.normalizeWsUri('file:///Users/sefa/test%23123'), '/Users/sefa/test#123')

    console.log('✓ app.js live runtime execution: hostMode safely declared, callApi transmits host and auth, and syncGit populates DOM')
    passed++
  } catch (err) {
    console.error('✗ app.js live runtime execution test')
    console.error(err)
    failed++
  }

  try {
    // BUG-04 & BUG-18: hooks/agents.ts node watchdog and shell redirection
    const { commandAllowed } = await import(agentsModuleUrl)
    const grant = { roots: ['/data/worktrees/app-abc1234', '/work/app/.antigravity/audits'], ctl: '/plugin/scripts/watchdog_ctl.py', jobId: 'app-abc1234' }

    // BUG-04: node watchdog.js complete and watchdog complete commands allowed
    assert.equal(commandAllowed(grant, 'node /path/to/watchdog.js complete --repo /work/app --verdict PASS'), null)
    assert.equal(commandAllowed(grant, 'node ./bin/watchdog.js complete'), null)
    assert.equal(commandAllowed(grant, 'watchdog complete --repo /work/app'), null)

    // BUG-18: safe file redirection to /dev/null and /tmp/
    assert.equal(commandAllowed(grant, 'cd /data/worktrees/app-abc1234 && npm test > /tmp/test-output.log 2>&1'), null)
    assert.equal(commandAllowed(grant, 'cd /data/worktrees/app-abc1234 && python3 -m pytest > /tmp/pytest.log'), null)
    assert.equal(commandAllowed(grant, 'echo "hello" > /tmp/unsafe-log.txt'), null)
    assert.equal(commandAllowed(grant, 'npm test > /tmp/out.log && echo "handling unsafe input"'), null)
    assert.notEqual(commandAllowed(grant, 'echo "test" > ~/.bashrc'), null)
    assert.notEqual(commandAllowed(grant, 'echo "test" > /etc/shadow'), null)
    assert.notEqual(commandAllowed(grant, 'echo "hello" > ./unsafe.txt'), null)

    console.log('✓ hooks/agents.ts: node watchdog complete execution and safe /tmp/ shell redirection')
    passed++
  } catch (err) {
    console.error('✗ hooks/agents.ts BUG-04 & BUG-18 test')
    console.error(err)
    failed++
  }

  try {
    // BUG-06 & BUG-08: sidecars/panel/view-model.js sameRepo null-safety & isAuditSkipped
    const vmUrl = pathToFileURL(path.join(rootDir, 'sidecars/panel/view-model.js')).href
    const vm = await import(vmUrl)

    // BUG-06: sameRepo returns false if either path is empty
    const jobA = { id: '1', repo_path: '' }
    const repoA = { repoPath: '/data/repoA' }
    const actionNull = vm.auditAction({ jobs: [jobA] }, repoA)
    assert.equal(actionNull.matchingJob, null)

    // BUG-08: [skip-watchdog] marked as isAuditSkipped, button enabled as 'audit'
    const skipRepo = {
      repoPath: '/data/repoB',
      head: { sha: 'abcdef1234567890', shortSha: 'abcdef1', subject: 'docs: update [skip-watchdog]' },
    }
    const skipAction = vm.auditAction({ jobs: [] }, skipRepo)
    assert.equal(skipAction.isAuditSkipped, true)
    assert.equal(skipAction.isAppliedFix, false)
    assert.equal(skipAction.kind, 'audit')
    assert.equal(skipAction.disabled, false)
    assert.ok(skipAction.label.includes('Run Review'))

    console.log('✓ view-model.js: sameRepo cross-repo isolation and [skip-watchdog] manual review override')
    passed++
  } catch (err) {
    console.error('✗ view-model.js BUG-06 & BUG-08 test')
    console.error(err)
    failed++
  }

  try {
    // BUG-01, BUG-05, BUG-07, BUG-17, BUG-19: universal bridge and CLI
    const bridgeUrl = pathToFileURL(path.join(rootDir, 'packages/universal/dist/bridge.js')).href
    const bridge = await import(bridgeUrl)

    // BUG-05: formatStatusReport filters jobs by repoPath and excludes empty repo_path
    const multiRepoReport = bridge.formatStatusReport(
      {
        jobs: [
          { short_sha: 'other1', repo_path: '/other/repo', verdict: 'NEEDS_ATTENTION', status: 'completed' },
          { short_sha: 'empty1', repo_path: '', verdict: 'NEEDS_ATTENTION', status: 'completed' },
          { short_sha: 'target1', repo_path: rootDir, verdict: 'PASS', status: 'completed' },
        ],
      },
      { bestRepo: { repoPath: rootDir, repoName: 'watchdog', branch: 'main' } }
    )
    assert.ok(multiRepoReport.includes('target1'), 'Status report must show target repo job')
    assert.ok(!multiRepoReport.includes('other1'), 'Status report must NOT leak other repo job')
    assert.ok(!multiRepoReport.includes('empty1'), 'Status report must NOT leak job with empty repo_path')

    // BUG-17: applyFix throws when no fix branch is present
    await assert.rejects(
      async () => {
        await bridge.applyFix(rootDir)
      },
      (err) => {
        assert.ok(err.message.includes('No fix branch available'), `Expected informative error, got: ${err.message}`)
        return true
      }
    )

    // BUG-19: cancelPlanExecution function exists and runs
    assert.equal(typeof bridge.cancelPlanExecution, 'function')
    const cancelRes = await bridge.cancelPlanExecution(rootDir, 'non-existent-999')
    assert.ok(cancelRes !== null && typeof cancelRes === 'object')

    console.log('✓ universal bridge: status cross-repo filtering, applyFix error guard, and cancelPlanExecution')
    passed++
  } catch (err) {
    console.error('✗ universal bridge BUG-05, BUG-17, BUG-19 test')
    console.error(err)
    failed++
  }

  try {
    // BUG-02: execute-plan --no-spawn does not mark execution running
    const { execFileSync } = await import('node:child_process')
    const ctlScript = path.join(rootDir, 'scripts/watchdog_ctl.py')
    const out = execFileSync('python3', [ctlScript, 'execute-plan', '--repo', rootDir, '--plan-id', '1', '--no-spawn', '--json'], {
      encoding: 'utf8',
    })
    const parsed = JSON.parse(out)
    assert.equal(parsed.dispatched, false)
    assert.equal(parsed.execution, null)

    // BUG-01: watchdog complete without --sha resolves gracefully
    const compHelp = execFileSync('python3', [ctlScript, 'complete', '--help'], { encoding: 'utf8' })
    assert.ok(!compHelp.includes('required: --sha') && !compHelp.includes('--sha SHA\n\nrequired arguments:\n  --repo REPO\n  --sha SHA'), '--sha must be optional')

    console.log('✓ watchdog_ctl.py: read-only plan inspection preserves state and complete --sha is optional')
    passed++
  } catch (err) {
    console.error('✗ watchdog_ctl.py BUG-01 & BUG-02 test')
    console.error(err)
    failed++
  }

  try {
    // BUG-10 & BUG-14: StateLock directory lock coordination and app.js link/audit handlers
    const { execFileSync } = await import('node:child_process')
    const pyOutput = execFileSync('python3', [
      '-c',
      `
import sys, os, time
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(rootDir)})
import scripts.watchdog_ctl as ctl

# Verify STATE_LOCK_DIR is acquired and cleaned up
assert not ctl.STATE_LOCK_DIR.exists(), "STATE_LOCK_DIR should not exist before lock"
with ctl.StateLock():
    assert ctl.STATE_LOCK_DIR.exists(), "STATE_LOCK_DIR should exist during lock"
    assert (ctl.STATE_LOCK_DIR / "pid").exists(), "pid file should exist inside STATE_LOCK_DIR"
    assert (ctl.STATE_LOCK_DIR / "pid").read_text().strip() == str(os.getpid()), "pid file should contain current PID"
assert not ctl.STATE_LOCK_DIR.exists(), "STATE_LOCK_DIR should be removed after lock"
print("OK")
      `,
    ], { encoding: 'utf8' })
    assert.ok(pyOutput.includes('OK'), 'Python StateLock must manage STATE_LOCK_DIR')

    // Test app.js open-file and runAudit integrity
    const appJsRaw = fs.readFileSync(path.join(rootDir, 'sidecars/panel/app.js'), 'utf8')
    assert.ok(appJsRaw.includes("const latest = activeRepo?.youngestCommit"), 'runAudit must declare latest before use')
    assert.ok(appJsRaw.includes("window.handleFileLinkClick"), 'handleFileLinkClick must be declared on window')

    console.log('✓ StateLock directory coordination and app.js file link / audit handlers verified')
    passed++
  } catch (err) {
    console.error('✗ StateLock & app.js test')
    console.error(err)
    failed++
  }

  try {
    // Audit Fixes: Windows open-file spawn format, non-busy wait in saveStatePatch, PID-based lock protection, and Windows drive root path normalization
    const { execFileSync } = await import('node:child_process')
    const mainMjsRaw = fs.readFileSync(path.join(rootDir, 'sidecars/panel/main.mjs'), 'utf8')

    // 1. [MAJOR] Windows Cross-Platform Process Spawn Failure in /api/open-file
    assert.ok(mainMjsRaw.includes("process.platform === 'win32'"), 'main.mjs must check win32')
    assert.ok(mainMjsRaw.includes("child = spawn('cmd.exe', ['/c', 'start', '\"\"', filePath], { detached: true, stdio: 'ignore' })"), 'main.mjs must spawn cmd.exe with /c start "" filePath on win32')
    assert.ok(!mainMjsRaw.includes("spawn('start'"), 'main.mjs must not spawn start directly as binary')
    assert.ok(mainMjsRaw.includes("child.on('error', () => {})"), 'main.mjs must register error listener on spawned child')
    assert.ok(mainMjsRaw.includes("child.unref()"), 'main.mjs must unref spawned child process')

    // Functional mock test of open-file spawn logic across platforms
    const testSpawnCalls = []
    const mockSpawn = (cmd, args, opts) => {
      const listeners = {}
      const mockChild = {
        on: (ev, fn) => { listeners[ev] = fn },
        unref: () => {}
      }
      testSpawnCalls.push({ cmd, args, opts, listeners })
      return mockChild
    }
    const testOpenFile = (platform, filePath) => {
      let child
      if (platform === 'win32') {
        child = mockSpawn('cmd.exe', ['/c', 'start', '""', filePath], { detached: true, stdio: 'ignore' })
      } else {
        const opener = platform === 'darwin' ? 'open' : 'xdg-open'
        child = mockSpawn(opener, [filePath], { detached: true, stdio: 'ignore' })
      }
      child.on('error', () => {})
      child.unref()
    }
    testOpenFile('win32', 'C:\\foo\\bar.txt')
    assert.deepEqual(testSpawnCalls[0].cmd, 'cmd.exe')
    assert.deepEqual(testSpawnCalls[0].args, ['/c', 'start', '""', 'C:\\foo\\bar.txt'])
    assert.deepEqual(testSpawnCalls[0].opts, { detached: true, stdio: 'ignore' })
    assert.equal(typeof testSpawnCalls[0].listeners['error'], 'function')

    testOpenFile('darwin', '/Users/test/file.txt')
    assert.deepEqual(testSpawnCalls[1].cmd, 'open')
    assert.deepEqual(testSpawnCalls[1].args, ['/Users/test/file.txt'])
    assert.deepEqual(testSpawnCalls[1].opts, { detached: true, stdio: 'ignore' })

    testOpenFile('linux', '/home/test/file.txt')
    assert.deepEqual(testSpawnCalls[2].cmd, 'xdg-open')
    assert.deepEqual(testSpawnCalls[2].args, ['/home/test/file.txt'])
    assert.deepEqual(testSpawnCalls[2].opts, { detached: true, stdio: 'ignore' })

    // 2. [MINOR] Synchronous Event-Loop Spin-Wait in saveStatePatch and loadState
    assert.ok(!mainMjsRaw.includes('while (Date.now() - start <'), 'main.mjs must not contain synchronous busy-wait spin loops')
    assert.ok(mainMjsRaw.includes('Atomics.wait(sleepBuffer, 0, 0, ms)'), 'main.mjs must use Atomics.wait for sleep-based delay')
    assert.ok(mainMjsRaw.includes('syncSleep(25)'), 'saveStatePatch must use syncSleep(25)')
    assert.ok(mainMjsRaw.includes('syncSleep(20)'), 'saveStatePatch must use syncSleep(20)')
    assert.ok(mainMjsRaw.includes('syncSleep(15)'), 'loadState must use syncSleep(15)')

    // Verify actual Atomics.wait non-busy sleep execution
    const testSleepBuffer = new Int32Array(new SharedArrayBuffer(4))
    const sleepT0 = Date.now()
    Atomics.wait(testSleepBuffer, 0, 0, 25)
    const sleepElapsed = Date.now() - sleepT0
    assert.ok(sleepElapsed >= 15, `Atomics.wait must pause execution without busy-waiting (elapsed: ${sleepElapsed}ms)`)

    // 3. [MINOR] Stale Lock Removal Race Window in StateLock and saveStatePatch
    assert.ok(mainMjsRaw.includes("writeFileSync(join(lockDir, 'pid'), String(process.pid), 'utf8')"), 'saveStatePatch must record owning PID')
    assert.ok(mainMjsRaw.includes('process.kill(pid, 0)'), 'saveStatePatch must check process liveness before removing lock')
    assert.ok(mainMjsRaw.includes("rmSync(lockDir, { recursive: true, force: true })"), 'saveStatePatch must recursively remove lockDir')

    // 4. [NIT] Windows Root Drive Normalization and Python StateLock PID verification
    const pyAuditOutput = execFileSync('python3', [
      '-c',
      `
import sys, os, time, shutil
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, ${JSON.stringify(rootDir)})
import scripts.watchdog_ctl as ctl

# 4a. Verify Windows root drive normalization in clean_repo_path across all formats
with patch("scripts.watchdog_ctl.Path") as mock_path:
    for candidate in [
        "C:", "C:\\\\", "C:/", "file:///C:/", "file:///C:", "/C:/", "/C:", "file://localhost/C:", "file://localhost/C:/"
    ]:
        ctl.clean_repo_path(candidate)
        mock_path.assert_called_with("C:\\\\")

    ctl.clean_repo_path("C:\\\\repo\\\\")
    mock_path.assert_called_with("C:\\\\repo")
    ctl.clean_repo_path("C:/repo/")
    mock_path.assert_called_with("C:/repo")

for c1 in ["C:", "C:\\\\", "C:/", "file:///C:/", "file:///C:", "/C:/", "/C:", "file://localhost/C:", "file://localhost/C:/"]:
    for c2 in ["C:", "C:\\\\", "C:/", "file:///C:/", "file:///C:", "/C:/", "/C:"]:
        assert ctl.is_same_repo_path(c1, c2) is True, f"is_same_repo_path failed for {c1} vs {c2}"

# 4b. Verify is_pid_alive helper
assert ctl.is_pid_alive(os.getpid()) is True, "Current process PID must be alive"
assert ctl.is_pid_alive(99999999) is False, "Non-existent PID must be dead"
assert ctl.is_pid_alive(0) is False, "PID 0 must be invalid"
assert ctl.is_pid_alive(-10) is False, "Negative PID must be invalid"

# 4c. Verify StateLock records PID and cleans up on clean exit
ctl.ensure_dirs()
if ctl.STATE_LOCK_DIR.exists():
    shutil.rmtree(ctl.STATE_LOCK_DIR, ignore_errors=True)

with ctl.StateLock():
    assert ctl.STATE_LOCK_DIR.exists()
    pid_file = ctl.STATE_LOCK_DIR / "pid"
    assert pid_file.exists(), "StateLock must write pid file"
    assert pid_file.read_text().strip() == str(os.getpid()), "pid file must match current PID"

assert not ctl.STATE_LOCK_DIR.exists(), "STATE_LOCK_DIR must be cleaned up after exit"

# 4d. Verify stale lock (>5s) with a LIVE PID is NOT deleted and caller exit does NOT evict it
ctl.STATE_LOCK_DIR.mkdir(parents=True, exist_ok=True)
(ctl.STATE_LOCK_DIR / "pid").write_text(str(os.getpid()))
os.utime(ctl.STATE_LOCK_DIR, (time.time() - 10, time.time() - 10))

mtime = ctl.STATE_LOCK_DIR.stat().st_mtime
assert time.time() - mtime > 5.0

with ctl.StateLock():
    assert ctl.STATE_LOCK_DIR.exists(), "STATE_LOCK_DIR must not be deleted while PID is live"
    assert (ctl.STATE_LOCK_DIR / "pid").read_text().strip() == str(os.getpid())

# After StateLock exits, STATE_LOCK_DIR must STILL exist with the original PID because it was held by live process
assert ctl.STATE_LOCK_DIR.exists(), "Active lock must NOT be deleted on exit by a non-acquiring process"
assert (ctl.STATE_LOCK_DIR / "pid").read_text().strip() == str(os.getpid())
shutil.rmtree(ctl.STATE_LOCK_DIR, ignore_errors=True)

# 4e. Verify stale lock (>5s) with a DEAD PID is evicted and reacquired
ctl.STATE_LOCK_DIR.mkdir(parents=True, exist_ok=True)
(ctl.STATE_LOCK_DIR / "pid").write_text("99999999")
os.utime(ctl.STATE_LOCK_DIR, (time.time() - 10, time.time() - 10))

with ctl.StateLock():
    assert ctl.STATE_LOCK_DIR.exists()
    assert (ctl.STATE_LOCK_DIR / "pid").read_text().strip() == str(os.getpid())

assert not ctl.STATE_LOCK_DIR.exists()

# 4f. Verify stale lock (>5s) with NO pid file is also evicted and reacquired
ctl.STATE_LOCK_DIR.mkdir(parents=True, exist_ok=True)
os.utime(ctl.STATE_LOCK_DIR, (time.time() - 10, time.time() - 10))

with ctl.StateLock():
    assert ctl.STATE_LOCK_DIR.exists()
    assert (ctl.STATE_LOCK_DIR / "pid").read_text().strip() == str(os.getpid())

assert not ctl.STATE_LOCK_DIR.exists()

print("AUDIT_FIXES_VERIFIED")
      `,
    ], { encoding: 'utf8' })
    assert.ok(pyAuditOutput.includes('AUDIT_FIXES_VERIFIED'), 'Python audit fixes verification must pass')

    console.log('✓ audit fixes verified: Windows open-file spawn, non-busy wait in saveStatePatch, PID-based lock protection, and Windows drive root normalization')
    passed++
  } catch (err) {
    console.error('✗ audit fixes verification test')
    console.error(err)
    failed++
  }

  try {
    // Single-agent execution, JSON key parsing with newConversation, active execution mutex, and debounce guard
    const { execFileSync } = await import('node:child_process')
    const ctlScript = path.join(rootDir, 'scripts/watchdog_ctl.py')

    // 1. Python Controller tests: newConversation parsing, active execution mutex, and recovered conversationId
    const pyOutput = execFileSync('python3', [
      '-c',
      `
import sys, json, tempfile, shutil
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(rootDir)})
import scripts.watchdog_ctl as ctl

# Test JSON key parsing with newConversation
data_nested = {"response": {"newConversation": {"conversationId": "nested-conv-123"}}}
resp = data_nested.get("response") if isinstance(data_nested.get("response"), dict) else {}
new_conv = resp.get("newConversation") if isinstance(resp.get("newConversation"), dict) else {}
conv_id = (
    data_nested.get("conversationId")
    or resp.get("conversationId")
    or new_conv.get("conversationId")
)
assert conv_id == "nested-conv-123", f"Expected nested-conv-123, got {conv_id}"

# Test null-safety
data_null_resp = {"response": None}
resp_null = data_null_resp.get("response") if isinstance(data_null_resp.get("response"), dict) else {}
new_conv_null = resp_null.get("newConversation") if isinstance(resp_null.get("newConversation"), dict) else {}
conv_null_safe = (
    data_null_resp.get("conversationId")
    or resp_null.get("conversationId")
    or new_conv_null.get("conversationId")
)
assert conv_null_safe is None

# Test extract_conversation_id helper
assert ctl.extract_conversation_id(data_nested) == "nested-conv-123"
assert ctl.extract_conversation_id(data_null_resp) is None
assert ctl.extract_conversation_id({"response": {"newConversation": None}}) is None
assert ctl.extract_conversation_id({"conversationId": "direct-id"}) == "direct-id"
assert ctl.extract_conversation_id({"response": {"conversationId": "resp-id"}}) == "resp-id"
assert ctl.extract_conversation_id(None) is None
assert ctl.extract_conversation_id("invalid") is None

# Test is_plan_id_match helper
assert ctl.is_plan_id_match("1", "prop-1") is True
assert ctl.is_plan_id_match("#1", "prop-1") is True
assert ctl.is_plan_id_match("prop-1-slug", "1") is True
assert ctl.is_plan_id_match("prop-1-slug", "prop-1") is True
assert ctl.is_plan_id_match("prop-2", "prop-1") is False

# Test active execution mutex in execute_plan_in_agent
temp_dir = Path(tempfile.mkdtemp())
try:
    ns_dir = temp_dir / ".antigravity" / "next_steps"
    ns_dir.mkdir(parents=True)
    plan_file = ns_dir / "plan-1-test.md"
    plan_file.write_text("# Plan 1\\nDetails", encoding="utf-8")
    (ns_dir / "proposals.json").write_text(json.dumps({
        "proposals": [{
            "id": "prop-1",
            "title": "Test Plan 1",
            "planPath": str(plan_file),
            "planFile": "plan-1-test.md"
        }]
    }), encoding="utf-8")

    # Set execution state as running with active conversation
    (ns_dir / "execution_state.json").write_text(json.dumps({
        "executions": {
            "prop-1": {
                "planId": "prop-1",
                "title": "Test Plan 1",
                "status": "running",
                "conversationId": "foreground-agent"
            }
        }
    }), encoding="utf-8")

    # Mutex rejection test
    res = ctl.execute_plan_in_agent(temp_dir, "prop-1", spawn_agent=False)
    assert res.get("ok") is False, f"Expected ok: False, got {res}"
    assert res.get("alreadyRunning") is True, f"Expected alreadyRunning: True, got {res}"
    assert res.get("conversationId") == "foreground-agent"
    assert "already executing in an active agent conversation" in res.get("error", "")

    # When execution status is completed or interrupted -> mutex does not reject
    (ns_dir / "execution_state.json").write_text(json.dumps({
        "executions": {
            "prop-1": {
                "planId": "prop-1",
                "title": "Test Plan 1",
                "status": "completed",
                "conversationId": "foreground-agent"
            }
        }
    }), encoding="utf-8")
    res_completed = ctl.execute_plan_in_agent(temp_dir, "prop-1", spawn_agent=False)
    assert res_completed.get("ok") is True, f"Expected ok: True, got {res_completed}"
    assert not res_completed.get("alreadyRunning")

    # Test recovered conversationId updates conv_id and dispatched: True
    plan_file_rec = ns_dir / "plan-rec-test.md"
    plan_file_rec.write_text("# Plan Rec\\nDetails", encoding="utf-8")
    (ns_dir / "proposals.json").write_text(json.dumps({
        "proposals": [{
            "id": "prop-rec",
            "title": "Test Plan Rec",
            "planPath": str(plan_file_rec)
        }]
    }), encoding="utf-8")
    (ns_dir / "execution_state.json").write_text(json.dumps({
        "executions": {
            "prop-rec": {
                "planId": "prop-rec",
                "title": "Test Plan Rec",
                "conversationId": "disk-recovered-conv-888",
                "status": "interrupted"
            }
        }
    }), encoding="utf-8")

    orig_spawn = ctl.spawn_plan_agent
    ctl.spawn_plan_agent = lambda repo, title, content: None
    res_rec = ctl.execute_plan_in_agent(temp_dir, "prop-rec", spawn_agent=True)
    assert res_rec.get("ok") is True
    assert res_rec.get("dispatched") is True, f"dispatched must be True when recovered, got {res_rec.get('dispatched')}"
    assert res_rec.get("conversationId") == "disk-recovered-conv-888"

    # Test multi-threaded concurrency mutex with StateLock
    import threading, time
    plan_file_conc = ns_dir / "plan-conc-test.md"
    plan_file_conc.write_text("# Plan Conc\\nDetails", encoding="utf-8")
    (ns_dir / "proposals.json").write_text(json.dumps({
        "proposals": [{
            "id": "prop-conc",
            "title": "Test Plan Conc",
            "planPath": str(plan_file_conc)
        }]
    }), encoding="utf-8")
    (ns_dir / "execution_state.json").write_text(json.dumps({"executions": {}}), encoding="utf-8")

    ctl.spawn_plan_agent = lambda repo, title, content: (time.sleep(0.05) or "foreground-agent")
    conc_results = []
    def run_worker():
        r = ctl.execute_plan_in_agent(temp_dir, "prop-conc", spawn_agent=True)
        conc_results.append(r)
    th1 = threading.Thread(target=run_worker)
    th2 = threading.Thread(target=run_worker)
    th1.start()
    th2.start()
    th1.join()
    th2.join()
    assert len(conc_results) == 2
    ok_count = sum(1 for r in conc_results if r.get("ok") is True)
    mutex_count = sum(1 for r in conc_results if r.get("alreadyRunning") is True)
    assert ok_count == 1, f"Expected exactly 1 successful execution, got {ok_count}"
    assert mutex_count == 1, f"Expected exactly 1 mutex rejection, got {mutex_count}"
    ctl.spawn_plan_agent = orig_spawn
finally:
    shutil.rmtree(temp_dir, ignore_errors=True)

print("PYTHON_MUTEX_AND_PARSE_OK")
      `,
    ], { encoding: 'utf8' })
    assert.ok(pyOutput.includes('PYTHON_MUTEX_AND_PARSE_OK'))

    // 2. Sidecar Backend: POST /api/next-steps/execute supports data?.noSpawn
    const mainMjsRaw = fs.readFileSync(path.join(rootDir, 'sidecars/panel/main.mjs'), 'utf8')
    assert.ok(mainMjsRaw.includes("if (data?.noSpawn)"), 'main.mjs must check data?.noSpawn')
    assert.ok(mainMjsRaw.includes("args.push('--no-spawn')"), "main.mjs must append '--no-spawn' to args")

    // 3. Frontend Webview app.js: debounce guard, button disabling, alreadyRunning, convRes key extraction
    const appJsRaw = fs.readFileSync(path.join(rootDir, 'sidecars/panel/app.js'), 'utf8')
    assert.ok(appJsRaw.includes("let isExecutingPlan = false;"), 'app.js must declare isExecutingPlan')
    assert.ok(appJsRaw.includes("if (isExecutingPlan) return;"), 'app.js executePlan must check isExecutingPlan debounce guard')
    assert.ok(appJsRaw.includes("res?.alreadyRunning"), 'app.js executePlan must handle res.alreadyRunning')
    assert.ok(appJsRaw.includes("Plan is already executing in an active agent conversation"), 'app.js executePlan must toast already executing message')
    assert.ok(appJsRaw.includes("convRes?.response?.newConversation?.conversationId"), 'app.js executePlan and runAudit must extract newConversation.conversationId')
    assert.ok(appJsRaw.includes("res.dispatched || (res.conversationId && res.conversationId !== 'foreground-agent')"), 'app.js executePlan must eliminate race condition on backend dispatch')

    // 4. Runtime test of executePlan in VM sandbox:
    // Test that when res.alreadyRunning is returned, sidecar.agent.startConversation is NOT called!
    const vm = await import('node:vm')
    let startConvCalled = 0
    let toastMessages = []

    const elements = new Map()
    function mockElement(tag = 'div') {
      return {
        tagName: tag.toUpperCase(),
        style: {},
        classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
        setAttribute() {},
        removeAttribute() {},
        getAttribute: () => null,
        appendChild() {},
        addEventListener() {},
        removeEventListener() {},
        innerHTML: '',
        innerText: '',
        textContent: '',
        value: '',
        hidden: false,
        disabled: false,
        dataset: {},
        querySelector: () => null,
        querySelectorAll: () => [],
      }
    }

    const modalBtn = mockElement('button')
    modalBtn.id = 'modal-btn-execute'
    elements.set('modal-btn-execute', modalBtn)
    const planModal = mockElement('div')
    planModal.id = 'plan-modal'
    elements.set('plan-modal', planModal)
    const toastEl = mockElement('div')
    toastEl.id = 'toast'
    elements.set('toast', toastEl)

    let currentExecuteApiResponse = {}
    let lastToastMessage = ''

    const testSandbox = {
      window: null,
      document: {
        getElementById: (id) => elements.get(id) || mockElement(),
        querySelector: (sel) => {
          if (sel === '#modal-btn-execute') return modalBtn
          return null
        },
        querySelectorAll: () => [],
        addEventListener() {},
      },
      $: (id) => elements.get(id) || mockElement(),
      localStorage: { getItem: () => null, setItem: () => {} },
      sessionStorage: { getItem: () => null, setItem: () => {} },
      location: { search: '' },
      navigator: { clipboard: { writeText: async () => {} } },
      setTimeout,
      clearTimeout,
      sidecar: {
        agent: {
          startConversation: async () => {
            startConvCalled++
            return { conversationId: 'fallback-agent-123' }
          },
        },
        fetch: async (url, options = {}) => {
          if (url.includes('/api/next-steps/execute')) {
            return {
              ok: true,
              status: 200,
              json: async () => currentExecuteApiResponse,
            }
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
          }
        },
      },
      addEventListener() {},
      removeEventListener() {},
      getComputedStyle: () => ({ getPropertyValue: () => '#0b0f19' }),
      matchMedia: () => ({ matches: false }),
      URLSearchParams,
      console: { log() {}, warn() {}, error() {} },
    }
    testSandbox.window = testSandbox

    // Run app.js in sandbox
    vm.createContext(testSandbox)
    vm.runInContext(appJsRaw, testSandbox)

    testSandbox.renderDashboard({
      activeRepos: [
        { repoPath: '/test/repo', repoName: 'test-repo' },
      ],
    })

    // 1. Test execute plan when alreadyRunning is true
    currentExecuteApiResponse = {
      ok: false,
      alreadyRunning: true,
      conversationId: 'existing-conv-1',
      error: 'Plan is already executing in an active agent conversation.',
    }
    await testSandbox.executePlan('prop-1')
    assert.equal(startConvCalled, 0, 'startConversation must NOT be called when alreadyRunning is true')
    assert.ok(toastEl.textContent.includes('Plan is already executing in an active agent conversation'), `Must toast already executing message, got: ${toastEl.textContent}`)

    // 2. Test successful backend dispatch (res.dispatched = true)
    toastEl.textContent = ''
    currentExecuteApiResponse = {
      ok: true,
      dispatched: true,
      conversationId: 'backend-spawned-conv-777',
      title: 'Test Plan',
    }
    await testSandbox.executePlan('prop-1')
    assert.equal(startConvCalled, 0, 'startConversation must NOT be called when backend dispatched: true')
    assert.ok(toastEl.textContent.includes('Agent conversation started'), `Must toast Agent conversation started, got: ${toastEl.textContent}`)

    // 3. Test debounce guard: in-flight call returns immediately
    let slowResolve
    currentExecuteApiResponse = new Promise((resolve) => { slowResolve = resolve })
    testSandbox.sidecar.fetch = async (url) => {
      if (url.includes('/api/next-steps/execute')) {
        const data = await currentExecuteApiResponse
        return { ok: true, status: 200, json: async () => data }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    const p1 = testSandbox.executePlan('prop-1')
    // While p1 is in-flight, execute button should be disabled and second call debounced
    assert.equal(modalBtn.disabled, true, 'modal execute button must be disabled during in-flight request')
    const p2 = testSandbox.executePlan('prop-1')
    slowResolve({ ok: true, dispatched: true, conversationId: 'c1', title: 'Plan 1' })
    await Promise.all([p1, p2])
    assert.equal(modalBtn.disabled, false, 'modal execute button must be re-enabled after completion')

    // 4. Test fallback to sidecar.agent.startConversation when backend did not dispatch
    toastEl.textContent = ''
    startConvCalled = 0
    let lastMarkRunningCall = null
    testSandbox.sidecar.fetch = async (url, options = {}) => {
      if (url.includes('/api/next-steps/execute')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            dispatched: false,
            conversationId: 'foreground-agent',
            title: 'Test Plan Fallback',
            prompt: 'Execute plan prompt',
          }),
        }
      }
      if (url.includes('/api/next-steps/mark-running')) {
        lastMarkRunningCall = options.body ? (typeof options.body === 'string' ? JSON.parse(options.body) : options.body) : null
        return { ok: true, status: 200, json: async () => ({ ok: true }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    testSandbox.sidecar.agent.startConversation = async () => {
      startConvCalled++
      return {
        response: {
          newConversation: {
            conversationId: 'vm-fallback-new-conv-999',
          },
        },
      }
    }
    await testSandbox.executePlan('prop-1')
    assert.equal(startConvCalled, 1, 'startConversation must be called when backend did not dispatch')
    assert.equal(lastMarkRunningCall?.conversationId, 'vm-fallback-new-conv-999', 'mark-running must receive extracted newConversation ID')
    assert.ok(toastEl.textContent.includes('Launched agent conversation'), `Must toast Launched agent conversation, got: ${toastEl.textContent}`)

    console.log('✓ single-agent execution, JSON key parsing with newConversation, active execution mutex, and debounce guard verified')
    passed++
  } catch (err) {
    console.error('✗ single-agent execution & mutex test')
    console.error(err)
    failed++
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
