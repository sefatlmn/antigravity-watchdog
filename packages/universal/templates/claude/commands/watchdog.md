---
description: Watchdog audit status, review trigger, and bugfix application
---

Use the Watchdog tools to inspect or trigger audits:
1. Call `watchdog_status` to view recent audits, verdicts, and fix branches.
2. Call `watchdog_audit` to run a post-commit code & visual review in an isolated Git worktree.
3. Call `watchdog_apply_fix` to merge fixes from `fix/watchdog-<sha>` onto the working branch.
4. Call `watchdog_comment` to forward guidance to an active audit.
5. Call `watchdog_open_panel` to open the live Watchdog Sidepanel UI.
