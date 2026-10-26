# Watchdog & Next Steps

Autonomous post-commit auditing, visual verification, and sequential next-step synthesis across agentic code editors.

Watchdog operates non-intrusively in isolated Git worktrees. It verifies code correctness, executes headless Playwright passes, commits reproducible fixes to isolated `fix/watchdog-<sha>` branches, and synthesizes 4 project-grounded `/plan`-compliant implementation plans.

Supported environments:
- **Google Antigravity**: Native plugin with visual companion panel, lifecycle hooks, and skills.
- **Claude Code**: Native plugin (`.claude-plugin/plugin.json`) with live Sidepanel UI (`sidecars/panel/`), automatic `SessionStart` & `Stop` hooks, subagents, slash commands (`/panel`, `/watchdog`, `/next-steps`, `/apply-fix`, `/goal`), and MCP server — 100% shared codebase with Antigravity.
- **OpenCode Desktop**: Native plugin with chat commands and agent tools (backwards-compatible).
- **Cursor & Windsurf**: Standard stdio MCP integration.
- **OpenAI Codex & Custom Agents**: Structured CLI tools and agent rules.

---

## Requirements

- Python 3.10+
- Node.js 18+
- Git 2.30+
- Playwright (optional, required for browser test passes)

---

## Installation

### Method 1: Google Antigravity (Companion Panel)

Clone the repository into your Antigravity plugins directory:

```bash
git clone git@github.com:sefatlmn/antigravity-watchdog.git ~/.gemini/config/plugins/watchdog
```

To enable:
1. Open Antigravity Settings -> Plugins.
2. Ensure Watchdog is enabled.
3. The companion panel opens from the side pane or runs as a sidecar dashboard.

The repository root is a native Antigravity plugin containing lifecycle hooks (`hooks.json`), agent rules (`rules/AGENTS.md`), agent skills (`skills/`), and the webview panel (`sidecars/panel/`).

---

### Method 2: Universal Agentic Edition (Claude Code, Cursor, Codex, OpenCode)

Build the universal package:

```bash
cd packages/universal
npm install
npm run build
```

#### Automated Setup Assistant

Run the built-in setup wizard in your target repository:

```bash
node ~/.gemini/config/plugins/watchdog/packages/universal/bin/watchdog.js setup [claude|cursor|opencode|codex|all]
```

---

### Editor Integrations

#### 1. Claude Code (Native Plugin + Sidepanel UI)

The repository root is a native Claude Code plugin sharing the exact same codebase, skills, hooks, controller, and live Sidepanel UI (`sidecars/panel/`) as Antigravity.

**Option A — Launch directly with `--plugin-dir`:**

```bash
claude --plugin-dir ~/.gemini/config/plugins/watchdog
```

**Option B — Install via Claude Code Plugin Marketplace:**

Inside Claude Code, run:

```text
/plugin marketplace add ~/.gemini/config/plugins/watchdog
/plugin install watchdog@watchdog-local
```

When a Claude Code session starts (`SessionStart` hook), Watchdog automatically launches the shared Sidepanel UI daemon on `http://127.0.0.1:4891` and opens a right-docked companion window synced to your active repository. When a turn finishes (`Stop` hook), Watchdog inspects new commits and dispatches isolated Git worktree audits and Next Steps synthesis automatically.

Commands available in Claude Code:
- `/panel` (or `/watchdog:panel`): Launch or focus the live Watchdog Sidepanel UI window.
- `/watchdog` (or `/watchdog:watchdog`): Review status, trigger audits, forward notes to active auditors, or apply fixes.
- `/next-steps` (or `/watchdog:next-steps`): Synthesize 4 `/plan`-compliant proposals or execute a plan.
- `/apply-fix` (or `/watchdog:apply-fix`): Cherry-pick verified fixes from an isolated `fix/watchdog-<sha>` branch.
- `/goal` (or `/watchdog:goal`): Inspect, set, or clear the repository milestone goal.

*(Optional Standalone MCP setup)*: If you prefer registering only the MCP server without the full plugin:

```bash
claude mcp add watchdog node ~/.gemini/config/plugins/watchdog/packages/universal/dist/mcp.js
```

#### 2. Cursor / Windsurf

Add the server to `.cursor/mcp.json` or your Windsurf MCP configuration:

```json
{
  "mcpServers": {
    "watchdog": {
      "command": "node",
      "args": [
        "/Users/sefa/.gemini/config/plugins/watchdog/packages/universal/dist/mcp.js"
      ]
    }
  }
}
```

#### 3. OpenCode Desktop

Add the package path to `~/.config/opencode/opencode.json` (or project-level `opencode.json`):

```json
{
  "plugins": [
    "/Users/sefa/.gemini/config/plugins/watchdog/packages/universal"
  ]
}
```

Existing configurations pointing to `/Users/sefa/.gemini/config/plugins/watchdog/packages/opencode` continue to resolve through the backwards-compatible symlink.

#### 4. OpenAI Codex & Agent Rules

Add the guidelines in `packages/universal/templates/codex/CODEX.md` to your repository's `CODEX.md` or `AGENTS.md`.

---

## Universal MCP Tools Reference

When connected via MCP, the following tools are available to agents:

| Tool | Description |
| :--- | :--- |
| `watchdog_status` | Inspect repository status, recent audit verdicts, active jobs, and fix branches |
| `watchdog_audit` | Queue an autonomous code & visual review in an isolated Git worktree |
| `watchdog_apply_fix` | Apply verified fixes from an isolated `fix/watchdog-<sha>` branch onto the working branch |
| `watchdog_next_steps` | Synthesize 4 project-grounded next-step implementation plans adhering to `/plan` |
| `watchdog_execute_plan` | Retrieve the full specification prompt for an approved next-step implementation plan |
| `watchdog_goal` | Inspect, set, or clear the repository milestone goal |
| `watchdog_comment` | Send guidance or focus notes to an in-progress Watchdog audit |
| `watchdog_continue` | Resume an interrupted audit or check completed audit report |
| `watchdog_cancel_synthesis` | Cancel an ongoing next-steps synthesis turn |
| `watchdog_open_panel` | Launch and open the live Watchdog Sidepanel UI for the current repository |

MCP Prompts exposed:
- `watchdog_audit`: Instructions and testing guidelines for reviewing commits.
- `watchdog_next_steps`: Instructions for evaluating and executing proposed implementation plans.

---

## Universal CLI Usage

You can execute Watchdog directly from the command line or scripts:

```bash
# Check status and latest verdicts
./packages/universal/bin/watchdog.js status

# Machine-readable JSON output
./packages/universal/bin/watchdog.js status --json

# Trigger an audit on HEAD in an isolated worktree
./packages/universal/bin/watchdog.js audit "Focus on state persistence and edge cases"

# Apply confirmed fixes from fix/watchdog-<sha> to working branch
./packages/universal/bin/watchdog.js apply-fix <sha>

# Synthesize and display 4 structured implementation proposals
./packages/universal/bin/watchdog.js next-steps

# Display approved implementation plan specification for agent execution
./packages/universal/bin/watchdog.js plan 1

# Inspect or set project milestone goal
./packages/universal/bin/watchdog.js goal --set "Ship production v2 release"

# Open the live Watchdog Sidepanel UI
./packages/universal/bin/watchdog.js panel

# Start the MCP stdio server
./packages/universal/bin/watchdog.js mcp
```

---

## How It Works

- **Isolated Worktree**: Audits run in detached worktrees under `~/.gemini/antigravity/watchdog/worktrees/`. The agent's working tree is never touched during reviews.
- **Fix Branch**: Reproducible test or lint fixes are committed to `fix/watchdog-<short_sha>`. Apply them cleanly using `apply-fix` or the UI companion panel.
- **Next Steps**: Synthesizes 4 forward-looking implementation plans in `.antigravity/next_steps/` based on repo goals, commits, and handoffs, strictly following the `/plan` methodology.

---

## Preventing Auto-Audits

Include any of these tags in your commit message to skip background Watchdog execution:

- `[skip-watchdog]`
- `[auto-review]`
- `[watchdog]`

---

## License

Apache-2.0
