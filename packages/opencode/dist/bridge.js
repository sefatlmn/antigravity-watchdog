import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
function findPluginRoot(startDir) {
    let curr = startDir;
    for (let i = 0; i < 6; i++) {
        if (existsSync(join(curr, "scripts", "qa_ctl.py"))) {
            return curr;
        }
        const parent = dirname(curr);
        if (parent === curr)
            break;
        curr = parent;
    }
    return resolve(startDir, "..", "..");
}
const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = findPluginRoot(HERE);
export const QA_CTL_SCRIPT = join(PLUGIN_ROOT, "scripts", "qa_ctl.py");
export const QA_STOP_HOOK_SCRIPT = join(PLUGIN_ROOT, "scripts", "qa_stop_hook.py");
let resolvedPythonBin = null;
export function getPythonBin() {
    if (resolvedPythonBin)
        return resolvedPythonBin;
    const candidates = [
        process.env.PYTHON_BIN,
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/usr/bin/python3",
        "python3",
        "python",
    ].filter(Boolean);
    for (const bin of candidates) {
        try {
            execFileSync(bin, ["--version"], { stdio: "ignore" });
            resolvedPythonBin = bin;
            return bin;
        }
        catch {
            // try next
        }
    }
    return "python3";
}
export async function runCtlJson(args) {
    const py = getPythonBin();
    const fullArgs = [QA_CTL_SCRIPT, ...args];
    if (!fullArgs.includes("--json")) {
        fullArgs.push("--json");
    }
    try {
        const { stdout } = await execFileAsync(py, fullArgs, {
            cwd: PLUGIN_ROOT,
            encoding: "utf8",
            maxBuffer: 20 * 1024 * 1024,
            timeout: 60000,
        });
        return JSON.parse(stdout.trim() || "{}");
    }
    catch (err) {
        if (err.stdout) {
            try {
                return JSON.parse(err.stdout.trim());
            }
            catch {
                // fall through
            }
        }
        const message = err.stderr ? String(err.stderr).trim() : err.message;
        throw new Error(`QA Watchdog error: ${message}`);
    }
}
export async function getStatus(repo) {
    const args = ["status"];
    if (repo)
        args.push("--repo", repo);
    return runCtlJson(args);
}
export async function syncRepo(repo) {
    const args = ["sync"];
    if (repo)
        args.push("--repo", repo);
    return runCtlJson(args);
}
export async function prepareWorktree(repo, sha) {
    return runCtlJson(["prepare", "--repo", repo, "--sha", sha]);
}
export async function queueAudit(repo, sha, userComment) {
    const args = ["queue", "--repo", repo, "--sha", sha];
    if (userComment)
        args.push("--comment", userComment);
    return runCtlJson(args);
}
export async function applyFix(repo, sha) {
    return runCtlJson(["apply-fix", "--repo", repo, "--sha", sha]);
}
export async function continueAudit(repo, sha, jobId) {
    const args = ["continue-job"];
    if (jobId)
        args.push("--job-id", jobId);
    if (repo)
        args.push("--repo", repo);
    if (sha)
        args.push("--sha", sha);
    return runCtlJson(args);
}
export async function sendAuditComment(repo, comment, jobId) {
    const args = ["send-comment", "--repo", repo, "--comment", comment];
    if (jobId)
        args.push("--job-id", jobId);
    return runCtlJson(args);
}
export async function synthesizeNextSteps(repo, force = false) {
    const args = ["next-steps", "--repo", repo];
    if (force)
        args.push("--force");
    return runCtlJson(args);
}
export async function checkSynthesis(repo) {
    return runCtlJson(["check-synthesis", "--repo", repo]);
}
export async function dispatchSynthesis(repo) {
    return runCtlJson(["dispatch-synthesis", "--repo", repo]);
}
export async function cancelSynthesis(repo) {
    return runCtlJson(["cancel-synthesis", "--repo", repo]);
}
export async function manageGoal(repo, goal, clear = false) {
    const args = ["goal", "--repo", repo];
    if (clear) {
        args.push("--clear");
    }
    else if (goal) {
        args.push("--set", goal.trim());
    }
    return runCtlJson(args);
}
export async function executePlan(repo, planId) {
    return runCtlJson(["execute-plan", "--repo", repo, "--plan-id", planId]);
}
export async function triggerStopHook(payload) {
    const py = getPythonBin();
    const jsonStr = JSON.stringify(payload);
    try {
        const child = execFile(py, [QA_STOP_HOOK_SCRIPT], {
            cwd: PLUGIN_ROOT,
            timeout: 30000,
        });
        if (child.stdin) {
            child.stdin.write(jsonStr);
            child.stdin.end();
        }
        await new Promise((resolvePromise) => {
            child.on("close", () => resolvePromise());
            child.on("error", () => resolvePromise());
        });
    }
    catch {
        // Non-blocking background trigger
    }
}
export function readReportMarkdown(reportPath) {
    if (existsSync(reportPath)) {
        return readFileSync(reportPath, "utf8");
    }
    return "";
}
//# sourceMappingURL=bridge.js.map