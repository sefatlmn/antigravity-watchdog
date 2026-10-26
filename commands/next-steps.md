---
description: Synthesize, inspect, or execute the 4 project-grounded Next Steps implementation plans
argument-hint: "[refresh | execute <1-4> | goal [text]]"
---

Handle the user's Next Steps command (`$ARGUMENTS`):
- If `$ARGUMENTS` is `refresh`, call `watchdog_next_steps` with `force: true` to re-analyze the codebase and synthesize 4 fresh `/plan` proposals.
- If `$ARGUMENTS` starts with `execute`, call `watchdog_execute_plan` with the specified plan ID (1, 2, 3, or 4) and implement the returned plan specification step by step.
- If `$ARGUMENTS` starts with `goal`, call `watchdog_goal` to view or update the repository milestone goal.
- Otherwise, call `watchdog_next_steps` to display the 4 current implementation proposals and active project goal.
