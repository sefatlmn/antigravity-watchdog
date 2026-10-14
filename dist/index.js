import { Plugin } from "@opencode/plugin";
import { Schema } from "effect";
import { getStatus, prepareWorktree, applyFix, synthesizeNextSteps, triggerStopHook, } from "./bridge.js";
import { startDashboardServer } from "./server.js";
export default Plugin.define({
    id: "qa-watchdog",
    async setup(ctx) {
        let dashboardServer = null;
        const abortController = new AbortController();
        // 1. Start local dashboard server for the Watchdog UI panel
        try {
            dashboardServer = await startDashboardServer(4198);
            console.log(`[QA Watchdog] Local dashboard active at ${dashboardServer.url}`);
        }
        catch (err) {
            console.warn(`[QA Watchdog] Could not start dashboard server: ${err.message}`);
        }
        // 2. Register slash commands
        try {
            await ctx.command.transform((editor) => {
                editor.add({
                    name: "watchdog",
                    description: "Show QA Watchdog status or open the visual dashboard",
                    execute: async ({ sessionID }) => {
                        const status = await getStatus(ctx.location.directory);
                        const statusText = status.paused ? "PAUSED" : "ACTIVE";
                        const url = dashboardServer ? dashboardServer.url : "http://127.0.0.1:4198";
                        await ctx.session.synthetic({
                            sessionID,
                            text: `QA Watchdog Status: ${statusText}\nDashboard: ${url}\nTracked Repositories: ${Object.keys(status.repos || {}).length}\nRecent Jobs: ${status.jobs?.length || 0}`,
                        });
                    },
                });
                editor.add({
                    name: "next-steps",
                    description: "Synthesize 4 project-grounded next-step implementation plans",
                    execute: async ({ sessionID }) => {
                        const dir = ctx.location.directory;
                        const proposals = await synthesizeNextSteps(dir, true);
                        const count = proposals.proposals?.length || 0;
                        await ctx.session.synthetic({
                            sessionID,
                            text: `Synthesized ${count} next-step implementation proposals for repository:\n${JSON.stringify(proposals, null, 2)}`,
                        });
                    },
                });
            });
        }
        catch (err) {
            console.warn(`[QA Watchdog] Command registration skipped: ${err.message}`);
        }
        // 3. Register custom tools
        try {
            await ctx.tool.transform((editor) => {
                editor.add({
                    name: "qa_watchdog_status",
                    description: "Inspect QA Watchdog status, active audits, worktrees, and proposals",
                    input: Schema.Struct({
                        repo: Schema.optional(Schema.String),
                    }),
                    execute: async (input) => {
                        const targetRepo = input.repo || ctx.location.directory;
                        const status = await getStatus(targetRepo);
                        return {
                            output: status,
                            content: JSON.stringify(status, null, 2),
                        };
                    },
                });
                editor.add({
                    name: "qa_watchdog_audit",
                    description: "Prepare an isolated worktree and trigger a QA Watchdog review for a commit",
                    input: Schema.Struct({
                        repo: Schema.String,
                        sha: Schema.String,
                        comment: Schema.optional(Schema.String),
                    }),
                    execute: async (input) => {
                        await prepareWorktree(input.repo, input.sha);
                        const status = await getStatus(input.repo);
                        return {
                            output: status,
                            content: `Prepared isolated worktree for commit ${input.sha} on branch fix/qa-${input.sha.slice(0, 7)}`,
                        };
                    },
                });
                editor.add({
                    name: "qa_watchdog_apply_fix",
                    description: "Apply confirmed bug fixes from an isolated fix/qa-<sha> branch onto the active branch",
                    input: Schema.Struct({
                        repo: Schema.String,
                        sha: Schema.String,
                    }),
                    execute: async (input) => {
                        const result = await applyFix(input.repo, input.sha);
                        return {
                            output: result,
                            content: JSON.stringify(result, null, 2),
                        };
                    },
                });
                editor.add({
                    name: "qa_watchdog_next_steps",
                    description: "Synthesize 4 project-grounded next-step implementation plans adhering to /plan standard",
                    input: Schema.Struct({
                        repo: Schema.optional(Schema.String),
                        force: Schema.optional(Schema.Boolean),
                    }),
                    execute: async (input) => {
                        const targetRepo = input.repo || ctx.location.directory;
                        const proposals = await synthesizeNextSteps(targetRepo, Boolean(input.force));
                        return {
                            output: proposals,
                            content: JSON.stringify(proposals, null, 2),
                        };
                    },
                });
                editor.add({
                    name: "qa_watchdog_dashboard",
                    description: "Get the local URL for the QA Watchdog interactive dashboard panel",
                    input: Schema.Struct({}),
                    execute: async () => {
                        const url = dashboardServer ? dashboardServer.url : "http://127.0.0.1:4198";
                        return {
                            output: { url },
                            content: `QA Watchdog dashboard is available at: ${url}`,
                        };
                    },
                });
            });
        }
        catch (err) {
            console.warn(`[QA Watchdog] Tool registration skipped: ${err.message}`);
        }
        // 4. Update agents with QA Watchdog instructions
        try {
            await ctx.agent.transform((editor) => {
                editor.update("build", (agent) => {
                    if (agent.system) {
                        agent.system +=
                            "\n\n[QA Watchdog Guideline]: When making commits, ensure clean commit messages. The QA Watchdog monitors commits in an isolated git worktree without touching your working tree.";
                    }
                });
            });
        }
        catch {
            // agent transform fallback
        }
        // 5. Subscribe to session lifecycle events to run post-commit reviews
        void (async () => {
            try {
                const stream = ctx.event.subscribe({ signal: abortController.signal });
                for await (const event of stream) {
                    if (event.type === "session.status") {
                        const data = event.data;
                        if (data?.status?.type === "idle") {
                            const workspaceDir = event.location?.directory || ctx.location.directory;
                            if (workspaceDir) {
                                // Trigger the QA stop hook asynchronously
                                triggerStopHook({
                                    fullyIdle: true,
                                    terminationReason: "model_stop",
                                    workspacePaths: [workspaceDir],
                                    conversationId: data.sessionID,
                                }).catch(() => { });
                            }
                        }
                    }
                }
            }
            catch {
                // stream aborted on plugin unload
            }
        })();
        // 6. Return cleanup handler
        return async () => {
            abortController.abort();
            if (dashboardServer) {
                await dashboardServer.close().catch(() => { });
            }
        };
    },
});
//# sourceMappingURL=index.js.map