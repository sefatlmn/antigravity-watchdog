# Watchdog

Post-commit QA auditing and next steps planning for Google Antigravity and OpenCode Desktop.

Runs visual and code verification in isolated Git worktrees, tests UI in headless Playwright, records fixes to isolated `fix/qa-<sha>` branches, and proposes milestone-aligned next steps.

## Requirements

- Python 3.10+
- Node.js 18+
- Git 2.30+
- Playwright (optional, required for browser test passes)

---

## Installation

### Method 1: Google Antigravity (Visual Companion Panel)

Clone the repository into your Antigravity plugins directory:

```bash
git clone git@github.com:sefatlmn/antigravity-watchdog.git ~/.gemini/config/plugins/qa-watchdog
```

To enable:
1. Open Antigravity Settings -> Plugins.
2. Ensure `qa-watchdog` is enabled.
3. The companion panel opens from the side pane or runs as a sidecar dashboard.

The root of this repository is a native Antigravity plugin containing the lifecycle stop hook (`hooks.json`), agent rules (`rules/AGENTS.md`), agent skills (`skills/qa-watchdog/`, `skills/next-steps/`), CLI engines (`scripts/`), and the sidecar UI panel (`sidecars/panel/`).

---

### Method 2: OpenCode Desktop (Chat-Driven Plugin)

OpenCode does not host webview sidecars. The OpenCode integration is packaged as a pure, UI-less plugin in `packages/opencode/` that operates entirely through chat commands and native agent tools.

#### 1. Build the Package

```bash
cd packages/opencode
npm install
npm run build
```

#### 2. Register in OpenCode

Add the package path to your `~/.config/opencode/opencode.json` (or project-level `opencode.json`):

```json
{
  "plugins": [
    "/path/to/qa-watchdog/packages/opencode"
  ]
}
```

Or install via the OpenCode CLI:

```bash
opencode plugin add /path/to/qa-watchdog/packages/opencode
```

#### 3. Chat Commands in OpenCode

- **`/watchdog`**:
  - `/watchdog`: Formatted status report with current repo, branch, latest audit verdict, and available fix branches.
  - `/watchdog audit [notes]`: Trigger a QA review on the latest commit in an isolated worktree.
  - `/watchdog apply-fix [sha]`: Merge confirmed bug fixes from `fix/qa-<sha>` onto your working branch.

- **`/next-steps`**:
  - `/next-steps`: Synthesizes and prints 4 structured implementation proposals directly into chat.
  - `/next-steps execute <id>`: Loads the approved plan specification into the session for implementation.
  - `/next-steps refresh`: Forces a fresh context synthesis and generates new proposals.
  - `/next-steps cancel`: Cancels an ongoing next steps synthesis turn.
  - `/next-steps goal <text>`: Sets the milestone goal (or `/next-steps goal clear`).

- **Native Tools Available to Agents**:
  - `qa_watchdog_status`
  - `qa_watchdog_audit`
  - `qa_watchdog_apply_fix`
  - `qa_watchdog_next_steps`
  - `qa_watchdog_execute_plan`
  - `qa_watchdog_cancel_synthesis`
  - `qa_watchdog_goal`

- **Background Hook**: Automatically audits new commits on session `idle` in isolated worktrees.

---

## How It Works

- **Stop Hook**: When an agent finishes a turn and commits code, Watchdog detects the commit.
- **Isolated Worktree**: Audits run in detached worktrees under `~/.gemini/antigravity/qa_watchdog/worktrees/` so your working branch is never modified.
- **Fix Branch**: Reproducible test or lint fixes are committed to `fix/qa-<short_sha>`. Apply them to your working branch with one click in Antigravity or via `/watchdog apply-fix` in OpenCode.
- **Next Steps**: Synthesizes 4 forward-looking implementation plans in `.antigravity/next_steps/` based on repo goals, commits, and handoffs.

---

## Preventing Auto-Audits

Add any of these tags to your commit message to skip the QA watchdog:

- `[skip-qa]`
- `[auto-review]`
- `[qa-watchdog]`

---

## CLI Usage

```bash
# Check status and active repos
python3 scripts/qa_ctl.py status

# Run an audit on the latest commit
python3 scripts/qa_ctl.py run --repo /path/to/project

# Apply a fix from fix/qa-<sha> to active branch
python3 scripts/qa_ctl.py apply-fix --repo /path/to/project --sha <short_sha>

# Cancel an ongoing next-steps synthesis
python3 scripts/qa_ctl.py cancel-synthesis --repo /path/to/project
```

---

## License

Apache-2.0
