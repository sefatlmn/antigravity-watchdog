import { Plugin } from "@opencode/plugin";
import { Schema } from "effect";
import { getStatus, prepareWorktree, queueAudit, continueAudit, applyFix, pauseWatchdog, resumeWatchdog, synthesizeNextSteps, cancelSynthesis, manageGoal, executePlan, triggerStopHook, syncRepo, } from "./bridge.js";
export default Plugin.define({
    id: "qa-watchdog",
    async setup(ctx) {
        const abortController = new AbortController();
        // 1. Register slash commands (CLI/chat-only interface)
        try {
            await ctx.command.transform((editor) => {
                // /watchdog command
                editor.add({
                    name: "watchdog",
                    description: "QA Watchdog management: status, audit, apply-fix, pause, resume",
                    execute: async ({ sessionID, prompt }) => {
                        const dir = ctx.location.directory;
                        const text = (prompt?.text || "").trim();
                        const args = text.split(/\s+/).filter(Boolean);
                        const sub = (args[0] || "").toLowerCase();
                        if (sub === "pause") {
                            await pauseWatchdog();
                            await ctx.session.synthetic({
                                sessionID,
                                text: "QA Watchdog paused. Automatic post-commit background reviews are disabled.",
                            });
                            return;
                        }
                        if (sub === "resume") {
                            await resumeWatchdog();
                            await ctx.session.synthetic({
                                sessionID,
                                text: "QA Watchdog resumed. Automatic post-commit background reviews are active.",
                            });
                            return;
                        }
                        if (sub === "audit") {
                            const comment = args.slice(1).join(" ");
                            const sync = await syncRepo(dir);
                            const sha = sync.bestRepo?.headSha || "HEAD";
                            await prepareWorktree(dir, sha);
                            await queueAudit(dir, sha, comment || undefined);
                            await ctx.session.synthetic({
                                sessionID,
                                text: `Queued QA Watchdog audit for commit \`${sha.slice(0, 7)}\` in an isolated Git worktree.\nRun \`/watchdog\` to check progress once completed.`,
                            });
                            return;
                        }
                        if (sub === "continue" || sub === "resume-audit") {
                            const targetSha = args[1] || "";
                            try {
                                const res = await continueAudit(dir, targetSha);
                                if (res.completed) {
                                    await ctx.session.synthetic({
                                        sessionID,
                                        text: `Audit for commit \`${res.shortSha || "HEAD"}\` has already completed.\nVerdict: **${res.verdict || "PASS"}**\n${res.summary || ""}`,
                                    });
                                }
                                else if (res.ok) {
                                    await ctx.session.synthetic({
                                        sessionID,
                                        text: `Resumed QA Watchdog audit for commit \`${res.shortSha || "HEAD"}\` in worktree.\nRun \`/watchdog\` to check progress.`,
                                    });
                                }
                                else {
                                    await ctx.session.synthetic({
                                        sessionID,
                                        text: `Could not continue audit: ${res.error || "No active or interrupted audit found."}`,
                                    });
                                }
                            }
                            catch (err) {
                                await ctx.session.synthetic({
                                    sessionID,
                                    text: `Failed to continue audit: ${err.message}`,
                                });
                            }
                            return;
                        }
                        if (sub === "apply-fix" || sub === "apply") {
                            const targetSha = args[1];
                            const sync = await syncRepo(dir);
                            const sha = targetSha || sync.bestRepo?.lastFixSha || sync.bestRepo?.headSha;
                            if (!sha) {
                                await ctx.session.synthetic({
                                    sessionID,
                                    text: "No fix branch specified. Usage: `/watchdog apply-fix <sha>`",
                                });
                                return;
                            }
                            try {
                                const res = await applyFix(dir, sha);
                                await ctx.session.synthetic({
                                    sessionID,
                                    text: `Applied fixes from \`fix/qa-${sha.slice(0, 7)}\` to the working branch.\n${res.message || "Successfully applied fix."}`,
                                });
                            }
                            catch (err) {
                                await ctx.session.synthetic({
                                    sessionID,
                                    text: `Failed to apply fix: ${err.message}`,
                                });
                            }
                            return;
                        }
                        // Default: formatted status report
                        const status = await getStatus(dir);
                        const sync = await syncRepo(dir);
                        const repoInfo = sync.bestRepo || {};
                        const paused = Boolean(status.paused);
                        const jobs = status.jobs || [];
                        const latestJob = jobs[0];
                        let output = `## QA Watchdog Status: ${paused ? "PAUSED" : "ACTIVE"}\n\n`;
                        output += `- **Repository**: \`${repoInfo.repoName || dir}\` (\`${repoInfo.branch || "main"}\`)\n`;
                        output += `- **Head Commit**: \`${(repoInfo.headSha || "").slice(0, 7)}\` - ${repoInfo.headSubject || "No commits"}\n`;
                        if (latestJob) {
                            const shortSha = latestJob.shortSha || latestJob.sha?.slice(0, 7);
                            output += `\n### Latest Audit (\`${shortSha}\`)\n`;
                            output += `- **Verdict**: ${latestJob.verdict || "UNKNOWN"}\n`;
                            output += `- **Status**: ${latestJob.status || "completed"}\n`;
                            if (latestJob.summary) {
                                output += `- **Summary**: ${latestJob.summary}\n`;
                            }
                            if (latestJob.fixSha || latestJob.fixBranch) {
                                output += `- **Fix Branch**: \`${latestJob.fixBranch || `fix/qa-${shortSha}`}\` (Run \`/watchdog apply-fix ${shortSha}\`)\n`;
                            }
                        }
                        else {
                            output += `\nNo recent audits recorded.\n`;
                        }
                        output += `\n---\n**Available Commands**:\n`;
                        output += `- \`/watchdog audit [notes]\`: Run QA review on latest commit\n`;
                        output += `- \`/watchdog continue [sha]\`: Resume an interrupted audit or auto-complete if report is ready\n`;
                        output += `- \`/watchdog apply-fix [sha]\`: Apply fixes from isolated branch\n`;
                        output += `- \`/watchdog pause\` / \`/watchdog resume\`: Toggle background reviews\n`;
                        await ctx.session.synthetic({
                            sessionID,
                            text: output,
                        });
                    },
                });
                // /next-steps command
                editor.add({
                    name: "next-steps",
                    description: "Synthesize, inspect, or execute forward-looking next steps plans",
                    execute: async ({ sessionID, prompt }) => {
                        const dir = ctx.location.directory;
                        const text = (prompt?.text || "").trim();
                        const args = text.split(/\s+/).filter(Boolean);
                        const sub = (args[0] || "").toLowerCase();
                        if (sub === "cancel" || sub === "stop") {
                            const res = await cancelSynthesis(dir);
                            if (res.conversationId) {
                                try {
                                    await ctx.session.interrupt({ sessionID: res.conversationId });
                                }
                                catch {
                                    // external or finished session
                                }
                            }
                            await ctx.session.synthetic({
                                sessionID,
                                text: `Next steps synthesis cancelled.${res.notifiedChat ? " Respective synthesizer turn notified." : ""}`,
                            });
                            return;
                        }
                        if (sub === "goal") {
                            const goalText = args.slice(1).join(" ");
                            if (goalText.toLowerCase() === "clear") {
                                await manageGoal(dir, undefined, true);
                                await ctx.session.synthetic({
                                    sessionID,
                                    text: "Repository goal cleared.",
                                });
                                return;
                            }
                            if (goalText) {
                                await manageGoal(dir, goalText);
                                await ctx.session.synthetic({
                                    sessionID,
                                    text: `Repository goal set to: "${goalText}"`,
                                });
                                return;
                            }
                            const res = await manageGoal(dir);
                            await ctx.session.synthetic({
                                sessionID,
                                text: res.goal ? `Current milestone goal: "${res.goal}"` : "No goal currently set. Usage: `/next-steps goal <text>`",
                            });
                            return;
                        }
                        if (sub === "execute" || sub === "plan") {
                            const planId = args[1] || "1";
                            const planRes = await executePlan(dir, planId);
                            if (!planRes.ok || !planRes.prompt) {
                                await ctx.session.synthetic({
                                    sessionID,
                                    text: `Could not load proposal plan #${planId}. ${planRes.error || "File not found."}`,
                                });
                                return;
                            }
                            await ctx.session.synthetic({
                                sessionID,
                                text: `### Approved Plan #${planId}: ${planRes.title}\n\n${planRes.prompt}`,
                            });
                            return;
                        }
                        // Default: synthesize and display proposals in chat
                        const force = sub === "refresh" || sub === "force";
                        const proposalsRes = await synthesizeNextSteps(dir, force);
                        const proposals = proposalsRes.proposals || [];
                        const goal = proposalsRes.goal || proposalsRes.projectGoal;
                        let output = `## Proposed Next Steps\n\n`;
                        if (goal) {
                            output += `**Milestone Goal**: "${goal}"\n\n`;
                        }
                        if (proposals.length === 0) {
                            output += `No proposals available. Run \`/next-steps refresh\` to analyze repository context and synthesize proposals.\n`;
                        }
                        else {
                            proposals.forEach((p, idx) => {
                                const num = p.id || idx + 1;
                                const tag = p.category || p.tag || "Feature";
                                const diff = p.difficulty ? ` · ${p.difficulty}` : "";
                                const dur = p.estimatedDuration ? ` · ~${p.estimatedDuration}` : "";
                                output += `### ${num}. [${tag}] ${p.title}${diff}${dur}\n`;
                                if (p.summary || p.description) {
                                    output += `${p.summary || p.description}\n`;
                                }
                                if (Array.isArray(p.objectives) && p.objectives.length > 0) {
                                    p.objectives.slice(0, 3).forEach((obj) => {
                                        output += `- ${obj}\n`;
                                    });
                                }
                                if (Array.isArray(p.affectedFiles) && p.affectedFiles.length > 0) {
                                    output += `*Files*: ${p.affectedFiles.map((f) => `\`${f}\``).join(", ")}\n`;
                                }
                                output += `*Execute*: \`/next-steps execute ${num}\`\n\n`;
                            });
                        }
                        output += `---\n**Available Commands**:\n`;
                        output += `- \`/next-steps execute <id>\`: View approved plan and begin implementation\n`;
                        output += `- \`/next-steps refresh\`: Re-analyze project and generate fresh proposals\n`;
                        output += `- \`/next-steps cancel\`: Cancel active synthesis turn\n`;
                        output += `- \`/next-steps goal <text>\`: Set repository goal\n`;
                        await ctx.session.synthetic({
                            sessionID,
                            text: output,
                        });
                    },
                });
            });
        }
        catch (err) {
            console.warn(`[QA Watchdog] Command registration skipped: ${err.message}`);
        }
        // 2. Register native tools
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
                        await queueAudit(input.repo, input.sha, input.comment);
                        const status = await getStatus(input.repo);
                        return {
                            output: status,
                            content: `Prepared isolated worktree and queued audit for commit ${input.sha}`,
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
                    name: "qa_watchdog_continue",
                    description: "Resume an interrupted audit job or auto-complete if report is already generated",
                    input: Schema.Struct({
                        repo: Schema.optional(Schema.String),
                        sha: Schema.optional(Schema.String),
                        jobId: Schema.optional(Schema.String),
                    }),
                    execute: async (input) => {
                        const targetRepo = input.repo || ctx.location.directory;
                        const result = await continueAudit(targetRepo, input.sha, input.jobId);
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
                    name: "qa_watchdog_execute_plan",
                    description: "Load an approved implementation plan by ID for active coding execution",
                    input: Schema.Struct({
                        repo: Schema.optional(Schema.String),
                        planId: Schema.String,
                    }),
                    execute: async (input) => {
                        const targetRepo = input.repo || ctx.location.directory;
                        const result = await executePlan(targetRepo, input.planId);
                        return {
                            output: result,
                            content: JSON.stringify(result, null, 2),
                        };
                    },
                });
                editor.add({
                    name: "qa_watchdog_cancel_synthesis",
                    description: "Cancel or stop an ongoing Next Steps refresh and interrupt the synthesis turn",
                    input: Schema.Struct({
                        repo: Schema.optional(Schema.String),
                    }),
                    execute: async (input) => {
                        const targetRepo = input.repo || ctx.location.directory;
                        const result = await cancelSynthesis(targetRepo);
                        if (result.conversationId) {
                            try {
                                await ctx.session.interrupt({ sessionID: result.conversationId });
                            }
                            catch {
                                // external or finished session
                            }
                        }
                        return {
                            output: result,
                            content: JSON.stringify(result, null, 2),
                        };
                    },
                });
                editor.add({
                    name: "qa_watchdog_goal",
                    description: "Inspect or configure the repository milestone goal",
                    input: Schema.Struct({
                        repo: Schema.optional(Schema.String),
                        goal: Schema.optional(Schema.String),
                        clear: Schema.optional(Schema.Boolean),
                    }),
                    execute: async (input) => {
                        const targetRepo = input.repo || ctx.location.directory;
                        const result = await manageGoal(targetRepo, input.goal, Boolean(input.clear));
                        return {
                            output: result,
                            content: JSON.stringify(result, null, 2),
                        };
                    },
                });
            });
        }
        catch (err) {
            console.warn(`[QA Watchdog] Tool registration skipped: ${err.message}`);
        }
        // 3. Update agent instructions
        try {
            await ctx.agent.transform((editor) => {
                editor.update("build", (agent) => {
                    if (agent.system) {
                        agent.system +=
                            "\n\n[QA Watchdog Guideline]: When making commits, ensure clean commit messages. The QA Watchdog monitors commits in an isolated git worktree without touching your working tree. Use /watchdog to check review verdicts and /next-steps to view proposed implementation plans.";
                    }
                });
            });
        }
        catch {
            // fallback
        }
        // 4. Subscribe to session lifecycle events to run post-commit reviews
        void (async () => {
            try {
                const stream = ctx.event.subscribe({ signal: abortController.signal });
                for await (const event of stream) {
                    if (event.type === "session.status") {
                        const data = event.data;
                        if (data?.status?.type === "idle") {
                            const workspaceDir = event.location?.directory || ctx.location.directory;
                            if (workspaceDir) {
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
        // 5. Cleanup handler
        return async () => {
            abortController.abort();
        };
    },
});
//# sourceMappingURL=index.js.map