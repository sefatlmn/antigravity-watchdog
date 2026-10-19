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
  light-primary: "#1d4ed8"
  light-primary-hover: "#1e40af"
  light-accent: "#0369a1"
  light-success: "#047857"
  light-warning: "#b45309"
  light-danger: "#b91c1c"
  light-card: "#ffffff"
  light-border: "#e2e8f0"
  light-neutral-fg: "#0f172a"
  light-neutral-muted: "#475569"
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
  tag: "4px"
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
  button-cancel:
    backgroundColor: "transparent"
    textColor: "{colors.neutral-fg}"
    rounded: "{rounded.action}"
    height: "26px"
    padding: "0 10px"
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
  progress-bar:
    backgroundColor: "{colors.telemetry-cyan}"
    rounded: "{rounded.sm}"
    height: "4px"
  card:
    backgroundColor: "{colors.surface-midnight}"
    rounded: "{rounded.card}"
    padding: "10px 12px"
  tag-ok:
    backgroundColor: "rgba(16, 185, 129, 0.12)"
    textColor: "{colors.radar-emerald}"
    rounded: "{rounded.tag}"
    padding: "2px 7px"
---

# Design System: Watchdog

## Overview

**Creative North Star: "The Command Bridge"**

The Command Bridge design system embodies the calm, unyielding focus of a modern aerospace flight deck. Designed specifically for Google Antigravity developers running autonomous coding sessions, it delivers critical repository telemetry, automated verification verdicts, and forward-looking implementation plans with instantaneous legibility and zero visual noise.

Surfaces rest on a deep obsidian canvas (`#0b0f19`) in dark mode and crisp white/slate surfaces in light mode, layered with structured cards (`#131b2e` dark / `#ffffff` light) and delineated by hairline translucent borders. High-chroma telemetry cyan (`#38bdf8`) and radar emerald (`#10b981`) illuminate key commit hashes, branch tags, and verified bug fixes. In accordance with user direction and rigorous design principles, the interface is flat and disciplined, relying on surface tone stepping, WCAG AA contrast compliance, and border precision rather than heavy drop shadows, decorative glows, pulsing loops, marquee shimmers, or toy-like emoji glyphs.

**Key Characteristics:**
- **Flat Spatial Geometry:** Clean, planar surfaces at rest; borders and luminance stepping carry structural separation.
- **Instrument-Grade Telemetry:** Monospace identifiers, tabular-numeric metrics, and steady status indicators designed for immediate scanning.
- **Vector-Only Iconography:** 100% lightweight inline SVGs matching exact font size and stroke weights.
- **Instantaneous Feedback:** Restrained 150ms transitions with zero bounce or spring artifacts.
- **Strict WCAG AA Dual-Theme Contrast:** Calibrated text, border, and badge ratios exceeding 4.5:1 across both Dark and Light themes.

## Colors

A calibrated dark and light adaptive palette balancing deep obsidian tones with functional, high-visibility telemetry signals and WCAG AA contrast compliance.

### Primary
- **Action Blue** (`#2563eb`): Primary trigger actions and high-priority commitments in dark mode.
- **Action Blue Hover** (`#3b82f6`): Interactive hover feedback for primary buttons and focus rings.

### Secondary
- **Telemetry Cyan** (`#38bdf8`): Monospace commit SHAs, active process telemetry, and conversation tags.
- **Radar Emerald** (`#10b981`): Verified QA test passes, applied fixes, and active watchdog status beacons.

### Tertiary
- **Signal Amber** (`#f59e0b`): Warning states and documentation-only commit notices.
- **Danger Rose** (`#ef4444`): Destructive reset actions, failed audits, and network error alerts.

### Neutral
- **Obsidian Canvas** (`#0b0f19`): Main panel background canvas.
- **Midnight Surface** (`#131b2e`): Elevated cards, audit items, and proposal modules.
- **Content Well** (`rgba(0, 0, 0, 0.22)`): Inset code blocks, commit detail rows, and goal quotes.
- **Foreground Primary** (`#f8fafc`): Headings, active tabs, and primary readable copy.
- **Foreground Body** (`#e2e8f0`): Summary prose, descriptions, and proposal narratives.
- **Foreground Muted** (`#94a3b8`): Metadata labels, relative timestamps, and secondary controls.
- **Border Default** (`var(--border)`): Standard structural surface outlines, automatically adapting to dark and light modes.
- **Border Active** (`var(--border-strong-translucent)`): Hovered cards, focused inputs, and active interactive borders.

### Calibrated Light Theme Tokens (WCAG AA Certified)
- **Light Primary** (`#1d4ed8`): 5.83:1 contrast against `#ffffff`.
- **Light Accent / Telemetry** (`#0369a1`): 5.67:1 contrast against `#f0f9ff`.
- **Light Success / Radar** (`#047857`): 5.14:1 contrast against `#ecfdf5`.
- **Light Warning / Signal** (`#b45309`): 4.92:1 contrast against `#fffbeb`.
- **Light Danger** (`#b91c1c`): 6.45:1 contrast against `#fef2f2`.
- **Light Card Background** (`#ffffff`): Grounding canvas for cards.
- **Light Card Border** (`#e2e8f0`): Structural separator for cards and wells.
- **Light Foreground Primary** (`#0f172a`): High-legibility heading and prose tone.
- **Light Foreground Muted** (`#475569`): 4.63:1 contrast for secondary labels and timestamps.

### Antigravity Adaptive Theming
The design system dynamically synchronizes with Google Antigravity's active host theme (Dark Theme, Light Theme, or custom high-contrast palettes) via two cooperating mechanisms:
1. **Host Event Synchronization:** Listens for `theme-change` postMessage payloads sent by the Antigravity desktop Electron shell (`payload.themeType` and `payload.cssVariables`), dynamically assigning `--background`, `--foreground`, `--primary`, `--card`, `--border`, and `--muted`.
2. **Semantic `color-mix()` Derivations:** Uses CSS `color-mix(in srgb, var(--foreground) X%, transparent)` for all overlays, borders, hover states, and chip backgrounds. This guarantees mathematically balanced contrast across any host theme without requiring manual theme overrides.
3. **Pristine Mode Fallbacks:** Provides explicit calibrated light mode tokens (`[data-theme="light"]`, `.theme-light`, `@media (prefers-color-scheme: light)`) pairing clean white cards (`#ffffff`) with subtle slate borders (`#e2e8f0`) and high-contrast typography (`#0f172a`, `#475569`), while dark mode preserves the Command Bridge obsidian palette (`#0b0f19`, `#131b2e`).

### Named Rules
**The Beacon Accent Rule.** Vibrant blue (`#2563eb` / `#1d4ed8`) and telemetry cyan (`#38bdf8` / `#0369a1`) are strictly reserved for actionable triggers and live commit telemetry. They are never used as full decorative background fills for passive cards or containers.

**The Semantic Status Rule.** Colors have unambiguous roles: green means verified/applied; amber means caution/docs-only; cyan means live/running; red means failed/cancelled. Neutral cards never adopt semantic border colors unless actively communicating state.

**The Dual-Theme Contrast Rule.** Every text label, status tag, badge, and actionable icon must meet or exceed WCAG AA contrast thresholds (>= 4.5:1 for body copy and >= 3.0:1 for large display text or badges) across both Dark and Light themes.

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
- **Micro-Badges & Tags** (SemiBold 600, 10px, uppercase, tracking 0.03em, tabular-nums): Status tags, difficulty tags, tab counters.

### Named Rules
**The Monospace Discipline Rule.** Monospace typography is strictly reserved for Git commit hashes, branch names, file paths, and execution commands. Standard UI copy and headings must always use the system sans-serif stack.

**The Tabular Alignment Rule.** All numerical readouts—including commit timestamps, metric counts, and Git commit hashes—must declare `font-variant-numeric: tabular-nums` to maintain pixel-perfect vertical alignment and eliminate jitter during live telemetry refreshes.

**The Themed Surface Rule.** Browser defaults for text selection (`::selection`), focus rings (`:focus-visible`), caret colors, and scrollbars are explicitly styled to match the active host theme (`#38bdf8` caret/focus in dark, `#0369a1` in light, translucent selection, thin 5px rounded scrollbars).

## Layout

The layout is built for the Antigravity auxiliary right-hand pane, constrained to a maximum width of `640px` with fluid responsiveness down to `300px`.

- **Panel Container:** Single column `flex-direction: column` with uniform `--gap: 10px` and `padding: 12px 14px`.
- **Dual Tab Switcher:** Segmented control spanning 100% container width with equal-width tab buttons (`flex: 1`).
- **Cards:** Self-contained modules with internal `padding: 10px 12px` and `gap: 8px`.
- **Rhythm:** Elements within cards space at `4px` or `6px`; top-level cards space at `10px`.

## Elevation & Depth

Per user direction, the system is **flat with minimal shadows and glow**. Depth is communicated through stepped background luminosity, subtle 1px border contrasts, and inset content wells rather than diffuse drop shadows.

- **Canvas Level:** `#0b0f19` (dark) / `#f8fafc` (light) (lowest layer).
- **Surface Level:** `#131b2e` (dark) / `#ffffff` (light) with `border: 1px solid var(--border)`.
- **Inset Well Level:** `rgba(0, 0, 0, 0.22)` (dark) / `#f1f5f9` (light) with `border: 1px solid var(--border)`.
- **Modal Overlay:** `background: rgba(0, 0, 0, 0.75)` with `backdrop-filter: blur(4px)`.

### Shadow Vocabulary
- **Resting Surfaces:** `box-shadow: none;` (strict flat invariant).
- **Active Tab Pill:** `box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3)` (slight grounding contrast).
- **Modal Dialog:** `box-shadow: 0 12px 36px rgba(0, 0, 0, 0.6)` / `0 20px 40px -8px rgba(0, 0, 0, 0.7)` (depth isolation).

### Named Rules
**The Flat Horizon Rule.** Surfaces are planar and flat at rest. Structural hierarchy is communicated exclusively through surface luminance stepping and 1px translucent borders, never decorative drop shadows.

**The Honest Indicator Rule.** Liveness indicators communicate system state through calm, steady geometry. Pulsing dot animation loops and infinite marquee shimmers are prohibited.

## Shapes

The form language balances technical precision with subtle corner softening:

- **Progress Bar Indicator:** `border-radius: 2px`.
- **Compact Elements (Tags, File Chips):** `border-radius: 4px` (`{rounded.sm}`).
- **Card Action Controls (Buttons, Badges, Cancel Actions):** `border-radius: 5px` (`{rounded.action}`).
- **Interactive Controls (Buttons, Inputs, Tabs):** `border-radius: 6px` (`{rounded.md}`).
- **Surface Containers (Cards, Wells):** `border-radius: 8px` (`{rounded.card}`).
- **Floating Modals:** `border-radius: 10px` (`{rounded.modal}`).
- **Status Tags & Count Badges:** `border-radius: 4px` (`{rounded.tag}`).

## Components

### Primary Buttons
- **Shape:** Soft rectangular (`border-radius: 6px`).
- **Primary:** Background `{colors.primary}` (`#2563eb`), text `#ffffff`, padding `8px 14px`, font weight 600.
- **Hover / Focus:** Lightens background via color-mix (`#3b82f6`), outline none, active transforms `translateY(1px)`.
- **Disabled:** Background `rgba(255, 255, 255, 0.08)`, color `#94a3b8`, cursor `not-allowed`.

### Secondary & Action Buttons
- **Secondary:** Transparent background, `border: 1px solid var(--border)`, text `var(--foreground)`, padding `4px 9px`.
- **Accent (Apply Fix):** Background `rgba(56, 189, 248, 0.18)`, border `rgba(56, 189, 248, 0.35)`, color `#38bdf8`.
- **Warning (Docs Only):** Background `rgba(245, 158, 11, 0.14)`, border `rgba(245, 158, 11, 0.35)`, color `#fbbf24`.

### Card Action Buttons (Unified Token System)
All interactive controls and state tags within card footers (`.job-actions` on Audits and `.proposal-actions` on Next Steps) are strictly normalized to a shared design system:
- **Unified Height:** Exactly `26px` (`--card-action-height: 26px`) across status tags (`.applied-badge`), utility icon buttons (`.job-report-btn`, `.job-archive-btn`, `.proposal-plan-btn`), cancel buttons (`.btn-cancel`), and execution triggers (`.primary-btn`, `.accent-btn`).
- **Unified Inter-Action Spacing:** Normalized to `6px` (`--card-action-gap: 6px`) in all card action containers.
- **Unified Geometry:** `border-radius: 5px` (`--card-action-radius: 5px`) and `box-sizing: border-box`.
- **Vertical Centering & Alignment:** Single-line flex layout (`display: inline-flex; align-items: center; justify-content: center; line-height: 1;`) ensuring pixel-perfect baseline and horizontal symmetry across both panes.

### Stop / Cancel Refresh Controls
- **Card-level Action (`.btn-cancel`):** Height `26px`, padding `0 10px`, transparent background, `border: 1px solid var(--border)`, color `var(--foreground)`, inline SVG stop square. Hover applies `var(--hover-overlay)`.
- **Header Mini Trigger (`.btn-cancel-mini`):** Height `22px`, padding `0 6px`, `border-radius: 4px`, `border: 1px solid var(--border)`, color `var(--muted-foreground)`. Visible alongside refresh button whenever synthesis is running.

### Progress Bar
- **Track (`.proposals-progress`):** Height `4px`, background `var(--surface-well)`, `border-radius: 2px`, overflow `hidden`.
- **Indicator (`.proposals-progress-bar`):** Background `var(--accent)`, width animated via smooth cubic-bezier (`width 0.4s cubic-bezier(0.16, 1, 0.3, 1)`). Devoid of marquee shimmers or infinite loops.

### Status Tags & Indicators
- **Style:** Crisp technical tag (`border-radius: 4px`), padding `2px 7px`, font size `10px`, font weight 600, uppercase with letter-tracking.
- **Active / Ok:** Background `rgba(16, 185, 129, 0.12)`, border `rgba(16, 185, 129, 0.25)`, color `#34d399` (dark) / `#047857` (light), with a `5px` solid emerald square indicator.
- **Warning:** Background `rgba(245, 158, 11, 0.12)`, border `rgba(245, 158, 11, 0.25)`, color `#fbbf24` (dark) / `#b45309` (light).
- **Running / Auditing:** Same position, height, and geometry as applied badges, featuring a steady 6px accent dot.

### Segmented Tab Switcher
- **Container:** Background `rgba(255, 255, 255, 0.04)` (dark) / `#f1f5f9` (light), padding `3px`, border `1px solid var(--border)`, radius `8px`.
- **Tab Item:** Equal flex width (`flex: 1`), padding `6px 10px`, transparent background, text `var(--muted-foreground)`.
- **Active State:** Background `var(--card)`, text `var(--foreground)`, font weight 600, grounded by `0 1px 3px rgba(0, 0, 0, 0.3)` (dark) or `0 1px 2px rgba(0, 0, 0, 0.06)` (light).

### Cards & Wells
- **Card:** Background `var(--card)`, border `1px solid var(--card-border)`, radius `8px`, padding `10px 12px`.
- **Inner Well:** Background `var(--surface-well)`, border `1px solid var(--surface-well-border)`, radius `6px`, padding `8px 10px`.
- **Proposal Card Meta Row:** Single-line space-between flex container pairing muted category on left with difficulty on right, sharing identical typography (`font-size: 11px`, color `var(--text-muted)`).

### Inputs
- **Style:** Background `var(--surface-well)`, border `1px solid var(--border)`, radius `6px`, padding `6px 9px`.
- **Focus:** Border `var(--accent)`, background `var(--surface-well)`, box-shadow `0 0 0 1px var(--accent)`.

### Named Rules
**The Unified Action Metric Rule.** Every card footer control, utility icon button, status tag, and cancellation button shares an identical height of exactly 26px and gap of 6px. No interactive trigger may deviate from this geometry.

## Do's and Don'ts

### Do:
- **Do** maintain flat surfaces at rest; rely on surface luminance stepping and 1px borders for depth.
- **Do** format commit hashes, branch names, and file paths in monospace typography (`ui-monospace`).
- **Do** use vector SVG icons rendered inline with `currentColor` and matching text size.
- **Do** reserve high-chroma cyan and blue for live telemetry and primary interactive triggers.
- **Do** verify WCAG AA contrast (>= 4.5:1) for all text and status badges across both Dark and Light themes.
- **Do** keep state transitions brisk and restrained (`150ms ease`).

### Don't:
- **Don't** add emoji glyphs anywhere in the interface; use semantic SVG icons and clean typography.
- **Don't** use heavy drop shadows or colored glow effects on passive resting cards.
- **Don't** introduce pulsing dot keyframe loops or infinite marquee progress shimmers.
- **Don't** use decorative gradients or color fills on large background surfaces.
- **Don't** split the design token source of truth between stylesheet variables and arbitrary inline styles.
- **Don't** introduce spring or bouncy animations into developer utility workflows.
