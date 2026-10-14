import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function findPluginRoot(startDir: string): string {
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
    throw new Error(`QA Watchdog error: ${message}`);
  }
}

export async function getStatus(repo?: string): Promise<any> {
  const args = ["status"];
  if (repo) args.push("--repo", repo);
  return runCtlJson(args);
}

export async function syncRepo(repo?: string): Promise<any> {
  const args = ["sync"];
  if (repo) args.push("--repo", repo);
  return runCtlJson(args);
}

export async function prepareWorktree(repo: string, sha: string): Promise<any> {
  return runCtlJson(["prepare", "--repo", repo, "--sha", sha]);
}

export async function queueAudit(repo: string, sha: string, userComment?: string): Promise<any> {
  const args = ["queue", "--repo", repo, "--sha", sha];
  if (userComment) args.push("--comment", userComment);
  return runCtlJson(args);
}

export async function applyFix(repo: string, sha: string): Promise<any> {
  return runCtlJson(["apply-fix", "--repo", repo, "--sha", sha]);
}

export async function pauseWatchdog(): Promise<any> {
  return runCtlJson(["pause"]);
}

export async function resumeWatchdog(): Promise<any> {
  return runCtlJson(["resume"]);
}

export async function synthesizeNextSteps(repo: string, force = false): Promise<any> {
  const args = ["next-steps", "--repo", repo];
  if (force) args.push("--force");
  return runCtlJson(args);
}

export async function checkSynthesis(repo: string): Promise<any> {
  return runCtlJson(["check-synthesis", "--repo", repo]);
}

export async function dispatchSynthesis(repo: string): Promise<any> {
  return runCtlJson(["dispatch-synthesis", "--repo", repo]);
}

export async function cancelSynthesis(repo: string): Promise<any> {
  return runCtlJson(["cancel-synthesis", "--repo", repo]);
}

export async function manageGoal(repo: string, goal?: string, clear = false): Promise<any> {
  const args = ["goal", "--repo", repo];
  if (clear) {
    args.push("--clear");
  } else if (goal) {
    args.push("--set", goal.trim());
  }
  return runCtlJson(args);
}

export async function executePlan(repo: string, planId: string): Promise<any> {
  return runCtlJson(["execute-plan", "--repo", repo, "--plan-id", planId]);
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
