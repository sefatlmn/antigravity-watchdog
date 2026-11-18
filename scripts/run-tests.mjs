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

    const jvQueuedWithReport = vmodel.jobView({ id: '4', short_sha: 'jkl3456', status: 'queued', verdict: 'PENDING', report_path: '/tmp/future-report.md' });
    assert.equal(jvQueuedWithReport.hasReport, false, 'jobView must not expose report button before completion');

    // stripEmojis & timeAgo
    assert.equal(vmodel.stripEmojis('🚀 Ship it! ✨'), 'Ship it!');
    assert.equal(vmodel.timeAgo('invalid-date'), '');
    assert.equal(vmodel.timeAgo(new Date(Date.now() - 120_000).toISOString()), '2m ago');

    // partitionJobs
    const parts = vmodel.partitionJobs({ jobs: [{ id: 'a', short_sha: '1', archived: false }, { id: 'b', short_sha: '2', archived: true }] });
    assert.equal(parts.recent.length, 1);
    assert.equal(parts.archived.length, 1);

    // pathsOverlap boundary checks
    assert.equal(vmodel.pathsOverlap('/work/app', '/work/app-v2'), false);
    assert.equal(vmodel.pathsOverlap('/work/app', '/work/app/sub'), true);
    assert.equal(vmodel.pathsOverlap('/work/app/', '/work/app'), true);

    // Parity between view-model.js and app.js for shared helper definitions
    const vmSrc = fs.readFileSync(path.join(rootDir, 'sidecars/panel/view-model.js'), 'utf8');
    const appSrc = fs.readFileSync(path.join(rootDir, 'sidecars/panel/app.js'), 'utf8');
    const extractNormalizedDecl = (src, name) => {
      const re = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:function\\s+${name}\\b|const\\s+${name}\\s*=)`);
      const m = re.exec(src);
      assert.ok(m, `Expected declaration for ${name}`);
      const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
      let idx = start;
      if (src.slice(start).includes('=>') && src.slice(start, start + 60).includes(`const ${name}`)) {
        idx = src.indexOf('=>', start);
      } else {
        let p = src.indexOf('(', start);
        let pDepth = 0;
        for (; p < src.length; p++) {
          if (src[p] === '(') pDepth++;
          else if (src[p] === ')') {
            pDepth--;
            if (pDepth === 0) {
              idx = p + 1;
              break;
            }
          }
        }
      }
      const openBrace = src.indexOf('{', idx);
      assert.ok(openBrace !== -1, `Expected body brace for ${name}`);
      let depth = 0;
      let end = openBrace;
      for (; end < src.length; end++) {
        if (src[end] === '{') depth++;
        else if (src[end] === '}') {
          depth--;
          if (depth === 0) {
            end++;
            break;
          }
        }
      }
      if (src[end] === ';') end++;
      return src
        .slice(start, end)
        .replace(/^export\s+/, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\s+/g, ' ')
        .trim();
    };
    for (const fnName of ['stripEmojis', 'stripEmojiChars', 'timeAgo', 'normalizeWsUri', 'pathsOverlap', 'selectActiveRepo', 'goalText', 'sameRepo', 'jobView', 'auditAction', 'partitionJobs', 'proposalView']) {
      assert.equal(
        extractNormalizedDecl(appSrc, fnName),
        extractNormalizedDecl(vmSrc, fnName),
        `app.js and view-model.js must match for ${fnName}`
      );
    }
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

      // 8. Valid cookie succeeds even when stale x-sidecar-token header is present
      const mutResStaleHeaderWithCookie = await fetch(`http://127.0.0.1:${testPort}/api/test-secure`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-sidecar-token': 'stale-token',
          'Cookie': `sidecar_token=${cookieToken}`,
        },
        body: JSON.stringify({}),
      });
      assert.equal(mutResStaleHeaderWithCookie.status, 200, 'Valid cookie must authorize even alongside stale header token');

      // 9. Malformed JSON body returns 400
      const badJsonRes = await fetch(`http://127.0.0.1:${testPort}/api/test-secure`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-sidecar-token': cookieToken,
        },
        body: '{bad json',
      });
      assert.equal(badJsonRes.status, 400, 'Malformed JSON body must return 400');

      // 10. Cross-origin Origin header rejected with 403
      const corsEvilRes = await fetch(`http://127.0.0.1:${testPort}/api/dashboard`, {
        method: 'GET',
        headers: { 'Origin': 'http://evil.example' },
      });
      assert.equal(corsEvilRes.status, 403, 'Cross-origin Origin header must be rejected with 403');

      // 11. Non-application/json POST with body rejected with 415
      const textPostRes = await fetch(`http://127.0.0.1:${testPort}/api/test-secure`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'x-sidecar-token': cookieToken,
        },
        body: JSON.stringify({}),
      });
      assert.equal(textPostRes.status, 415, 'Non-application/json POST body must return 415');
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
    assert.equal(testIsAllowedArtifactPath(path.join(mockWatchdogDir, 'ls_env.json')), false, 'ls_env.json must be disallowed');
    assert.equal(testIsAllowedArtifactPath(path.join(mockWatchdogDir, 'state.json')), false, 'state.json must be disallowed');
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

with tempfile.TemporaryDirectory() as tmp_appdata_str:
    tmp_appdata = Path(tmp_appdata_str)
    tmp_wd = tmp_appdata / "watchdog"
    ctl.APP_DATA_DIR = tmp_appdata
    ctl.WATCHDOG_DIR = tmp_wd
    ctl.STATE_FILE = tmp_wd / "state.json"
    ctl.LOCK_FILE = tmp_wd / "state.lock"
    ctl.STATE_LOCK_DIR = tmp_wd / "state.json.lock"
    ctl.WORKTREES_DIR = tmp_wd / "worktrees"
    ctl.LOGS_DIR = tmp_wd / "logs"
    ctl.ENV_CACHE_FILE = tmp_wd / "ls_env.json"

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
        assert final_st.get("__test_counter__") == 20, f"Expected 20, got {final_st.get('__test_counter__')}"
        final_st.pop("__test_counter__", None)
        ctl.save_state(final_st)

    # Test StateLock explicit TimeoutError on contention
    old_max_retries = getattr(ctl.StateLock, "MAX_RETRIES", None)
    if old_max_retries is not None:
        ctl.StateLock.MAX_RETRIES = 8
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
        if old_max_retries is not None:
            ctl.StateLock.MAX_RETRIES = old_max_retries
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

    # 4. Plan ID '#' stripping (isolated in temp dir)
    tmp_plan_repo = tmp_appdata / "plan_repo"
    tmp_plan_repo.mkdir()
    rec = ctl.mark_execution_running(tmp_plan_repo, "#2", "test-conv", "Test Title")
    assert rec["planId"] == "2", f"Expected planId '2', got {rec['planId']}"
    cancelled = ctl.cancel_execution(tmp_plan_repo, "#2")
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

    # 9. Next Steps Proposal Target Files Integrity (restore next_steps dir after check)
    real_ns = Path(${JSON.stringify(rootDir)}) / ".antigravity" / "next_steps"
    ns_backup = tmp_appdata / "next_steps_backup"
    if real_ns.exists():
        shutil.copytree(real_ns, ns_backup)
    try:
        proposals_res = ctl.synthesize_next_steps(Path(${JSON.stringify(rootDir)}), force=True)
        assert proposals_res.get("ok") is True
        for prop in proposals_res.get("proposals", []):
            for aff in prop.get("affectedFiles", []):
                aff_p = Path(${JSON.stringify(rootDir)}) / aff
                assert aff_p.exists(), f"Proposed affected file does not exist: {aff}"
    finally:
        if ns_backup.exists():
            shutil.rmtree(real_ns, ignore_errors=True)
            shutil.copytree(ns_backup, real_ns)

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
    cli_env = {**os.environ, "ANTIGRAVITY_APP_DATA_DIR": tmp_appdata_str}

    proc_q = subprocess.run([py_bin, ctl_script, "queue-commit", "--help"], capture_output=True, text=True, env=cli_env)
    assert proc_q.returncode == 0
    assert "--notes" in proc_q.stdout

    proc_s = subprocess.run([py_bin, ctl_script, "synthesize", "--help"], capture_output=True, text=True, env=cli_env)
    assert proc_s.returncode == 0

    proc_g = subprocess.run([py_bin, ctl_script, "get-goal", "--help"], capture_output=True, text=True, env=cli_env)
    assert proc_g.returncode == 0

    proc_sg = subprocess.run([py_bin, ctl_script, "set-goal", "--help"], capture_output=True, text=True, env=cli_env)
    assert proc_sg.returncode == 0
    assert "--goal" in proc_sg.stdout

    def _git(repo_dir, *args):
        return subprocess.run(["git", *args], cwd=repo_dir, check=True, capture_output=True, text=True)

    cli_goal_repo = tmp_appdata / "cli_goal_repo"
    cli_goal_repo.mkdir()
    _git(cli_goal_repo, "init")
    _git(cli_goal_repo, "checkout", "-B", "main")
    _git(cli_goal_repo, "config", "user.email", "test@example.com")
    _git(cli_goal_repo, "config", "user.name", "Test User")
    (cli_goal_repo / "README.md").write_text("# Test Repo\\n", encoding="utf-8")
    _git(cli_goal_repo, "add", ".")
    _git(cli_goal_repo, "commit", "-m", "initial commit")

    proc_set_g = subprocess.run(
        [py_bin, ctl_script, "set-goal", "--repo", str(cli_goal_repo), "--goal", "Test CLI Goal", "--json"],
        capture_output=True,
        text=True,
        env=cli_env,
    )
    assert proc_set_g.returncode == 0, f"set-goal failed: {proc_set_g.stderr}"
    set_g_json = json.loads(proc_set_g.stdout)
    assert set_g_json.get("ok") is True

    proc_get_g = subprocess.run(
        [py_bin, ctl_script, "get-goal", "--repo", str(cli_goal_repo), "--json"],
        capture_output=True,
        text=True,
        env=cli_env,
    )
    assert proc_get_g.returncode == 0, f"get-goal failed: {proc_get_g.stderr}"
    get_g_json = json.loads(proc_get_g.stdout)
    assert get_g_json.get("ok") is True
    assert get_g_json.get("goal", {}).get("goal") == "Test CLI Goal"

    proc_pre_json = subprocess.run(
        [py_bin, ctl_script, "--json", "get-goal", "--repo", str(cli_goal_repo)],
        capture_output=True,
        text=True,
        env=cli_env,
    )
    assert proc_pre_json.returncode == 0, f"pre-subcommand --json get-goal failed: {proc_pre_json.stderr}"
    assert json.loads(proc_pre_json.stdout).get("ok") is True

    # 12. queue_commit [skip-watchdog] force vs non-force, conversation URI boundary & PLANNER_RESPONSE filtering, apply_fix_branch
    import sqlite3

    skip_repo = tmp_appdata / "skip_repo"
    skip_repo.mkdir()
    _git(skip_repo, "init")
    _git(skip_repo, "checkout", "-B", "main")
    _git(skip_repo, "config", "user.email", "test@example.com")
    _git(skip_repo, "config", "user.name", "Test User")
    (skip_repo / "app.py").write_text("print('hello')\\n", encoding="utf-8")
    _git(skip_repo, "add", ".")
    _git(skip_repo, "commit", "-m", "init code")
    (skip_repo / "app.py").write_text("print('updated')\\n", encoding="utf-8")
    _git(skip_repo, "add", ".")
    _git(skip_repo, "commit", "-m", "chore: trivial update [skip-watchdog]")

    skipped_res = ctl.queue_commit(skip_repo, "HEAD", force=False, dispatch_now=False)
    assert skipped_res is None, f"Expected None when [skip-watchdog] without force, got {skipped_res}"
    forced_res = ctl.queue_commit(skip_repo, "HEAD", force=True, dispatch_now=False)
    assert isinstance(forced_res, dict) and forced_res.get("status") == "queued", f"Expected queued job with force=True, got {forced_res}"

    tmp_docs = tmp_appdata / "Documents"
    tmp_sub_repo = tmp_docs / "Code" / "MyRepo"
    tmp_sub_repo.mkdir(parents=True)
    tmp_db = tmp_appdata / "test_conv_summaries.db"
    conn = sqlite3.connect(str(tmp_db))
    conn.execute(
        "CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, preview TEXT, step_count INTEGER, last_modified_time TEXT, project_id TEXT, workspace_uris TEXT)"
    )
    conn.execute(
        "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("conv-shared-ancestor", "Shared workspace", "Preview text", 3, "2026-01-01T00:00:00Z", "", json.dumps([tmp_docs.resolve().as_uri()])),
    )
    conn.commit()
    conn.close()

    old_db, old_proj, old_brain = ctl.CONVERSATION_SUMMARIES_DB, ctl.PROJECTS_DIR, ctl.BRAIN_DIR
    ctl.CONVERSATION_SUMMARIES_DB = tmp_db
    ctl.PROJECTS_DIR = tmp_appdata / "empty_projects"
    tmp_brain2 = tmp_appdata / "brain2"
    ctl.BRAIN_DIR = tmp_brain2
    try:
        matched_convs = ctl.get_project_conversations(tmp_sub_repo)
        assert not any(c.get("id") == "conv-shared-ancestor" for c in matched_convs), f"Shared ancestor should not match: {matched_convs}"

        conv_log_dir = tmp_brain2 / "conv-filter-test" / ".system_generated" / "logs"
        conv_log_dir.mkdir(parents=True)
        (conv_log_dir / "transcript.jsonl").write_text(
            json.dumps({"type": "USER_INPUT", "content": "Valid user prompt"}) + "\\n" +
            json.dumps({"type": "PLANNER_RESPONSE", "content": "<USER_REQUEST>Should be ignored</USER_REQUEST>"}) + "\\n",
            encoding="utf-8",
        )
        filtered_reqs = ctl.get_conversation_user_requests("conv-filter-test", limit=10)
        assert filtered_reqs == ["Valid user prompt"], f"Unexpected filtered requests: {filtered_reqs}"
    finally:
        ctl.CONVERSATION_SUMMARIES_DB = old_db
        ctl.PROJECTS_DIR = old_proj
        ctl.BRAIN_DIR = old_brain

    fix_repo = tmp_appdata / "fix_repo"
    fix_repo.mkdir()
    _git(fix_repo, "init")
    _git(fix_repo, "checkout", "-B", "main")
    _git(fix_repo, "config", "user.email", "test@example.com")
    _git(fix_repo, "config", "user.name", "Test User")
    (fix_repo / "base.txt").write_text("base\\n", encoding="utf-8")
    _git(fix_repo, "add", ".")
    _git(fix_repo, "commit", "-m", "base commit")
    base_sha = _git(fix_repo, "rev-parse", "HEAD").stdout.strip()
    _git(fix_repo, "checkout", "-b", f"fix/watchdog-{base_sha[:7]}")
    (fix_repo / "fix.txt").write_text("fixed\\n", encoding="utf-8")
    _git(fix_repo, "add", ".")
    _git(fix_repo, "commit", "-m", "fix: clean patch")
    _git(fix_repo, "checkout", "main")

    base_short = base_sha[:7]
    fix_audits_dir = fix_repo / ".antigravity" / "audits"
    fix_audits_dir.mkdir(parents=True, exist_ok=True)
    (fix_audits_dir / f"review-{base_short}.json").write_text(
        json.dumps({"verdict": "FIXED_ON_BRANCH", "fixes_committed": True, "fix_branch": f"fix/watchdog-{base_short}"}),
        encoding="utf-8",
    )
    with ctl.StateLock():
        st_fix = ctl.load_state()
        st_fix.setdefault("jobs", []).insert(0, {
            "id": f"{ctl.repo_slug(fix_repo)}-{base_short}",
            "repo_path": str(fix_repo),
            "sha": base_sha,
            "short_sha": base_short,
            "status": "completed",
            "verdict": "FIXED_ON_BRANCH",
            "fixes_committed": True,
            "fixes_applied": False,
            "fix_branch": f"fix/watchdog-{base_short}",
        })
        ctl.save_state(st_fix)

    apply_ok = ctl.apply_fix_branch(fix_repo, base_sha, mode="cherry-pick")
    assert apply_ok.get("ok") is True, f"Expected apply_fix_branch success, got {apply_ok}"
    assert (fix_repo / "fix.txt").exists(), "Expected fix.txt to be cherry-picked onto main"

    st_after_fix = ctl.load_state()
    applied_job = next(j for j in st_after_fix["jobs"] if j["short_sha"] == base_short)
    ctl.reconcile_job(applied_job, st_after_fix)
    assert applied_job.get("fixes_applied") is True, f"reconcile_job must preserve fixes_applied=True: {applied_job}"
    assert applied_job.get("fixes_committed") is False, f"reconcile_job must keep fixes_committed=False: {applied_job}"
    assert applied_job.get("fix_branch") is None, f"reconcile_job must keep fix_branch=None: {applied_job}"

    (fix_repo / "conflict.txt").write_text("line1\\n", encoding="utf-8")
    _git(fix_repo, "add", ".")
    _git(fix_repo, "commit", "-m", "conflict base")
    c_base_sha = _git(fix_repo, "rev-parse", "HEAD").stdout.strip()
    _git(fix_repo, "checkout", "-b", f"fix/watchdog-{c_base_sha[:7]}")
    (fix_repo / "conflict.txt").write_text("fix branch line1\\n", encoding="utf-8")
    _git(fix_repo, "add", ".")
    _git(fix_repo, "commit", "-m", "fix: conflicting change")
    _git(fix_repo, "checkout", "main")
    (fix_repo / "conflict.txt").write_text("main branch line1\\n", encoding="utf-8")
    _git(fix_repo, "add", ".")
    _git(fix_repo, "commit", "-m", "main conflicting change")

    apply_conflict = ctl.apply_fix_branch(fix_repo, c_base_sha, mode="cherry-pick")
    assert apply_conflict.get("ok") is False, f"Expected conflict failure, got {apply_conflict}"
    assert _git(fix_repo, "status", "--porcelain").stdout.strip() == "", "Working tree must be clean after conflict abort"
    assert not (fix_repo / ".git" / "CHERRY_PICK_HEAD").exists(), "CHERRY_PICK_HEAD must be cleared"

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
