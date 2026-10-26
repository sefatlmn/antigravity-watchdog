# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Antigravity developers running autonomous coding sessions who need non-intrusive background audits and structured next-step implementation plans without leaving the IDE.

## Product Purpose

Autonomous post-commit code review, visual verification, and sequential next-step synthesis. Watchdog operates non-intrusively in isolated Git worktrees and presents actionable findings, verified fixes, and `/plan`-compliant implementation roadmaps directly inside the Antigravity auxiliary pane.

## Positioning

Zero-friction assurance and intelligent momentum. Unlike static linters, detached external CI dashboards, or intrusive modal blockers, Watchdog:
- Listens to coding agent stop events and audits committed snapshots in isolated Git worktrees using Playwright MCP.
- Commits verified bug fixes directly to isolated `fix/qa-<short_sha>` branches for one-click application to the active branch.
- Inspects repository state, commit history, and linked conversations to synthesize 4 structured Next Steps proposals adhering to the official `/plan` standard.

## Operating Context

- **Environment:** Antigravity IDE right-side auxiliary pane webview (`sidecar://qa-watchdog/panel/`).
- **Runtime:** Background Node.js sidecar service communicating with local Git CLI, Antigravity Language Server, and AgentAPI.
- **Workflow:** Developers write code and commit changes; Watchdog transparently evaluates quality in the background, updates status in the aux pane, and supplies the next 4 actionable steps to sustain project velocity.

## Capabilities and Constraints

- **Dual-Pane Navigation:** Seamless switching between `Audits` (commit verification, manual audit triggers, interactive report reader, 1-click cherry-pick fix application, and collapsible archive stack) and `Next Steps` (goal discovery and editing, project conversation tracking, and 4 structured implementation proposals).
- **Zero Active-Tree Disruption:** Audits and fix commits execute in isolated worktrees (`~/.gemini/antigravity/qa_watchdog/worktrees/`), ensuring active files, uncommitted edits, and running dev servers are never disturbed.
- **Visual Studio Aesthetics:** Prominent status banners, spacious proposal cards, rich metadata chips, and expansive layout spacing suited for deep inspection.
- **Clean Iconography:** Strict zero-emoji policy; uses lightweight inline vector SVGs and clean semantic text labels.
- **Adherence to `/plan` Standard:** Synthesized proposals conform to Antigravity's `/plan` structure with categorized milestones, affected files, task checkboxes, and automated verification plans.

## Brand Commitments

- **Tone & Identity:** Professional, trustworthy, modern visual studio tool.
- **Visual Language:** Dark-mode native palette, calibrated accent colors (emerald for passes/fixes, amber for warnings, blue for milestones/actions), crisp vector SVGs, and zero emoji glyphs.

## Evidence on Hand

- **Core Plugin Codebase:** `plugin.json`, `hooks.json`, `scripts/qa_ctl.py`, `scripts/qa_stop_hook.py`.
- **Sidecar Web Panel:** `sidecars/panel/main.mjs`, `index.html`, `app.js`, `styles.css`.
- **Skills & Rules:** `skills/watchdog/SKILL.md`, `skills/next-steps/SKILL.md`, `rules/AGENTS.md`.
- **Active Repositories & Audits:** Validated in live environments including `elegant-bose` and `halftone` with verified Playwright test suites and audit records in `.antigravity/audits/`.

## Product Principles

1. **Non-Intrusive by Default:** Never interrupt active work or pollute the working branch; all audits and fixes remain sandboxed until explicitly approved.
2. **One-Click Resolution:** Identifying issues is only valuable when fixing them is instantaneous. Provide ready-to-merge fix branches and 1-click `/plan` agent execution prompts.
3. **Visual Studio Polish:** Prioritize spacious visual hierarchy, clear status banners, and intuitive controls so complex audit results and multi-step proposals can be scanned and acted on effortlessly.
4. **Context-Aware Continuity:** Anchor next steps in real repository goals, commit deltas, and multi-conversation history rather than disconnected suggestions.

## Accessibility & Inclusion

- Keyboard navigability across tabs, buttons, accordion disclosures, and modal dialogs.
- Clear ARIA roles (`tablist`, `tab`, `tabpanel`, `aria-selected`, `aria-controls`).
- High-contrast text tokens meeting WCAG AA standards in dark mode.
