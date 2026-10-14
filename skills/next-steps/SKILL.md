---
name: next-steps
description: Autonomous post-commit planning and next-step proposer. Inspects repository state, compares commits against initial project goals, and formulates up to 4 structured implementation plans adhering to the Antigravity /plan methodology.
---

# Next Steps Planner

This skill empowers Antigravity agents to inspect codebases and project history to propose the next logical implementation steps.

## Core Capabilities
1. **Goal Discovery**: Extracts the project's overarching mission from `.antigravity/next_steps/goal.json`, `README.md`, initial commits, or conversation history.
2. **Conversation Awareness**: Leverages context from all previous Antigravity conversations associated with this workspace.
3. **4-Tier Proposal Generation**:
   - 🎯 **Core Milestone**: Logical sequential progression toward the primary goal.
   - 🛡️ **Robustness & Error Handling**: Guardrails, boundary checks, input validation.
   - ⚡ **DX & Automated Testing**: Regression tests, test harnesses, CI verification.
   - ✨ **Polish & Micro-Interactions**: UX flow, responsive styling, loading states.
4. **Implementation Plans**:
   - Each proposal writes an implementation plan to `.antigravity/next_steps/plan-<id>-<slug>.md`.
   - Adheres strictly to the `/plan` methodology with Mermaid diagrams, clickable file links, diff blocks, and automated verification plans.
