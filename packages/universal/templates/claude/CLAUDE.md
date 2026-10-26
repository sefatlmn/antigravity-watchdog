# Claude Code Guidelines with Watchdog

This project uses Watchdog for automated post-commit code & visual reviews and forward-looking Next Steps planning.

## Watchdog Workflow
- **Isolated Worktrees**: Audits run independently in detached Git worktrees. Never edit worktree files directly.
- **Fix Branches**: Confirmed bugfixes are committed to `fix/watchdog-<sha>`. Merge them to your working branch via `watchdog_apply_fix` or `/watchdog apply-fix`.
- **Skip Tags**: Tag commits with `[skip-watchdog]` or `[skip-qa]` when making intermediate commits or running self-reviews to prevent redundant background cycles.
- **Next Steps Planning**: Use `/next-steps` or `watchdog_next_steps` to inspect 4 structured implementation proposals adhering to `/plan` methodology.
- **Plan Execution**: Use `watchdog_execute_plan` to load an approved proposal for active coding.
