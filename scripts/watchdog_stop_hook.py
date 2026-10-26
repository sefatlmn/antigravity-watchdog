#!/usr/bin/env python3
"""
Stop Lifecycle Hook for Watchdog (watchdog_stop_hook.py)

Fires when an agent conversation execution loop terminates.
Checks:
1. `fullyIdle == true`, `terminationReason == "model_stop"`, no `error`.
2. Conversation is NOT itself a `[WATCHDOG-SESSION]` (prevents infinite recursion).
3. Inspects `workspacePaths` for Git repositories (including nested project repos,
   ignoring empty-tree workspace wrapper repos) and resolves the youngest commit.
4. Prepares an isolated Git worktree (`fix/watchdog-<short_sha>`) and dispatches an
   independent background Watchdog review without blocking the coding chat.
"""

import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

import watchdog_ctl  # noqa: E402
import panel_launcher  # noqa: E402


def is_claude_payload(payload: Dict[str, Any]) -> bool:
    return bool(
        payload.get("hook_event_name")
        or ("session_id" in payload and "cwd" in payload)
    )


def is_watchdog_conversation(payload: Dict[str, Any], state: Dict[str, Any]) -> bool:
    if os.environ.get("WATCHDOG_SESSION") == "1":
        return True

    conv_id = payload.get("conversationId", "") or payload.get("session_id", "")
    active_convs = state.get("active_watchdog_conversations", [])
    if conv_id and conv_id in active_convs:
        return True

    last_msg = payload.get("last_assistant_message", "")
    if last_msg and "[WATCHDOG-SESSION]" in last_msg:
        return True

    transcript_path = payload.get("transcriptPath", "") or payload.get("transcript_path", "")
    if transcript_path:
        tp = Path(transcript_path)
        if tp.exists():
            try:
                with open(tp, "r", encoding="utf-8", errors="ignore") as fp:
                    head = fp.read(16384)
                if "[WATCHDOG-SESSION]" in head or "[NEXT-STEPS-SESSION]" in head or "[NEXT-STEPS-SYNTHESIZER-SESSION]" in head:
                    return True
            except Exception:
                pass
    return False


def get_new_commits_since_baseline(repo_root: Path, baseline_sha: str, target_sha: str) -> List[str]:
    """Return commit SHAs between baseline_sha..target_sha (oldest first), or [target_sha] if recent."""
    rc, _, _ = watchdog_ctl.run_git(repo_root, ["cat-file", "-e", f"{baseline_sha}^{{commit}}"])
    if rc != 0:
        info = watchdog_ctl.get_commit_info(repo_root, target_sha)
        if info and (time.time() - info["timestamp"] <= 1200):
            return [info["sha"]]
        return []

    rc_anc, _, _ = watchdog_ctl.run_git(repo_root, ["merge-base", "--is-ancestor", baseline_sha, target_sha])
    if rc_anc != 0:
        info = watchdog_ctl.get_commit_info(repo_root, target_sha)
        if info and (time.time() - info["timestamp"] <= 1200):
            return [info["sha"]]
        return []

    rc_list, out, _ = watchdog_ctl.run_git(repo_root, ["rev-list", "--reverse", f"{baseline_sha}..{target_sha}"])
    if rc_list != 0 or not out:
        return []
    commits = [c.strip() for c in out.splitlines() if c.strip()]
    if len(commits) > 3:
        info = watchdog_ctl.get_commit_info(repo_root, target_sha)
        if info and (time.time() - info["timestamp"] <= 900):
            return [info["sha"]]
        return []
    return commits


def handle_stop_event(payload: Dict[str, Any]) -> None:
    watchdog_ctl.cache_ls_env()

    if os.environ.get("WATCHDOG_SESSION") == "1":
        return

    hook_event = payload.get("hook_event_name", "")
    if hook_event == "SessionStart":
        cwd = payload.get("cwd") or os.getcwd()
        auto_open = os.environ.get("WATCHDOG_AUTO_OPEN_PANEL", "1") != "0"
        try:
            panel_launcher.ensure_panel(repo_path=cwd, open_window=auto_open)
        except Exception:
            pass
        return

    if is_claude_payload(payload):
        if payload.get("stop_hook_active"):
            return
        payload = dict(payload)
        payload["fullyIdle"] = True
        payload["terminationReason"] = "model_stop"
        if not payload.get("conversationId") and payload.get("session_id"):
            payload["conversationId"] = payload["session_id"]
        if not payload.get("transcriptPath") and payload.get("transcript_path"):
            payload["transcriptPath"] = payload["transcript_path"]
        if not payload.get("workspacePaths") and payload.get("cwd"):
            payload["workspacePaths"] = [payload["cwd"]]
        try:
            panel_launcher.start_panel_server(payload.get("cwd"))
        except Exception:
            pass

    if not payload.get("fullyIdle", False):
        return
    if payload.get("terminationReason") != "model_stop":
        return
    if payload.get("error"):
        return

    state = watchdog_ctl.load_state()
    if is_watchdog_conversation(payload, state):
        return

    workspace_paths = payload.get("workspacePaths") or []
    seen_roots = set()

    for wp in workspace_paths:
        for repo_root in watchdog_ctl.discover_git_roots(str(wp)):
            if str(repo_root) in seen_roots:
                continue
            seen_roots.add(str(repo_root))

            youngest_info, _ = watchdog_ctl.get_youngest_commit(repo_root, limit=5)
            if not youngest_info or youngest_info.get("is_empty_tree"):
                continue

            repo_key = str(repo_root)
            repo_entry = state.get("repos", {}).get(repo_key)

            # Check if an audit is already running for this repo to prevent double auditing
            running_job = watchdog_ctl.get_running_job(repo_root)
            if running_job:
                # An audit is currently running. Double auditing must be prevented!
                # Forward user messages from this finished turn as a comment to the in-progress audit.
                conv_id = payload.get("conversationId", "")
                transcript_path = payload.get("transcriptPath", "")
                user_reqs = watchdog_ctl.get_conversation_user_requests(
                    conv_id,
                    limit=1,
                    transcript_path=Path(transcript_path) if transcript_path else None,
                )
                user_msg = user_reqs[-1] if user_reqs else ""

                comment_parts = []
                if user_msg:
                    comment_parts.append(user_msg)
                if youngest_info["sha"] != running_job.get("sha"):
                    comment_parts.append(
                        f"New commit: {youngest_info['short_sha']} ({youngest_info['subject']})"
                    )

                if comment_parts:
                    full_comment = " — ".join(comment_parts)
                    watchdog_ctl.send_comment_to_job(running_job, full_comment)

                with watchdog_ctl.StateLock():
                    st = watchdog_ctl.load_state()
                    st.setdefault("repos", {})[repo_key] = {
                        "name": repo_root.name,
                        "baseline_sha": youngest_info["sha"],
                        "updated_at": watchdog_ctl.now_iso(),
                    }
                    watchdog_ctl.save_state(st)
                continue

            if not repo_entry or not repo_entry.get("baseline_sha"):
                age_seconds = time.time() - youngest_info["timestamp"]
                if age_seconds <= 1200:
                    watchdog_ctl.queue_commit(
                        repo_root,
                        sha=youngest_info["sha"],
                        base_sha=youngest_info.get("parent_sha", ""),
                        dispatch_now=True,
                    )
                    try:
                        watchdog_ctl.synthesize_next_steps(repo_root, force=True)
                    except Exception:
                        pass
                else:
                    with watchdog_ctl.StateLock():
                        st = watchdog_ctl.load_state()
                        st.setdefault("repos", {})[repo_key] = {
                            "name": repo_root.name,
                            "baseline_sha": youngest_info["sha"],
                            "updated_at": watchdog_ctl.now_iso(),
                        }
                        watchdog_ctl.save_state(st)
                continue

            baseline_sha = repo_entry["baseline_sha"]
            if baseline_sha == youngest_info["sha"]:
                continue

            new_commits = get_new_commits_since_baseline(repo_root, baseline_sha, youngest_info["sha"])
            if not new_commits:
                with watchdog_ctl.StateLock():
                    st = watchdog_ctl.load_state()
                    st.setdefault("repos", {})[repo_key] = {
                        "name": repo_root.name,
                        "baseline_sha": youngest_info["sha"],
                        "updated_at": watchdog_ctl.now_iso(),
                    }
                    watchdog_ctl.save_state(st)
                continue

            watchdog_ctl.queue_commit(
                repo_root,
                sha=new_commits[-1],
                base_sha=baseline_sha,
                dispatch_now=True,
            )
            try:
                watchdog_ctl.synthesize_next_steps(repo_root, force=True)
            except Exception:
                pass


def main() -> int:
    payload: Dict[str, Any] = {}
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        handle_stop_event(payload)
    except Exception as exc:
        try:
            watchdog_ctl.ensure_dirs()
            err_log = watchdog_ctl.LOGS_DIR / "hook_errors.log"
            with open(err_log, "a", encoding="utf-8") as fp:
                fp.write(f"[{watchdog_ctl.now_iso()}] Stop hook error: {exc}\n")
        except Exception:
            pass

    if not is_claude_payload(payload):
        sys.stdout.write(json.dumps({"decision": "allow"}) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
