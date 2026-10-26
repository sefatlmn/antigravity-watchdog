---
name: next-steps
description: Autonomous post-commit planning and next-step proposer. Ingests project handoffs, specifications, package manifests, full codebase trees, AST symbols, and all Antigravity chat transcripts to formulate 4 project-grounded implementation plans adhering to the /plan methodology.
---

# Next Steps Planner

This skill empowers Antigravity agents to inspect codebases and project history to propose genuine, project-tailored implementation steps instead of generic boilerplate.

## 4-Pillar Project Intelligence Pipeline

1. **Pillar 1: Handoff & Specification Ingestion (Primary Ground Truth)**
   - Specifically scans for `HANDOFF.md`, `project_handoff.md`, `WALKTHROUGH.md`, `PRODUCT.md`, `ROADMAP.md`, `TODO.md`, `ARCHITECTURE.md`, `SPECIFICATION.md`, and `SPEC.md`.
   - Extracts uncompleted milestones (`- [ ]`), completed items (`- [x]`), next steps sections, and architecture guidelines.
   - When a handoff document exists, it serves as the highest-priority source of truth for upcoming deliverables.

2. **Pillar 2: Manifests & Full Readme Analysis**
   - Parses package manifests (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`) to extract dependencies, project descriptions, scripts, and exact test runner commands (`npm test`, `pytest`, `cargo test`, etc.).
   - Parses the complete `README.md` (overview, features, architecture, roadmap, and current status).

3. **Pillar 3: Deep Codebase & AST/Symbol Traversal**
   - Scans the repository tree to classify architecture layers: entry points, UI components, backend/logic modules, test files, and configuration files.
   - Collects active `TODO`, `FIXME`, and `BUG` markers with exact file paths and line numbers.
   - Evaluates the velocity and trajectory of the last 15 commits and uncommitted dirty working-tree files.

4. **Pillar 4: All-Chats & Transcript Synthesizer**
   - Discovers all linked Antigravity conversations across the workspace (including ad-hoc sessions by inspecting transcript logs for repository file references).
   - Extracts chronological user requests, latest directives, corrections, and uncompleted checklist items from past artifacts (`implementation_plan.md`, `walkthrough.md`, `task.md`).

## Dynamic, Content-Driven Categories & Badges

Proposals are NOT restricted to a canned 4-bucket template (such as "Milestone, Robustness, DX, UX"). Instead, the synthesizer inspects the project's actual state and roadmap to freely assign categories and badges that accurately describe each proposal:
- `Feature` / `Workflow`: Core capabilities, user workflows, integrations, and deliverables.
- `UI` / `Design`: Responsive interfaces, modals, indicators, view layouts, and design tokens.
- `CLI` / `API`: Command ergonomics, flag validation, schema contracts, and endpoint integration.
- `Performance` / `Optimization`: Latency reduction, in-memory caching, memory footprint, and I/O tuning.
- `Testing` / `Tooling`: Automated regression suites, mock fixtures, and developer utilities.
- `Refactor` / `Architecture`: Code organization, modular decoupling, and marker resolution.
- `Security`: Boundary validation, path sanitization, and permission isolation.

## On-Demand Execution & Anti-Repetition Guardrail

Next Steps synthesis is triggered on-demand directly from the Watchdog auxiliary pane (via the Refresh action) rather than on every commit or in-chat commands.

When triggered:
1. The Watchdog backend gathers the last 15 commits, recent user chat directives, active specifications (`PRODUCT.md`, `HANDOFF.md`, `README.md`), and AST structure.
2. An autonomous background synthesizer agent is dispatched with an explicit **Anti-Repetition Mandate**: all recent commits and chat directives are flagged as `ALREADY COMPLETED WORK (DO NOT RE-PROPOSE)`.
3. The agent crafts 4 pragmatic, high-value, forward-looking improvements (slightly feature-preferred) and writes `.antigravity/next_steps/proposals.json` and 4 `/plan` markdown files.
4. When finished, the agent signals completion via `watchdog_ctl.py complete-synthesis --repo <repo>`.
5. The Watchdog aux pane polls the state and smoothly renders the updated proposals.

## Plan Formulation Standard

Each proposal writes a complete implementation plan to `.antigravity/next_steps/plan-<id>-<slug>.md`:
- Conforms strictly to Antigravity's `/plan` standard.
- Contains Mermaid flowcharts, absolute clickable `file:///` links, and realistic implementation code diff blocks.
- Employs project-specific automated test commands and manual verification checklists.
- Can be launched with 1 click via Antigravity AgentAPI (`agentapi new-conversation`).
- Maintains a strict zero-emoji policy across all generated files and plans.
