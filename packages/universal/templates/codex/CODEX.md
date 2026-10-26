# OpenAI Codex & Agent Rules for Watchdog

## Operating Principles
- **Autonomous Audits**: The repository uses Watchdog to verify code correctness and visual UX in isolated Git worktrees.
- **Commit Tagging**: Intermediate commits, refactors, and test commits should include `[skip-watchdog]` in the commit message.
- **Fix Application**: When an audit produces verified fixes on `fix/watchdog-<sha>`, apply them via the CLI:
  ```bash
  watchdog apply-fix <sha>
  ```
- **Next Steps Planning**: Propose and inspect project-grounded Next Steps adhering to the `/plan` methodology:
  ```bash
  watchdog next-steps
  watchdog plan <id>
  ```
