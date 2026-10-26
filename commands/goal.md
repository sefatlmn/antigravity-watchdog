---
description: View, set, clear, or refresh the repository's milestone goal for Next Steps synthesis
argument-hint: "[--refresh | --clear | <new goal text>]"
---

Manage the repository's project goal (`$ARGUMENTS`) using `watchdog_goal`:
- If `--clear` is passed, call `watchdog_goal` with `clear: true`.
- If new goal text is provided, call `watchdog_goal` with `goal: "$ARGUMENTS"`.
- Otherwise, call `watchdog_goal` to inspect the active milestone goal.
