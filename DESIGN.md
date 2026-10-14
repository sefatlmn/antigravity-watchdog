---
name: Watchdog
description: Autonomous post-commit code & visual watchdog with intelligent next steps planning
colors:
  primary: "#2563eb"
  primary-hover: "#3b82f6"
  telemetry-cyan: "#38bdf8"
  radar-emerald: "#10b981"
  signal-amber: "#f59e0b"
  danger-rose: "#ef4444"
  canvas-obsidian: "#0b0f19"
  surface-midnight: "#131b2e"
  surface-well: "#000000"
  neutral-fg: "#f8fafc"
  neutral-body: "#e2e8f0"
  neutral-muted: "#94a3b8"
  neutral-subtle: "#64748b"
  border-default: "rgba(255, 255, 255, 0.08)"
  border-active: "rgba(255, 255, 255, 0.16)"
typography:
  headline:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "ui-monospace, Menlo, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.03em"
rounded:
  sm: "4px"
  action: "5px"
  md: "6px"
  card: "8px"
  modal: "10px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
  xxl: "16px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.neutral-fg}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.neutral-fg}"
    rounded: "{rounded.md}"
    padding: "4px 9px"
  card-action-btn:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.neutral-fg}"
    rounded: "{rounded.action}"
    height: "26px"
    padding: "0 12px"
  card-action-icon-btn:
    backgroundColor: "transparent"
    textColor: "{colors.neutral-muted}"
    rounded: "{rounded.action}"
    height: "26px"
    width: "26px"
  applied-badge:
    backgroundColor: "rgba(16, 185, 129, 0.1)"
    textColor: "{colors.radar-emerald}"
    rounded: "{rounded.action}"
    height: "26px"
    padding: "0 8px"
  card:
    backgroundColor: "{colors.surface-midnight}"
    rounded: "{rounded.card}"
    padding: "10px 12px"
  pill-ok:
    backgroundColor: "rgba(16, 185, 129, 0.12)"
    textColor: "{colors.radar-emerald}"
    rounded: "{rounded.pill}"
    padding: "3px 9px"
---

# Design System: Watchdog

## Overview

**Creative North Star: "The Command Bridge"**

The Command Bridge design system embodies the calm, unyielding focus of a modern aerospace flight deck. Designed specifically for Google Antigravity developers running autonomous coding sessions, it delivers critical repository telemetry, automated verification verdicts, and forward-looking implementation plans with instantaneous legibility and zero visual noise.

Surfaces rest on a deep obsidian canvas (`#0b0f19`), layered with crisp midnight cards (`#131b2e`) and delineated by hairline translucent borders. High-chroma telemetry cyan (`#38bdf8`) and radar emerald (`#10b981`) illuminate key commit hashes, branch tags, and verified bug fixes. In accordance with user direction, the interface is flat and disciplined, relying on surface tone stepping and border precision rather than heavy drop shadows, decorative glows, or toy-like emoji glyphs.

**Key Characteristics:**
- **Flat Spatial Geometry:** Clean, planar surfaces at rest; borders carry structural separation.
- **Instrument-Grade Telemetry:** Monospace identifiers and status indicators designed for immediate scanning.
- **Vector-Only Iconography:** 100% lightweight inline SVGs matching exact font size and stroke weights.
- **Instantaneous Feedback:** Restrained 150ms transitions with zero bounce or spring artifacts.

## Colors

A calibrated dark-mode palette balancing deep obsidian tones with functional, high-visibility telemetry signals.

### Primary
- **Action Blue** (`#2563eb`): Primary trigger actions and high-priority commitments.
- **Action Blue Hover** (`#3b82f6`): Interactive hover feedback for primary buttons and focus rings.

### Secondary
- **Telemetry Cyan** (`#38bdf8`): Monospace commit SHAs, active process telemetry, and conversation tags.
- **Radar Emerald** (`#10b981`): Verified QA test passes, applied fixes, and active watchdog status beacons.

### Tertiary
- **Signal Amber** (`#f59e0b`): Warning states, documentation-only commit notices, and paused background status.
- **Danger Rose** (`#ef4444`): Destructive reset actions, failed audits, and network error alerts.

### Neutral
- **Obsidian Canvas** (`#0b0f19`): Main panel background canvas.
- **Midnight Surface** (`#131b2e`): Elevated cards, audit items, and proposal modules.
- **Content Well** (`rgba(0, 0, 0, 0.22)`): Inset code blocks, commit detail rows, and goal quotes.
- **Foreground Primary** (`#f8fafc`): Headings, active tabs, and primary readable copy.
- **Foreground Body** (`#e2e8f0`): Summary prose, descriptions, and proposal narratives.
- **Foreground Muted** (`#94a3b8`): Metadata labels, relative timestamps, and secondary controls.
- **Border Default** (`rgba(255, 255, 255, 0.08)`): Standard structural surface outlines.
- **Border Active** (`rgba(255, 255, 255, 0.16)`): Hovered cards, focused inputs, and active interactive borders.

### Named Rules
**The Beacon Accent Rule.** Vibrant blue (`#2563eb`) and telemetry cyan (`#38bdf8`) are strictly reserved for actionable triggers and live commit telemetry. They are never used as full decorative background fills for passive cards or containers.

**The Semantic Status Rule.** Colors have unambiguous roles: green means verified/applied; amber means caution/docs-only; cyan means live/running. Neutral cards never adopt semantic border colors unless actively communicating state.

## Typography

The typography pairs Apple/System UI sans-serif for UI labels and prose with clean monospace for Git telemetry and code paths. The system employs a disciplined 6-step modular scale tuned for high-density auxiliary pane workflows with tabular-numeric alignment.

**Display/Body Font:** `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif`  
**Telemetry/Mono Font:** `ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`

### Modular Hierarchy
- **Major Display / Markdown H1** (SemiBold 600, 16px, line-height 1.25, tracking -0.02em): Modal report headers.
- **Panel Header / Markdown H2** (SemiBold 600, 14px, line-height 1.35, tracking -0.01em): Panel title (`Watchdog`), modal sections.
- **Card Title / Markdown H3** (SemiBold 600, 13px, line-height 1.35, tracking -0.005em): Card titles, repo name, proposal titles.
- **Body / Prose** (Regular 400, 12px, line-height 1.55, text-wrap pretty): Proposal summaries, goal statements, and report markdown.
- **Control / Label** (Medium 500 / SemiBold 600, 12px / 11px, line-height 1.25): Tab labels, primary/secondary buttons, input placeholders.
- **Telemetry & Hashes** (SemiBold 600 / Medium 500, 11px, tracking 0.01em, tabular-nums): Commit SHAs, branch tags, file chips, and timestamps.
- **Micro-Badges & Tags** (SemiBold 600, 10px, uppercase, tracking 0.03em, tabular-nums): Status pills, difficulty tags, tab counters.

### Named Rules
**The Monospace Discipline Rule.** Monospace typography is strictly reserved for Git commit hashes, branch names, file paths, and execution commands. Standard UI copy and headings must always use the system sans-serif stack.

**The Tabular Alignment Rule.** All numerical readouts—including commit timestamps, estimated durations (`~20m`), badge counts, and Git commit hashes—must declare `font-variant-numeric: tabular-nums` to maintain pixel-perfect vertical alignment and eliminate jitter during live telemetry refreshes.

**The Themed Surface Rule.** Browser defaults for text selection (`::selection`), focus rings (`:focus-visible`), caret colors, and scrollbars are explicitly styled to match the dark Command Bridge palette (`#38bdf8` caret/focus, translucent selection, thin 5px rounded scrollbars).

## Layout

The layout is built for the Antigravity auxiliary right-hand pane, constrained to a maximum width of `640px` with fluid responsiveness down to `300px`.

- **Panel Container:** Single column `flex-direction: column` with uniform `--gap: 10px` and `padding: 12px 14px`.
- **Dual Tab Switcher:** Segmented control spanning 100% container width with equal-width tab buttons (`flex: 1`).
- **Cards:** Self-contained modules with internal `padding: 10px 12px` and `gap: 8px`.
- **Rhythm:** Elements within cards space at `4px` or `6px`; top-level cards space at `10px`.

## Elevation & Depth

Per user direction, the system is **flat with minimal shadows and glow**. Depth is communicated through stepped background luminosity, subtle 1px border contrasts, and inset content wells rather than diffuse drop shadows.

- **Canvas Level:** `#0b0f19` (lowest layer).
- **Surface Level:** `#131b2e` with `border: 1px solid rgba(255, 255, 255, 0.08)`.
- **Inset Well Level:** `rgba(0, 0, 0, 0.22)` with `border: 1px solid rgba(255, 255, 255, 0.04)`.
- **Modal Overlay:** `background: rgba(0, 0, 0, 0.75)` with `backdrop-filter: blur(4px)`.

### Shadow Vocabulary
- **Resting Surfaces:** `box-shadow: none;` (strict flat invariant).
- **Active Tab Pill:** `box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3)` (slight grounding contrast).
- **Modal Dialog:** `box-shadow: 0 12px 36px rgba(0, 0, 0, 0.6)` (depth isolation).
- **Status Dot Pulse:** `box-shadow: 0 0 6px #10b981` (active beacon indicator).

### Named Rules
**The Flat Horizon Rule.** Surfaces are planar and flat at rest. Structural hierarchy is communicated exclusively through surface luminance stepping and 1px translucent borders, never decorative drop shadows.

## Shapes

The form language balances technical precision with subtle corner softening:

- **Compact Elements (Tags, File Chips):** `border-radius: 4px` (`{rounded.sm}`).
- **Card Action Controls (Buttons, Badges):** `border-radius: 5px` (`{rounded.action}`).
- **Interactive Controls (Buttons, Inputs, Tabs):** `border-radius: 6px` (`{rounded.md}`).
- **Surface Containers (Cards, Wells):** `border-radius: 8px` (`{rounded.card}`).
- **Floating Modals:** `border-radius: 10px` (`{rounded.modal}`).
- **Status Pills & Count Badges:** `border-radius: 999px` (`{rounded.pill}`).

## Components

### Primary Buttons
- **Shape:** Soft rectangular (`border-radius: 6px`).
- **Primary:** Background `{colors.primary}` (`#2563eb`), text `#ffffff`, padding `8px 14px`, font weight 600.
- **Hover / Focus:** Lightens background via color-mix (`#3b82f6`), outline none, active transforms `translateY(1px)`.
- **Disabled:** Background `rgba(255, 255, 255, 0.08)`, color `#94a3b8`, cursor `not-allowed`.

### Secondary & Action Buttons
- **Secondary:** Transparent background, `border: 1px solid rgba(255, 255, 255, 0.12)`, text `#f8fafc`, padding `4px 9px`.
- **Accent (Apply Fix):** Background `rgba(56, 189, 248, 0.18)`, border `rgba(56, 189, 248, 0.35)`, color `#38bdf8`.
- **Warning (Docs Only):** Background `rgba(245, 158, 11, 0.14)`, border `rgba(245, 158, 11, 0.35)`, color `#fbbf24`.

### Card Action Buttons (Unified Token System)
All interactive controls and state tags within card footers (`.job-actions` on Audits and `.proposal-actions` on Next Steps) are strictly normalized to a shared design system:
- **Unified Height:** Exactly `26px` (`--card-action-height: 26px`) across status tags (`.applied-badge`), utility icon buttons (`.job-report-btn`, `.job-archive-btn`, `.proposal-plan-btn`), and execution triggers (`.primary-btn`, `.accent-btn`).
- **Unified Inter-Action Spacing:** Normalized to `6px` (`--card-action-gap: 6px`) in all card action containers.
- **Unified Geometry:** `border-radius: 5px` (`--card-action-radius: 5px`) and `box-sizing: border-box`.
- **Vertical Centering & Alignment:** Single-line flex layout (`display: inline-flex; align-items: center; justify-content: center; line-height: 1;`) ensuring pixel-perfect baseline and horizontal symmetry across both panes.

### Status Pills
- **Style:** Fully pill-shaped (`border-radius: 999px`), padding `3px 9px`, font size `11px`, font weight 500.
- **Active / Ok:** Background `rgba(16, 185, 129, 0.12)`, border `rgba(16, 185, 129, 0.25)`, color `#34d399`, with a `6px` solid emerald dot.
- **Warning:** Background `rgba(245, 158, 11, 0.12)`, border `rgba(245, 158, 11, 0.25)`, color `#fbbf24`.

### Segmented Tab Switcher
- **Container:** Background `rgba(255, 255, 255, 0.04)`, padding `3px`, border `1px solid rgba(255, 255, 255, 0.06)`, radius `8px`.
- **Tab Item:** Equal flex width (`flex: 1`), padding `6px 10px`, transparent background, text `#94a3b8`.
- **Active State:** Background `#131b2e`, text `#f8fafc`, font weight 600, grounded by `0 1px 3px rgba(0, 0, 0, 0.3)`.

### Cards & Wells
- **Card:** Background `#131b2e`, border `1px solid rgba(255, 255, 255, 0.08)`, radius `8px`, padding `10px 12px`.
- **Inner Well:** Background `rgba(0, 0, 0, 0.22)`, border `1px solid rgba(255, 255, 255, 0.04)`, radius `6px`, padding `8px 10px`.

### Inputs
- **Style:** Background `rgba(0, 0, 0, 0.22)`, border `1px solid rgba(255, 255, 255, 0.08)`, radius `6px`, padding `6px 9px`.
- **Focus:** Border `rgba(56, 189, 248, 0.45)`, background `rgba(0, 0, 0, 0.35)`, box-shadow `0 0 0 1px rgba(56, 189, 248, 0.2)`.

## Do's and Don'ts

### Do:
- **Do** maintain flat surfaces at rest; rely on surface luminance stepping and 1px borders for depth.
- **Do** format commit hashes, branch names, and file paths in monospace typography (`ui-monospace`).
- **Do** use vector SVG icons rendered inline with `currentColor` and matching text size.
- **Do** reserve high-chroma cyan and blue for live telemetry and primary interactive triggers.
- **Do** keep state transitions brisk and restrained (`150ms ease`).

### Don't:
- **Don't** add emoji glyphs anywhere in the interface; use semantic SVG icons and clean typography.
- **Don't** use heavy drop shadows or colored glow effects on passive resting cards.
- **Don't** use decorative gradients or color fills on large background surfaces.
- **Don't** split the design token source of truth between stylesheet variables and arbitrary inline styles.
- **Don't** introduce spring or bouncy animations into developer utility workflows.
