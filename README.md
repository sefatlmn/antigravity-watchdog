# Watchdog

Post-commit QA auditing and next steps planning plugin for Google Antigravity and OpenCode Desktop.

Runs visual and code verification in isolated Git worktrees, tests UI in headless Playwright, records fixes to isolated `fix/qa-<sha>` branches, and proposes milestone-aligned next steps in a companion web panel.

## Requirements

- Python 3.10+
- Node.js 18+
- Git 2.30+
- Playwright (optional, required for browser test passes)

## Installation

### 1. Clone & Build

```bash
# Antigravity plugins directory
git clone git@github.com:sefatlmn/antigravity-watchdog.git ~/.gemini/config/plugins/qa-watchdog
cd ~/.gemini/config/plugins/qa-watchdog
npm install
npm run build
```

### 2. Antigravity Setup

The plugin is auto-discovered when located in `~/.gemini/config/plugins/qa-watchdog`.

To verify:
1. Open Antigravity Settings -> Plugins.
2. Ensure `qa-watchdog` is enabled.
3. The companion panel opens from the side pane or runs as a sidecar dashboard.

### 3. OpenCode Desktop Setup

Add the plugin directory to your `~/.config/opencode/opencode.json` (or project-level `opencode.json`):

```json
{
  "plugins": [
    "~/.gemini/config/plugins/qa-watchdog"
  ]
}
```

The plugin starts the local dashboard at `http://127.0.0.1:4198` and registers slash commands (`/watchdog`, `/next-steps`) and tools (`qa_watchdog_*`).

## How It Works

- **Stop Hook**: When an agent finishes a turn and commits code, Watchdog detects the commit.
- **Isolated Worktree**: Audits run in detached worktrees under `~/.gemini/antigravity/qa_watchdog/worktrees/` so your working branch is never modified.
- **Fix Branch**: Reproducible test or lint fixes are committed to `fix/qa-<short_sha>`. Apply them to your working branch with one click in the panel or via CLI.
- **Next Steps**: Synthesizes 4 forward-looking implementation plans in `.antigravity/next_steps/` based on repo goals, commits, and handoffs.

## Preventing Auto-Audits

Add any of these tags to your commit message to skip the QA watchdog:

- `[skip-qa]`
- `[auto-review]`
- `[qa-watchdog]`

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

## License

Apache-2.0
