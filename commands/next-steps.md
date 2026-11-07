---
description: Synthesize, inspect, or execute the 4 project-grounded Next Steps implementation plans
argument-hint: "[1-4 | execute <1-4> | refresh | goal [text]]"
---

Handle the user's Next Steps command (`$ARGUMENTS`):
- If `$ARGUMENTS` is a plan number (1, 2, 3, or 4, with or without '#') or starts with `execute` or `plan` (e.g. `1`, `#1`, `execute 1`, `plan 1`), call `watchdog_execute_plan` with that plan ID and implement the returned plan specification step by step.
- If `$ARGUMENTS` is `refresh` or `force`, call `watchdog_next_steps` with `force: true` to re-analyze the codebase and synthesize 4 fresh `/plan` proposals.
- If `$ARGUMENTS` starts with `goal`, call `watchdog_goal` to view or update the repository milestone goal.
- Otherwise, call `watchdog_next_steps` to display the 4 current implementation proposals and active project goal.
