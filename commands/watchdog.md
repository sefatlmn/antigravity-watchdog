---
description: Watchdog audit status, manual worktree review trigger, comment forwarding, and sidepanel launcher
argument-hint: "[status | audit [notes] | comment <notes> | continue [sha] | apply-fix [sha] | panel]"
---

Handle the user's Watchdog command (`$ARGUMENTS`):
- If `$ARGUMENTS` is `panel`, call `watchdog_open_panel` with `open: true` to open the live Watchdog Sidepanel UI window.
- If `$ARGUMENTS` starts with `audit`, call `watchdog_audit` (passing any notes in `comment`) to run an isolated Git worktree code & Playwright visual review.
- If `$ARGUMENTS` starts with `comment`, call `watchdog_send_comment` to forward guidance to the active auditor.
- If `$ARGUMENTS` starts with `continue`, call `watchdog_continue` to resume an interrupted audit.
- If `$ARGUMENTS` starts with `apply-fix`, call `watchdog_apply_fix` to merge fixes from `fix/watchdog-<sha>` onto the active branch.
- Otherwise, call `watchdog_status` to display the repository status, latest audit verdict, and available fix branches.
