# Watchdog

Post-commit QA auditing and next steps planning for Google Antigravity and OpenCode Desktop.

Runs visual and code verification in isolated Git worktrees, tests UI in headless Playwright, records fixes to isolated `fix/qa-<sha>` branches, and proposes milestone-aligned next steps in a companion web panel.

## Requirements

- Python 3.10+
- Node.js 18+
- Git 2.30+
- Playwright (optional, required for browser test passes)

---

## Installation

### Method 1: Google Antigravity

Clone the repository into your Antigravity plugins directory:

```bash
git clone git@github.com:sefatlmn/antigravity-watchdog.git ~/.gemini/config/plugins/qa-watchdog
```

To enable:
1. Open Antigravity Settings -> Plugins.
2. Ensure `qa-watchdog` is enabled.
3. The companion panel opens from the side pane or runs as a sidecar dashboard.

The root of this repository is a native Antigravity plugin containing the lifecycle stop hook (`hooks.json`), agent rules (`rules/AGENTS.md`), agent skills (`skills/qa-watchdog/`, `skills/next-steps/`), CLI engines (`scripts/`), and the sidecar panel (`sidecars/panel/`).

---

### Method 2: OpenCode Desktop

The OpenCode plugin is maintained as a dedicated package in `packages/opencode/`.

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

#### OpenCode Features

- **Slash Commands**:
  - `/watchdog`: Displays active watchdog telemetry and dashboard link.
  - `/next-steps`: Synthesizes 4 forward-looking implementation plans.
  - `/next-steps cancel`: Cancels an active synthesis turn.
- **Native Tools**: `qa_watchdog_status`, `qa_watchdog_audit`, `qa_watchdog_apply_fix`, `qa_watchdog_next_steps`, `qa_watchdog_cancel_synthesis`, `qa_watchdog_dashboard`.
- **Background Hook**: Automatically audits new commits on session `idle` in isolated worktrees.
- **Interactive Panel**: Companion dashboard server runs at `http://127.0.0.1:4198`.

---

## How It Works

- **Stop Hook**: When an agent finishes a turn and commits code, Watchdog detects the commit.
- **Isolated Worktree**: Audits run in detached worktrees under `~/.gemini/antigravity/qa_watchdog/worktrees/` so your working branch is never modified.
- **Fix Branch**: Reproducible test or lint fixes are committed to `fix/qa-<short_sha>`. Apply them to your working branch with one click in the panel or via CLI.
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

# Pause or resume background processing
python3 scripts/qa_ctl.py pause
python3 scripts/qa_ctl.py resume
```

---

## License

Apache-2.0
