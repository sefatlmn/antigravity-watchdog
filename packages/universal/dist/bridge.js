import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
function findPluginRoot(startDir) {
    const envRoot = process.env.WATCHDOG_PLUGIN_ROOT;
    if (envRoot && existsSync(join(envRoot, "scripts", "watchdog_ctl.py"))) {
        return envRoot;
    }
    let curr = startDir;
    for (let i = 0; i < 6; i++) {
        if (existsSync(join(curr, "scripts", "watchdog_ctl.py"))) {
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
export const WATCHDOG_CTL_SCRIPT = join(PLUGIN_ROOT, "scripts", "watchdog_ctl.py");
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
export function resolveRepo(repo) {
    if (repo && repo.trim()) {
        let s = repo.trim();
        if (s.startsWith("file://")) {
            s = s.replace(/^file:\/\/(localhost)?/i, "");
            try {
                s = decodeURIComponent(s);
            }
            catch { }
            if (/^\/[a-zA-Z]:[\\/]/.test(s)) {
                s = s.slice(1);
            }
        }
        else if (s.includes("%")) {
            try {
                s = decodeURIComponent(s);
            }
            catch { }
        }
        return resolve(s);
    }
    return process.cwd();
}
function extractJsonFromOutput(out) {
    const trimmed = (out || "").trim();
    if (!trimmed)
        return {};
    try {
        return JSON.parse(trimmed);
    }
    catch {
        const firstBrace = trimmed.indexOf("{");
        const lastBrace = trimmed.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            try {
                return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
            }
            catch { }
        }
        const firstBracket = trimmed.indexOf("[");
        const lastBracket = trimmed.lastIndexOf("]");
        if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
            try {
                return JSON.parse(trimmed.slice(firstBracket, lastBracket + 1));
            }
            catch { }
        }
        throw new Error(`Could not parse JSON output: ${trimmed}`);
    }
}
export async function runCtlJson(args) {
    const py = getPythonBin();
    const effectiveHost = process.env.WATCHDOG_HOST || "claude";
    const fullArgs = [WATCHDOG_CTL_SCRIPT, ...args];
    if (!fullArgs.includes("--json")) {
        fullArgs.push("--json");
    }
    if (!fullArgs.includes("--host")) {
        fullArgs.push("--host", effectiveHost);
    }
    const currentPath = process.env.PATH || "";
    const augmentedPath = `/opt/homebrew/bin:/usr/local/bin:${currentPath}`;
    try {
        const { stdout } = await execFileAsync(py, fullArgs, {
            cwd: PLUGIN_ROOT,
            encoding: "utf8",
            maxBuffer: 20 * 1024 * 1024,
            timeout: 60000,
            env: { ...process.env, PATH: augmentedPath, WATCHDOG_HOST: effectiveHost },
        });
        return extractJsonFromOutput(stdout);
    }
    catch (err) {
        if (err.stdout) {
            try {
                return extractJsonFromOutput(err.stdout);
            }
            catch {
                // fall through
            }
        }
        const message = err.stderr ? String(err.stderr).trim() : err.message;
        throw new Error(`Watchdog error: ${message}`);
    }
}
export async function getStatus(repo) {
    const targetRepo = resolveRepo(repo);
    return runCtlJson(["status", "--repo", targetRepo]);
}
export async function getGitState(repo) {
    const targetRepo = resolveRepo(repo);
    return runCtlJson(["git-state", "--repo", targetRepo]);
}
export async function syncRepo(repo) {
    const target = resolveRepo(repo);
    return runCtlJson(["sync", "--repo", target]);
}
export async function prepareWorktree(repo, sha) {
    const targetRepo = resolveRepo(repo);
    let targetSha = sha || "";
    if (!targetSha) {
        try {
            const sync = await syncRepo(targetRepo);
            targetSha = String(sync?.bestRepo?.head?.sha || sync?.bestRepo?.headSha || "HEAD");
        }
        catch {
            targetSha = "HEAD";
        }
    }
    return runCtlJson(["prepare", "--repo", targetRepo, "--sha", targetSha]);
}
export async function queueAudit(repo, sha, userComment, force = false) {
    const targetRepo = resolveRepo(repo);
    let targetSha = sha || "";
    if (!targetSha) {
        try {
            const sync = await syncRepo(targetRepo);
            targetSha = String(sync?.bestRepo?.head?.sha || sync?.bestRepo?.headSha || "HEAD");
        }
        catch {
            targetSha = "HEAD";
        }
    }
    const args = ["queue", "--repo", targetRepo, "--sha", targetSha];
    if (userComment && userComment.trim())
        args.push("--comment", userComment.trim());
    if (force)
        args.push("--force");
    return runCtlJson(args);
}
export async function applyFix(repo, sha) {
    const targetRepo = resolveRepo(repo);
    let targetSha = (sha || "").replace(/^fix\/watchdog-/, "");
    if (!targetSha) {
        try {
            const sync = await syncRepo(targetRepo);
            const firstFix = sync?.bestRepo?.fixBranches?.[0];
            targetSha = String(firstFix?.shortSha ||
                (typeof firstFix === "string" ? firstFix.replace(/^fix\/watchdog-/, "") : "") ||
                sync?.bestRepo?.lastFixSha ||
                "").replace(/^fix\/watchdog-/, "");
        }
        catch {
            // ignore sync failure and throw error below if no sha
        }
    }
    if (!targetSha) {
        throw new Error("No fix branch available to apply. Run an audit first or specify a commit SHA.");
    }
    return runCtlJson(["apply-fix", "--repo", targetRepo, "--sha", targetSha]);
}
export async function continueAudit(repo, sha, jobId) {
    const targetRepo = resolveRepo(repo);
    const args = ["continue-job", "--repo", targetRepo];
    if (jobId)
        args.push("--job-id", jobId);
    if (sha)
        args.push("--sha", sha);
    return runCtlJson(args);
}
export async function completeAudit(repo, sha, verdict = "PASS", summary = "Audit completed.", bugsCount = 0, fixesCommitted = false) {
    const targetRepo = resolveRepo(repo);
    let targetSha = sha;
    if (!targetSha) {
        try {
            const state = await getStatus(targetRepo);
            const activeJob = state?.jobs?.find((j) => j.status === "running" || j.status === "dispatched" || j.status === "queued");
            targetSha = activeJob?.sha || activeJob?.commit_sha || activeJob?.short_sha;
        }
        catch {
            // fallback handled by watchdog_ctl
        }
    }
    const args = ["complete", "--repo", targetRepo];
    if (targetSha)
        args.push("--sha", targetSha);
    args.push("--verdict", verdict);
    args.push("--summary", summary);
    args.push("--bugs-count", String(bugsCount));
    args.push("--fixes-committed", fixesCommitted ? "true" : "false");
    return runCtlJson(args);
}
export async function sendAuditComment(repo, comment, jobId) {
    const targetRepo = resolveRepo(repo);
    if (!comment)
        throw new Error("Comment must not be empty.");
    const args = ["send-comment", "--repo", targetRepo, "--comment", comment];
    if (jobId)
        args.push("--job-id", jobId);
    return runCtlJson(args);
}
export async function synthesizeNextSteps(repo, force = false) {
    const targetRepo = resolveRepo(repo);
    const args = ["next-steps", "--repo", targetRepo];
    if (force)
        args.push("--force");
    return runCtlJson(args);
}
export async function checkSynthesis(repo) {
    const targetRepo = resolveRepo(repo);
    return runCtlJson(["check-synthesis", "--repo", targetRepo]);
}
export async function dispatchSynthesis(repo) {
    const targetRepo = resolveRepo(repo);
    return runCtlJson(["dispatch-synthesis", "--repo", targetRepo]);
}
export async function cancelSynthesis(repo) {
    const targetRepo = resolveRepo(repo);
    return runCtlJson(["cancel-synthesis", "--repo", targetRepo]);
}
export async function manageGoal(repo, goal, clear = false, refresh = false) {
    const targetRepo = resolveRepo(repo);
    const args = ["goal", "--repo", targetRepo];
    if (refresh) {
        args.push("--refresh");
    }
    else if (clear) {
        args.push("--clear");
    }
    else if (goal) {
        args.push("--set", goal.trim());
    }
    const res = await runCtlJson(args);
    if (res && typeof res.goal === "object" && res.goal !== null) {
        if (res.goal.source && !res.source)
            res.source = res.goal.source;
        if (res.goal.updatedAt && !res.updatedAt)
            res.updatedAt = res.goal.updatedAt;
        res.goal = res.goal.goal || res.goal;
    }
    return res;
}
export async function executePlan(repo, planId, noSpawn = true) {
    const targetRepo = resolveRepo(repo);
    const id = String(planId || "1").trim().replace(/^#/, "");
    const args = ["execute-plan", "--repo", targetRepo, "--plan-id", id];
    if (noSpawn) {
        args.push("--no-spawn");
    }
    return runCtlJson(args);
}
export async function cancelPlanExecution(repo, planId) {
    const targetRepo = resolveRepo(repo);
    const id = String(planId || "1").trim().replace(/^#/, "");
    return runCtlJson(["cancel-execution", "--repo", targetRepo, "--plan-id", id]);
}
export function readReportMarkdown(reportPath) {
    if (existsSync(reportPath)) {
        return readFileSync(reportPath, "utf8");
    }
    return "";
}
export function formatStatusReport(status, syncInfo) {
    const repoInfo = syncInfo?.bestRepo || {};
    const repoPath = repoInfo.repoPath || status?.repo || status?.repo_path || "";
    let jobs = Array.isArray(status?.jobs) ? status.jobs : [];
    if (repoPath) {
        const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
        const target = norm(repoPath);
        jobs = jobs.filter((j) => {
            const jp = norm(j?.repo || j?.repo_path || "");
            return Boolean(jp && jp === target);
        });
    }
    const latestJob = jobs[0];
    let output = `## Watchdog Status: ACTIVE\n\n`;
    if (status?.error && jobs.length === 0) {
        output += `Status notice: ${status.error}\n\n`;
    }
    if (repoInfo.repoName || repoInfo.branch) {
        output += `- **Repository**: \`${repoInfo.repoName || "active"}\` (\`${repoInfo.branch || "main"}\`)\n`;
    }
    const headSha = repoInfo.head?.sha || repoInfo.headSha;
    const headSubject = repoInfo.head?.subject || repoInfo.headSubject;
    if (headSha) {
        output += `- **Head Commit**: \`${headSha.slice(0, 7)}\` - ${headSubject || "No commit message"}\n`;
    }
    if (latestJob) {
        const shortSha = latestJob.short_sha || latestJob.shortSha || latestJob.sha?.slice(0, 7);
        output += `\n### Latest Audit (\`${shortSha}\`)\n`;
        output += `- **Verdict**: ${latestJob.verdict || "UNKNOWN"}\n`;
        output += `- **Status**: ${latestJob.status || "completed"}\n`;
        if (latestJob.summary) {
            output += `- **Summary**: ${latestJob.summary}\n`;
        }
        const fixBranch = latestJob.fix_branch || latestJob.fixBranch;
        if ((latestJob.fixes_committed || latestJob.fixSha || fixBranch) && !latestJob.fixes_applied) {
            output += `- **Fix Branch**: \`${fixBranch || `fix/watchdog-${shortSha}`}\`\n`;
        }
    }
    else {
        output += `\nNo recent audits recorded.\n`;
    }
    return output;
}
export function formatNextStepsReport(proposalsRes) {
    if (!proposalsRes) {
        return "## Proposed Next Steps\n\nNo proposals available. Refresh to synthesize proposals.\n";
    }
    const proposals = proposalsRes.proposals || [];
    const rawGoal = proposalsRes.goal || proposalsRes.projectGoal;
    const goalStr = typeof rawGoal === "string"
        ? rawGoal
        : (rawGoal?.goal || rawGoal?.text || "");
    let output = `## Proposed Next Steps\n\n`;
    if (goalStr && goalStr.trim()) {
        output += `**Milestone Goal**: "${goalStr.trim()}"\n\n`;
    }
    if (proposalsRes.error && proposals.length === 0) {
        output += `Could not load proposals: ${proposalsRes.error}\n`;
    }
    else if (proposals.length === 0) {
        output += `No proposals available. Refresh to synthesize proposals.\n`;
    }
    else {
        proposals.forEach((p, idx) => {
            const num = idx + 1;
            const tag = p.category || p.tag || p.badge || "Feature";
            const diff = p.difficulty ? ` · ${p.difficulty}` : "";
            const dur = p.estimatedDuration || p.estimatedTime ? ` · ~${p.estimatedDuration || p.estimatedTime}` : "";
            output += `### ${num}. [${tag}] ${p.title}${diff}${dur}\n`;
            if (p.summary || p.description) {
                output += `${p.summary || p.description}\n`;
            }
            const goalsList = p.objectives || p.goals;
            if (Array.isArray(goalsList) && goalsList.length > 0) {
                goalsList.slice(0, 3).forEach((obj) => {
                    output += `- ${obj}\n`;
                });
            }
            if (Array.isArray(p.affectedFiles) && p.affectedFiles.length > 0) {
                output += `*Files*: ${p.affectedFiles.map((f) => `\`${f}\``).join(", ")}\n`;
            }
            output += `*Execute*: \`watchdog plan ${num}\` (or tool \`watchdog_execute_plan\` with \`"${num}"\`)\n\n`;
        });
    }
    return output;
}
//# sourceMappingURL=bridge.js.map