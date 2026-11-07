---
description: View, set, clear, or refresh the repository's milestone goal for Next Steps synthesis
argument-hint: "[clear | refresh | <new goal text>]"
---

Manage the repository's project goal (`$ARGUMENTS`) using `watchdog_goal`:
- If `$ARGUMENTS` is `clear` or `--clear`, call `watchdog_goal` with `clear: true`.
- If `$ARGUMENTS` is `refresh` or `--refresh`, call `watchdog_goal` with `refresh: true`.
- If new goal text is provided, call `watchdog_goal` with `goal: "$ARGUMENTS"`.
- Otherwise, call `watchdog_goal` to inspect the active milestone goal.
