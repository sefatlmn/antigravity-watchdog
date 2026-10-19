import { createInterface } from "node:readline";
import {
  getStatus,
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
      },
    },
  },
  {
    name: "watchdog_apply_fix",
    description: "Apply verified fixes from an isolated fix/qa-<sha> branch onto the active branch.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Path to git repository (defaults to working directory).",
        },
        sha: {
          type: "string",
          description: "Target commit SHA whose fix branch (fix/qa-<sha>) should be merged.",
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

// Add backwards-compatible qa_watchdog_* tool aliases
const ALIAS_TOOLS = PRIMARY_TOOLS.map((t) => ({
  ...t,
  name: `qa_${t.name}`,
}));

const ALL_TOOLS = [...PRIMARY_TOOLS, ...ALIAS_TOOLS];

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

async function handleToolCall(rawName: string, args: Record<string, any> = {}): Promise<{ text: string; isError?: boolean }> {
  const name = rawName.replace(/^qa_/, "");
  try {
    switch (name) {
      case "watchdog_status": {
        const status = await getStatus(args.repo);
        let syncInfo: any = null;
        try {
          syncInfo = await syncRepo(args.repo);
        } catch {
          // ignore sync failure
        }
        const text = formatStatusReport(status, syncInfo);
        return { text };
      }

      case "watchdog_audit": {
        await prepareWorktree(args.repo, args.sha);
        const res = await queueAudit(args.repo, args.sha, args.comment);
        const shortSha = res?.job?.short_sha || (args.sha ? String(args.sha).slice(0, 7) : "HEAD");
        if (res?.already_running) {
          return { text: `Audit for commit \`${shortSha}\` is already running. Double auditing prevented.` };
        }
        return {
          text: `Queued Watchdog audit for commit \`${shortSha}\` in an isolated Git worktree.\n` +
            `Reviewers will test code correctness, run Playwright browser passes, and commit reproducible fixes to \`fix/qa-${shortSha}\`.`,
        };
      }

      case "watchdog_apply_fix": {
        const res = await applyFix(args.repo, args.sha);
        return {
          text: `Applied fixes to working branch.\n${res?.message || JSON.stringify(res, null, 2)}`,
        };
      }

      case "watchdog_next_steps": {
        const res = await synthesizeNextSteps(args.repo, Boolean(args.force));
        const text = formatNextStepsReport(res);
        return { text };
      }

      case "watchdog_execute_plan": {
        if (!args.planId) {
          return { text: "Error: planId is required (e.g. '1', '2', '3', '4').", isError: true };
        }
        const res = await executePlan(args.repo, String(args.planId));
        if (!res?.ok || !res?.prompt) {
          return { text: `Could not load plan #${args.planId}: ${res?.error || "Plan file not found."}`, isError: true };
        }
        return {
          text: `### Approved Plan #${args.planId}: ${res.title || "Implementation"}\n\n${res.prompt}`,
        };
      }

      case "watchdog_goal": {
        const res = await manageGoal(args.repo, args.goal, Boolean(args.clear));
        if (args.clear) {
          return { text: "Repository milestone goal cleared." };
        }
        if (args.goal) {
          return { text: `Repository milestone goal set to: "${args.goal}"` };
        }
        return {
          text: res?.goal ? `Current milestone goal: "${res.goal}"` : "No goal currently set.",
        };
      }

      case "watchdog_comment": {
        if (!args.comment) {
          return { text: "Error: comment is required.", isError: true };
        }
        const res = await sendAuditComment(args.repo, String(args.comment), args.jobId);
        if (res?.ok) {
          return { text: `Sent guidance to in-progress audit for commit \`${res.short_sha || "active"}\`:\n> "${args.comment}"` };
        }
        return { text: `Could not send comment: ${res?.error || "No in-progress audit found."}`, isError: true };
      }

      case "watchdog_continue": {
        const res = await continueAudit(args.repo, args.sha, args.jobId);
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
        return { text: `Unknown tool: ${rawName}`, isError: true };
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
                version: "1.1.0",
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
          if (promptName === "watchdog_audit" || promptName === "qa_audit") {
            const notes = params?.arguments?.notes;
            const text =
              "You are acting as or interacting with Watchdog. Follow these rules:\n" +
              "1. Autonomous audits run in isolated Git worktrees, never modifying the user's active tree.\n" +
              "2. Confirmed bugs and fixes are committed to fix/qa-<sha>.\n" +
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
          } else if (promptName === "watchdog_next_steps" || promptName === "qa_next_steps") {
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
