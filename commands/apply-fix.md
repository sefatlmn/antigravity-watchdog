---
description: Apply verified bug fixes from an isolated fix/watchdog-<sha> branch onto the working branch
argument-hint: "[sha]"
---

Call `watchdog_apply_fix` (using `$ARGUMENTS` as `sha`, or the latest audited commit SHA from `watchdog_status` if omitted) to cherry-pick or merge verified fixes onto the active branch.
