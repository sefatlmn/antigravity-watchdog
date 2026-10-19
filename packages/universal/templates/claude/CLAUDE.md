# Claude Code Guidelines with QA Watchdog

This project uses QA Watchdog for automated post-commit code & visual QA and forward-looking Next Steps planning.

## QA Watchdog Workflow
- **Isolated Worktrees**: Audits run independently in detached Git worktrees. Never edit worktree files directly.
- **Fix Branches**: Confirmed bugfixes are committed to `fix/qa-<sha>`. Merge them to your working branch via `qa_watchdog_apply_fix` or `/watchdog apply-fix`.
- **Skip Tags**: Tag commits with `[skip-qa]` when making intermediate commits or running self-reviews to prevent redundant background cycles.
- **Next Steps Planning**: Use `/next-steps` or `qa_watchdog_next_steps` to inspect 4 structured implementation proposals adhering to `/plan` methodology.
- **Plan Execution**: Use `qa_watchdog_execute_plan` to load an approved proposal for active coding.
