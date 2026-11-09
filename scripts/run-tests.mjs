import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  return (async () => {
    try {
      await fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`✗ ${name}`);
      console.error(err);
      failed++;
    }
  })();
}

async function main() {
  console.log('Running Watchdog Antigravity Test Suite...\n');

  // =========================================================================
  // 1. View-Model Unit Tests (sidecars/panel/view-model.js)
  // =========================================================================
  await runTest('sidecars/panel/view-model.js: selectActiveRepo, normalizeWsUri, auditAction, jobView, helpers', async () => {
    const vmUrl = pathToFileURL(path.join(rootDir, 'sidecars/panel/view-model.js')).href;
    const vmodel = await import(vmUrl);

    // selectActiveRepo
    assert.equal(vmodel.selectActiveRepo({ activeRepos: [], jobs: [] }), null);
    const parentWsTest = vmodel.selectActiveRepo(
      {
        activeRepos: [
          { repoPath: '/Users/test/other-repo', repoName: 'other-repo' },
          { repoPath: '/Users/test/#KdG/AI Sandbox/antigravity-watchdog', repoName: 'antigravity-watchdog' },
        ],
        jobs: [],
      },
      { workspaceUris: ['file:///Users/test/%23KdG/AI%20Sandbox'] }
    );
    assert.equal(parentWsTest?.repoName, 'antigravity-watchdog');

    // normalizeWsUri
    assert.equal(vmodel.normalizeWsUri('file:///Users/sefa/%23KdG/Sandbox/'), '/Users/sefa/#KdG/Sandbox');
    assert.equal(vmodel.normalizeWsUri('file:///C:/Users/test/workspace/'), 'C:/Users/test/workspace');
    assert.equal(vmodel.normalizeWsUri('/plain/path/with/trailing/slash///'), '/plain/path/with/trailing/slash');
    assert.equal(vmodel.normalizeWsUri(''), '');

    // auditAction
    const actionNone = vmodel.auditAction({ activeRepos: [], jobs: [] }, null);
    assert.equal(actionNone.kind, 'none');
    assert.equal(actionNone.disabled, true);

    // sameRepo empty guard
    const jobA = { id: '1', repo_path: '' };
    const repoA = { repoPath: '/data/repoA' };
    const actionEmptyRepo = vmodel.auditAction({ jobs: [jobA] }, repoA);
    assert.equal(actionEmptyRepo.matchingJob, null);

    // [skip-watchdog] manual review override
    const skipRepo = {
      repoPath: '/data/repoB',
      head: { sha: 'abcdef1234567890', shortSha: 'abcdef1', subject: 'docs: update [skip-watchdog]' },
    };
    const skipAction = vmodel.auditAction({ jobs: [] }, skipRepo);
    assert.equal(skipAction.isAuditSkipped, true);
    assert.equal(skipAction.isAppliedFix, false);
    assert.equal(skipAction.kind, 'audit');
    assert.equal(skipAction.disabled, false);
    assert.ok(skipAction.label.includes('Run Review'));

    // jobView
    const jv = vmodel.jobView({ id: '1', short_sha: 'abc1234', status: 'completed', verdict: 'FIXED_ON_BRANCH', fixes_committed: true });
    assert.equal(jv.hasFixToApply, true);
    assert.deepEqual(jv.badge, { kind: 'fix', label: 'Ready' });

    const jvPass = vmodel.jobView({ id: '2', short_sha: 'def5678', status: 'completed', verdict: 'PASS' });
    assert.equal(jvPass.isPassed, true);
    assert.equal(jvPass.badge, null);

    const jvNeeds = vmodel.jobView({ id: '3', short_sha: 'ghi9012', status: 'completed', verdict: 'NEEDS_ATTENTION' });
    assert.deepEqual(jvNeeds.badge, { kind: 'warn', label: 'Issues' });

    // stripEmojis & timeAgo
    assert.equal(vmodel.stripEmojis('🚀 Ship it! ✨'), 'Ship it!');
    assert.equal(vmodel.timeAgo('invalid-date'), '');
    assert.equal(vmodel.timeAgo(new Date(Date.now() - 120_000).toISOString()), '2m ago');

    // partitionJobs
    const parts = vmodel.partitionJobs({ jobs: [{ id: 'a', short_sha: '1', archived: false }, { id: 'b', short_sha: '2', archived: true }] });
    assert.equal(parts.recent.length, 1);
    assert.equal(parts.archived.length, 1);
  });

  // =========================================================================
  // 2. Panel DOM Structure & Syntax Verification
  // =========================================================================
  await runTest('sidecars/panel: index.html markup integrity and JS syntax validation', async () => {
    const indexHtml = fs.readFileSync(path.join(rootDir, 'sidecars/panel/index.html'), 'utf8');

    // Classic script tag for /app.js so Antigravity sidecar-gateway preserves cookies
    assert.ok(!/<script\s+type="module"\s+src="\/app\.js/.test(indexHtml), 'index.html must use classic script tag for /app.js');
    assert.ok(/id="btn-refresh-goal"/.test(indexHtml), 'index.html must include #btn-refresh-goal');
    assert.ok(/id="goal-text"/.test(indexHtml), 'index.html must include #goal-text');
    assert.ok(/id="proposals-list"/.test(indexHtml), 'index.html must include #proposals-list');
    assert.ok(/id="btn-run-audit"/.test(indexHtml), 'index.html must include #btn-run-audit');

    // Verify syntax of panel files
    execFileSync(process.execPath, ['--check', path.join(rootDir, 'sidecars/panel/app.js')]);
    execFileSync(process.execPath, ['--check', path.join(rootDir, 'sidecars/panel/main.mjs')]);
    execFileSync(process.execPath, ['--check', path.join(rootDir, 'sidecars/panel/view-model.js')]);
    execFileSync(process.execPath, ['--check', path.join(rootDir, 'sidecars/panel/standalone_sdk.mjs')]);
  });

  // =========================================================================
  // 3. Standalone SDK Security & Route Dispatching (standalone_sdk.mjs)
  // =========================================================================
  await runTest('sidecars/panel/standalone_sdk.mjs: token issuance, loopback protection, 401 unauthenticated guard', async () => {
    const sdkUrl = pathToFileURL(path.join(rootDir, 'sidecars/panel/standalone_sdk.mjs')).href;
    const { SidecarApp } = await import(sdkUrl);
    const testApp = new SidecarApp();
    testApp.page('/', () => '<html><body>Antigravity Panel</body></html>');
    testApp.api('/api/test-secure', () => ({ ok: true }));
    testApp.api('/api/dashboard', () => ({ ok: true, activeRepos: [] }));
    const testServer = await testApp.run();
    const testPort = testServer.address().port;

    try {
      // 1. GET / returns 200 and issues sidecar_token cookie
      const getRes = await fetch(`http://127.0.0.1:${testPort}/`);
      assert.equal(getRes.status, 200);
      const setCookie = getRes.headers.get('set-cookie') || '';
      assert.ok(setCookie.includes('sidecar_token='), 'GET / must issue sidecar_token cookie');
      const tokenMatch = setCookie.match(/sidecar_token=([^;]+)/);
      const cookieToken = tokenMatch ? tokenMatch[1] : null;
      assert.ok(cookieToken, 'sidecar_token cookie value must be present');

      // 2. Safe read endpoint /api/dashboard allowed without token
      const dashRes = await fetch(`http://127.0.0.1:${testPort}/api/dashboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(dashRes.status, 200);

      // 3. Mutating endpoint without token returns 401
      const mutResNoToken = await fetch(`http://127.0.0.1:${testPort}/api/test-secure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(mutResNoToken.status, 401);

      // 4. Mutating endpoint with valid cookie token succeeds (200)
      const mutResCookie = await fetch(`http://127.0.0.1:${testPort}/api/test-secure`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': `sidecar_token=${cookieToken}`,
        },
        body: JSON.stringify({}),
      });
      assert.equal(mutResCookie.status, 200);

      // 5. Mutating endpoint with valid header token succeeds (200)
      const mutResHeader = await fetch(`http://127.0.0.1:${testPort}/api/test-secure`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-sidecar-token': cookieToken,
        },
        body: JSON.stringify({}),
      });
      assert.equal(mutResHeader.status, 200);

      // 6. /api/open-file is not a safe endpoint, requires auth token
      testApp.api('/api/open-file', () => ({ ok: true }));
      const openResNoToken = await fetch(`http://127.0.0.1:${testPort}/api/open-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(openResNoToken.status, 401, '/api/open-file must require token authentication');

      // 7. Non-loopback Host header returns 401 (preventing DNS rebinding)
      for (const badHost of ['attacker.com', 'localhost.attacker.com', '127.0.0.1.attacker.com', 'attacker.com:60242']) {
        const rebindStatus = await new Promise((resolve, reject) => {
          const req = http.request({
            hostname: '127.0.0.1',
            port: testPort,
            path: '/api/dashboard',
            method: 'POST',
            headers: {
              'Host': badHost,
              'Content-Type': 'application/json',
              'x-sidecar-token': cookieToken,
            },
          }, (res) => {
            resolve(res.statusCode);
          });
          req.on('error', reject);
          req.end(JSON.stringify({}));
        });
        assert.equal(rebindStatus, 401, `Non-loopback Host header (${badHost}) must be rejected with 401`);
      }
    } finally {
      testServer.close();
    }
  });

  // =========================================================================
  // 4. Host Bridge Logic in main.mjs (Process Spawn, Atomics.wait, State Lock)
  // =========================================================================
  await runTest('sidecars/panel/main.mjs: cross-platform file opening, Atomics.wait sleep, PID lock safety', async () => {
    const mainMjsRaw = fs.readFileSync(path.join(rootDir, 'sidecars/panel/main.mjs'), 'utf8');

    // Cross-platform open-file spawn logic
    assert.ok(mainMjsRaw.includes("process.platform === 'win32'"), 'main.mjs must check win32');
    assert.ok(mainMjsRaw.includes("child.on('error', () => {})"));
    assert.ok(mainMjsRaw.includes("child.unref()"));
    assert.ok(mainMjsRaw.includes("DANGEROUS_OPEN_EXTENSIONS"), 'main.mjs must define dangerous extensions list');
    assert.ok(mainMjsRaw.includes("isPathInside"), 'main.mjs must check workspace confinement');
    assert.ok(mainMjsRaw.includes("Timed out waiting for state lock:"), 'saveStatePatch must throw explicit timeout error');
    assert.ok(mainMjsRaw.includes("async function runGit"), 'main.mjs must declare runGit as async');
    assert.ok(mainMjsRaw.includes("async function runPythonCtl"), 'main.mjs must declare runPythonCtl as async');
    assert.ok(!mainMjsRaw.includes("normResolved.includes('/.antigravity/')"), 'main.mjs must not use loose substring matching for .antigravity');
    assert.ok(mainMjsRaw.includes("isPathInside(WATCHDOG_DIR, resolved)"), 'isAllowedArtifactPath must anchor to WATCHDOG_DIR');
    assert.ok(mainMjsRaw.includes("join(root, '.antigravity')"), 'isAllowedArtifactPath must anchor to active workspace .antigravity');

    // Non-busy wait using Atomics.wait
    assert.ok(!mainMjsRaw.includes('while (Date.now() - start <'), 'main.mjs must not contain synchronous busy-wait spin loops');
    assert.ok(mainMjsRaw.includes('Atomics.wait(sleepBuffer, 0, 0, ms)'), 'main.mjs must use Atomics.wait for sleep');
    assert.ok(mainMjsRaw.includes('syncSleep(25)'), 'saveStatePatch must use syncSleep(25)');
    assert.ok(mainMjsRaw.includes('syncSleep(20)'), 'saveStatePatch must use syncSleep(20)');
    assert.ok(mainMjsRaw.includes('syncSleep(15)'), 'loadState must use syncSleep(15)');

    // Actual Atomics.wait execution check
    const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
    const t0 = Date.now();
    Atomics.wait(sleepBuffer, 0, 0, 25);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 15, `Atomics.wait must pause execution without spin-waiting (elapsed: ${elapsed}ms)`);

    // Lock file PID recording and verification
    assert.ok(mainMjsRaw.includes("writeFileSync(join(lockDir, 'pid'), String(process.pid), 'utf8')"));
    assert.ok(mainMjsRaw.includes('process.kill(pid, 0)'));
    assert.ok(mainMjsRaw.includes("rmSync(lockDir, { recursive: true, force: true })"));

    // Ensure host in api/health is strictly 'antigravity'
    assert.ok(mainMjsRaw.includes("host: 'antigravity'"), 'api/health must report host as antigravity');

    // Functional verification of isPathInside and symlink escape prevention
    const tmpTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-test-conf-'));
    try {
      const insideFile = path.join(tmpTestDir, 'safe.txt');
      fs.writeFileSync(insideFile, 'safe');
      const outsideFile = path.join(os.tmpdir(), `outside-target-${Date.now()}.txt`);
      fs.writeFileSync(outsideFile, 'secret');

      const symlinkToOutside = path.join(tmpTestDir, 'sym-outside.txt');
      const symlinkToInside = path.join(tmpTestDir, 'sym-inside.txt');
      try {
        fs.symlinkSync(outsideFile, symlinkToOutside);
        fs.symlinkSync(insideFile, symlinkToInside);
      } catch {}

      const isPathInsideMatch = mainMjsRaw.match(/function getRealPath[\s\S]*?function isPathInside\([^)]*\)\s*\{[\s\S]*?\n\}/);
      assert.ok(isPathInsideMatch, 'isPathInside function must be extractable from main.mjs');
      const testIsPathInside = new Function('resolve', 'relative', 'isAbsolute', 'existsSync', 'realpathSync', `
        ${isPathInsideMatch[0]}
        return isPathInside;
      `)(path.resolve, path.relative, path.isAbsolute, fs.existsSync, fs.realpathSync);

      assert.equal(testIsPathInside(tmpTestDir, insideFile), true, 'Direct child file must be inside');
      assert.equal(testIsPathInside(tmpTestDir, outsideFile), false, 'Outside file must not be inside');
      if (fs.existsSync(symlinkToOutside)) {
        assert.equal(testIsPathInside(tmpTestDir, symlinkToOutside), false, 'Symlink pointing outside workspace must NOT be considered inside');
        assert.equal(testIsPathInside(tmpTestDir, symlinkToInside), true, 'Symlink pointing inside workspace must be considered inside');
      }
      fs.rmSync(outsideFile, { force: true });
    } finally {
      fs.rmSync(tmpTestDir, { recursive: true, force: true });
    }

    // Functional verification of isAllowedArtifactPath
    const isAllowedMatch = mainMjsRaw.match(/function isAllowedArtifactPath\([^)]*\)\s*\{[\s\S]*?\n\}/);
    assert.ok(isAllowedMatch, 'isAllowedArtifactPath function must be extractable from main.mjs');
    const mockWatchdogDir = path.join(os.tmpdir(), 'watchdog-mock');
    const mockWorkspace = path.join(os.tmpdir(), 'ws-mock');
    const testIsAllowedArtifactPath = new Function('resolve', 'join', 'isPathInside', 'getActiveWorkspacePaths', 'WATCHDOG_DIR', `
      ${isAllowedMatch[0]}
      return isAllowedArtifactPath;
    `)(path.resolve, path.join, (parent, target) => {
      const rel = path.relative(path.resolve(parent), path.resolve(target));
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    }, () => [mockWorkspace], mockWatchdogDir);

    assert.equal(testIsAllowedArtifactPath(path.join(mockWatchdogDir, 'report.md')), true, 'WATCHDOG_DIR .md must be allowed');
    assert.equal(testIsAllowedArtifactPath(path.join(mockWorkspace, '.antigravity', 'plan.json')), true, 'Workspace .antigravity .json must be allowed');
    assert.equal(testIsAllowedArtifactPath(path.join(mockWorkspace, 'src', 'fake.md')), false, 'Workspace outside .antigravity must be disallowed');
    assert.equal(testIsAllowedArtifactPath('/arbitrary/path/with/.antigravity/fake.md'), false, 'Arbitrary path with .antigravity substring must be disallowed');
    assert.equal(testIsAllowedArtifactPath(path.join(mockWorkspace, '.antigravity', 'evil.sh')), false, 'Non-md/json must be disallowed');
  });

  // =========================================================================
  // 5. Frontend Panel app.js Runtime Simulation in VM Sandbox
  // =========================================================================
  await runTest('sidecars/panel/app.js: hostMode, DOM synchronization, debounce guard, alreadyRunning mutex, AgentAPI response unwrap', async () => {
    const appJsCode = fs.readFileSync(path.join(rootDir, 'sidecars/panel/app.js'), 'utf8');

    const elements = new Map();
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
          add(c) { this.classes.add(c); },
          remove(c) { this.classes.delete(c); },
          toggle(c, v) { if (v) this.classes.add(c); else this.classes.delete(c); },
          contains(c) { return this.classes.has(c); },
        },
        dataset: {},
        style: { setProperty() {} },
        setAttribute() {},
        removeAttribute() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {},
        innerHTML: '',
      };
      elements.set(id, el);
      return el;
    }

    const domIds = [
      'select-repo', 'repo-name', 'repo-branch', 'commit-sha', 'commit-subject', 'commit-time',
      'commit-tag-badge', 'btn-run-audit', 'btn-run-audit-text', 'btn-run-audit-icon',
      'input-audit-comment', 'audits-count', 'archived-count', 'archive-details', 'jobs-list',
      'archived-jobs-list', 'btn-sync', 'toast', 'tab-btn-audits', 'tab-btn-next-steps',
      'tab-pane-audits', 'tab-pane-next-steps', 'tab-badge-audits', 'tab-badge-proposals',
      'btn-refresh-goal', 'btn-edit-goal', 'btn-refresh-proposals', 'btn-cancel-synthesis-header',
      'goal-text', 'ns-goal-text', 'input-goal', 'proposals-list', 'ns-goal-edit-form', 'ns-goal-view',
      'report-card', 'btn-close-report', 'btn-send-report-chat', 'modal-btn-execute', 'plan-modal',
    ];
    for (const id of domIds) {
      createMockElement(id);
    }

    const mockStorage = new Map();
    const storageObj = {
      getItem(k) { return mockStorage.get(k) || null; },
      setItem(k, v) { mockStorage.set(k, String(v)); },
      removeItem(k) { mockStorage.delete(k); },
    };

    let startConvCalls = 0;
    let executeApiResponse = { ok: true, dispatched: true, title: 'Plan 1' };

    const sandbox = {
      window: null,
      document: {
        getElementById(id) {
          if (!elements.has(id)) createMockElement(id);
          return elements.get(id);
        },
        addEventListener() {},
        documentElement: createMockElement('html'),
        hidden: false,
        querySelector(sel) {
          if (sel === '#modal-btn-execute') return elements.get('modal-btn-execute');
          return null;
        },
        querySelectorAll: () => [],
      },
      location: {
        href: 'plugin://watchdog--panel-12345/?token=test-token&conversationId=test-conv-1',
        search: '?token=test-token&conversationId=test-conv-1',
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
      navigator: { clipboard: { writeText: async () => {} } },
      sidecar: {
        isStandalone: false,
        conversationId: 'test-conv-1',
        getWorkspaceUris: async () => ['file:///Users/sefa/Documents/Code/Watchdog/antigravity-watchdog'],
        onWorkspaceChange: () => {},
        agent: {
          startConversation: async () => {
            startConvCalls++;
            return { response: { newConversation: { conversationId: 'antigravity-agent-conv-456' } } };
          },
        },
        fetch: async (url, options = {}) => {
          if (url.includes('/api/next-steps/execute')) {
            return { ok: true, status: 200, json: async () => executeApiResponse };
          }
          if (url.includes('/api/dashboard')) {
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
                      subject: 'feat: native Antigravity architecture',
                      relativeTime: 'just now',
                      timestamp: Date.now() / 1000,
                    },
                    youngestCommit: {
                      sha: '976b62cc0dfa774281bc29dae0a30afc4e79f5aa',
                      short_sha: '976b62c',
                      subject: 'feat: native Antigravity architecture',
                      relative_time: 'just now',
                      timestamp: Date.now() / 1000,
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
            };
          }
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        },
      },
    };
    sandbox.window = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(appJsCode, sandbox);

    // Verify hostMode evaluates to 'antigravity'
    assert.equal(sandbox.window.hostMode, 'antigravity', `window.hostMode must be 'antigravity', got: ${sandbox.window.hostMode}`);

    // Call init / syncGit
    await sandbox.init();
    await new Promise((r) => setTimeout(r, 50));

    const commitSubjectEl = elements.get('commit-subject');
    assert.ok(commitSubjectEl.textContent.includes('feat: native Antigravity architecture'));
    const repoNameEl = elements.get('repo-name');
    assert.equal(repoNameEl.textContent, 'antigravity-watchdog');

    // Test executePlan alreadyRunning mutex
    executeApiResponse = {
      ok: false,
      alreadyRunning: true,
      conversationId: 'existing-conv',
      error: 'Plan is already executing in an active agent conversation.',
    };
    await sandbox.executePlan('prop-1');
    assert.equal(startConvCalls, 0, 'startConversation must NOT be called when plan is already running');
    const toastEl = elements.get('toast');
    assert.ok(toastEl.textContent.includes('Plan is already executing'));

    // Test executePlan successful backend dispatch
    toastEl.textContent = '';
    executeApiResponse = {
      ok: true,
      dispatched: true,
      conversationId: 'backend-spawned-conv-777',
      title: 'Test Plan',
    };
    await sandbox.executePlan('prop-1');
    assert.equal(startConvCalls, 0, 'startConversation must NOT be called when backend dispatched: true');
    assert.ok(toastEl.textContent.includes('Agent conversation started'));
  });

  // =========================================================================
  // 6. Python Controller Concurrency, Pathing, and Transcripts (watchdog_ctl.py)
  // =========================================================================
  await runTest('scripts/watchdog_ctl.py: StateLock concurrency, path normalization, plan execution mutex, worktree reconciliation', async () => {
    const pyOutput = execFileSync('python3', [
      '-c',
      `
import sys, os, time, json, threading, tempfile, shutil, subprocess
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, ${JSON.stringify(rootDir)})
import scripts.watchdog_ctl as ctl

# 1. StateLock Concurrency
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

# Test StateLock explicit TimeoutError on contention
timed_out_raised = False
try:
    ctl.STATE_LOCK_DIR.mkdir(parents=True, exist_ok=True)
    (ctl.STATE_LOCK_DIR / "pid").write_text(str(os.getpid()), encoding="utf-8")
    def try_lock():
        global timed_out_raised
        try:
            with ctl.StateLock():
                pass
        except TimeoutError:
            timed_out_raised = True
    t_lock = threading.Thread(target=try_lock)
    t_lock.start()
    t_lock.join()
finally:
    shutil.rmtree(ctl.STATE_LOCK_DIR, ignore_errors=True)
assert timed_out_raised is True, "StateLock must raise TimeoutError on contention timeout"

# Test StateLock explicit TimeoutError on file lock contention
timed_out_file_lock = False
try:
    with open(ctl.LOCK_FILE, "a+") as f_held:
        if ctl.fcntl is not None:
            ctl.fcntl.flock(f_held.fileno(), ctl.fcntl.LOCK_EX)
        def try_flock():
            global timed_out_file_lock
            try:
                with ctl.StateLock():
                    pass
            except TimeoutError:
                timed_out_file_lock = True
        t_flock = threading.Thread(target=try_flock)
        t_flock.start()
        t_flock.join()
        if ctl.fcntl is not None:
            ctl.fcntl.flock(f_held.fileno(), ctl.fcntl.LOCK_UN)
finally:
    pass
assert timed_out_file_lock is True, "StateLock must raise TimeoutError on file lock contention"

# 2. Path normalization & Windows compatibility
assert ctl.is_same_repo_path("/path/to/repo/", "/path/to/repo") is True
assert ctl.is_same_repo_path("C:\\\\repo\\\\sub", "C:/repo/sub") is True
assert ctl.is_same_repo_path(None, "/path") is False
assert ctl.is_same_repo_path("/path", None) is False

for candidate in ["C:", "C:\\\\", "C:/", "file:///C:/", "file:///C:", "/C:/", "/C:", "file://localhost/C:", "file://localhost/C:/"]:
    for other in ["C:", "C:\\\\", "C:/", "file:///C:/", "file:///C:", "/C:/", "/C:"]:
        assert ctl.is_same_repo_path(candidate, other) is True, f"Failed match {candidate} vs {other}"

# 3. Process liveness verification
assert ctl.is_pid_alive(os.getpid()) is True
assert ctl.is_pid_alive(99999999) is False
assert ctl.is_pid_alive(0) is False
assert ctl.is_pid_alive(-5) is False

# 4. Plan ID '#' stripping
repo_path = Path(${JSON.stringify(rootDir)})
rec = ctl.mark_execution_running(repo_path, "#2", "test-conv", "Test Title")
assert rec["planId"] == "2", f"Expected planId '2', got {rec['planId']}"
cancelled = ctl.cancel_execution(repo_path, "#2")
assert cancelled["ok"] is True

# 5. Antigravity Brain Transcript settling & activity checks
with tempfile.TemporaryDirectory() as tmp_brain:
    brain_dir = Path(tmp_brain)
    old_brain = ctl.BRAIN_DIR
    ctl.BRAIN_DIR = brain_dir
    try:
        test_conv_id = "test-conv-active-check"
        log_dir = brain_dir / test_conv_id / ".system_generated" / "logs"
        log_dir.mkdir(parents=True)
        t_file = log_dir / "transcript.jsonl"

        # Recent PLANNER_RESPONSE without tool calls -> active
        t_file.write_text(json.dumps({"type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": []}) + "\\n", encoding="utf-8")
        assert ctl.is_conversation_active(test_conv_id, max_age_seconds=900) is True

        # Tool calls present -> active
        t_file.write_text(json.dumps({"type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": [{"name": "test"}]}) + "\\n", encoding="utf-8")
        assert ctl.is_conversation_active(test_conv_id, max_age_seconds=900) is True

        # GENERIC status ERROR (e.g. failing test output) -> still active
        t_file.write_text(json.dumps({"type": "GENERIC", "status": "ERROR", "content": "1 test failed"}) + "\\n", encoding="utf-8")
        assert ctl.is_conversation_active(test_conv_id, max_age_seconds=900) is True

        # PLANNER_RESPONSE status ERROR -> inactive
        t_file.write_text(json.dumps({"type": "PLANNER_RESPONSE", "status": "ERROR", "tool_calls": []}) + "\\n", encoding="utf-8")
        assert ctl.is_conversation_active(test_conv_id, max_age_seconds=900) is False

        # Status CANCELLED -> inactive
        t_file.write_text(json.dumps({"type": "GENERIC", "status": "CANCELLED"}) + "\\n", encoding="utf-8")
        assert ctl.is_conversation_active(test_conv_id, max_age_seconds=900) is False

        # Stale PLANNER_RESPONSE (> 600s) -> inactive
        t_file.write_text(json.dumps({"type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": []}) + "\\n", encoding="utf-8")
        stale_time_dead = time.time() - 650
        os.utime(t_file, (stale_time_dead, stale_time_dead))
        assert ctl.is_conversation_active(test_conv_id, max_age_seconds=900) is False
    finally:
        ctl.BRAIN_DIR = old_brain

# 6. Reconcile job finding report in detached worktree
with tempfile.TemporaryDirectory() as tmp_repo, tempfile.TemporaryDirectory() as tmp_wt:
    r_dir = Path(tmp_repo)
    w_dir = Path(tmp_wt)
    sha = "1234567890abcdef"
    short_sha = sha[:7]
    
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
    assert modified is True
    assert job["status"] == "completed"
    assert job["verdict"] == "PASS"
    assert (r_dir / ".antigravity" / "audits" / f"review-{short_sha}.md").exists()

# 7. Goal inspection and discovery
with tempfile.TemporaryDirectory() as tmp_goal_repo:
    gr_dir = Path(tmp_goal_repo)
    (gr_dir / "README.md").write_text("# Project Apollo\\n\\nGoal: Launch rocket into orbit reliably.", encoding="utf-8")
    g_res = ctl.load_goal(gr_dir)
    assert "rocket" in g_res.get("goal", "").lower() or len(g_res.get("goal", "")) > 0

    s_res = ctl.save_goal_override(gr_dir, "Land astronauts safely")
    assert s_res.get("goal") == "Land astronauts safely"
    assert s_res.get("source") == "User Override"

# 8. Deep codebase analysis
res_codebase = ctl.deep_analyze_codebase(Path(${JSON.stringify(rootDir)}))
self_matches = [t for t in res_codebase.get("todos", []) if "watchdog_ctl.py" in t.get("file", "")]
assert not self_matches, f"TODO scanner should not self-match: {self_matches}"

with tempfile.TemporaryDirectory() as tmp_prune:
    pr_root = Path(tmp_prune)
    (pr_root / "src").mkdir()
    (pr_root / "src" / "index.js").write_text("// TODO: legitimate task\\nconsole.log(1)", encoding="utf-8")
    (pr_root / "node_modules").mkdir()
    (pr_root / "node_modules" / "bad.js").write_text("// TODO: should be ignored\\n", encoding="utf-8")
    (pr_root / ".antigravity").mkdir()
    (pr_root / ".antigravity" / "hidden.js").write_text("// TODO: should be ignored\\n", encoding="utf-8")
    pr_codebase = ctl.deep_analyze_codebase(pr_root)
    assert any("src/index.js" in f or "src\\\\index.js" in f for f in pr_codebase["all_source_files"]), "src/index.js must be found"
    assert not any("node_modules" in f for f in pr_codebase["all_source_files"]), "node_modules must be pruned"
    assert not any(".antigravity" in f for f in pr_codebase["all_source_files"]), ".antigravity must be pruned"

# 9. Next Steps Proposal Target Files Integrity (No deleted files allowed)
proposals_res = ctl.synthesize_next_steps(Path(${JSON.stringify(rootDir)}), force=True)
assert proposals_res.get("ok") is True
for prop in proposals_res.get("proposals", []):
    for aff in prop.get("affectedFiles", []):
        aff_p = Path(${JSON.stringify(rootDir)}) / aff
        assert aff_p.exists(), f"Proposed affected file does not exist: {aff}"

# 10. Transcript extraction formats (USER_INPUT, USER, and Task subagent messages)
with tempfile.TemporaryDirectory() as tmp_t_dir:
    t_conv = "test-conv-format-extraction"
    t_log_dir = Path(tmp_t_dir) / t_conv / ".system_generated" / "logs"
    t_log_dir.mkdir(parents=True)
    t_file = t_log_dir / "transcript.jsonl"
    t_file.write_text(
        json.dumps({"type": "USER_INPUT", "content": "Direct user input prompt"}) + "\\n" +
        json.dumps({"type": "USER", "content": "<USER_REQUEST>Tagged user request</USER_REQUEST>"}) + "\\n" +
        json.dumps({"type": "SYSTEM_MESSAGE", "content": "[Message] content=<original_task>\\nTask: Subagent task prompt\\n</original_task>"}) + "\\n",
        encoding="utf-8"
    )
    old_b = ctl.BRAIN_DIR
    ctl.BRAIN_DIR = Path(tmp_t_dir)
    try:
        reqs = ctl.get_conversation_user_requests(t_conv, limit=10)
        assert "Direct user input prompt" in reqs
        assert "Tagged user request" in reqs
        assert any("Subagent task prompt" in r for r in reqs)
    finally:
        ctl.BRAIN_DIR = old_b

# 11. CLI subcommand aliases (queue-commit, synthesize, get-goal, set-goal)
py_bin = sys.executable
ctl_script = str(Path(${JSON.stringify(rootDir)}) / "scripts" / "watchdog_ctl.py")

proc_q = subprocess.run([py_bin, ctl_script, "queue-commit", "--help"], capture_output=True, text=True)
assert proc_q.returncode == 0
assert "--notes" in proc_q.stdout

proc_s = subprocess.run([py_bin, ctl_script, "synthesize", "--help"], capture_output=True, text=True)
assert proc_s.returncode == 0

proc_g = subprocess.run([py_bin, ctl_script, "get-goal", "--help"], capture_output=True, text=True)
assert proc_g.returncode == 0

proc_sg = subprocess.run([py_bin, ctl_script, "set-goal", "--help"], capture_output=True, text=True)
assert proc_sg.returncode == 0
assert "--goal" in proc_sg.stdout

print("PYTHON_TESTS_OK")
      `,
    ], { encoding: 'utf8' });
    assert.ok(pyOutput.includes('PYTHON_TESTS_OK'));
  });

  // =========================================================================
  // Summary
  // =========================================================================
  console.log(`\n========================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
