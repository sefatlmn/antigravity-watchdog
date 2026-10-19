# Watchdog & Next Steps Rules

The **Watchdog** plugin monitors completed coding tasks, dispatches independent post-commit code & visual reviews in isolated Git worktrees, and formulates up to 4 structured Next Steps implementation plans adhering to the official `/plan` standard.

## Guidelines for Coding Conversations
- **Never manually trigger recursive reviews or plans**:
  - Commits containing `[auto-review]`, `[qa-watchdog]`, or `[skip-qa]` in the commit message are ignored by the Watchdog hook.
  - Conversations containing `[NEXT-STEPS-SESSION]`, `[NEXT-STEPS-SYNTHESIZER-SESSION]`, or `[QA-WATCHDOG-SESSION]` do not trigger recursive cycles.
- **Audit Reports & Fix Branches**:
  - Completed audit reports are saved to `.antigravity/audits/review-<short_sha>.md` (and `.json`).
  - When Watchdog fixes reproducible bugs, it commits them to an isolated branch named `fix/qa-<short_sha>` without modifying your active working tree or current branch.
  - If the user asks to inspect or apply the latest Watchdog findings, check `.antigravity/audits/` and `git branch --list 'fix/qa-*'`.
- **Next Steps Implementation Plans**:
  - Implementation plans are saved to `.antigravity/next_steps/plan-<id>-<slug>.md` and referenced in `.antigravity/next_steps/proposals.json`.
  - When executing an approved next step, follow the generated plan file and verify all criteria.
