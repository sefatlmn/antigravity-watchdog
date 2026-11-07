import { Plugin } from "@opencode/plugin";
import { Schema } from "effect";
import {
  getStatus,
  prepareWorktree,
  queueAudit,
  continueAudit,
  sendAuditComment,
  applyFix,
  synthesizeNextSteps,
  cancelSynthesis,
  manageGoal,
  executePlan,
  syncRepo,
  formatNextStepsReport,
} from "./bridge.js";

export default Plugin.define({
  id: "watchdog",

  async setup(ctx) {
    // 1. Register slash commands (CLI/chat-only interface)
    try {
      await ctx.command.transform((editor) => {
        // /watchdog command
        editor.add({
          name: "watchdog",
          description: "Watchdog management: status, audit, apply-fix, continue, comment",
          execute: async ({ sessionID, prompt }) => {
            const dir = ctx.location.directory;
            const text = (prompt?.text || "").trim();
            const args = text.split(/\s+/).filter(Boolean);
            const sub = (args[0] || "").toLowerCase();

            if (sub === "audit") {
              try {
                const comment = args.slice(1).join(" ");
                const status = await getStatus(dir);
                const runningJob = (status.jobs || []).find((j: any) => j.status === "running" || j.status === "queued");

                if (runningJob) {
                  const targetSha = runningJob.shortSha || runningJob.sha?.slice(0, 7) || "current";
                  if (comment) {
                    await sendAuditComment(dir, comment, runningJob.id);
                    await ctx.session.synthetic({
                      sessionID,
                      text: `An audit for commit \`${targetSha}\` is already in progress. Your comment was forwarded to the active auditor:\n> "${comment}"`,
                    });
                  } else {
                    await ctx.session.synthetic({
                      sessionID,
                      text: `An audit for commit \`${targetSha}\` is already in progress. Double auditing prevented.\nTo send guidance to the auditor, run \`/watchdog comment <notes>\`.`,
                    });
                  }
                  return;
                }

                const sync = await syncRepo(dir);
                const sha = sync.bestRepo?.head?.sha || sync.bestRepo?.headSha || "HEAD";
                const res = await queueAudit(dir, sha, comment || undefined, true);
                if (res?.skipped || res?.ok === false) {
                  await ctx.session.synthetic({
                    sessionID,
                    text: `Watchdog audit skipped: ${res?.reason || res?.error || "Commit was skipped."}`,
                  });
                } else {
                  await ctx.session.synthetic({
                    sessionID,
                    text: `Queued Watchdog audit for commit \`${sha.slice(0, 7)}\` in an isolated Git worktree.\nRun \`/watchdog\` to check progress once completed.`,
                  });
                }
              } catch (err: any) {
                await ctx.session.synthetic({
                  sessionID,
                  text: `Failed to queue Watchdog audit: ${err.message}`,
                });
              }
              return;
            }

            if (sub === "comment" || sub === "note") {
              const comment = args.slice(1).join(" ");
              if (!comment) {
                await ctx.session.synthetic({
                  sessionID,
                  text: "Please provide a comment. Usage: `/watchdog comment <your message>`",
                });
                return;
              }
              try {
                const res = await sendAuditComment(dir, comment);
                if (res.ok) {
                  await ctx.session.synthetic({
                    sessionID,
                    text: `Sent comment to in-progress audit for commit \`${res.short_sha || "active"}\`:\n> "${comment}"`,
                  });
                } else {
                  await ctx.session.synthetic({
                    sessionID,
                    text: `Could not send comment: ${res.error || "No in-progress audit found."}`,
                  });
                }
              } catch (err: any) {
                await ctx.session.synthetic({
                  sessionID,
                  text: `Failed to send comment: ${err.message}`,
                });
              }
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
                } else if (res.ok) {
                  await ctx.session.synthetic({
                    sessionID,
                    text: `Resumed Watchdog audit for commit \`${res.shortSha || "HEAD"}\` in worktree.\nRun \`/watchdog\` to check progress.`,
                  });
                } else {
                  await ctx.session.synthetic({
                    sessionID,
                    text: `Could not continue audit: ${res.error || "No active or interrupted audit found."}`,
                  });
                }
              } catch (err: any) {
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
              const firstFix = sync.bestRepo?.fixBranches?.[0];
              const fixSha = firstFix?.shortSha ||
                (typeof firstFix === "string" ? firstFix.replace(/^fix\/watchdog-/, "") : "") ||
                sync.bestRepo?.lastFixSha;
              const sha = targetSha || fixSha || sync.bestRepo?.head?.sha || sync.bestRepo?.headSha;
              if (!sha) {
                await ctx.session.synthetic({
                  sessionID,
                  text: "No fix branch specified. Usage: `/watchdog apply-fix <sha>`",
                });
                return;
              }
              try {
                const res = await applyFix(dir, sha);
                if (res?.ok === false || res?.error) {
                  await ctx.session.synthetic({
                    sessionID,
                    text: `Failed to apply fix: ${res.error || "Unknown error"}`,
                  });
                  return;
                }
                await ctx.session.synthetic({
                  sessionID,
                  text: `Applied fixes for commit \`${sha.slice(0, 7)}\` to the working branch.\n${res.message || "Successfully applied fix."}`,
                });
              } catch (err: any) {
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
            const jobs = status.jobs || [];
            const latestJob = jobs[0];

            let output = `## Watchdog Status: ACTIVE\n\n`;
            output += `- **Repository**: \`${repoInfo.repoName || dir}\` (\`${repoInfo.branch || "main"}\`)\n`;
            const headSha = repoInfo.head?.sha || repoInfo.headSha || "";
            const headSubject = repoInfo.head?.subject || repoInfo.headSubject || "No commits";
            output += `- **Head Commit**: \`${headSha.slice(0, 7)}\` - ${headSubject}\n`;

            if (latestJob) {
              const shortSha = latestJob.shortSha || latestJob.sha?.slice(0, 7);
              output += `\n### Latest Audit (\`${shortSha}\`)\n`;
              output += `- **Verdict**: ${latestJob.verdict || "UNKNOWN"}\n`;
              output += `- **Status**: ${latestJob.status || "completed"}\n`;
              if (latestJob.summary) {
                output += `- **Summary**: ${latestJob.summary}\n`;
              }
              if (latestJob.fixSha || latestJob.fixBranch) {
                output += `- **Fix Branch**: \`${latestJob.fixBranch || `fix/watchdog-${shortSha}`}\` (Run \`/watchdog apply-fix ${shortSha}\`)\n`;
              }
            } else {
              output += `\nNo recent audits recorded.\n`;
            }

            output += `\n---\n**Available Commands**:\n`;
            output += `- \`/watchdog audit [notes]\`: Run review on latest commit (forwards notes if running)\n`;
            output += `- \`/watchdog comment <notes>\`: Send guidance/focus note to in-progress audit\n`;
            output += `- \`/watchdog continue [sha]\`: Resume an interrupted audit or auto-complete if report is ready\n`;
            output += `- \`/watchdog apply-fix [sha]\`: Apply fixes from isolated branch\n`;

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
                } catch {
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
              const goalText = args.slice(1).join(" ").trim();
              const lower = goalText.toLowerCase();
              if (lower === "clear" || lower === "--clear") {
                await manageGoal(dir, undefined, true);
                await ctx.session.synthetic({
                  sessionID,
                  text: "Repository goal cleared.",
                });
                return;
              }
              if (lower === "refresh" || lower === "--refresh") {
                const res = await manageGoal(dir, undefined, false, true);
                const goalStr = typeof res?.goal === "object" ? (res.goal?.goal || "") : (res?.goal || "");
                await ctx.session.synthetic({
                  sessionID,
                  text: goalStr ? `Refreshed repository goal: "${goalStr}"` : "Repository goal refreshed.",
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
              const currentGoal = typeof res?.goal === "object" ? (res.goal?.goal || "") : (res?.goal || "");
              await ctx.session.synthetic({
                sessionID,
                text: currentGoal ? `Current milestone goal: "${currentGoal}"` : "No goal currently set. Usage: `/next-steps goal <text>`",
              });
              return;
            }

            if (sub === "execute" || sub === "plan" || (sub && /^#?[1-4]$/.test(sub))) {
              const planId = ((sub === "execute" || sub === "plan" ? args[1] : sub) || "1").replace(/^#/, "");
              const planRes = await executePlan(dir, planId, true);
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
            let output = formatNextStepsReport(proposalsRes);

            output += `\n---\n**Available Commands**:\n`;
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
    } catch (err: any) {
      console.warn(`[Watchdog] Command registration skipped: ${err.message}`);
    }

    // 2. Register native tools
    try {
      await ctx.tool.transform((editor) => {
        const registerTool = (name: string, description: string, input: any, execute: (i: any) => Promise<any>) => {
          editor.add({ name, description, input, execute });
        };

        registerTool(
          "watchdog_status",
          "Inspect Watchdog status, active audits, worktrees, and proposals",
          Schema.Struct({ repo: Schema.optional(Schema.String) }),
          async (input) => {
            const targetRepo = input.repo || ctx.location.directory;
            const status = await getStatus(targetRepo);
            return {
              output: status,
              content: JSON.stringify(status, null, 2),
            };
          }
        );

        registerTool(
          "watchdog_audit",
          "Prepare an isolated worktree and trigger a Watchdog review for a commit",
          Schema.Struct({
            repo: Schema.optional(Schema.String),
            sha: Schema.optional(Schema.String),
            comment: Schema.optional(Schema.String),
            force: Schema.optional(Schema.Boolean),
          }),
          async (input) => {
            const targetRepo = input.repo || ctx.location.directory;
            const res = await queueAudit(targetRepo, input.sha, input.comment, input.force ?? true);
            const shortSha = res?.job?.short_sha || (input.sha ? String(input.sha).slice(0, 7) : "HEAD");
            const status = await getStatus(targetRepo);
            return {
              output: { status, queue: res },
              content: res?.skipped
                ? `Audit skipped: ${res?.reason || "Commit was skipped."}`
                : `Queued audit for commit ${shortSha} in an isolated Git worktree`,
            };
          }
        );

        registerTool(
          "watchdog_apply_fix",
          "Apply confirmed bug fixes from an isolated fix branch onto the active branch",
          Schema.Struct({
            repo: Schema.optional(Schema.String),
            sha: Schema.optional(Schema.String),
          }),
          async (input) => {
            const targetRepo = input.repo || ctx.location.directory;
            const result = await applyFix(targetRepo, input.sha);
            return {
              output: result,
              content: JSON.stringify(result, null, 2),
            };
          }
        );

        registerTool(
          "watchdog_continue",
          "Resume an interrupted audit job or auto-complete if report is already generated",
          Schema.Struct({
            repo: Schema.optional(Schema.String),
            sha: Schema.optional(Schema.String),
            jobId: Schema.optional(Schema.String),
          }),
          async (input) => {
            const targetRepo = input.repo || ctx.location.directory;
            const result = await continueAudit(targetRepo, input.sha, input.jobId);
            return {
              output: result,
              content: JSON.stringify(result, null, 2),
            };
          }
        );

        const commentHandler = async (input: any) => {
          const targetRepo = input.repo || ctx.location.directory;
          const result = await sendAuditComment(targetRepo, input.comment, input.jobId);
          return {
            output: result,
            content: JSON.stringify(result, null, 2),
          };
        };

        registerTool(
          "watchdog_comment",
          "Send a comment or guidance message to an in-progress Watchdog audit",
          Schema.Struct({
            comment: Schema.String,
            repo: Schema.optional(Schema.String),
            jobId: Schema.optional(Schema.String),
          }),
          commentHandler
        );

        registerTool(
          "watchdog_send_comment",
          "Send a comment or guidance message to an in-progress Watchdog audit",
          Schema.Struct({
            comment: Schema.String,
            repo: Schema.optional(Schema.String),
            jobId: Schema.optional(Schema.String),
          }),
          commentHandler
        );

        registerTool(
          "watchdog_next_steps",
          "Synthesize 4 project-grounded next-step implementation plans adhering to /plan standard",
          Schema.Struct({
            repo: Schema.optional(Schema.String),
            force: Schema.optional(Schema.Boolean),
          }),
          async (input) => {
            const targetRepo = input.repo || ctx.location.directory;
            const proposals = await synthesizeNextSteps(targetRepo, Boolean(input.force));
            return {
              output: proposals,
              content: JSON.stringify(proposals, null, 2),
            };
          }
        );

        registerTool(
          "watchdog_execute_plan",
          "Load an approved implementation plan by ID for active coding execution",
          Schema.Struct({
            repo: Schema.optional(Schema.String),
            planId: Schema.String,
          }),
          async (input) => {
            const targetRepo = input.repo || ctx.location.directory;
            const planId = String(input.planId || "").replace(/^#/, "");
            const result = await executePlan(targetRepo, planId, true);
            return {
              output: result,
              content: JSON.stringify(result, null, 2),
            };
          }
        );

        registerTool(
          "watchdog_cancel_synthesis",
          "Cancel or stop an ongoing Next Steps refresh and interrupt the synthesis turn",
          Schema.Struct({
            repo: Schema.optional(Schema.String),
          }),
          async (input) => {
            const targetRepo = input.repo || ctx.location.directory;
            const result = await cancelSynthesis(targetRepo);
            if (result.conversationId) {
              try {
                await ctx.session.interrupt({ sessionID: result.conversationId });
              } catch {
                // external or finished session
              }
            }
            return {
              output: result,
              content: JSON.stringify(result, null, 2),
            };
          }
        );

        registerTool(
          "watchdog_goal",
          "Inspect or configure the repository milestone goal",
          Schema.Struct({
            repo: Schema.optional(Schema.String),
            goal: Schema.optional(Schema.String),
            clear: Schema.optional(Schema.Boolean),
            refresh: Schema.optional(Schema.Boolean),
          }),
          async (input) => {
            const targetRepo = input.repo || ctx.location.directory;
            const isClear = Boolean(input.clear) || (typeof input.goal === "string" && input.goal.trim().toLowerCase() === "clear");
            const isRefresh = Boolean(input.refresh) || (typeof input.goal === "string" && input.goal.trim().toLowerCase() === "refresh");
            const goalVal = (isClear || isRefresh) ? undefined : input.goal;
            const result = await manageGoal(
              targetRepo,
              goalVal,
              isClear,
              isRefresh
            );
            const goalStr = typeof result?.goal === "object" ? (result.goal?.goal || "") : (result?.goal || "");
            let text = "No goal currently set.";
            if (isClear) {
              text = "Repository milestone goal cleared.";
            } else if (isRefresh) {
              text = goalStr ? `Refreshed repository milestone goal: "${goalStr}"` : "Milestone goal refreshed.";
            } else if (goalVal) {
              text = `Repository milestone goal set to: "${goalVal}"`;
            } else if (goalStr) {
              text = `Current milestone goal: "${goalStr}"`;
            }
            return {
              output: result,
              content: text,
            };
          }
        );
      });
    } catch (err: any) {
      console.warn(`[Watchdog] Tool registration skipped: ${err.message}`);
    }

    // 3. Update agent instructions
    try {
      await ctx.agent.transform((editor) => {
        editor.update("build", (agent) => {
          if (agent.system) {
            agent.system +=
              "\n\n[Watchdog Guideline]: When making commits, ensure clean commit messages. Watchdog audits commits on request in an isolated git worktree without touching your working tree. Use /watchdog audit to request one, /watchdog to check review verdicts and /next-steps to view proposed implementation plans.";
          }
        });
      });
    } catch {
      // fallback
    }
  },
});
