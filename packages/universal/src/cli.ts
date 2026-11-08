#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  getStatus,
  getGitState,
  syncRepo,
  prepareWorktree,
  queueAudit,
  applyFix,
  continueAudit,
  completeAudit,
  sendAuditComment,
  synthesizeNextSteps,
  cancelSynthesis,
  cancelPlanExecution,
  manageGoal,
  executePlan,
  formatStatusReport,
  formatNextStepsReport,
  resolveRepo,
  PLUGIN_ROOT,
} from "./bridge.js";
import { startMcpServer } from "./mcp.js";

function printHelp(): void {
  const help = `
Watchdog Universal CLI (Universal Agentic Edition)

Usage:
  watchdog <command> [options] [arguments]

Commands:
  status                   Show repository status, latest audit verdict, and fix branches
  sync                     Sync Git history and detect repositories
  git-state                Inspect raw Git status and branch metadata
  audit [notes...]         Queue audit in isolated worktree for HEAD or --sha
  apply-fix [sha]          Apply confirmed fixes from fix branch to active branch
  continue [sha]           Resume an interrupted audit or check completed audit report
  complete [options]       Mark a Watchdog audit job complete
  comment <notes...>       Send guidance note to an in-progress audit
  next-steps               Synthesize and display 4 project-grounded implementation plans
  plan <id>                Display approved plan prompt specification for agent execution
  cancel-plan [id]         Cancel an ongoing next step plan execution
  goal                     Inspect current milestone goal
  goal --set "<goal>"      Set project milestone goal
  goal --refresh           Refresh project milestone goal
  goal --clear             Clear current milestone goal
  mcp                      Start the Model Context Protocol stdio server
  setup [editor]           Configure integration for claude, cursor, opencode, or codex

Options:
  --repo <path>            Target repository path (defaults to current directory)
  --sha <commit>           Target commit SHA
  --refresh, --force       Force fresh next-steps synthesis
  --json                   Output machine-readable JSON
  --help, -h               Show this help message
`;
  console.log(help.trim());
}

export const VALUE_FLAGS = new Set([
  "repo",
  "sha",
  "set",
  "comment",
  "job-id",
  "plan-id",
  "editor",
  "limit",
  "conversation-id",
  "verdict",
  "summary",
  "bugs-count",
  "fixes-committed",
]);

export function parseArgs(args: string[]): {
  cmd: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
} {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (key.includes("=")) {
        const [k, v] = key.split("=", 2);
        flags[k] = v;
      } else if (VALUE_FLAGS.has(key) && i + 1 < args.length && !args[i + 1].startsWith("-")) {
        flags[key] = args[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith("-")) {
      const key = arg.slice(1);
      flags[key] = true;
    } else {
      positionals.push(arg);
    }
    i++;
  }

  const cmd = positionals[0] || "status";
  const rest = positionals.slice(1);
  return { cmd, flags, positionals: rest };
}

async function handleSetup(editor?: string, targetRepo?: string): Promise<void> {
  const repo = resolveRepo(targetRepo);
  const ed = (editor || "all").toLowerCase();

  console.log(`Setting up Watchdog Universal Edition for repository: ${repo}`);

  const universalDistMcp = join(PLUGIN_ROOT, "packages", "universal", "dist", "mcp.js");

  if (ed === "claude" || ed === "all") {
    console.log("\n--- Claude Code Setup ---");
    const claudeCommandsDir = join(repo, ".claude", "commands");
    try {
      mkdirSync(claudeCommandsDir, { recursive: true });
      writeFileSync(
        join(claudeCommandsDir, "watchdog.md"),
        `---
description: Watchdog audit status, review trigger, and bugfix application
---

Run \`watchdog_status\` to inspect status. If an audit is needed, run \`watchdog_audit\`.
If a fix branch exists, apply it using \`watchdog_apply_fix\`.
`,
        "utf8"
      );
      writeFileSync(
        join(claudeCommandsDir, "next-steps.md"),
        `---
description: Propose or execute next-step implementation plans
---

Run \`watchdog_next_steps\` to synthesize 4 structured implementation plans adhering to the /plan standard.
To execute a proposal, call \`watchdog_execute_plan\` with the plan ID.
`,
        "utf8"
      );
      console.log(`Created custom slash commands in ${claudeCommandsDir}/:`);
      console.log("  - /watchdog");
      console.log("  - /next-steps");
    } catch (err: any) {
      console.warn(`Could not create .claude/commands: ${err.message}`);
    }

    console.log("\nNative Claude Code Plugin (includes Sidepanel UI, hooks, skills, agents & MCP):");
    console.log(`  claude --plugin-dir "${PLUGIN_ROOT}"`);
    console.log("Or install via Claude Code Marketplace:");
    console.log(`  /plugin marketplace add "${PLUGIN_ROOT}"`);
    console.log("  /plugin install watchdog@watchdog-marketplace");
    console.log("\nOr add Watchdog MCP server standalone to Claude Code CLI:");
    console.log(`  claude mcp add watchdog node "${universalDistMcp}"`);
  }

  if (ed === "cursor" || ed === "all") {
    console.log("\n--- Cursor / Windsurf Setup ---");
    const cursorDir = join(repo, ".cursor");
    const mcpConfigPath = join(cursorDir, "mcp.json");
    const mcpConfig = {
      mcpServers: {
        watchdog: {
          command: "node",
          args: [universalDistMcp],
        },
      },
    };
    try {
      mkdirSync(cursorDir, { recursive: true });
      writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + "\n", "utf8");
      console.log(`Created Cursor MCP config: ${mcpConfigPath}`);
    } catch (err: any) {
      console.warn(`Could not create .cursor/mcp.json: ${err.message}`);
    }
  }

  if (ed === "opencode" || ed === "all") {
    console.log("\n--- OpenCode Setup ---");
    const pluginPath = join(PLUGIN_ROOT, "packages", "universal");
    console.log("Add this package to ~/.config/opencode/opencode.json:");
    console.log(
      JSON.stringify(
        {
          plugins: [pluginPath],
        },
        null,
        2
      )
    );
  }

  if (ed === "codex" || ed === "all") {
    console.log("\n--- OpenAI Codex / Agents Rule Setup ---");
    const agentsPath = join(repo, "AGENTS.md");
    const snippet = `
## Watchdog Rules
- Audits run asynchronously in isolated Git worktrees without touching active working branches.
- Tag commits with [skip-watchdog] when intermediate or reviewing code.
- Reproducible fixes are committed to fix branches. Apply fixes via \`watchdog apply-fix\`.
- View milestone-aligned next steps via \`watchdog next-steps\`.
`;
    if (!existsSync(agentsPath)) {
      writeFileSync(agentsPath, snippet.trim() + "\n", "utf8");
      console.log(`Created ${agentsPath}`);
    } else {
      console.log(`Add the following snippet to your ${agentsPath}:\n${snippet}`);
    }
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const { cmd, flags, positionals } = parseArgs(rawArgs);

  if (flags.help || flags.h || cmd === "help") {
    printHelp();
    return;
  }

  const repo = typeof flags.repo === "string" ? flags.repo : undefined;
  const isJson = Boolean(flags.json);

  try {
    switch (cmd) {
      case "mcp": {
        startMcpServer();
        break;
      }

      case "status": {
        const status = await getStatus(repo);
        let syncInfo: any = null;
        try {
          syncInfo = await syncRepo(repo);
        } catch {
          // fallback
        }
        if (isJson) {
          console.log(JSON.stringify({ status, sync: syncInfo }, null, 2));
        } else {
          console.log(formatStatusReport(status, syncInfo));
        }
        break;
      }

      case "sync": {
        const res = await syncRepo(repo);
        if (isJson) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`Synced repository: ${res?.bestRepo?.repoName || res?.bestRepo?.repoPath || "success"}`);
        }
        break;
      }

      case "git-state":
      case "git_state": {
        const res = await getGitState(repo);
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case "audit": {
        const targetSha = typeof flags.sha === "string" ? flags.sha : undefined;
        const comment = positionals.join(" ").trim() || undefined;
        const res = await queueAudit(repo, targetSha, comment, true);
        if (isJson) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          const shortSha = res?.job?.short_sha || targetSha || "HEAD";
          if (res?.skipped || res?.ok === false) {
            console.log(`Audit skipped: ${res?.reason || res?.error || "Commit was skipped."}`);
          } else if (res?.already_running) {
            console.log(`Audit for commit ${shortSha} is already running.`);
          } else {
            console.log(`Queued Watchdog audit for commit ${shortSha} in an isolated Git worktree.`);
          }
        }
        break;
      }

      case "apply-fix":
      case "apply": {
        const targetSha = positionals[0] || (typeof flags.sha === "string" ? flags.sha : undefined);
        const res = await applyFix(repo, targetSha);
        if (isJson) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          if (res?.ok === false || res?.error) {
            console.error(`Error applying fix: ${res.error || "Unknown error"}`);
            process.exit(1);
          }
          console.log(res?.message || "Successfully applied fix branch.");
        }
        break;
      }

      case "continue":
      case "resume": {
        const targetSha = positionals[0] || (typeof flags.sha === "string" ? flags.sha : undefined);
        const jobId = typeof flags["job-id"] === "string" ? flags["job-id"] : undefined;
        const res = await continueAudit(repo, targetSha, jobId);
        if (isJson) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          if (res?.ok === false || res?.error) {
            console.error(`Error: ${res.error || "Could not continue audit."}`);
            process.exit(1);
          }
          if (res?.completed) {
            console.log(`Audit completed: ${res.verdict || "PASS"}\n${res.summary || ""}`);
          } else {
            console.log(res?.message || "Resumed audit job in worktree.");
          }
        }
        break;
      }

      case "complete": {
        const targetSha = positionals[0] || (typeof flags.sha === "string" ? flags.sha : "");
        const verdict = typeof flags.verdict === "string" ? flags.verdict : "PASS";
        const summary = typeof flags.summary === "string" ? flags.summary : "Audit completed.";
        const bugsCount = typeof flags["bugs-count"] === "string" ? parseInt(flags["bugs-count"], 10) || 0 : 0;
        const fixesCommitted = flags["fixes-committed"] === true || flags["fixes-committed"] === "true";
        const res = await completeAudit(repo, targetSha, verdict, summary, bugsCount, fixesCommitted);
        if (isJson) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          if (res?.ok === false || res?.error) {
            console.error(`Error completing audit: ${res.error || "Unknown error"}`);
            process.exit(1);
          }
          console.log(`Audit marked complete: ${verdict} - ${summary}`);
        }
        break;
      }

      case "comment":
      case "note": {
        const comment = positionals.join(" ").trim();
        if (!comment) {
          console.error("Error: Comment text is required. Usage: watchdog comment <text>");
          process.exit(1);
        }
        const jobId = typeof flags["job-id"] === "string" ? flags["job-id"] : undefined;
        const res = await sendAuditComment(repo, comment, jobId);
        if (isJson) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          if (res?.ok === false || res?.error) {
            console.error(`Error: ${res.error || "No in-progress audit found."}`);
            process.exit(1);
          }
          console.log(`Comment forwarded: "${comment}"`);
        }
        break;
      }

      case "next-steps":
      case "proposals": {
        const sub = positionals[0]?.toLowerCase();
        if (sub === "execute" || sub === "plan" || (sub && /^#?[1-4]$/.test(sub))) {
          const planId = (sub === "execute" || sub === "plan" ? (positionals[1] || "1") : sub).replace(/^#/, "");
          const res = await executePlan(repo, planId, true);
          if (isJson) {
            console.log(JSON.stringify(res, null, 2));
          } else {
            if (res?.ok && res?.prompt) {
              console.log(`### Approved Plan #${planId}: ${res.title || ""}\n\n${res.prompt}`);
            } else {
              console.error(`Could not load plan #${planId}: ${res?.error || "Plan not found"}`);
              process.exit(1);
            }
          }
          break;
        }
        const force = Boolean(flags.refresh || flags.force || sub === "refresh");
        const res = await synthesizeNextSteps(repo, force);
        if (isJson) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(formatNextStepsReport(res));
        }
        break;
      }

      case "plan":
      case "execute": {
        const planId = (positionals[0] || "1").replace(/^#/, "");
        const res = await executePlan(repo, planId, true);
        if (isJson) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          if (res?.ok && res?.prompt) {
            console.log(`### Approved Plan #${planId}: ${res.title || ""}\n\n${res.prompt}`);
          } else {
            console.error(`Could not load plan #${planId}: ${res?.error || "Plan not found"}`);
            process.exit(1);
          }
        }
        break;
      }

      case "cancel": {
        const res = await cancelSynthesis(repo);
        if (isJson) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log("Next steps synthesis cancelled.");
        }
        break;
      }

      case "cancel-plan":
      case "cancel-execution": {
        const planId = (positionals[0] || (typeof flags["plan-id"] === "string" ? flags["plan-id"] : "1")).replace(/^#/, "");
        const res = await cancelPlanExecution(repo, planId);
        if (isJson) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          if (res?.ok === false || res?.error) {
            console.error(`Error cancelling plan execution: ${res.error || "Unknown error"}`);
            process.exit(1);
          }
          console.log(`Plan execution #${res.planId || planId} cancelled.`);
        }
        break;
      }

      case "goal": {
        let targetRepo = repo;
        const pos = [...positionals];
        if (!targetRepo && pos.length > 0 && existsSync(pos[0]) && statSync(pos[0]).isDirectory()) {
          targetRepo = pos.shift();
        }
        const rawPos = pos.join(" ").trim();
        const clear = Boolean(flags.clear) || pos[0]?.toLowerCase() === "clear";
        const refresh = Boolean(flags.refresh) || pos[0]?.toLowerCase() === "refresh";
        const setGoal = typeof flags.set === "string" ? flags.set : (!clear && !refresh ? rawPos : "");
        if (refresh) {
          const res = await manageGoal(targetRepo, undefined, false, true);
          const goalStr = typeof res?.goal === "object" ? (res.goal?.goal || "") : (res?.goal || "");
          console.log(isJson ? JSON.stringify(res, null, 2) : (goalStr ? `Milestone goal refreshed: "${goalStr}"` : "Milestone goal refreshed."));
        } else if (clear) {
          const res = await manageGoal(targetRepo, undefined, true);
          console.log(isJson ? JSON.stringify(res, null, 2) : "Milestone goal cleared.");
        } else if (setGoal) {
          const res = await manageGoal(targetRepo, setGoal);
          console.log(isJson ? JSON.stringify(res, null, 2) : `Milestone goal set to: "${setGoal}"`);
        } else {
          const res = await manageGoal(targetRepo);
          const goalStr = typeof res?.goal === "object" ? (res.goal?.goal || "") : (res?.goal || "");
          console.log(isJson ? JSON.stringify(res, null, 2) : (goalStr ? `Milestone goal: "${goalStr}"` : "No goal set."));
        }
        break;
      }

      case "setup": {
        const editor = positionals[0] || (typeof flags.editor === "string" ? flags.editor : "all");
        await handleSetup(editor, repo);
        break;
      }

      default: {
        console.error(`Unknown command: ${cmd}`);
        printHelp();
        process.exit(1);
      }
    }
  } catch (err: any) {
    if (isJson) {
      console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(1);
  }
}

export async function runCli(): Promise<void> {
  await main();
}

const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] && process.argv[1].endsWith("cli.js"));

if (isDirectInvocation) {
  runCli();
}
