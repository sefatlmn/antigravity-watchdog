import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function findPluginRoot(startDir: string): string {
  const envRoot = process.env.WATCHDOG_PLUGIN_ROOT || process.env.QA_WATCHDOG_PLUGIN_ROOT;
  if (envRoot && existsSync(join(envRoot, "scripts", "qa_ctl.py"))) {
    return envRoot;
  }
  let curr = startDir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(curr, "scripts", "qa_ctl.py"))) {
      return curr;
    }
    const parent = dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return resolve(startDir, "..", "..");
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = findPluginRoot(HERE);
export const QA_CTL_SCRIPT = join(PLUGIN_ROOT, "scripts", "qa_ctl.py");
export const QA_STOP_HOOK_SCRIPT = join(PLUGIN_ROOT, "scripts", "qa_stop_hook.py");

let resolvedPythonBin: string | null = null;

export function getPythonBin(): string {
  if (resolvedPythonBin) return resolvedPythonBin;
  const candidates = [
    process.env.PYTHON_BIN,
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/usr/bin/python3",
    "python3",
    "python",
  ].filter(Boolean) as string[];

  for (const bin of candidates) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      resolvedPythonBin = bin;
      return bin;
    } catch {
      // try next
    }
  }
  return "python3";
}

export function resolveRepo(repo?: string): string {
  if (repo && repo.trim()) {
    return resolve(repo.trim());
  }
  return process.cwd();
}

export async function runCtlJson<T = any>(args: string[]): Promise<T> {
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
  } catch (err: any) {
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout.trim());
      } catch {
        // fall through
      }
    }
    const message = err.stderr ? String(err.stderr).trim() : err.message;
    throw new Error(`Watchdog error: ${message}`);
  }
}

export async function getStatus(repo?: string): Promise<any> {
  const args = ["status"];
  if (repo) args.push("--repo", resolveRepo(repo));
  return runCtlJson(args);
}

export async function syncRepo(repo?: string): Promise<any> {
  const target = resolveRepo(repo);
  return runCtlJson(["sync", "--repo", target]);
}

export async function prepareWorktree(repo?: string, sha?: string): Promise<any> {
  const targetRepo = resolveRepo(repo);
  let targetSha = sha || "";
  if (!targetSha) {
    const sync = await syncRepo(targetRepo);
    targetSha = String(sync?.bestRepo?.headSha || "HEAD");
  }
  return runCtlJson(["prepare", "--repo", targetRepo, "--sha", targetSha]);
}

export async function queueAudit(repo?: string, sha?: string, userComment?: string): Promise<any> {
  const targetRepo = resolveRepo(repo);
  let targetSha = sha || "";
  if (!targetSha) {
    const sync = await syncRepo(targetRepo);
    targetSha = String(sync?.bestRepo?.headSha || "HEAD");
  }
  const args: string[] = ["queue", "--repo", targetRepo, "--sha", targetSha];
  if (userComment && userComment.trim()) args.push("--comment", userComment.trim());
  return runCtlJson(args);
}

export async function applyFix(repo?: string, sha?: string): Promise<any> {
  const targetRepo = resolveRepo(repo);
  let targetSha = sha || "";
  if (!targetSha) {
    const sync = await syncRepo(targetRepo);
    targetSha = String(sync?.bestRepo?.lastFixSha || sync?.bestRepo?.headSha || "");
  }
  if (!targetSha) {
    throw new Error("No fix branch or commit SHA specified.");
  }
  return runCtlJson(["apply-fix", "--repo", targetRepo, "--sha", targetSha]);
}

export async function continueAudit(repo?: string, sha?: string, jobId?: string): Promise<any> {
  const targetRepo = resolveRepo(repo);
  const args = ["continue-job", "--repo", targetRepo];
  if (jobId) args.push("--job-id", jobId);
  if (sha) args.push("--sha", sha);
  return runCtlJson(args);
}

export async function sendAuditComment(repo?: string, comment?: string, jobId?: string): Promise<any> {
  const targetRepo = resolveRepo(repo);
  if (!comment) throw new Error("Comment must not be empty.");
  const args = ["send-comment", "--repo", targetRepo, "--comment", comment];
  if (jobId) args.push("--job-id", jobId);
  return runCtlJson(args);
}

export async function synthesizeNextSteps(repo?: string, force = false): Promise<any> {
  const targetRepo = resolveRepo(repo);
  const args = ["next-steps", "--repo", targetRepo];
  if (force) args.push("--force");
  return runCtlJson(args);
}

export async function checkSynthesis(repo?: string): Promise<any> {
  const targetRepo = resolveRepo(repo);
  return runCtlJson(["check-synthesis", "--repo", targetRepo]);
}

export async function dispatchSynthesis(repo?: string): Promise<any> {
  const targetRepo = resolveRepo(repo);
  return runCtlJson(["dispatch-synthesis", "--repo", targetRepo]);
}

export async function cancelSynthesis(repo?: string): Promise<any> {
  const targetRepo = resolveRepo(repo);
  return runCtlJson(["cancel-synthesis", "--repo", targetRepo]);
}

export async function manageGoal(repo?: string, goal?: string, clear = false): Promise<any> {
  const targetRepo = resolveRepo(repo);
  const args = ["goal", "--repo", targetRepo];
  if (clear) {
    args.push("--clear");
  } else if (goal) {
    args.push("--set", goal.trim());
  }
  return runCtlJson(args);
}

export async function executePlan(repo?: string, planId?: string): Promise<any> {
  const targetRepo = resolveRepo(repo);
  const id = planId || "1";
  return runCtlJson(["execute-plan", "--repo", targetRepo, "--plan-id", id]);
}

export async function cancelPlanExecution(repo?: string, planId?: string): Promise<any> {
  const targetRepo = resolveRepo(repo);
  const id = planId || "1";
  return runCtlJson(["cancel-execution", "--repo", targetRepo, "--plan-id", id]);
}

export async function triggerStopHook(payload: {
  fullyIdle: boolean;
  terminationReason: string;
  workspacePaths: string[];
  conversationId?: string;
}): Promise<void> {
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
    await new Promise<void>((resolvePromise) => {
      child.on("close", () => resolvePromise());
      child.on("error", () => resolvePromise());
    });
  } catch {
    // Non-blocking background trigger
  }
}

export function readReportMarkdown(reportPath: string): string {
  if (existsSync(reportPath)) {
    return readFileSync(reportPath, "utf8");
  }
  return "";
}

export function formatStatusReport(status: any, syncInfo?: any): string {
  const repoInfo = syncInfo?.bestRepo || {};
  const jobs = status.jobs || [];
  const latestJob = jobs[0];

  let output = `## Watchdog Status: ACTIVE\n\n`;
  if (repoInfo.repoName || repoInfo.branch) {
    output += `- **Repository**: \`${repoInfo.repoName || "active"}\` (\`${repoInfo.branch || "main"}\`)\n`;
  }
  if (repoInfo.headSha) {
    output += `- **Head Commit**: \`${repoInfo.headSha.slice(0, 7)}\` - ${repoInfo.headSubject || "No commit message"}\n`;
  }

  if (latestJob) {
    const shortSha = latestJob.shortSha || latestJob.sha?.slice(0, 7);
    output += `\n### Latest Audit (\`${shortSha}\`)\n`;
    output += `- **Verdict**: ${latestJob.verdict || "UNKNOWN"}\n`;
    output += `- **Status**: ${latestJob.status || "completed"}\n`;
    if (latestJob.summary) {
      output += `- **Summary**: ${latestJob.summary}\n`;
    }
    if (latestJob.fixSha || latestJob.fixBranch) {
      output += `- **Fix Branch**: \`${latestJob.fixBranch || `fix/qa-${shortSha}`}\`\n`;
    }
  } else {
    output += `\nNo recent audits recorded.\n`;
  }

  return output;
}

export function formatNextStepsReport(proposalsRes: any): string {
  const proposals = proposalsRes.proposals || [];
  const rawGoal = proposalsRes.goal || proposalsRes.projectGoal;
  const goalStr =
    typeof rawGoal === "string"
      ? rawGoal
      : (rawGoal?.goal || rawGoal?.text || "");

  let output = `## Proposed Next Steps\n\n`;
  if (goalStr && goalStr.trim()) {
    output += `**Milestone Goal**: "${goalStr.trim()}"\n\n`;
  }

  if (proposals.length === 0) {
    output += `No proposals available. Refresh to synthesize proposals.\n`;
  } else {
    proposals.forEach((p: any, idx: number) => {
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
        goalsList.slice(0, 3).forEach((obj: string) => {
          output += `- ${obj}\n`;
        });
      }
      if (Array.isArray(p.affectedFiles) && p.affectedFiles.length > 0) {
        output += `*Files*: ${p.affectedFiles.map((f: string) => `\`${f}\``).join(", ")}\n`;
      }
      output += `*Execute*: \`watchdog plan ${num}\` (or tool \`watchdog_execute_plan\` with \`"${num}"\`)\n\n`;
    });
  }

  return output;
}
