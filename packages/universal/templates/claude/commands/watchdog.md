---
description: QA Watchdog audit status, review trigger, and bugfix application
---

Use the QA Watchdog tools to inspect or trigger audits:
1. Call `qa_watchdog_status` to view recent audits, verdicts, and fix branches.
2. Call `qa_watchdog_audit` to run a post-commit code & visual QA review in an isolated Git worktree.
3. Call `qa_watchdog_apply_fix` to merge fixes from `fix/qa-<sha>` onto the working branch.
4. Call `qa_watchdog_comment` to forward guidance to an active audit.
