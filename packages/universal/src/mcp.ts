import { createInterface } from "node:readline";
import {
  getStatus,
  getGitState,
  syncRepo,
  prepareWorktree,
  queueAudit,
  applyFix,
  continueAudit,
  sendAuditComment,
  synthesizeNextSteps,
  cancelSynthesis,
  manageGoal,
  executePlan,
  formatStatusReport,
  formatNextStepsReport,
} from "./bridge.js";

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

const PRIMARY_TOOLS = [
  {
    name: "watchdog_status",
    description: "Inspect repository status, recent audit verdicts, active jobs, and fix branches.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Path to git repository (defaults to working directory).",
        },
      },
    },
  },
  {
    name: "watchdog_sync",
    description: "Scan workspaces and sync Git history to discover active repositories and latest commits.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Path to git repository or workspace folder (defaults to working directory).",
        },
      },
    },
  },
  {
    name: "watchdog_git_state",
    description: "Inspect raw git branch, commit status, and candidate repositories in workspace.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Path to git repository or workspace folder (defaults to working directory).",
        },
      },
    },
  },
  {
    name: "watchdog_audit",
    description: "Queue an autonomous code and visual audit in an isolated Git worktree.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Path to git repository (defaults to working directory).",
        },
        sha: {
          type: "string",
          description: "Commit SHA to audit (defaults to HEAD).",
        },
        comment: {
          type: "string",
          description: "Optional guidance note or focus area for the auditor.",
        },
        force: {
          type: "boolean",
          description: "Force audit even if commit has skip tags or is docs-only.",
        },
      },
    },
  },
  {
    name: "watchdog_apply_fix",
    description: "Apply verified fixes from an isolated fix branch onto the active branch.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Path to git repository (defaults to working directory).",
        },
        sha: {
          type: "string",
          description: "Target commit SHA whose fix branch should be merged.",
        },
      },
    },
  },
  {
    name: "watchdog_next_steps",
    description: "Synthesize 4 project-grounded next-step implementation plans adhering to /plan methodology.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Path to git repository (defaults to working directory).",
        },
        force: {
          type: "boolean",
          description: "Force fresh synthesis ignoring cache.",
        },
      },
    },
  },
  {
    name: "watchdog_execute_plan",
    description: "Retrieve the full specification prompt for an approved next-step implementation plan.",
    inputSchema: {
      type: "object",
      properties: {
        planId: {
          type: "string",
          description: "Proposal plan ID (e.g. 1, 2, 3, or 4).",
        },
        repo: {
          type: "string",
          description: "Path to git repository (defaults to working directory).",
        },
      },
      required: ["planId"],
    },
  },
  {
    name: "watchdog_goal",
    description: "Inspect, set, or clear the repository milestone goal.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Path to git repository (defaults to working directory).",
        },
        goal: {
          type: "string",
          description: "New milestone goal to set.",
        },
        clear: {
          type: "boolean",
          description: "Set true to clear existing goal override.",
        },
        refresh: {
          type: "boolean",
          description: "Review codebase and generate a refreshed project goal.",
        },
      },
    },
  },
  {
    name: "watchdog_comment",
    description: "Send guidance or focus notes to an in-progress Watchdog audit.",
    inputSchema: {
      type: "object",
      properties: {
        comment: {
          type: "string",
          description: "Guidance message to forward to the active auditor.",
        },
        repo: {
          type: "string",
          description: "Path to git repository (defaults to working directory).",
        },
        jobId: {
          type: "string",
          description: "Optional specific job ID to message.",
        },
      },
      required: ["comment"],
    },
  },
  {
    name: "watchdog_continue",
    description: "Resume an interrupted audit or check if report is already generated.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Path to git repository (defaults to working directory).",
        },
        sha: {
          type: "string",
          description: "Commit SHA to resume.",
        },
        jobId: {
          type: "string",
          description: "Optional job ID.",
        },
      },
    },
  },
  {
    name: "watchdog_cancel_synthesis",
    description: "Cancel an ongoing next-steps synthesis turn.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Path to git repository (defaults to working directory).",
        },
      },
    },
  },
];

const ALL_TOOLS = [
  ...PRIMARY_TOOLS,
  {
    name: "watchdog_send_comment",
    description: "Send guidance or focus notes to an in-progress Watchdog audit (backwards compatibility alias for watchdog_comment).",
    inputSchema: PRIMARY_TOOLS.find((t) => t.name === "watchdog_comment")?.inputSchema || {
      type: "object",
      properties: {
        comment: {
          type: "string",
          description: "Guidance message to forward to the active auditor.",
        },
        repo: {
          type: "string",
          description: "Path to git repository (defaults to working directory).",
        },
        jobId: {
          type: "string",
          description: "Optional specific job ID to message.",
        },
      },
      required: ["comment"],
    },
  },
];

const PROMPTS = [
  {
    name: "watchdog_audit",
    description: "Guidelines and instructions for reviewing a commit with Watchdog.",
    arguments: [
      {
        name: "notes",
        description: "Focus areas or testing hints.",
        required: false,
      },
    ],
  },
  {
    name: "watchdog_next_steps",
    description: "Guidelines for selecting and executing proposed next steps.",
    arguments: [
      {
        name: "focus",
        description: "Optional product or engineering focus area.",
        required: false,
      },
    ],
  },
];

async function handleToolCall(name: string, args: Record<string, any> = {}): Promise<{ text: string; isError?: boolean }> {
  try {
    switch (name) {
      case "watchdog_status": {
        const repo = args.repo || args.repo_path || args.repoPath;
        const status = await getStatus(repo);
        let syncInfo: any = null;
        try {
          syncInfo = await syncRepo(repo);
        } catch {
          // ignore sync failure
        }
        const text = formatStatusReport(status, syncInfo);
        return { text };
      }

      case "watchdog_sync": {
        const repo = args.repo || args.repo_path || args.repoPath;
        const res = await syncRepo(repo);
        return { text: JSON.stringify(res, null, 2) };
      }

      case "watchdog_git_state": {
        const repo = args.repo || args.repo_path || args.repoPath;
        const res = await getGitState(repo);
        return { text: JSON.stringify(res, null, 2) };
      }

      case "watchdog_audit": {
        const repo = args.repo || args.repo_path || args.repoPath;
        const comment = args.comment || args.notes || args.message;
        const res = await queueAudit(repo, args.sha, comment, args.force ?? true);
        const shortSha = res?.job?.short_sha || (args.sha ? String(args.sha).slice(0, 7) : "HEAD");
        if (res?.skipped || res?.ok === false) {
          return { text: `Audit skipped: ${res?.reason || res?.error || "Commit was skipped."}` };
        }
        if (res?.already_running) {
          return { text: `Audit for commit \`${shortSha}\` is already running. Double auditing prevented.` };
        }
        return {
          text: `Queued Watchdog audit for commit \`${shortSha}\` in an isolated Git worktree.\n` +
            `Auditors will test code correctness, run Playwright browser passes, and commit reproducible fixes to \`fix/watchdog-${shortSha}\`.`,
        };
      }

      case "watchdog_apply_fix": {
        const repo = args.repo || args.repo_path || args.repoPath;
        const res = await applyFix(repo, args.sha);
        if (res?.ok === false || res?.error) {
          return {
            text: `Failed to apply fixes: ${res.error || "Unknown error"}`,
            isError: true,
          };
        }
        return {
          text: `Applied fixes to working branch.\n${res?.message || JSON.stringify(res, null, 2)}`,
        };
      }

      case "watchdog_next_steps": {
        const repo = args.repo || args.repo_path || args.repoPath;
        const force = Boolean(args.force || args.refresh);
        const res = await synthesizeNextSteps(repo, force);
        const text = formatNextStepsReport(res);
        return { text };
      }

      case "watchdog_execute_plan": {
        const planId = String(args.planId || args.plan_id || args.plan || args.id || "").replace(/^#/, "");
        if (!planId) {
          return { text: "Error: planId is required (e.g. '1', '2', '3', '4').", isError: true };
        }
        const repo = args.repo || args.repo_path || args.repoPath;
        const res = await executePlan(repo, planId, true);
        if (!res?.ok || !res?.prompt) {
          return { text: `Could not load plan #${planId}: ${res?.error || "Plan file not found."}`, isError: true };
        }
        return {
          text: `### Approved Plan #${planId}: ${res.title || "Implementation"}\n\n${res.prompt}`,
        };
      }

      case "watchdog_goal": {
        const repo = args.repo || args.repo_path || args.repoPath;
        const isClear = Boolean(args.clear) || (typeof args.goal === "string" && args.goal.trim().toLowerCase() === "clear");
        const isRefresh = Boolean(args.refresh) || (typeof args.goal === "string" && args.goal.trim().toLowerCase() === "refresh");
        const goalVal = (isClear || isRefresh) ? undefined : args.goal;
        const res = await manageGoal(repo, goalVal, isClear, isRefresh);
        if (isClear) {
          return { text: "Repository milestone goal cleared." };
        }
        const goalStr = typeof res?.goal === "object" ? (res.goal?.goal || "") : (res?.goal || "");
        if (isRefresh) {
          return { text: goalStr ? `Refreshed repository milestone goal: "${goalStr}"` : "Milestone goal refreshed." };
        }
        if (goalVal) {
          return { text: `Repository milestone goal set to: "${goalVal}"` };
        }
        return {
          text: goalStr ? `Current milestone goal: "${goalStr}"` : "No goal currently set.",
        };
      }

      case "watchdog_send_comment":
      case "watchdog_comment": {
        const comment = args.comment || args.notes || args.message;
        if (!comment) {
          return { text: "Error: comment is required.", isError: true };
        }
        const repo = args.repo || args.repo_path || args.repoPath;
        const jobId = args.jobId || args.job_id;
        const res = await sendAuditComment(repo, String(comment), jobId);
        if (res?.ok) {
          return { text: `Sent guidance to in-progress audit for commit \`${res.short_sha || "active"}\`:\n> "${comment}"` };
        }
        return { text: `Could not send comment: ${res?.error || "No in-progress audit found."}`, isError: true };
      }

      case "watchdog_continue": {
        const repo = args.repo || args.repo_path || args.repoPath;
        const jobId = args.jobId || args.job_id;
        const res = await continueAudit(repo, args.sha, jobId);
        if (res?.completed) {
          return {
            text: `Audit for commit \`${res.shortSha || "HEAD"}\` has completed.\n` +
              `Verdict: **${res.verdict || "PASS"}**\n${res.summary || ""}`,
          };
        }
        if (res?.ok) {
          return { text: `Resumed Watchdog audit for commit \`${res.shortSha || "HEAD"}\` in worktree.` };
        }
        return { text: `Could not continue audit: ${res?.error || "No active or interrupted audit found."}`, isError: true };
      }

      case "watchdog_cancel_synthesis": {
        const res = await cancelSynthesis(args.repo);
        return { text: `Next steps synthesis cancelled.${res?.notifiedChat ? " Active turn notified." : ""}` };
      }

      default:
        return { text: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err: any) {
    return { text: `Watchdog error: ${err.message}`, isError: true };
  }
}

export function startMcpServer(): void {
  const rl = createInterface({
    input: process.stdin,
    terminal: false,
  });

  const send = (res: JsonRpcResponse) => {
    process.stdout.write(JSON.stringify(res) + "\n");
  };

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed);
    } catch {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    const { id, method, params } = req;

    // Handle notifications (no id)
    if (id === undefined || id === null) {
      if (method === "notifications/initialized") {
        // Client confirmed initialization
      }
      return;
    }

    try {
      switch (method) {
        case "initialize": {
          send({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: {
                tools: {},
                prompts: {},
              },
              serverInfo: {
                name: "watchdog",
                version: "1.3.0",
              },
            },
          });
          break;
        }

        case "ping": {
          send({ jsonrpc: "2.0", id, result: {} });
          break;
        }

        case "tools/list": {
          send({
            jsonrpc: "2.0",
            id,
            result: {
              tools: ALL_TOOLS,
            },
          });
          break;
        }

        case "tools/call": {
          const toolName = params?.name;
          const toolArgs = params?.arguments || {};
          const result = await handleToolCall(toolName, toolArgs);
          send({
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: result.text,
                },
              ],
              isError: Boolean(result.isError),
            },
          });
          break;
        }

        case "prompts/list": {
          send({
            jsonrpc: "2.0",
            id,
            result: {
              prompts: PROMPTS,
            },
          });
          break;
        }

        case "prompts/get": {
          const promptName = params?.name;
          if (promptName === "watchdog_audit") {
            const notes = params?.arguments?.notes;
            const text =
              "You are acting as or interacting with Watchdog. Follow these rules:\n" +
              "1. Autonomous audits run in isolated Git worktrees, never modifying the user's active tree.\n" +
              "2. Confirmed bugs and fixes are committed to isolated fix branches.\n" +
              "3. Apply fixes via tool watchdog_apply_fix.\n" +
              "4. To prevent double audits, check watchdog_status before queuing.\n" +
              (notes ? `Auditor focus notes: ${notes}\n` : "");
            send({
              jsonrpc: "2.0",
              id,
              result: {
                description: "Watchdog Audit Guidelines",
                messages: [
                  {
                    role: "user",
                    content: { type: "text", text },
                  },
                ],
              },
            });
          } else if (promptName === "watchdog_next_steps") {
            const focus = params?.arguments?.focus;
            const text =
              "Synthesize or inspect the 4 next-step implementation proposals adhering to the official /plan standard.\n" +
              "Review the proposal list via watchdog_next_steps and execute an approved plan via watchdog_execute_plan.\n" +
              (focus ? `Focus area: ${focus}\n` : "");
            send({
              jsonrpc: "2.0",
              id,
              result: {
                description: "Watchdog Next Steps Guidelines",
                messages: [
                  {
                    role: "user",
                    content: { type: "text", text },
                  },
                ],
              },
            });
          } else {
            send({
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: `Prompt not found: ${promptName}` },
            });
          }
          break;
        }

        default: {
          send({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          });
          break;
        }
      }
    } catch (err: any) {
      send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: `Internal error: ${err.message}`,
        },
      });
    }
  });

  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

const isDirectMcpInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] && (process.argv[1].endsWith("mcp.js") || process.argv[1].endsWith("mcp.ts")));

if (isDirectMcpInvocation) {
  startMcpServer();
}
