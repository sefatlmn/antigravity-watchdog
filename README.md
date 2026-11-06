# Watchdog & Next Steps

Autonomous post-commit auditing, visual verification, and next-step synthesis for agentic code editors.

Watchdog works in isolated Git worktrees, so your working tree is never touched. When you ask it to audit a commit, it reviews the change, runs headless Playwright checks, and commits reproducible fixes to an isolated `fix/watchdog-<sha>` branch for you to apply. It also synthesizes 4 project-grounded, `/plan`-style implementation proposals.

Supported environments:

| Environment | What you get |
| :--- | :--- |
| **Google Antigravity** | Native plugin: Watchdog panel in the side pane, skills, agent rules |
| **Claude Code** | Native plugin: `/watchdog`, `/next-steps`, `/apply-fix` and `/goal` slash commands, an in-session audit agent, MCP server |
| **OpenCode Desktop** | Plugin with chat commands and agent tools |
| **Cursor & Windsurf** | stdio MCP server |
| **OpenAI Codex & custom agents** | CLI and agent rules |

You can use Claude Code and Antigravity side by side: both read and write the same Watchdog state, so an audit started in one shows up in the other.

---

## Requirements

- Python 3.10+
- Node.js 18+
- Git 2.30+
- Playwright MCP (optional, for the browser test pass)

---

## Install

### Claude Code

At the prompt of a Claude Code terminal session:

```text
/plugin marketplace add sefatlmn/antigravity-watchdog
/plugin install watchdog@watchdog-marketplace
```

From a shell:

```bash
claude plugin marketplace add sefatlmn/antigravity-watchdog
claude plugin install watchdog@watchdog-marketplace
```

In the Claude desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `sefatlmn/antigravity-watchdog`, then add the **watchdog** plugin.

### Google Antigravity

Clone the repository into Antigravity's plugins folder:

```bash
git clone https://github.com/sefatlmn/antigravity-watchdog.git ~/.gemini/config/plugins/watchdog
```

On Windows the folder is `%USERPROFILE%\.gemini\config\plugins\watchdog`.

Then open **Settings → Plugins**, make sure **Watchdog** is enabled, and open the Watchdog view from the side pane. To update later, run `git pull` in that folder.

### Both

Install it in each editor as above. The two installs share one state folder (see [Where things live](#where-things-live)).

---

## The Watchdog panel (Antigravity)

The panel is Antigravity's Watchdog view in the side pane. It has two tabs:

- **Audits:** the active repository and its latest commit, a button to audit it (with an optional focus note, or a note sent to an audit already running), recent audits with their verdicts, the report reader, one-click **Apply Fix**, and an archive.
- **Next Steps:** the project goal (edit it, or have Watchdog review the codebase and propose one), and 4 synthesized proposals, each with its plan and an **Execute in Agent** button.

Watchdog works on Git repositories only.

---

## Slash commands (Claude Code)

In Claude Code, Watchdog is a set of slash commands, run in the Git project the session is in:

- `/watchdog [status | audit [notes] | comment <notes> | continue [sha] | apply-fix [sha]]`
- `/next-steps [refresh | execute <1-4> | goal [text]]`
- `/apply-fix [sha]`
- `/goal [--refresh | --clear | <new goal text>]`

---

## Other editors

These use the universal package in `packages/universal`. Its built files are committed, so no build step is needed to use it. Below, replace `/path/to/antigravity-watchdog` with where you cloned the repository.

**Setup assistant:** run in your project to configure one editor, or all of them:

```bash
node /path/to/antigravity-watchdog/packages/universal/bin/watchdog.js setup all
```

**Cursor / Windsurf:** add the server to `.cursor/mcp.json` or your Windsurf MCP configuration:

```json
{
  "mcpServers": {
    "watchdog": {
      "command": "node",
      "args": ["/path/to/antigravity-watchdog/packages/universal/dist/mcp.js"]
    }
  }
}
```

**Claude Code, MCP server only** (without the plugin's commands and audit agent):

```bash
claude mcp add watchdog node /path/to/antigravity-watchdog/packages/universal/dist/mcp.js
```

**OpenCode Desktop:** add the package to `~/.config/opencode/opencode.json` (or a project-level `opencode.json`):

```json
{
  "plugins": ["/path/to/antigravity-watchdog/packages/universal"]
}
```

`packages/opencode` is a legacy alias of `packages/universal`.

**OpenAI Codex:** add the guidelines in `packages/universal/templates/codex/CODEX.md` to your repository's `CODEX.md` or `AGENTS.md`.

---

## MCP tools

| Tool | Description |
| :--- | :--- |
| `watchdog_status` | Repository status, recent audit verdicts, active jobs, and fix branches |
| `watchdog_audit` | Queue a code & visual review in an isolated Git worktree |
| `watchdog_apply_fix` | Apply verified fixes from a `fix/watchdog-<sha>` branch onto the working branch |
| `watchdog_next_steps` | Synthesize 4 project-grounded implementation plans |
| `watchdog_execute_plan` | Get the full specification prompt for an approved plan |
| `watchdog_goal` | Inspect, set, or clear the repository milestone goal |
| `watchdog_comment` | Send guidance to an in-progress audit |
| `watchdog_continue` | Resume an interrupted audit, or pick up a finished report |
| `watchdog_cancel_synthesis` | Cancel an ongoing Next Steps synthesis |

MCP prompts: `watchdog_audit` (instructions for reviewing commits) and `watchdog_next_steps` (instructions for evaluating and executing plans).

---

## CLI

From the repository root:

```bash
# Status and latest verdicts (add --json for machine-readable output)
./packages/universal/bin/watchdog.js status

# Audit HEAD in an isolated worktree, with a focus note
./packages/universal/bin/watchdog.js audit "Focus on state persistence and edge cases"

# Apply confirmed fixes from fix/watchdog-<sha> to the working branch
./packages/universal/bin/watchdog.js apply-fix <sha>

# Synthesize and show 4 implementation proposals; print plan 1's specification
./packages/universal/bin/watchdog.js next-steps
./packages/universal/bin/watchdog.js plan 1

# Inspect or set the project milestone goal
./packages/universal/bin/watchdog.js goal --set "Ship production v2 release"

# Start the MCP stdio server
./packages/universal/bin/watchdog.js mcp
```

The panel's web UI can also run on its own, outside any editor:

```bash
node sidecars/panel/main.mjs
```

It prints a `WATCHDOG_PANEL_URL=…` line to open in a browser.

---

## How it works

- **Isolated worktree:** each audit runs in a detached worktree. Your working tree, uncommitted edits, and running dev servers are left alone.
- **Fix branch:** reproducible fixes are committed to `fix/watchdog-<short_sha>`. Apply them with **Apply Fix**, `/apply-fix`, or `apply-fix`.
- **Agents:** Antigravity runs audits and syntheses as new agent conversations.

  In Claude Code, `/watchdog audit` starts the audit as a background subagent of your session (`watchdog:watchdog-auditor`), on your existing sign-in. `/next-steps refresh` synthesizes proposals locally, and `/next-steps execute <n>` hands the plan to Claude in the main chat, with your usual permissions. The audit agent may only do what an audit needs; the plugin refuses everything else, without changing your permission settings:
  - **Audit:** read files; edit only in its isolated worktree and the repository's `.antigravity/audits/`; read-only git, plus `git add` and `git commit` in the worktree; test, lint, typecheck, build and dev-server commands (npm, pnpm, yarn, npx, pytest, cargo, go); the Playwright MCP tools; and reporting back to Watchdog.

  It may not push, install packages, use the network, or delete files. An audit agent that stops without reporting is marked interrupted, and `/watchdog continue` starts it again.

  Outside Claude Code (Cursor, the CLI), Watchdog falls back to background `claude -p` sessions with the same limits. Those need the `claude` CLI to be signed in; set `WATCHDOG_CLAUDE_BACKGROUND=0` to turn them off.
- **Next Steps:** proposals and plans are written to `.antigravity/next_steps/` in your repository, based on its docs, recent commits, and goal.

### Where things live

- Watchdog state, logs and worktrees: `~/.gemini/antigravity/watchdog/` (set `ANTIGRAVITY_APP_DATA_DIR` to move the parent folder). Both editors use it.
- Audit reports: `.antigravity/audits/review-<short_sha>.md` in your repository.

### Everything runs when you ask

Watchdog never acts on its own. Audits start from the panel's audit button, `/watchdog audit`, the `watchdog_audit` MCP tool, or the CLI's `audit`; Next Steps refresh from the panel's button or `/next-steps refresh`, and the project goal from the panel's review button.

Watchdog does not audit commits whose message contains any of these tags (its own fix commits carry them):

- `[skip-watchdog]`
- `[auto-review]`
- `[watchdog]`

---

## Repository layout

One codebase serves every host:

- `scripts/watchdog_ctl.py`: the controller, used by every host.
- `sidecars/panel/`: the panel. `main.mjs` is the panel server (Antigravity's `sidecar_sdk` inside Antigravity, the bundled `standalone_sdk.mjs` anywhere else). `view-model.js` holds the panel's decisions (badges, button states). `index.html`, `app.js` and `styles.css` are the web panel.
- `hooks/agents.ts`: the Claude Code audit agent in the session, and its permissions.
- `plugin.json`, `rules/`: the Antigravity plugin. `.claude-plugin/`, `hooks/hooks.json`, `.mcp.json`, `commands/`, `agents/`: the Claude Code plugin. `skills/` serves both.
- `packages/universal/`: MCP server, CLI, and OpenCode plugin.

To run the tests and typecheck: `npm test && npm run typecheck` (or `claude plugin test .` inside Claude Code).

---

## License

Apache-2.0
