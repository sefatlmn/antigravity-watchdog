# Watchdog & Next Steps Rules

The **Watchdog** plugin runs independent code & visual reviews of commits in isolated Git worktrees when the user asks for one, and formulates up to 4 structured Next Steps implementation plans adhering to the official `/plan` standard.

## Guidelines for Coding Conversations
- **Audits and plans run only when the user asks**: never start a Watchdog audit or Next Steps synthesis on your own. Watchdog does not audit commits containing `[auto-review]`, `[watchdog]`, or `[skip-watchdog]`.
- **Audit Reports & Fix Branches**:
  - Completed audit reports are saved to `.antigravity/audits/review-<short_sha>.md` (and `.json`).
  - When Watchdog fixes reproducible bugs, it commits them to an isolated branch named `fix/watchdog-<short_sha>` without modifying your active working tree or current branch.
  - If the user asks to inspect or apply the latest Watchdog findings, check `.antigravity/audits/` and `git branch --list 'fix/watchdog-*'`.
- **Next Steps Implementation Plans**:
  - Implementation plans are saved to `.antigravity/next_steps/plan-<id>-<slug>.md` and referenced in `.antigravity/next_steps/proposals.json`.
  - When executing an approved next step, follow the generated plan file and verify all criteria.
