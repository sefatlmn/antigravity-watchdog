# Watchdog & Next Steps for Google Antigravity

Autonomous post-commit auditing, visual verification, and sequential next-step synthesis natively integrated into **Google Antigravity**.

Watchdog operates non-intrusively in isolated Git worktrees, ensuring your active working tree, uncommitted edits, and running dev servers are never disturbed. When you trigger an audit, Watchdog reviews the diff, executes automated tests and Playwright visual checks, and commits reproducible fixes to an isolated `fix/watchdog-<sha>` branch. In parallel, its Next Steps engine synthesizes 4 project-grounded, `/plan`-compliant implementation proposals.

---

## Features

- **Isolated Git Worktrees:** Every audit and test pass executes in a temporary, detached worktree. Your working tree is never touched.
- **Automated Fix Branches:** Confirmed bug fixes are automatically committed to `fix/watchdog-<short_sha>` for one-click cherry-picking.
- **Native Antigravity Sidecar Panel:** An embedded webview directly inside Antigravity's auxiliary side pane displaying active audits, status badges, diffs, reports, and Next Steps plans.
- **AgentAPI Background Synthesis:** Directly communicates with Antigravity's AgentAPI to spawn background audits and plan executions.
- **Next Steps Implementation Engine:** Ingests repository documentation, recent user transcripts, and codebase symbols to formulate 4 structured `/plan` proposals.
- **Audits Run Only on Demand:** Watchdog never audits without user interaction, and automatically skips commits tagged `[skip-watchdog]`, `[auto-review]`, or `[watchdog]`.

---

## Requirements

- Google Antigravity IDE
- Python 3.10+
- Node.js 18+
- Git 2.30+
- Playwright MCP (optional, for visual regression audits)

---

## Installation

Clone the repository into Antigravity's plugins directory:

```bash
git clone https://github.com/sefatlmn/antigravity-watchdog.git ~/.gemini/config/plugins/watchdog
```

*On Windows, clone into `%USERPROFILE%\.gemini\config\plugins\watchdog`.*

Then open **Settings → Plugins** in Antigravity, verify that **Watchdog** is enabled, and open the Watchdog view in the auxiliary side pane.

---

## Repository Layout

- `plugin.json`: Antigravity plugin manifest defining the auxiliary webview panel and metadata.
- `rules/AGENTS.md`: Project-level agent instructions for Watchdog audits and Next Steps synthesis.
- `skills/`:
  - `skills/watchdog-auditor/`: Autonomous post-commit code review and visual verification skill.
  - `skills/next-steps-synthesizer/`: Post-commit planning and next-step proposal synthesizer.
- `sidecars/panel/`: Embedded auxiliary panel webview:
  - `main.mjs`: Node.js sidecar service integrating with Antigravity's `sidecar_sdk` (or bundled fallback).
  - `view-model.js`: Reactive UI state, badge computations, and selection logic.
  - `app.js`: Front-end controller, theme synchronizer, and AgentAPI dispatcher.
  - `index.html` & `styles.css`: Impeccable dark/light responsive interface.
- `scripts/`:
  - `scripts/watchdog_ctl.py`: Core controller managing SQLite state, Git worktrees, and AgentAPI jobs.
  - `scripts/run-tests.mjs`: Test suite covering controller logic, panel view-model, and sidecar endpoints.
- `types/index.d.ts`: Standalone TypeScript definitions for all Watchdog domain types.

---

## Controller CLI

The controller script can also be queried directly from the command line:

```bash
# Check repository status and recent audits
python3 scripts/watchdog_ctl.py status

# Queue an audit for HEAD with optional focus notes (aliases: queue, queue-commit)
python3 scripts/watchdog_ctl.py queue --repo . --comment "Check edge case handling"
python3 scripts/watchdog_ctl.py queue-commit --repo . --notes "Check edge case handling"

# Apply fixes from a verified fix branch
python3 scripts/watchdog_ctl.py apply-fix --repo . --sha <sha>

# Synthesize Next Steps proposals (aliases: next-steps, synthesize)
python3 scripts/watchdog_ctl.py next-steps --repo .
python3 scripts/watchdog_ctl.py synthesize --repo .

# Set or inspect milestone goal (aliases: goal, get-goal, set-goal)
python3 scripts/watchdog_ctl.py goal --repo .
python3 scripts/watchdog_ctl.py goal --repo . --goal "Production release v2"
python3 scripts/watchdog_ctl.py set-goal --repo . --goal "Production release v2"
```

---

## Testing & Typechecking

Run the Antigravity test suite and verify TypeScript types:

```bash
npm test
npm run typecheck
```

---

## License

Apache-2.0
