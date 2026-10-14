# Watchdog (`antigravity-watchdog`)

Autonomous post-commit code review, visual verification, and next steps planning plugin for Google Antigravity.

Watchdog monitors active coding turns in real time, dispatches independent post-commit code and visual audits in isolated Git worktrees, tests UI flows in a live browser via Playwright, self-heals reproducible bugs onto dedicated fix branches, and synthesizes structured implementation proposals for upcoming milestones.

---

## Key Features

- **Autonomous Lifecycle Hook**: Listens to the agent lifecycle `Stop` event. Once an agent completes a task and commits changes, Watchdog inspects the repository diff without human intervention.
- **Isolated Git Worktrees**: Every audit is executed in a detached, isolated worktree (`~/.gemini/antigravity/qa_watchdog/worktrees/`). Your primary branch, active working tree, and running dev servers are never touched or interrupted.
- **Multi-Viewport Browser Testing**: Automatically launches a headless test server on a free port and inspects desktop (1440x900) and mobile (390x844) viewports using Playwright to detect layout shifts, broken interactions, console errors, and network issues.
- **Self-Healing Fix Branches**: Reproducible test failures and lint regressions are fixed and committed directly to an isolated branch (`fix/qa-<short_sha>`) with one-click cherry-pick application into your working branch.
- **Autonomous Next Steps Planning**: Scans project context, goals, and recent commits to generate up to 4 structured implementation proposals adhering to the official Antigravity `/plan` standard.
- **Companion Sidecar Web Panel**: A right-hand sidebar UI panel providing live watchdog telemetry, audit summaries, one-click fix application, goal configuration, and proposal execution.

---

## Architecture Overview

```
                                [Antigravity Agent Turn]
                                            │
                                            ▼ (commit)
                              [Lifecycle Hook: Stop Event]
                                            │
                    ┌───────────────────────┴───────────────────────┐
                    ▼                                               ▼
       [Isolated Worktree Spawn]                        [Context Synthesis]
        fix/qa-<short_sha>                               Goal & Milestone Audit
                    │                                               │
                    ▼                                               ▼
    [Playwright MCP & Static Suite]                   [4 Structured Next Steps Plans]
   Desktop / Mobile / Unit / Lint                    .antigravity/next_steps/plan-*.md
                    │                                               │
                    ▼                                               ▼
      [Commit Fixes & Write Report]                    [Expose in Companion Panel]
   .antigravity/audits/review-<sha>.md                  Audit Logs & Proposal Action
```

---

## Installation

Clone this repository into your Antigravity plugins directory:

```bash
cd ~/.gemini/config/plugins
git clone git@github.com:sefatlmn/antigravity-watchdog.git qa-watchdog
```

Ensure the plugin is enabled in your Antigravity configuration or via the Plugins menu.

### Dependencies

- **Python 3.10+**: Runs the lifecycle stop hook and orchestration CLI (`scripts/qa_stop_hook.py`, `scripts/qa_ctl.py`).
- **Node.js 18+**: Powers the sidecar companion panel server (`sidecars/panel/main.mjs`) and OpenCode V2 TypeScript plugin engine.
- **Playwright MCP**: Optional but recommended for visual regression and live browser verification passes.

---

## OpenCode Desktop Integration

Watchdog is built as a **dual-target hybrid plugin**, simultaneously compatible with **Google Antigravity** and **OpenCode Desktop** from a single codebase.

### Enabling in OpenCode Desktop

Add the plugin path to your `~/.config/opencode/opencode.json` (or project-level `opencode.json`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/Users/sefa/.gemini/config/plugins/qa-watchdog"
  ]
}
```

Or build and link via npm/CLI:
```bash
npm run build
```

### Features in OpenCode Desktop

1. **Slash Commands**:
   - `/watchdog`: Displays the active Watchdog telemetry, tracked repositories, and link to the local dashboard.
   - `/next-steps`: Gathers project context across handoffs, manifests, READMEs, and Git commits to synthesize 4 `/plan` proposals.

2. **Native Tools**:
   - `qa_watchdog_status`: Returns current watchdog state, jobs, and proposals.
   - `qa_watchdog_audit`: Prepares an isolated worktree (`fix/qa-<sha>`) and launches an audit for a commit.
   - `qa_watchdog_apply_fix`: Merges/cherry-picks bug fixes from `fix/qa-<sha>` onto the active branch.
   - `qa_watchdog_next_steps`: Synthesizes 4 forward-looking implementation plans.
   - `qa_watchdog_dashboard`: Surfaces the local dashboard URL.

3. **Background Lifecycle Event Hook**:
   - Subscribes to OpenCode's `session.status` stream. When a turn reaches `idle`, Watchdog automatically checks for new commits and runs the non-blocking post-commit QA audit in an isolated worktree.

4. **Interactive Dashboard**:
   - A standalone dashboard server starts automatically on `http://127.0.0.1:4198` when OpenCode launches, serving the full companion UI panel.

---

## Companion Panel

The Watchdog companion panel runs as an Antigravity auxiliary web sidecar and provides a clean, two-tab command bridge:

1. **Audits Tab**:
   - Status toggle: Pause or resume automatic background audits with one click.
   - Latest commit monitor with active branch tracking.
   - Manual audit trigger with optional focus notes/comments.
   - Recent audits list with test verdicts, summaries, and fix status.
   - One-click fix cherry-picking (`Apply Fix to <branch>`).
   - Integrated markdown report viewer with one-click export to active conversation.
   - Collapsible audit archive with instant restore.

2. **Next Steps Tab**:
   - Project Goal banner with automatic detection from `README.md` and inline custom override editor.
   - 4 project-tailored proposals with dynamic, content-driven tags (e.g. Feature, UI, Workflow, Performance, CLI, API, Tooling), difficulty, and estimated durations.
   - Clean, unified single-paragraph descriptions with key objective checklists and affected file tags.
   - Inline plan reader modal for full architectural specifications.
   - One-click `"Execute in Agent"` dispatch button.

---

## Configuration & Conventions

### Ignoring Commits
Commits containing any of the following tags in the commit subject are automatically ignored by the background watchdog to prevent recursive review loops:
- `[skip-qa]`
- `[auto-review]`
- `[qa-watchdog]`

Conversations containing `[NEXT-STEPS-SESSION]` or `[QA-WATCHDOG-SESSION]` also bypass triggering.

### CLI Management
You can manually interact with the Watchdog engine via the included CLI:

```bash
# Check watchdog status and queue
python3 scripts/qa_ctl.py status

# Trigger a manual audit on the youngest commit
python3 scripts/qa_ctl.py run --repo /path/to/project

# Apply an isolated bug fix commit to active branch
python3 scripts/qa_ctl.py apply-fix --repo /path/to/project --sha <short_sha>

# Pause or resume background processing
python3 scripts/qa_ctl.py pause
python3 scripts/qa_ctl.py resume
```

---

## Design System

The Watchdog companion interface is built according to the **Command Bridge** design system, adhering to strict `/impeccable` tokens:
- High-contrast, dark-mode color palette (`#0b0f19` canvas, `#131b2e` surface cards, `#2563eb` primary actions, `#38bdf8` telemetry cyan, `#10b981` radar emerald).
- Normalized action controls across cards (`--card-action-height: 26px`, `--card-action-gap: 6px`, `--card-action-radius: 5px`).
- Pure vector iconography (inline SVG, zero external icon font dependencies, zero emojis).
- Full keyboard navigation and escape/backdrop modal dismissal.

---

## License

Apache-2.0
