#!/usr/bin/env python3
"""
QA Watchdog Controller (qa_ctl.py)

Manages state, isolated Git worktrees, git history sync (automatic youngest-commit
resolution across branches and nested repos), job queueing, background agent dispatch,
fix-branch application, and cleanup for the global Antigravity QA Watchdog plugin.
"""

import argparse
import datetime
import fcntl
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

HOME = Path.home()
APP_DATA_DIR = Path(os.environ.get("ANTIGRAVITY_APP_DATA_DIR", str(HOME / ".gemini" / "antigravity")))
WATCHDOG_DIR = APP_DATA_DIR / "qa_watchdog"
STATE_FILE = WATCHDOG_DIR / "state.json"
LOCK_FILE = WATCHDOG_DIR / "state.lock"
WORKTREES_DIR = WATCHDOG_DIR / "worktrees"
LOGS_DIR = WATCHDOG_DIR / "logs"
ENV_CACHE_FILE = WATCHDOG_DIR / "ls_env.json"

CONVERSATION_SUMMARIES_DB = APP_DATA_DIR / "conversation_summaries.db"
BRAIN_DIR = APP_DATA_DIR / "brain"
PROJECTS_DIR = HOME / ".gemini" / "config" / "projects"
NEXT_STEPS_DIR_NAME = "next_steps"

PLUGIN_DIR = Path(__file__).resolve().parent.parent
SKILL_PATH = PLUGIN_DIR / "skills" / "qa-watchdog" / "SKILL.md"
AGENTAPI_DEFAULT = HOME / ".gemini" / "antigravity" / "bin" / "agentapi"

SKIP_TAGS = ("[auto-review]", "[qa-watchdog]", "[skip-qa]")
EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
SKIP_SCAN_DIRS = {
    ".git",
    "node_modules",
    ".antigravity",
    ".venv",
    "venv",
    "dist",
    "build",
    "__pycache__",
    ".next",
    ".nuxt",
    "target",
}


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def ensure_dirs() -> None:
    for d in (WATCHDOG_DIR, WORKTREES_DIR, LOGS_DIR):
        d.mkdir(parents=True, exist_ok=True)


def default_state() -> Dict[str, Any]:
    return {
        "paused": False,
        "auto_dispatch": True,
        "skip_docs_only": True,
        "repos": {},
        "jobs": [],
        "active_qa_conversations": [],
    }


class StateLock:
    def __init__(self) -> None:
        ensure_dirs()
        self.fp = open(LOCK_FILE, "w")

    def __enter__(self) -> "StateLock":
        fcntl.flock(self.fp.fileno(), fcntl.LOCK_EX)
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        try:
            fcntl.flock(self.fp.fileno(), fcntl.LOCK_UN)
        finally:
            self.fp.close()


def load_state() -> Dict[str, Any]:
    ensure_dirs()
    if not STATE_FILE.exists():
        return default_state()
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        base = default_state()
        base.update(data)
        return base
    except Exception:
        return default_state()


def save_state(state: Dict[str, Any]) -> None:
    ensure_dirs()
    if len(state.get("jobs", [])) > 100:
        state["jobs"] = state["jobs"][:100]
    tmp_file = STATE_FILE.with_suffix(".tmp")
    tmp_file.write_text(json.dumps(state, indent=2), encoding="utf-8")
    tmp_file.replace(STATE_FILE)


def cache_ls_env() -> None:
    """Persist Language Server connection variables when available so background workers can use them."""
    ensure_dirs()
    keys = [
        "ANTIGRAVITY_LS_ADDRESS",
        "ANTIGRAVITY_CSRF_TOKEN",
        "ANTIGRAVITY_AGENTAPI_EXE",
        "ANTIGRAVITY_APP_DATA_DIR",
    ]
    found = {k: os.environ[k] for k in keys if os.environ.get(k)}
    if found.get("ANTIGRAVITY_LS_ADDRESS") and found.get("ANTIGRAVITY_CSRF_TOKEN"):
        try:
            ENV_CACHE_FILE.write_text(json.dumps(found, indent=2), encoding="utf-8")
            os.chmod(ENV_CACHE_FILE, 0o600)
        except Exception:
            pass


def get_cached_ls_env() -> Dict[str, str]:
    env = dict(os.environ)
    if ENV_CACHE_FILE.exists():
        try:
            cached = json.loads(ENV_CACHE_FILE.read_text(encoding="utf-8"))
            for k, v in cached.items():
                if v and not env.get(k):
                    env[k] = str(v)
        except Exception:
            pass
    return env


def run_git(repo_path: Path, args: List[str], timeout: int = 15) -> Tuple[int, str, str]:
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo_path)] + args,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except Exception as exc:
        return 1, "", str(exc)


def get_commit_info(repo_root: Path, rev: str = "HEAD") -> Optional[Dict[str, Any]]:
    fmt = "%H%n%h%n%ct%n%cr%n%an%n%T%n%s%n%B"
    rc, out, _ = run_git(repo_root, ["log", "-1", f"--format={fmt}", rev])
    if rc != 0 or not out:
        return None
    lines = out.split("\n")
    if len(lines) < 7:
        return None
    full_sha = lines[0].strip()
    short_sha = lines[1].strip()
    try:
        ts = int(lines[2].strip())
    except ValueError:
        ts = int(datetime.datetime.now().timestamp())
    relative_time = lines[3].strip()
    author = lines[4].strip()
    tree_hash = lines[5].strip()
    subject = lines[6].strip()
    body = "\n".join(lines[7:]).strip()

    rc_p, parent_out, _ = run_git(repo_root, ["rev-parse", f"{full_sha}~1"])
    parent_sha = parent_out.strip() if rc_p == 0 else ""

    return {
        "sha": full_sha,
        "short_sha": short_sha,
        "timestamp": ts,
        "committed_at": datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc).isoformat(),
        "relative_time": relative_time,
        "author": author,
        "tree_hash": tree_hash,
        "is_empty_tree": tree_hash == EMPTY_TREE_HASH,
        "subject": subject,
        "body": body,
        "parent_sha": parent_sha,
        "is_auto_review": any(tag in (f"{subject}\n{body}") for tag in SKIP_TAGS),
        "is_docs_only": is_docs_only_commit(repo_root, full_sha),
    }


def get_youngest_commit(
    repo_root: Path, limit: int = 12
) -> Tuple[Optional[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Scan git commit history across HEAD and all local branches/tags (excluding fix/qa-* branches)
    and return (youngest_commit, recent_commits) sorted by (is_non_empty_tree, timestamp) DESC.
    """
    fmt = "%H%x1f%h%x1f%ct%x1f%cr%x1f%an%x1f%T%x1f%s"
    rc, out, _ = run_git(
        repo_root,
        [
            "log",
            "--exclude=fix/qa-*",
            "--branches",
            "--tags",
            "HEAD",
            "--date-order",
            f"-n{limit * 2}",
            f"--format={fmt}",
        ],
    )
    if rc != 0 or not out:
        info = get_commit_info(repo_root, "HEAD")
        return (info, [info] if info else [])

    commits: List[Dict[str, Any]] = []
    seen_shas = set()
    for raw_line in out.splitlines():
        parts = raw_line.strip().split("\x1f")
        if len(parts) < 7:
            continue
        full_sha, short_sha, ts_str, rel_time, author, tree_hash, subject = parts[:7]
        if full_sha in seen_shas:
            continue
        seen_shas.add(full_sha)
        try:
            ts = int(ts_str)
        except ValueError:
            ts = 0
        commits.append(
            {
                "sha": full_sha,
                "short_sha": short_sha,
                "timestamp": ts,
                "committed_at": datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc).isoformat(),
                "relative_time": rel_time,
                "author": author,
                "tree_hash": tree_hash,
                "is_empty_tree": tree_hash == EMPTY_TREE_HASH,
                "subject": subject,
                "is_auto_review": any(tag in subject for tag in SKIP_TAGS),
            }
        )

    if not commits:
        info = get_commit_info(repo_root, "HEAD")
        return (info, [info] if info else [])

    # Sort strictly by (non-empty tree first, newest commit timestamp first)
    commits.sort(key=lambda c: (0 if c["is_empty_tree"] else 1, c["timestamp"]), reverse=True)
    recent = commits[:limit]

    # Enrich the youngest commit with full body & parent_sha
    youngest_full = get_commit_info(repo_root, recent[0]["sha"])
    if youngest_full:
        recent[0] = youngest_full

    return recent[0], recent


def _repo_head_score(repo: Path) -> Tuple[int, int]:
    """Return (is_non_empty_tree, youngest_commit_timestamp) for sorting candidate git roots."""
    youngest, _ = get_youngest_commit(repo, limit=3)
    if not youngest:
        return (0, 0)
    non_empty = 0 if youngest.get("is_empty_tree") else 1
    return (non_empty, int(youngest.get("timestamp", 0)))


def discover_git_roots(path_str: str) -> List[Path]:
    """
    Discover git repository roots at path_str and up to 3 directory levels below it,
    sorted by (is_non_empty_tree, youngest_commit_timestamp) descending.
    Automatically filters out empty-tree wrapper repositories when nested real repositories exist.
    """
    if not path_str:
        return []
    p = Path(path_str).expanduser().resolve()
    if not p.exists():
        return []
    if p.is_file():
        p = p.parent
    if "qa_watchdog/worktrees" in str(p) or ".antigravity/worktrees" in str(p):
        return []

    candidates: List[Path] = []
    seen = set()

    rc, out, _ = run_git(p, ["rev-parse", "--show-toplevel"])
    if rc == 0 and out:
        root = Path(out).resolve()
        if "qa_watchdog/worktrees" not in str(root) and ".antigravity/worktrees" not in str(root):
            candidates.append(root)
            seen.add(str(root))

    def _scan_dir(d: Path, depth: int) -> None:
        if depth > 3:
            return
        try:
            for child in d.iterdir():
                if not child.is_dir() or child.name.startswith(".") or child.name in SKIP_SCAN_DIRS:
                    continue
                if (child / ".git").exists():
                    r = child.resolve()
                    if str(r) not in seen and "qa_watchdog/worktrees" not in str(r):
                        seen.add(str(r))
                        candidates.append(r)
                else:
                    _scan_dir(child, depth + 1)
        except Exception:
            pass

    _scan_dir(p, 1)

    scored = [(repo, _repo_head_score(repo)) for repo in candidates]
    scored.sort(key=lambda item: item[1], reverse=True)

    # If there is at least one non-empty repo, drop any outer wrapper repo whose score has non_empty == 0
    has_non_empty = any(score[0] == 1 for _, score in scored)
    if has_non_empty:
        scored = [(repo, score) for repo, score in scored if score[0] == 1]

    return [repo for repo, _ in scored]


def resolve_git_root(path_str: str) -> Optional[Path]:
    roots = discover_git_roots(path_str)
    return roots[0] if roots else None


# -----------------------------------------------------------------------------
# 4-Pillar Project Intelligence & Next Steps Synthesizer
# -----------------------------------------------------------------------------

def get_project_conversations(repo_root: Path) -> List[Dict[str, Any]]:
    """
    Find all Antigravity conversations associated with this repository.
    Matches via:
    1. Direct folder matching in `conversation_summaries.db` (workspace_uris containing repo path or repo name)
    2. Parent workspace folders up to home
    3. Project resource mapping in ~/.gemini/config/projects/*.json
    4. Transcript content search (fallback when workspace_uris was left empty)
    """
    if not CONVERSATION_SUMMARIES_DB.exists():
        return []

    repo_str = str(repo_root.resolve())
    repo_name = repo_root.name
    ancestors: List[str] = []
    curr = repo_root.resolve().parent
    while curr and curr != HOME and curr != Path("/"):
        ancestors.append(str(curr))
        curr = curr.parent

    # Find project IDs from ~/.gemini/config/projects
    matched_project_ids = set()
    if PROJECTS_DIR.exists():
        try:
            for pfile in PROJECTS_DIR.glob("*.json"):
                try:
                    pdata = json.loads(pfile.read_text(encoding="utf-8"))
                    pid = pdata.get("id") or pfile.stem
                    resources = pdata.get("projectResources", {}).get("resources", [])
                    for res in resources:
                        f_uri = res.get("folderUri", "")
                        for check_p in [repo_str] + ancestors:
                            if check_p in f_uri or f_uri.replace("file://", "").rstrip("/") == check_p:
                                matched_project_ids.add(pid)
                                break
                except Exception:
                    pass
        except Exception:
            pass

    conversations: List[Dict[str, Any]] = []
    seen_ids = set()
    try:
        conn = sqlite3.connect(str(CONVERSATION_SUMMARIES_DB))
        cur = conn.cursor()
        cur.execute(
            """
            SELECT conversation_id, title, preview, step_count, last_modified_time, project_id, workspace_uris
            FROM conversation_summaries
            ORDER BY last_modified_time DESC
            """
        )
        rows = cur.fetchall()
        conn.close()

        for row in rows:
            cid, title, preview, step_count, mtime, pid, w_uris = row
            if not cid or cid in seen_ids:
                continue

            matches = False
            # 1. Project ID match
            if pid and pid in matched_project_ids:
                matches = True

            # 2. Workspace URIs match
            if not matches and w_uris:
                for check_p in [repo_str] + ancestors:
                    if check_p in w_uris or check_p.replace(" ", "%20") in w_uris:
                        matches = True
                        break

            # 3. Fallback: check repo_name match in workspace_uris, title, or preview
            if not matches and repo_name and len(repo_name) > 3:
                combined_text = f"{title or ''} {preview or ''} {w_uris or ''}".lower()
                if repo_name.lower() in combined_text:
                    matches = True

            # 4. Deep fallback: inspect transcript header/cwd if workspace_uris was blank
            if not matches:
                t_file = BRAIN_DIR / cid / ".system_generated" / "logs" / "transcript.jsonl"
                if t_file.exists():
                    try:
                        with open(t_file, "r", encoding="utf-8", errors="ignore") as tf:
                            lines_checked = 0
                            for line in tf:
                                if repo_str in line or (repo_name in line and len(repo_name) > 4):
                                    matches = True
                                    break
                                lines_checked += 1
                                if lines_checked > 60:
                                    break
                    except Exception:
                        pass

            if matches:
                seen_ids.add(cid)
                conversations.append(
                    {
                        "conversationId": cid,
                        "title": title or "Untitled Conversation",
                        "preview": preview or "",
                        "stepCount": step_count or 0,
                        "lastModifiedTime": mtime or "",
                        "projectId": pid or "",
                    }
                )
    except Exception:
        pass

    return conversations


def get_conversation_user_requests(conv_id: str, limit: int = 5) -> List[str]:
    """
    Extract recent user requests from a conversation transcript.
    """
    t_file = BRAIN_DIR / conv_id / ".system_generated" / "logs" / "transcript.jsonl"
    if not t_file.exists():
        return []
    requests: List[str] = []
    try:
        with open(t_file, "r", encoding="utf-8", errors="ignore") as fp:
            for line in fp:
                if not line.strip():
                    continue
                try:
                    step = json.loads(line)
                    if step.get("type") == "USER_INPUT":
                        content = step.get("content", "")
                        m = re.search(r"<USER_REQUEST>(.*?)</USER_REQUEST>", content, re.DOTALL)
                        req_text = m.group(1).strip() if m else content.strip()
                        if req_text and not req_text.startswith("Comments on artifact URI:") and req_text not in requests:
                            requests.append(req_text)
                except Exception:
                    pass
    except Exception:
        pass
    return requests[-limit:]


def deep_analyze_conversations(repo_root: Path, convs: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Pillar 4: Deeply analyze user requests, instructions, and past plan artifacts
    across all linked project conversations.
    """
    intel: Dict[str, Any] = {
        "all_requests": [],
        "latest_directive": "",
        "pending_tasks": [],
        "completed_tasks": [],
        "recent_complaints": [],
        "total_chats_analyzed": len(convs),
    }

    recent_requests: List[str] = []
    seen_reqs = set()

    for c in convs[:10]:
        cid = c.get("conversationId")
        if not cid:
            continue

        # 1. Collect requests from transcript
        reqs = get_conversation_user_requests(cid, limit=6)
        for r in reqs:
            cleaned = re.sub(r"\s+", " ", r).strip()
            # Strip slash command prefixes like /impeccable, /plan, /audit
            cleaned = re.sub(r"^/([a-zA-Z0-9_\-]+)\s*", "", cleaned).strip()
            if cleaned and cleaned not in seen_reqs and len(cleaned) > 5:
                seen_reqs.add(cleaned)
                recent_requests.append(cleaned)
                # Check for user complaints or bug indicators
                lower_r = cleaned.lower()
                if any(k in lower_r for k in ("broken", "doesn't work", "does not work", "fix", "error", "fails", "stuck", "overhaul", "glitch", "crash")):
                    intel["recent_complaints"].append(cleaned[:120])

        # 2. Inspect brain directory artifacts for pending / completed tasks
        brain_path = BRAIN_DIR / cid
        if brain_path.exists():
            for art_name in ("implementation_plan.md", "walkthrough.md", "task.md"):
                art_file = brain_path / art_name
                if art_file.exists():
                    try:
                        content = art_file.read_text(encoding="utf-8", errors="ignore")
                        for line in content.splitlines():
                            line_s = line.strip()
                            if line_s.startswith("- [ ]") or line_s.startswith("* [ ]"):
                                item_text = line_s[5:].strip()
                                item_text = re.sub(r"^/([a-zA-Z0-9_\-]+)\s*", "", item_text).strip()
                                if item_text and item_text not in intel["pending_tasks"] and len(item_text) < 140:
                                    intel["pending_tasks"].append(item_text)
                            elif line_s.startswith("- [x]") or line_s.startswith("* [x]"):
                                item_text = line_s[5:].strip()
                                item_text = re.sub(r"^/([a-zA-Z0-9_\-]+)\s*", "", item_text).strip()
                                if item_text and item_text not in intel["completed_tasks"] and len(item_text) < 140:
                                    intel["completed_tasks"].append(item_text)
                    except Exception:
                        pass

    intel["all_requests"] = recent_requests
    if recent_requests:
        intel["latest_directive"] = recent_requests[0]

    return intel


def discover_project_handoff_and_specs(repo_root: Path) -> Dict[str, Any]:
    """
    Pillar 1: Specifically scan for handoff documents, product specifications,
    walkthroughs, and roadmap files to serve as primary source of truth.
    """
    result: Dict[str, Any] = {
        "found": False,
        "file": "",
        "rel_path": "",
        "doc_type": "",
        "title": "",
        "summary": "",
        "next_steps_items": [],
        "uncompleted_tasks": [],
        "completed_tasks": [],
        "sections": {},
    }

    # Priority candidate paths
    candidates = [
        # Handoff documents
        ("HANDOFF.md", "handoff"),
        ("handoff.md", "handoff"),
        ("project_handoff.md", "handoff"),
        ("PROJECT_HANDOFF.md", "handoff"),
        (".antigravity/handoff.md", "handoff"),
        (".antigravity/HANDOFF.md", "handoff"),
        ("docs/HANDOFF.md", "handoff"),
        ("docs/handoff.md", "handoff"),
        # Walkthrough documents
        ("WALKTHROUGH.md", "walkthrough"),
        ("walkthrough.md", "walkthrough"),
        ("docs/WALKTHROUGH.md", "walkthrough"),
        ("docs/walkthrough.md", "walkthrough"),
        # Product & Specification documents
        ("PRODUCT.md", "product"),
        ("product.md", "product"),
        ("docs/PRODUCT.md", "product"),
        ("ROADMAP.md", "roadmap"),
        ("roadmap.md", "roadmap"),
        ("TODO.md", "todo"),
        ("todo.md", "todo"),
        ("ARCHITECTURE.md", "architecture"),
        ("architecture.md", "architecture"),
        ("SPECIFICATION.md", "spec"),
        ("specification.md", "spec"),
        ("SPEC.md", "spec"),
        ("spec.md", "spec"),
        # Design document (lower priority per user directive)
        ("DESIGN.md", "design"),
        ("design.md", "design"),
    ]

    for rel_cand, doc_type in candidates:
        cand_path = repo_root / rel_cand
        if cand_path.exists() and cand_path.is_file():
            try:
                content = cand_path.read_text(encoding="utf-8", errors="ignore").strip()
                if not content or len(content) < 40:
                    continue

                result["found"] = True
                result["file"] = str(cand_path)
                result["rel_path"] = rel_cand
                result["doc_type"] = doc_type

                lines = content.splitlines()

                # Extract title
                for line in lines:
                    if line.strip().startswith("# "):
                        result["title"] = line.strip().lstrip("#").strip()
                        break
                if not result["title"]:
                    result["title"] = cand_path.stem.replace("_", " ").title()

                current_section = ""
                section_lines: Dict[str, List[str]] = {}

                for line in lines:
                    line_s = line.strip()
                    if line_s.startswith("## ") or line_s.startswith("### "):
                        current_section = line_s.lstrip("#").strip().lower()
                        section_lines.setdefault(current_section, [])
                    elif current_section:
                        section_lines[current_section].append(line_s)

                    # Extract checklist tasks
                    if line_s.startswith("- [ ]") or line_s.startswith("* [ ]"):
                        task_text = line_s[5:].strip()
                        if task_text and task_text not in result["uncompleted_tasks"]:
                            result["uncompleted_tasks"].append(task_text)
                    elif line_s.startswith("- [x]") or line_s.startswith("* [x]"):
                        task_text = line_s[5:].strip()
                        if task_text and task_text not in result["completed_tasks"]:
                            result["completed_tasks"].append(task_text)

                for sec_name, s_lines in section_lines.items():
                    text_blob = "\n".join([l for l in s_lines if l and not l.strip().startswith("<!--")])
                    result["sections"][sec_name] = text_blob
                    # If this section is explicitly Next Steps / Remaining Work
                    if any(k in sec_name for k in ("next step", "remaining", "roadmap", "priority", "upcoming", "deliverable")):
                        for l in s_lines:
                            clean_l = l.lstrip("-*123456789. ").strip()
                            clean_l = re.sub(r"<!--.*?-->", "", clean_l).strip()
                            if clean_l and len(clean_l) > 10 and clean_l not in result["next_steps_items"]:
                                result["next_steps_items"].append(clean_l)

                # Prioritize explicit purpose/overview/description sections for summary
                found_purpose = ""
                for sec_k, sec_v in result["sections"].items():
                    if any(pk in sec_k for pk in ("product purpose", "purpose", "overview", "description", "mission", "goal", "about")):
                        clean_lines = [l.strip() for l in sec_v.splitlines() if l.strip() and not l.strip().startswith("<!--") and not l.strip().startswith("#")]
                        if clean_lines:
                            found_purpose = " ".join(clean_lines[:2])
                            break

                if found_purpose:
                    result["summary"] = re.sub(r"<!--.*?-->", "", found_purpose).strip()
                else:
                    summary_lines = []
                    for line in lines:
                        line_s = line.strip()
                        if line_s and not line_s.startswith("#") and not line_s.startswith("[") and not line_s.startswith("!") and not line_s.startswith("```") and not line_s.startswith("<!--"):
                            clean_s = re.sub(r"<!--.*?-->", "", line_s).strip()
                            if clean_s:
                                summary_lines.append(clean_s)
                                if len(summary_lines) >= 3:
                                    break
                    result["summary"] = " ".join(summary_lines[:2])

                # Enrich generic document titles (e.g. # Product -> QA Watchdog Product Specification)
                if result["title"].lower() in ("product", "handoff", "walkthrough", "roadmap", "specification", "spec", "todo"):
                    clean_repo_title = repo_root.name.replace("_", " ").replace("-", " ").title()
                    result["title"] = f"{clean_repo_title} {result['title']}"

                break
            except Exception:
                continue

    return result


def discover_project_manifests(repo_root: Path) -> Dict[str, Any]:
    """
    Pillar 2: Inspect package manifests (package.json, pyproject.toml, Cargo.toml, go.mod)
    to determine the project's purpose, dependencies, scripts, and test commands.
    """
    manifest: Dict[str, Any] = {
        "manifest_type": "",
        "name": "",
        "description": "",
        "version": "",
        "tech_stack": set(),
        "scripts": {},
        "test_command": "",
        "build_command": "",
    }

    # 1. package.json
    pkg_file = repo_root / "package.json"
    if pkg_file.exists():
        try:
            pdata = json.loads(pkg_file.read_text(encoding="utf-8"))
            manifest["manifest_type"] = "npm"
            manifest["name"] = pdata.get("name", "")
            manifest["description"] = pdata.get("description", "")
            manifest["version"] = pdata.get("version", "")
            manifest["scripts"] = pdata.get("scripts", {})

            deps = {**pdata.get("dependencies", {}), **pdata.get("devDependencies", {})}
            if "react" in deps:
                manifest["tech_stack"].add("React")
            if "vue" in deps:
                manifest["tech_stack"].add("Vue")
            if "svelte" in deps:
                manifest["tech_stack"].add("Svelte")
            if "vite" in deps:
                manifest["tech_stack"].add("Vite")
            if "next" in deps:
                manifest["tech_stack"].add("Next.js")
            if "electron" in deps:
                manifest["tech_stack"].add("Electron")
            if "playwright" in deps or "@playwright/test" in deps:
                manifest["tech_stack"].add("Playwright")
            if "jest" in deps:
                manifest["tech_stack"].add("Jest")
            if "vitest" in deps:
                manifest["tech_stack"].add("Vitest")
            if "tailwindcss" in deps:
                manifest["tech_stack"].add("TailwindCSS")
            if "typescript" in deps:
                manifest["tech_stack"].add("TypeScript")
            else:
                manifest["tech_stack"].add("JavaScript")

            if "test" in manifest["scripts"]:
                manifest["test_command"] = "npm test"
            if "build" in manifest["scripts"]:
                manifest["build_command"] = "npm run build"
        except Exception:
            pass

    # 2. Python (pyproject.toml, setup.py, requirements.txt)
    pyproject = repo_root / "pyproject.toml"
    if pyproject.exists():
        try:
            content = pyproject.read_text(encoding="utf-8", errors="ignore")
            manifest["manifest_type"] = manifest["manifest_type"] or "python"
            manifest["tech_stack"].add("Python")
            m_desc = re.search(r'description\s*=\s*["\']([^"\']+)["\']', content)
            if m_desc and not manifest["description"]:
                manifest["description"] = m_desc.group(1)
            if "pytest" in content:
                manifest["test_command"] = "pytest"
            if "fastapi" in content.lower():
                manifest["tech_stack"].add("FastAPI")
            if "django" in content.lower():
                manifest["tech_stack"].add("Django")
        except Exception:
            pass

    req_file = repo_root / "requirements.txt"
    if req_file.exists():
        manifest["tech_stack"].add("Python")
        try:
            req_content = req_file.read_text(encoding="utf-8", errors="ignore")
            if "pytest" in req_content and not manifest["test_command"]:
                manifest["test_command"] = "pytest"
        except Exception:
            pass

    # 3. Cargo.toml
    cargo_file = repo_root / "Cargo.toml"
    if cargo_file.exists():
        manifest["manifest_type"] = manifest["manifest_type"] or "cargo"
        manifest["tech_stack"].add("Rust")
        manifest["test_command"] = manifest["test_command"] or "cargo test"
        manifest["build_command"] = manifest["build_command"] or "cargo build"

    # 4. go.mod
    go_mod = repo_root / "go.mod"
    if go_mod.exists():
        manifest["manifest_type"] = manifest["manifest_type"] or "go"
        manifest["tech_stack"].add("Go")
        manifest["test_command"] = manifest["test_command"] or "go test ./..."

    manifest["tech_stack"] = sorted(list(manifest["tech_stack"]))
    return manifest


def parse_full_readme(repo_root: Path) -> Dict[str, Any]:
    """
    Pillar 2: Read the entire README.md to synthesize the project mission,
    features, architecture, and current development status.
    """
    result: Dict[str, Any] = {
        "found": False,
        "title": "",
        "tagline": "",
        "features": [],
        "overview": "",
        "roadmap_items": [],
    }

    readme_path = None
    for cand in ("README.md", "readme.md", "README", "Readme.md"):
        p = repo_root / cand
        if p.exists() and p.is_file():
            readme_path = p
            break

    if not readme_path:
        return result

    try:
        content = readme_path.read_text(encoding="utf-8", errors="ignore").strip()
        result["found"] = True
        lines = content.splitlines()

        for line in lines:
            if line.strip().startswith("# "):
                result["title"] = line.strip().lstrip("#").strip()
                break

        # Extract tagline / overview
        overview_lines = []
        for line in lines:
            line_s = line.strip()
            if line_s.startswith("#"):
                continue
            if line_s and not line_s.startswith("[") and not line_s.startswith("!") and not line_s.startswith("```"):
                overview_lines.append(line_s)
                if len(overview_lines) >= 3:
                    break
        result["overview"] = " ".join(overview_lines)
        if overview_lines:
            result["tagline"] = overview_lines[0]

        # Extract features and roadmap
        current_section = ""
        for line in lines:
            line_s = line.strip()
            if line_s.startswith("## "):
                current_section = line_s.lstrip("#").strip().lower()
            elif current_section:
                if any(k in current_section for k in ("feature", "capabilities", "highlight", "what is")):
                    if line_s.startswith("- ") or line_s.startswith("* "):
                        feat = line_s.lstrip("-* ").strip()
                        if feat and len(feat) > 5 and feat not in result["features"]:
                            result["features"].append(feat)
                elif any(k in current_section for k in ("roadmap", "upcoming", "todo", "next step")):
                    if line_s.startswith("- ") or line_s.startswith("* ") or line_s.startswith("- [ ]"):
                        item = line_s.lstrip("-* [ ]").strip()
                        if item and len(item) > 5 and item not in result["roadmap_items"]:
                            result["roadmap_items"].append(item)
    except Exception:
        pass

    return result


def deep_analyze_codebase(repo_root: Path, head_sha: str = "HEAD") -> Dict[str, Any]:
    """
    Pillar 3: Traverse the whole repository tree, categorize source files into
    architectural layers, detect entry points, scan active TODOs/FIXMEs,
    and trace recent git commit velocity.
    """
    codebase: Dict[str, Any] = {
        "entry_points": [],
        "ui_files": [],
        "logic_files": [],
        "test_files": [],
        "config_files": [],
        "all_source_files": [],
        "todos": [],
        "recent_commits": [],
        "dirty_files": [],
        "changed_files_head": [],
        "languages": set(),
        "has_tests": False,
    }

    # 1. Traverse directory tree
    try:
        for p in repo_root.rglob("*"):
            if not p.is_file():
                continue
            rel_str = str(p.relative_to(repo_root))

            # Skip ignored directories
            parts = p.relative_to(repo_root).parts
            if any(part in SKIP_SCAN_DIRS or part.startswith(".") for part in parts[:-1]):
                continue
            if ".antigravity" in parts or "worktrees" in parts:
                continue

            ext = p.suffix.lower()
            fname = p.name.lower()

            if ext in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".rs", ".go", ".cpp", ".c", ".h", ".html", ".css", ".scss", ".vue", ".svelte"):
                codebase["all_source_files"].append(rel_str)

                # Classify into architectural layers
                if fname in ("index.html", "main.mjs", "app.js", "main.py", "app.py", "server.js", "server.py", "cli.py", "index.ts", "main.ts", "main.tsx", "qa_ctl.py"):
                    codebase["entry_points"].append(rel_str)
                elif ext in (".tsx", ".jsx", ".vue", ".svelte", ".html", ".css", ".scss") or "sidecars/panel" in rel_str or "ui" in parts:
                    codebase["ui_files"].append(rel_str)
                elif "test" in fname or "spec" in fname or "tests" in parts or "test" in parts:
                    codebase["test_files"].append(rel_str)
                    codebase["has_tests"] = True
                else:
                    codebase["logic_files"].append(rel_str)

                if ext in (".ts", ".tsx"):
                    codebase["languages"].add("TypeScript")
                elif ext in (".js", ".jsx", ".mjs"):
                    codebase["languages"].add("JavaScript")
                elif ext == ".py":
                    codebase["languages"].add("Python")
                elif ext in (".html", ".css", ".scss"):
                    codebase["languages"].add("Web UI")
                elif ext == ".rs":
                    codebase["languages"].add("Rust")
                elif ext == ".go":
                    codebase["languages"].add("Go")

                # Scan for TODO/FIXME markers
                if p.stat().st_size < 250000 and len(codebase["todos"]) < 30:
                    try:
                        for i, line in enumerate(p.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
                            if any(k in line for k in ("TODO", "FIXME", "BUG", "HACK")) and len(line.strip()) < 140:
                                codebase["todos"].append({
                                    "file": rel_str,
                                    "line": i,
                                    "text": line.strip(),
                                })
                                if len(codebase["todos"]) >= 30:
                                    break
                    except Exception:
                        pass
            elif fname in ("package.json", "tsconfig.json", "pyproject.toml", "cargo.toml", "vite.config.ts", "vite.config.js", "docker-compose.yml"):
                codebase["config_files"].append(rel_str)
    except Exception:
        pass

    codebase["languages"] = sorted(list(codebase["languages"]))

    # 2. Git velocity: last 15 commits
    rc_log, log_out, _ = run_git(repo_root, ["log", "-n", "15", "--format=%H%x09%h%x09%s%x09%cd%x09%an"])
    if rc_log == 0 and log_out:
        for line in log_out.splitlines():
            parts = line.split("\t")
            if len(parts) >= 3:
                codebase["recent_commits"].append({
                    "sha": parts[0],
                    "short_sha": parts[1],
                    "subject": parts[2],
                    "date": parts[3] if len(parts) > 3 else "",
                    "author": parts[4] if len(parts) > 4 else "",
                })

    # 3. Head commit delta
    rc_diff, diff_out, _ = run_git(repo_root, ["diff-tree", "--no-commit-id", "--name-status", "-r", head_sha])
    if rc_diff != 0 or not diff_out.strip():
        rc_diff, diff_out, _ = run_git(repo_root, ["diff", "--name-status", "HEAD~1..HEAD"])
    if rc_diff == 0 and diff_out:
        for line in diff_out.splitlines():
            parts = line.strip().split("\t", 1)
            if len(parts) == 2:
                codebase["changed_files_head"].append({"status": parts[0], "path": parts[1]})

    # 4. Dirty working tree files
    rc_st, st_out, _ = run_git(repo_root, ["status", "--porcelain"])
    if rc_st == 0 and st_out:
        for line in st_out.splitlines():
            line_s = line.strip()
            if not line_s:
                continue
            parts = line_s.split(maxsplit=1)
            if len(parts) == 2:
                codebase["dirty_files"].append({"status": parts[0], "path": parts[1].strip()})

    return codebase


def load_goal(repo_root: Path) -> Dict[str, Any]:
    """
    Multi-source hierarchical goal discovery:
    1. User override in .antigravity/next_steps/goal.json
    2. Discovered Handoff / Product document (highest automated authority)
    3. Package Manifest description (package.json / pyproject.toml)
    4. Full README.md overview / tagline
    5. Earliest / latest user conversation intent
    6. Initial git commit subject
    7. Repository name fallback
    """
    # 1. Custom override
    goal_file = repo_root / ".antigravity" / NEXT_STEPS_DIR_NAME / "goal.json"
    if goal_file.exists():
        try:
            data = json.loads(goal_file.read_text(encoding="utf-8"))
            if data.get("goal"):
                return data
        except Exception:
            pass

    # 2. Handoff / Product document
    handoff = discover_project_handoff_and_specs(repo_root)
    if handoff.get("found"):
        title = handoff.get("title", "")
        summary = handoff.get("summary", "")
        uncompleted = handoff.get("uncompleted_tasks", [])
        doc_type_label = "Product Spec" if handoff.get("doc_type") == "product" else ("Walkthrough" if handoff.get("doc_type") == "walkthrough" else "Handoff")
        source_label = f"{doc_type_label} ({handoff['rel_path']})"
        clean_sum = re.sub(r"<!--.*?-->", "", summary).strip()
        if clean_sum and len(clean_sum) > 15:
            return {
                "goal": f"{title} - {clean_sum[:130]}",
                "source": source_label,
                "updatedAt": now_iso(),
            }
        elif uncompleted:
            clean_unc = re.sub(r"^/([a-zA-Z0-9_\-]+)\s*", "", uncompleted[0]).strip()
            return {
                "goal": f"{title} - Next: {clean_unc[:100]}",
                "source": source_label,
                "updatedAt": now_iso(),
            }
        elif title:
            return {
                "goal": title,
                "source": source_label,
                "updatedAt": now_iso(),
            }

    # 3. Package manifest
    manifest = discover_project_manifests(repo_root)
    if manifest.get("description"):
        return {
            "goal": f"{manifest.get('name', repo_root.name)}: {manifest['description']}",
            "source": f"{manifest.get('manifest_type') or 'package'}.json",
            "updatedAt": now_iso(),
        }

    # 4. Full README
    readme = parse_full_readme(repo_root)
    if readme.get("found") and readme.get("tagline"):
        title_str = readme.get("title") or repo_root.name
        return {
            "goal": f"{title_str} - {readme['tagline'][:120]}",
            "source": "README.md",
            "updatedAt": now_iso(),
        }

    # 5. Conversation intent
    convs = get_project_conversations(repo_root)
    if convs:
        sorted_convs = sorted(convs, key=lambda c: c.get("lastModifiedTime") or "")
        for c in sorted_convs:
            reqs = get_conversation_user_requests(c["conversationId"], limit=1)
            if reqs:
                first_req = reqs[0].split("\n")[0].strip()
                if len(first_req) > 12:
                    return {
                        "goal": first_req[:140],
                        "source": f"Conversation ({c.get('title') or 'Earliest Prompt'})",
                        "updatedAt": now_iso(),
                    }

    # 6. Initial commit
    rc, init_sha, _ = run_git(repo_root, ["rev-list", "--max-parents=0", "HEAD"])
    if rc == 0 and init_sha.strip():
        first_sha = init_sha.strip().splitlines()[0]
        first_info = get_commit_info(repo_root, first_sha)
        if first_info and first_info.get("subject") and not first_info["subject"].lower().startswith("initial commit"):
            return {
                "goal": first_info["subject"],
                "source": "Initial Commit",
                "updatedAt": now_iso(),
            }

    return {
        "goal": f"Develop and maintain {repo_root.name}",
        "source": "Repository Name",
        "updatedAt": now_iso(),
    }


def save_goal_override(repo_root: Path, goal_text: str) -> Dict[str, Any]:
    ns_dir = repo_root / ".antigravity" / NEXT_STEPS_DIR_NAME
    ns_dir.mkdir(parents=True, exist_ok=True)
    goal_file = ns_dir / "goal.json"
    data = {
        "goal": goal_text.strip(),
        "source": "User Override",
        "updatedAt": now_iso(),
    }
    goal_file.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return data


def clear_goal_override(repo_root: Path) -> Dict[str, Any]:
    goal_file = repo_root / ".antigravity" / NEXT_STEPS_DIR_NAME / "goal.json"
    if goal_file.exists():
        goal_file.unlink()
    return load_goal(repo_root)


def analyze_codebase_delta(repo_root: Path, sha: str = "HEAD") -> Dict[str, Any]:
    """
    Backwards-compatible wrapper around deep_analyze_codebase.
    """
    deep = deep_analyze_codebase(repo_root, head_sha=sha)
    return {
        "changedFiles": deep["changed_files_head"],
        "languages": deep["languages"],
        "recentSubjects": [c["subject"] for c in deep["recent_commits"][:5]],
        "todos": deep["todos"][:5],
    }


def synthesize_next_steps(repo_root: Path, force: bool = False) -> Dict[str, Any]:
    """
    Synthesize up to 4 structured next-step implementation plans adhering to
    the official Antigravity /plan standard.

    Uses the 4-Pillar Project Intelligence Pipeline:
    1. Handoff & Specification Ingestion (Primary Ground Truth)
    2. Manifests & Full Readme Analysis
    3. Deep Codebase Tree, AST/Symbol, and Git Velocity Traversal
    4. All-Chats & Transcript Synthesizer

    Dynamically scores and selects the top 4 most impactful categories from:
    feature, architecture, robustness, performance, testing, security, ux, api.
    """
    ns_dir = repo_root / ".antigravity" / NEXT_STEPS_DIR_NAME
    ns_dir.mkdir(parents=True, exist_ok=True)
    proposals_file = ns_dir / "proposals.json"

    youngest, _ = get_youngest_commit(repo_root, limit=5)
    if not youngest:
        return {"ok": False, "error": "No commits found in repository."}

    head_sha = youngest["sha"]
    short_sha = youngest["short_sha"]
    subject = youngest["subject"]

    # Check cache if not forcing refresh
    if not force and proposals_file.exists():
        try:
            cached = json.loads(proposals_file.read_text(encoding="utf-8"))
            if cached.get("commitSha") == head_sha and cached.get("proposals"):
                return {
                    "ok": True,
                    "repo": str(repo_root),
                    "commitSha": head_sha,
                    "shortSha": short_sha,
                    "goal": cached.get("goal") or load_goal(repo_root),
                    "proposals": cached["proposals"],
                    "conversationsCount": len(get_project_conversations(repo_root)),
                    "cached": True,
                }
        except Exception:
            pass

    # -------------------------------------------------------------------------
    # Ingest 4 Pillars of Intelligence
    # -------------------------------------------------------------------------
    handoff = discover_project_handoff_and_specs(repo_root)
    manifest = discover_project_manifests(repo_root)
    readme = parse_full_readme(repo_root)
    codebase = deep_analyze_codebase(repo_root, head_sha=head_sha)
    convs = get_project_conversations(repo_root)
    chat_intel = deep_analyze_conversations(repo_root, convs)
    goal_data = load_goal(repo_root)
    goal_text = goal_data.get("goal") or f"Develop and maintain {repo_root.name}"

    # Determine core affected files from recent changes or key entry points
    recent_changed_paths = [f["path"] for f in codebase["changed_files_head"]]
    if not recent_changed_paths:
        recent_changed_paths = [f["path"] for f in codebase["dirty_files"]]
    if not recent_changed_paths:
        recent_changed_paths = codebase["entry_points"][:3] or codebase["logic_files"][:3] or codebase["all_source_files"][:3]

    latest_user_directive = chat_intel.get("latest_directive", "")
    pending_tasks = handoff.get("uncompleted_tasks", []) or handoff.get("next_steps_items", []) or chat_intel.get("pending_tasks", []) or readme.get("roadmap_items", [])

    # Compute intelligent test verification command
    if codebase["has_tests"] and manifest.get("test_command"):
        test_cmd = manifest["test_command"]
    elif codebase["has_tests"] and "Python" in codebase["languages"]:
        test_cmd = "pytest"
    elif "Python" in codebase["languages"] and ("JavaScript" in codebase["languages"] or "TypeScript" in codebase["languages"]):
        test_cmd = "python3 -m py_compile scripts/qa_ctl.py && node -c sidecars/panel/main.mjs && node --check sidecars/panel/app.js"
    elif "Python" in codebase["languages"]:
        main_py = codebase["entry_points"][0] if codebase["entry_points"] else "scripts/qa_ctl.py"
        test_cmd = f"python3 -m py_compile {main_py}"
    elif "JavaScript" in codebase["languages"] or "TypeScript" in codebase["languages"]:
        test_cmd = manifest.get("test_command") or "node -c sidecars/panel/main.mjs"
    else:
        test_cmd = manifest.get("test_command") or "git status"

    # -------------------------------------------------------------------------
    # Dynamic Category Scoring
    # -------------------------------------------------------------------------
    scores: Dict[str, float] = {
        "feature": 50.0,
        "architecture": 30.0,
        "robustness": 35.0,
        "performance": 25.0,
        "testing": 30.0,
        "security": 15.0,
        "ux": 20.0 if codebase["ui_files"] else 5.0,
        "api": 20.0,
    }

    # Signal 1: Handoff pending tasks or uncompleted items
    if pending_tasks:
        scores["feature"] += 60.0
    if handoff.get("found"):
        scores["feature"] += 30.0
        if "architecture" in handoff.get("sections", {}):
            scores["architecture"] += 20.0

    # Signal 2: Active chat requests and recent directives
    if latest_user_directive:
        ld_lower = latest_user_directive.lower()
        if any(w in ld_lower for w in ("overhaul", "refactor", "clean", "structure", "decouple", "architect")):
            scores["architecture"] += 50.0
        if any(w in ld_lower for w in ("fix", "bug", "crash", "stuck", "error", "boundary", "guard")):
            scores["robustness"] += 45.0
        if any(w in ld_lower for w in ("ui", "button", "polish", "color", "style", "layout", "tab", "card", "view", "visual")):
            scores["ux"] += 40.0
        if any(w in ld_lower for w in ("perf", "fast", "speed", "slow", "paginate", "cache", "memory", "lag")):
            scores["performance"] += 45.0
        if any(w in ld_lower for w in ("test", "verify", "coverage", "assert", "mock", "dx")):
            scores["testing"] += 40.0

    # Signal 3: Codebase TODOs and FIXMEs
    todo_count = len(codebase["todos"])
    if todo_count > 0:
        scores["robustness"] += min(todo_count * 5.0, 35.0)

    # Signal 4: Test presence gap
    if not codebase["has_tests"] and len(codebase["logic_files"]) > 2:
        scores["testing"] += 35.0
    elif codebase["has_tests"]:
        scores["testing"] += 15.0

    # Signal 5: UI files presence
    if codebase["ui_files"]:
        scores["ux"] += 25.0

    # Pick top 4 distinct categories
    ranked_cats = sorted(scores.keys(), key=lambda c: scores[c], reverse=True)[:4]

    # -------------------------------------------------------------------------
    # Formulate Tailored Proposal Meta for the Top 4 Categories
    # -------------------------------------------------------------------------
    proposals_meta: List[Dict[str, Any]] = []

    for cat in ranked_cats:
        if cat == "feature":
            # Target primary deliverable from handoff or latest chat directive
            primary_task = pending_tasks[0] if pending_tasks else (latest_user_directive[:80] if latest_user_directive else f"Expand core capabilities of {repo_root.name}")
            source_attribution = f"Derived from {handoff.get('rel_path') or 'recent project directives'}"
            target_files = recent_changed_paths[:3] or codebase["logic_files"][:3]

            proposals_meta.append({
                "category": "feature",
                "badge": "Milestone",
                "difficulty": "Medium",
                "estimatedTime": "30m",
                "title": f"Advance Milestone: {primary_task[:60].strip('.')}",
                "subtitle": f"{source_attribution}: {primary_task}",
                "summary": f"Sequential development milestone advancing '{goal_text[:80]}'. Builds upon recent commit {short_sha} ({subject}) to deliver the next critical feature.",
                "goals": [
                    f"Implement core logic for: '{primary_task[:70]}'",
                    f"Integrate changes with existing modules in {', '.join(target_files[:2])}",
                    f"Verify behavior against requirements in {handoff.get('rel_path') or 'project specification'}",
                ],
                "affectedFiles": target_files,
                "slug": "core-milestone",
            })

        elif cat == "architecture":
            target_files = codebase["entry_points"][:2] + codebase["logic_files"][:2]
            target_files = list(dict.fromkeys(target_files))[:3] or recent_changed_paths[:3]
            proposals_meta.append({
                "category": "architecture",
                "badge": "Architecture",
                "difficulty": "High",
                "estimatedTime": "35m",
                "title": f"Architectural Refactoring & Module Decoupling",
                "subtitle": f"Strengthen cohesion and interface isolation across {', '.join(target_files[:2])}",
                "summary": f"Decompose monolithic flows, isolate sidecar/controller boundaries, and enforce clean data contracts across {repo_root.name}.",
                "goals": [
                    f"Extract shared domain logic from {target_files[0] if target_files else 'entry points'} into modular components",
                    "Formalize clean parameter schemas and return types between subsystems",
                    "Eliminate circular references and reduce tight coupling across layers",
                ],
                "affectedFiles": target_files,
                "slug": "architecture-refactor",
            })

        elif cat == "robustness":
            todo_mention = f" ({codebase['todos'][0]['file']}:{codebase['todos'][0]['line']})" if codebase["todos"] else ""
            target_files = [t["file"] for t in codebase["todos"][:2]] if codebase["todos"] else recent_changed_paths[:3]
            target_files = list(dict.fromkeys(target_files))[:3]

            proposals_meta.append({
                "category": "robustness",
                "badge": "Robustness",
                "difficulty": "Low",
                "estimatedTime": "20m",
                "title": "Harden Edge Cases, Error Boundaries & Guardrails",
                "subtitle": f"Resolve pending markers{todo_mention} and add defensive null safety",
                "summary": f"Strengthen newly updated code paths in {', '.join(target_files[:2])} with explicit parameter guards, try/catch recovery, and boundary validation.",
                "goals": [
                    f"Address active TODO/FIXME markers in {target_files[0] if target_files else 'core files'}",
                    "Add defensive validation for empty/malformed inputs and subprocess execution",
                    "Ensure graceful fallback states instead of unhandled exceptions or crashes",
                ],
                "affectedFiles": target_files,
                "slug": "robustness-guardrails",
            })

        elif cat == "performance":
            target_files = recent_changed_paths[:3]
            proposals_meta.append({
                "category": "performance",
                "badge": "Performance",
                "difficulty": "Medium",
                "estimatedTime": "25m",
                "title": "Optimize Execution Latency, Memory & Caching",
                "subtitle": "Streamline I/O throughput, pagination, and data structures",
                "summary": f"Enhance runtime efficiency and responsiveness in {', '.join(target_files[:2])} through lazy evaluation, optimized caching, and reduced disk/network round-trips.",
                "goals": [
                    "Implement localized in-memory caching for repetitive file/command reads",
                    "Paginate heavy query datasets and eliminate redundant synchronous calls",
                    "Profile and minimize CPU/memory overhead during background polling",
                ],
                "affectedFiles": target_files,
                "slug": "performance-optimization",
            })

        elif cat == "testing":
            target_files = codebase["test_files"][:2] or [f"tests/test_{Path(f).stem}.py" if f.endswith(".py") else f"{f}.test.ts" for f in recent_changed_paths[:2]]
            proposals_meta.append({
                "category": "testing",
                "badge": "DX & Tests",
                "difficulty": "Medium",
                "estimatedTime": "20m",
                "title": f"Automated Regression Test Suite ({manifest.get('manifest_type') or 'CLI'})",
                "subtitle": f"Implement comprehensive unit & integration tests using '{test_cmd}'",
                "summary": f"Establish automated test fixtures and regression checks covering recent changes ({short_sha}) to ensure stability on future commits.",
                "goals": [
                    f"Write regression test cases verifying core behaviors introduced in {short_sha}",
                    "Establish deterministic mock fixtures for external subprocesses and file I/O",
                    f"Provide single-command verification via '{test_cmd}'",
                ],
                "affectedFiles": target_files,
                "slug": "automated-testing-dx",
            })

        elif cat == "security":
            target_files = recent_changed_paths[:3]
            proposals_meta.append({
                "category": "security",
                "badge": "Security",
                "difficulty": "Medium",
                "estimatedTime": "20m",
                "title": "Sanitize Input Boundaries & Path Traversal Guardrails",
                "subtitle": "Enforce strict schema validation and prevent unauthorized access",
                "summary": f"Harden filesystem access, subprocess arguments, and API payloads across {', '.join(target_files[:2])} against injection or traversal vulnerabilities.",
                "goals": [
                    "Validate and resolve all file paths against repository boundaries",
                    "Sanitize external inputs passed to shell commands and subprocess runners",
                    "Enforce strict payload validation on incoming API requests",
                ],
                "affectedFiles": target_files,
                "slug": "security-validation",
            })

        elif cat == "ux":
            target_files = codebase["ui_files"][:3] or recent_changed_paths[:3]
            proposals_meta.append({
                "category": "ux",
                "badge": "Polish & UX",
                "difficulty": "Medium",
                "estimatedTime": "20m",
                "title": "Refine Interface Polish, Loading States & Micro-Interactions",
                "subtitle": "Enhance visual hierarchy, button states, and layout responsiveness",
                "summary": f"Polish user-facing components in {', '.join(target_files[:2])}, adding smooth feedback states, loading spinners, and strict design token alignment.",
                "goals": [
                    "Implement responsive loading indicators, toasts, and clear empty states",
                    "Unify button heights, spacing, and icon alignment across card components",
                    "Ensure accessible typography, keyboard navigation, and theme consistency",
                ],
                "affectedFiles": target_files,
                "slug": "ux-polish",
            })

        elif cat == "api":
            target_files = codebase["entry_points"][:2] or recent_changed_paths[:2]
            proposals_meta.append({
                "category": "api",
                "badge": "API & DX",
                "difficulty": "Low",
                "estimatedTime": "15m",
                "title": "Enhance API Ergonomics, CLI Flags & Documentation",
                "subtitle": "Streamline developer interfaces, CLI help messages, and payloads",
                "summary": f"Refine the developer-facing interface in {', '.join(target_files[:2])}, adding comprehensive flag validation, self-documenting help, and structured JSON output.",
                "goals": [
                    "Provide clear CLI help text and option flags for all subcommands",
                    "Standardize JSON response payloads with consistent error reporting",
                    "Update documentation and inline docstrings to match current signatures",
                ],
                "affectedFiles": target_files,
                "slug": "api-ergonomics-dx",
            })

    # Ensure exactly 4 proposals are constructed
    proposals_meta = proposals_meta[:4]

    proposals: List[Dict[str, Any]] = []

    for i, meta in enumerate(proposals_meta, 1):
        plan_id = f"prop-{i}-{meta['slug']}"
        plan_filename = f"plan-{i}-{meta['slug']}.md"
        plan_file = ns_dir / plan_filename

        file_links_md = "\n".join([f"- [{f}](file://{str((repo_root / f).resolve())}): Core modifications" for f in meta["affectedFiles"]])
        goals_md = "\n".join([f"- [ ] {g}" for g in meta["goals"]])

        plan_content = f"""# Implementation Plan: {meta['title']}

{meta['summary']}

---

## User Review Required

> [!IMPORTANT]
> **Context & Evidence**:
> - **Project Goal:** {goal_text}
> - **Goal Source:** {goal_data.get('source', 'Discovered')}
> - **Current State:** Commit [`{short_sha}`](file://{str(repo_root)}) - {subject}
> - **Category:** {meta['badge']} ({meta['difficulty']} Difficulty, ~{meta['estimatedTime']})
> - **Directive / Handoff Context:** {handoff.get('title') or latest_user_directive or 'Sequential project roadmap'}

```mermaid
flowchart TD
    Current["Current State: {short_sha}"] --> Plan["{meta['title']}"]
    Plan --> Changes["Implement Changes in {', '.join(meta['affectedFiles'][:2]) or 'Target Files'}"]
    Changes --> Verify["Automated Verification ({test_cmd})"]
    Verify --> Complete["Milestone Completed"]
```

---

## Proposed Changes

### Key Deliverables
{goals_md}

### Affected Files
{file_links_md}

```markdown
<!-- Proposed Implementation Guidelines -->
- Adhere strictly to existing architectural conventions and design tokens.
- Maintain documentation integrity and preserve untouched comments.
- Test edge cases thoroughly before committing.
```

---

## Verification Plan

### Automated Tests
- Run test command: `{test_cmd}`
- Ensure zero linting or type errors across modified files.

### Manual Verification
- Verify functionality directly in the application or CLI.
- Confirm graceful handling when inputs are invalid or missing.
"""
        plan_file.write_text(plan_content, encoding="utf-8")

        proposal_entry = {
            "id": plan_id,
            "category": meta["category"],
            "badge": meta["badge"],
            "difficulty": meta["difficulty"],
            "estimatedTime": meta["estimatedTime"],
            "title": meta["title"],
            "subtitle": meta["subtitle"],
            "summary": meta["summary"],
            "goals": meta["goals"],
            "affectedFiles": meta["affectedFiles"],
            "planFile": f".antigravity/{NEXT_STEPS_DIR_NAME}/{plan_filename}",
            "planPath": str(plan_file),
            "commitContext": {
                "sha": head_sha,
                "shortSha": short_sha,
                "subject": subject,
            },
        }
        proposals.append(proposal_entry)

    cache_data = {
        "repo": str(repo_root),
        "commitSha": head_sha,
        "shortSha": short_sha,
        "goal": goal_data,
        "generatedAt": now_iso(),
        "proposals": proposals,
        "intelligence": {
            "handoff": handoff.get("rel_path") or None,
            "manifest": manifest.get("manifest_type") or None,
            "techStack": manifest.get("tech_stack", []),
            "conversationsAnalyzed": len(convs),
            "todosCount": len(codebase["todos"]),
        },
    }
    proposals_file.write_text(json.dumps(cache_data, indent=2), encoding="utf-8")

    return {
        "ok": True,
        "repo": str(repo_root),
        "commitSha": head_sha,
        "shortSha": short_sha,
        "goal": goal_data,
        "proposals": proposals,
        "conversationsCount": len(convs),
        "intelligence": cache_data["intelligence"],
    }



def spawn_plan_agent(repo_root: Path, plan_title: str, plan_markdown: str) -> Optional[str]:
    """
    Launch a background Antigravity agent conversation to execute a Next Steps plan.
    """
    env = get_cached_ls_env()
    agentapi_bin = env.get("ANTIGRAVITY_AGENTAPI_EXE") or str(AGENTAPI_DEFAULT)
    if not Path(agentapi_bin).exists():
        return None

    prompt = f"""[NEXT-STEPS-SESSION]
You are tasked with executing the following approved implementation plan:

{plan_markdown}

Execute this plan step by step, adhering to the plan specifications, writing necessary tests, and verifying results.
"""
    title = f"Next Step: {plan_title}"
    if "language_server" in Path(agentapi_bin).name:
        cmd = [agentapi_bin, "agentapi", "new-conversation", f"--title={title}", prompt]
    else:
        cmd = [agentapi_bin, "new-conversation", f"--title={title}", prompt]

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=str(repo_root),
            env=env,
            timeout=10,
        )
        if proc.returncode == 0:
            data = json.loads(proc.stdout)
            return data.get("conversationId") or data.get("response", {}).get("conversationId")
    except Exception:
        pass
    return None


def execute_plan_in_agent(repo_root: Path, plan_id: str) -> Dict[str, Any]:
    """
    Prepare prompt or launch detached agent conversation for an approved next step plan.
    """
    ns_dir = repo_root / ".antigravity" / NEXT_STEPS_DIR_NAME
    proposals_file = ns_dir / "proposals.json"
    if not proposals_file.exists():
        return {"ok": False, "error": "No proposals found for repository. Run 'next-steps' first."}

    try:
        data = json.loads(proposals_file.read_text(encoding="utf-8"))
        proposals = data.get("proposals", [])
        matched = next((p for p in proposals if p["id"] == plan_id), None)
        if not matched:
            return {"ok": False, "error": f"Proposal '{plan_id}' not found."}

        plan_path = Path(matched["planPath"])
        if not plan_path.exists():
            plan_path = repo_root / matched["planFile"]
        if not plan_path.exists():
            return {"ok": False, "error": f"Plan file not found: {matched.get('planFile')}"}

        plan_content = plan_path.read_text(encoding="utf-8")
        title = matched["title"]

        conv_id = spawn_plan_agent(repo_root, title, plan_content)
        prompt_text = f"[NEXT-STEPS-SESSION]\nImplement the approved plan '{title}':\n\n{plan_content}"

        return {
            "ok": True,
            "planId": plan_id,
            "title": title,
            "dispatched": bool(conv_id),
            "conversationId": conv_id,
            "prompt": prompt_text,
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def inspect_repo_details(repo_root: Path) -> Optional[Dict[str, Any]]:
    youngest, recent = get_youngest_commit(repo_root, limit=12)
    if not youngest:
        return None
    rc_b, branch, _ = run_git(repo_root, ["rev-parse", "--abbrev-ref", "HEAD"])
    rc_fb, fb_out, _ = run_git(repo_root, ["branch", "--list", "fix/qa-*", "--format=%(refname:short)"])
    fix_branches = [b.strip() for b in fb_out.splitlines() if b.strip()] if rc_fb == 0 and fb_out else []

    audits_dir = repo_root / ".antigravity" / "audits"
    reports = []
    if audits_dir.exists():
        try:
            for f in sorted(audits_dir.glob("review-*.md"), key=lambda x: x.stat().st_mtime, reverse=True)[:15]:
                st = f.stat()
                reports.append(
                    {
                        "name": f.name,
                        "shortSha": f.stem.replace("review-", ""),
                        "path": str(f),
                        "updatedAt": datetime.datetime.fromtimestamp(st.st_mtime, tz=datetime.timezone.utc).isoformat(),
                        "mtimeMs": int(st.st_mtime * 1000),
                    }
                )
        except Exception:
            pass

    ns_dir = repo_root / ".antigravity" / NEXT_STEPS_DIR_NAME
    proposals_file = ns_dir / "proposals.json"
    proposals = []
    if proposals_file.exists():
        try:
            p_data = json.loads(proposals_file.read_text(encoding="utf-8"))
            proposals = p_data.get("proposals", [])
        except Exception:
            pass

    goal_data = load_goal(repo_root)
    convs = get_project_conversations(repo_root)

    return {
        "repoPath": str(repo_root),
        "repoName": repo_root.name,
        "branch": branch if rc_b == 0 and branch else "HEAD",
        "head": {
            "sha": youngest["sha"],
            "shortSha": youngest["short_sha"],
            "subject": youngest["subject"],
            "relativeTime": youngest.get("relative_time", ""),
            "committedAt": youngest.get("committed_at", ""),
            "timestamp": youngest.get("timestamp", 0),
            "author": youngest.get("author", ""),
        },
        "youngestCommit": youngest,
        "recentCommits": recent,
        "fixBranches": fix_branches,
        "reports": reports,
        "goal": goal_data,
        "proposals": proposals,
        "conversationsCount": len(convs),
    }


def sync_git_history(workspace_paths: List[str]) -> Dict[str, Any]:
    """
    Scan workspace_paths (and tracked repos in state.json), discover all Git repositories
    (including nested ones), find the youngest commit in each, prune stale empty-tree
    wrapper repos, update baseline SHAs in state.json, and return the synced summary.
    """
    with StateLock():
        state = load_state()
        requested_roots = set()
        discovered_roots: List[Path] = []
        seen_roots = set()

        for wp in workspace_paths:
            if not wp:
                continue
            for r in discover_git_roots(wp):
                requested_roots.add(str(r))
                if str(r) not in seen_roots:
                    seen_roots.add(str(r))
                    discovered_roots.append(r)

        for tracked_path in list(state.get("repos", {}).keys()):
            for r in discover_git_roots(tracked_path):
                if str(r) not in seen_roots:
                    seen_roots.add(str(r))
                    discovered_roots.append(r)

        repo_details: List[Dict[str, Any]] = []
        for r in discovered_roots:
            details = inspect_repo_details(r)
            if details:
                details["inRequestedWorkspace"] = (
                    (str(r) in requested_roots) if requested_roots else True
                )
                repo_details.append(details)

        # Sort by: (inRequestedWorkspace, not is_empty_tree, youngestCommit.timestamp) DESC
        repo_details.sort(
            key=lambda d: (
                1 if d.get("inRequestedWorkspace", True) else 0,
                0 if d["youngestCommit"].get("is_empty_tree") else 1,
                int(d["youngestCommit"].get("timestamp", 0)),
            ),
            reverse=True,
        )

        # Prune any tracked outer wrapper repo in state["repos"] that has an empty-tree commit
        # or contains a nested active repository inside it
        new_repos_state: Dict[str, Any] = {}
        empty_wrapper_paths = set()
        for d in repo_details:
            rpath = d["repoPath"]
            yc = d["youngestCommit"]
            has_nested_child = any(
                other["repoPath"] != rpath and other["repoPath"].startswith(rpath + "/")
                for other in repo_details
            )
            if yc.get("is_empty_tree") and has_nested_child:
                empty_wrapper_paths.add(rpath)
                continue
            new_repos_state[rpath] = {
                "name": d["repoName"],
                "baseline_sha": yc["sha"],
                "youngest_short_sha": yc["short_sha"],
                "youngest_subject": yc["subject"],
                "youngest_committed_at": yc.get("committed_at", ""),
                "updated_at": now_iso(),
            }

        # Also check any previous state["repos"] entries that were empty wrappers of discovered repos
        for old_rpath in list(state.get("repos", {}).keys()):
            if any(
                d["repoPath"] != old_rpath and d["repoPath"].startswith(old_rpath + "/")
                for d in repo_details
            ):
                info = get_commit_info(Path(old_rpath), "HEAD")
                if not info or info.get("is_empty_tree"):
                    empty_wrapper_paths.add(old_rpath)

        # Filter out empty wrapper repos from repo_details and state["jobs"]
        if empty_wrapper_paths:
            repo_details = [d for d in repo_details if d["repoPath"] not in empty_wrapper_paths]
            state["jobs"] = [
                j for j in state.get("jobs", []) if j.get("repo_path") not in empty_wrapper_paths
            ]

        # Reconcile any completed jobs whose fix commits have already been applied to HEAD
        for j in state.get("jobs", []):
            if j.get("fixes_committed") and j.get("fix_branch") and not j.get("fixes_applied"):
                jr_path = Path(j.get("repo_path", ""))
                fb = j["fix_branch"]
                if jr_path.exists():
                    rc_fb, _, _ = run_git(jr_path, ["rev-parse", "--verify", f"refs/heads/{fb}"])
                    if rc_fb != 0:
                        j["fixes_applied"] = True
                        j["fixes_committed"] = False
                        j["fix_branch"] = None
                        continue
                    rc_d, diff_out, _ = run_git(jr_path, ["diff", f"HEAD..{fb}"])
                    if rc_d == 0 and not diff_out.strip():
                        j["fixes_applied"] = True
                        j["fixes_committed"] = False
                        j["fix_branch"] = None
                        run_git(jr_path, ["branch", "-D", fb])

        state["repos"] = new_repos_state
        save_state(state)

    best_repo = repo_details[0] if repo_details else None
    return {
        "ok": True,
        "syncedAt": now_iso(),
        "bestRepo": best_repo,
        "youngestCommit": best_repo["youngestCommit"] if best_repo else None,
        "recentCommits": best_repo["recentCommits"] if best_repo else [],
        "activeRepos": repo_details,
        "prunedWrapperRepos": list(empty_wrapper_paths),
    }


DOC_EXTS = {
    ".md", ".markdown", ".mdown", ".mkdn", ".txt", ".rst", ".adoc", ".asciidoc", ".pdf",
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".bmp"
}
DOC_FILENAMES = {
    "readme", "license", "licence", "copying", "changelog", "changes", "history",
    "contributing", "code_of_conduct", "security", "authors", "contributors",
    ".gitignore", ".gitattributes", ".gitmodules", ".editorconfig",
    ".prettierignore", ".eslintignore", ".npmignore", ".dockerignore", ".mailmap"
}


def is_docs_only_commit(repo_root: Path, sha: str, base_sha: str = "") -> bool:
    rc_log, subject, _ = run_git(repo_root, ["log", "-1", "--format=%s", sha])
    subject = subject.lower().strip()
    is_docs_conventional = bool(re.match(r"^docs?(\([^)]+\))?:", subject))

    if base_sha:
        rc, out, _ = run_git(repo_root, ["diff", "--name-only", base_sha, sha])
    else:
        rc, out, _ = run_git(repo_root, ["show", "--pretty=", "--name-only", sha])
    if rc != 0 or not out:
        return False
    files = [f.strip() for f in out.splitlines() if f.strip()]
    if not files:
        return True

    parent = base_sha or f"{sha}~1"
    for f in files:
        if f.startswith(".antigravity/"):
            continue
        p = Path(f)
        base = p.name.lower()
        stem = p.stem.lower()
        ext = p.suffix.lower()
        if base in DOC_FILENAMES or stem in DOC_FILENAMES:
            continue
        if ext in DOC_EXTS:
            continue
        if base == "package.json" and is_docs_conventional:
            rc_d, diff_u0, _ = run_git(repo_root, ["diff", "-U0", f"{parent}..{sha}", "--", f])
            if rc_d == 0 and diff_u0:
                added_removed = "\n".join(
                    line for line in diff_u0.splitlines()
                    if (line.startswith("+") or line.startswith("-"))
                    and not line.startswith("+++") and not line.startswith("---")
                )
                code_pattern = re.compile(r'"(dependencies|devDependencies|peerDependencies|scripts|main|module|exports)"', re.IGNORECASE)
                if not code_pattern.search(added_removed):
                    continue
        return False
    return True


def repo_slug(repo_root: Path) -> str:
    safe_name = re.sub(r"[^a-zA-Z0-9_-]+", "-", repo_root.name).strip("-") or "repo"
    short_hash = hashlib.sha1(str(repo_root).encode("utf-8")).hexdigest()[:6]
    return f"{safe_name}-{short_hash}"


def ensure_git_exclude(repo_root: Path) -> None:
    """Add .antigravity/ to .git/info/exclude so audit reports don't dirty git status."""
    rc, git_common_dir, _ = run_git(repo_root, ["rev-parse", "--git-common-dir"])
    if rc != 0 or not git_common_dir:
        return
    gdir = (repo_root / git_common_dir).resolve()
    exclude_file = gdir / "info" / "exclude"
    try:
        exclude_file.parent.mkdir(parents=True, exist_ok=True)
        existing = exclude_file.read_text(encoding="utf-8") if exclude_file.exists() else ""
        if ".antigravity/" not in existing:
            with open(exclude_file, "a", encoding="utf-8") as fp:
                if existing and not existing.endswith("\n"):
                    fp.write("\n")
                fp.write("# Antigravity QA Watchdog local audit artifacts\n.antigravity/\n")
    except Exception:
        pass


def prepare_worktree(repo_root: Path, sha: str) -> Tuple[Path, str, Path]:
    """
    Create or reset an isolated Git worktree for `sha` on branch `fix/qa-<short_sha>`.
    Returns (worktree_path, fix_branch, report_path).
    """
    ensure_dirs()
    ensure_git_exclude(repo_root)
    if sha in ("HEAD", "YOUNGEST", ""):
        info, _ = get_youngest_commit(repo_root, limit=3)
    else:
        info = get_commit_info(repo_root, sha)
    if not info:
        raise RuntimeError(f"Could not resolve commit {sha} in {repo_root}")

    full_sha = info["sha"]
    short_sha = info["short_sha"]
    slug = repo_slug(repo_root)
    worktree_path = WORKTREES_DIR / f"{slug}-{short_sha}"
    fix_branch = f"fix/qa-{short_sha}"

    audits_dir = repo_root / ".antigravity" / "audits"
    audits_dir.mkdir(parents=True, exist_ok=True)
    report_path = audits_dir / f"review-{short_sha}.md"

    run_git(repo_root, ["worktree", "prune"])

    if worktree_path.exists():
        rc, _, _ = run_git(worktree_path, ["rev-parse", "--is-inside-work-tree"])
        if rc != 0:
            shutil.rmtree(worktree_path, ignore_errors=True)
        else:
            # Reset existing worktree to clean full_sha on fix_branch
            run_git(worktree_path, ["checkout", "-B", fix_branch, full_sha])
            run_git(worktree_path, ["reset", "--hard", full_sha])
            run_git(worktree_path, ["clean", "-fd"])

    if not worktree_path.exists():
        rc, _, err = run_git(
            repo_root,
            ["worktree", "add", "-B", fix_branch, str(worktree_path), full_sha],
            timeout=30,
        )
        if rc != 0:
            rc2, _, err2 = run_git(
                repo_root,
                ["worktree", "add", "--detach", str(worktree_path), full_sha],
                timeout=30,
            )
            if rc2 != 0:
                raise RuntimeError(f"Failed to create git worktree: {err} / {err2}")

    primary_nm = repo_root / "node_modules"
    wt_nm = worktree_path / "node_modules"
    if primary_nm.is_dir() and not wt_nm.exists():
        try:
            os.symlink(str(primary_nm), str(wt_nm))
        except Exception:
            pass

    for venv_name in (".venv", "venv"):
        primary_venv = repo_root / venv_name
        wt_venv = worktree_path / venv_name
        if primary_venv.is_dir() and not wt_venv.exists():
            try:
                os.symlink(str(primary_venv), str(wt_venv))
            except Exception:
                pass

    return worktree_path, fix_branch, report_path


def build_qa_prompt(job: Dict[str, Any]) -> str:
    repo_path = job["repo_path"]
    sha = job["sha"]
    short_sha = job["short_sha"]
    base_sha = job.get("base_sha") or f"{sha}~1"
    commit_msg = job.get("commit_msg", "")
    worktree_path = job["worktree_path"]
    fix_branch = job["fix_branch"]
    report_path = job["report_path"]
    user_comment = (job.get("user_comment") or "").strip()
    comment_block = ""
    if user_comment:
        comment_block = f"""
### User Focus Note & Instructions
> **User Note/Comment**: {user_comment}
*Please pay special attention to the user's specific request/note above while auditing and testing.*
"""

    ctl_script_path = str(Path(__file__).resolve())
    return f"""[QA-WATCHDOG-SESSION]
You are the **Autonomous Code & Visual QA Watchdog** reviewing a newly committed change.

First, read your operating skill instructions using `view_file`:
`{SKILL_PATH}`

### Target Audit Context
- **Primary Repository (DO NOT MODIFY SOURCE FILES HERE)**: `{repo_path}`
- **Isolated Worktree (RUN ALL CHECKS & FIXES HERE)**: `{worktree_path}`
- **Isolated Fix Branch**: `{fix_branch}`
- **Reviewed Commit**: `{sha}` (`{short_sha}`) — "{commit_msg}"
- **Base Commit for Diff**: `{base_sha}`
- **Target Audit Report Path**: `{report_path}`{comment_block}

### Required Execution Steps
1. **Code & Diff Audit (in `{worktree_path}`)**:
   - Inspect `git show --stat {sha}` and `git diff {base_sha}..{sha}` inside `{worktree_path}`.
   - Run applicable static checks (typecheck, linter, unit tests) inside `{worktree_path}`.
   - Evaluate correctness, edge cases, security, architecture, performance, functionality, and scalability.

2. **Live Visual & Functional QA (Playwright MCP)**:
   - If this project has a web UI / frontend or HTTP server, start an isolated instance from `{worktree_path}` on a free port (so you do not collide with any running dev server).
   - Use the `playwright` MCP tools (`browser_navigate`, `browser_snapshot`, `browser_take_screenshot`, `browser_click`, `browser_type`, `browser_resize`, `browser_console_messages`, `browser_network_requests`) to test affected routes and user flows like a real user at both Desktop (`1440x900`) and Mobile (`390x844`) viewports.
   - Stop any server process you started once browser testing is complete.

3. **Immediate Bug Fixes on Isolated Branch (`{fix_branch}`)**:
   - If you find confirmed, reproducible bugs (broken logic, crashes, build/type errors, broken UI layouts), fix them directly inside `{worktree_path}` on branch `{fix_branch}`, verify the fix, and commit with:
     `git commit -m "fix(qa): resolve issues in {short_sha} [auto-review]"`
   - Do NOT auto-commit speculative refactors or architectural rewrites; document those in the report.

4. **Write Report & Mark Job Complete**:
   - Write the full structured Markdown audit report to `{report_path}`.
   - Run the completion command:
     ```bash
     python3 "{ctl_script_path}" complete \\
       --repo "{repo_path}" \\
       --sha "{sha}" \\
       --verdict "<PASS|FIXED_ON_BRANCH|NEEDS_ATTENTION>" \\
       --summary "<concise 1-2 sentence summary of findings>" \\
       --bugs-count <number_of_bugs_found> \\
       --fixes-committed <true_or_false>
     ```
"""


def spawn_detached_agent(job: Dict[str, Any]) -> bool:
    """
    Launch a background QA conversation via `agentapi new-conversation`.
    """
    env = get_cached_ls_env()
    agentapi_bin = env.get("ANTIGRAVITY_AGENTAPI_EXE") or str(AGENTAPI_DEFAULT)
    if not Path(agentapi_bin).exists():
        return False

    prompt = build_qa_prompt(job)
    title = f"QA Watchdog: {job['repo_name']} @ {job['short_sha']}"
    log_file = LOGS_DIR / f"agent-{job['id']}.log"

    if "language_server" in Path(agentapi_bin).name:
        cmd = [agentapi_bin, "agentapi", "new-conversation", f"--title={title}", prompt]
    else:
        cmd = [agentapi_bin, "new-conversation", f"--title={title}", prompt]

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=job["worktree_path"] if Path(job["worktree_path"]).exists() else job["repo_path"],
            env=env,
            timeout=10,
        )
        with open(log_file, "a", encoding="utf-8") as lf:
            lf.write(f"\n[{now_iso()}] Dispatched QA Watchdog via {agentapi_bin} for {job['id']}\n")
            if proc.stdout:
                lf.write(f"STDOUT:\n{proc.stdout}\n")
            if proc.stderr:
                lf.write(f"STDERR:\n{proc.stderr}\n")

        if proc.returncode == 0:
            conv_id = None
            try:
                data = json.loads(proc.stdout)
                conv_id = data.get("conversationId") or data.get("response", {}).get("conversationId")
            except Exception:
                pass
            if conv_id:
                with StateLock():
                    st = load_state()
                    active = st.setdefault("active_qa_conversations", [])
                    if conv_id not in active:
                        active.append(conv_id)
                    for j in st.get("jobs", []):
                        if j["id"] == job["id"]:
                            j["conversation_id"] = conv_id
                            break
                    save_state(st)
            return True
        return False
    except Exception as exc:
        try:
            with open(log_file, "a", encoding="utf-8") as lf:
                lf.write(f"[{now_iso()}] Failed to spawn agentapi: {exc}\n")
        except Exception:
            pass
        return False


def queue_commit(
    repo_root: Path,
    sha: str = "YOUNGEST",
    base_sha: str = "",
    dispatch_now: bool = True,
    force: bool = False,
    user_comment: str = "",
) -> Optional[Dict[str, Any]]:
    # Always resolve "HEAD", "YOUNGEST", or "" to the youngest commit in the repository's history
    if sha in ("HEAD", "YOUNGEST", ""):
        info, _ = get_youngest_commit(repo_root, limit=5)
    else:
        info = get_commit_info(repo_root, sha)
    if not info:
        return None

    full_sha = info["sha"]
    short_sha = info["short_sha"]
    msg_full = f"{info['subject']}\n{info.get('body', '')}"

    if any(tag in msg_full for tag in SKIP_TAGS):
        return None

    slug = repo_slug(repo_root)
    job_id = f"{slug}-{short_sha}"

    with StateLock():
        state = load_state()
        repo_key = str(repo_root)

        if not force and state.get("skip_docs_only", True):
            if is_docs_only_commit(repo_root, full_sha, base_sha or info.get("parent_sha", "")):
                state.setdefault("repos", {})[repo_key] = {
                    "name": repo_root.name,
                    "baseline_sha": full_sha,
                    "updated_at": now_iso(),
                }
                save_state(state)
                return None

        existing_idx = next((i for i, j in enumerate(state["jobs"]) if j["id"] == job_id), None)
        if existing_idx is not None and not force:
            state.setdefault("repos", {})[repo_key] = {
                "name": repo_root.name,
                "baseline_sha": full_sha,
                "updated_at": now_iso(),
            }
            if user_comment:
                state["jobs"][existing_idx]["user_comment"] = user_comment.strip()
            save_state(state)
            return state["jobs"][existing_idx]

        worktree_path, fix_branch, report_path = prepare_worktree(repo_root, full_sha)

        job: Dict[str, Any] = {
            "id": job_id,
            "repo_path": repo_key,
            "repo_name": repo_root.name,
            "sha": full_sha,
            "short_sha": short_sha,
            "base_sha": base_sha or info.get("parent_sha") or f"{full_sha}~1",
            "commit_msg": info["subject"],
            "user_comment": user_comment.strip() if user_comment else None,
            "author": info["author"],
            "committed_at": info["committed_at"],
            "queued_at": now_iso(),
            "started_at": None,
            "completed_at": None,
            "status": "queued",
            "verdict": "PENDING",
            "summary": "Queued for code & visual QA review.",
            "bugs_count": 0,
            "fixes_committed": False,
            "fix_branch": fix_branch,
            "worktree_path": str(worktree_path),
            "report_path": str(report_path),
        }

        if existing_idx is not None:
            state["jobs"].pop(existing_idx)
        state["jobs"].insert(0, job)

        state.setdefault("repos", {})[repo_key] = {
            "name": repo_root.name,
            "baseline_sha": full_sha,
            "updated_at": now_iso(),
        }
        save_state(state)

    should_dispatch = dispatch_now and not state.get("paused", False) and state.get("auto_dispatch", True)
    if should_dispatch:
        dispatched = spawn_detached_agent(job)
        if dispatched:
            with StateLock():
                state = load_state()
                for j in state["jobs"]:
                    if j["id"] == job_id:
                        j["status"] = "running"
                        j["started_at"] = now_iso()
                        j["summary"] = "Autonomous QA Watchdog review in progress…"
                        break
                save_state(state)
                job["status"] = "running"

    return job


def complete_job(
    repo_root: Path,
    sha: str,
    verdict: str,
    summary: str,
    bugs_count: int = 0,
    fixes_committed: bool = False,
) -> Dict[str, Any]:
    info = get_commit_info(repo_root, sha)
    short_sha = info["short_sha"] if info else sha[:7]
    full_sha = info["sha"] if info else sha
    slug = repo_slug(repo_root)
    job_id = f"{slug}-{short_sha}"

    worktree_path = WORKTREES_DIR / f"{slug}-{short_sha}"
    fix_branch = f"fix/qa-{short_sha}"
    audits_dir = repo_root / ".antigravity" / "audits"
    audits_dir.mkdir(parents=True, exist_ok=True)
    report_md = audits_dir / f"review-{short_sha}.md"
    report_json = audits_dir / f"review-{short_sha}.json"

    has_branch_commits = fixes_committed
    rc, ahead_out, _ = run_git(repo_root, ["rev-list", "--count", f"{full_sha}..{fix_branch}"])
    if rc == 0 and ahead_out.isdigit():
        has_branch_commits = int(ahead_out) > 0

    if has_branch_commits and verdict == "PASS":
        verdict = "FIXED_ON_BRANCH"

    if not has_branch_commits:
        if worktree_path.exists():
            run_git(repo_root, ["worktree", "remove", "--force", str(worktree_path)])
            shutil.rmtree(worktree_path, ignore_errors=True)
        run_git(repo_root, ["branch", "-D", fix_branch])

    result_payload = {
        "id": job_id,
        "repo_path": str(repo_root),
        "repo_name": repo_root.name,
        "sha": full_sha,
        "short_sha": short_sha,
        "completed_at": now_iso(),
        "status": "completed",
        "verdict": verdict,
        "summary": summary,
        "bugs_count": bugs_count,
        "fixes_committed": has_branch_commits,
        "fix_branch": fix_branch if has_branch_commits else None,
        "report_path": str(report_md),
    }
    report_json.write_text(json.dumps(result_payload, indent=2), encoding="utf-8")

    with StateLock():
        state = load_state()
        matched = False
        for j in state["jobs"]:
            if j["id"] == job_id or j.get("short_sha") == short_sha:
                j["status"] = "completed"
                j["completed_at"] = result_payload["completed_at"]
                j["verdict"] = verdict
                j["summary"] = summary
                j["bugs_count"] = bugs_count
                j["fixes_committed"] = has_branch_commits
                matched = True
                conv_id = j.get("conversation_id")
                if conv_id and "active_qa_conversations" in state:
                    state["active_qa_conversations"] = [
                        c for c in state["active_qa_conversations"] if c != conv_id
                    ]
                break
        if not matched:
            state["jobs"].insert(
                0,
                {
                    **result_payload,
                    "commit_msg": info["subject"] if info else "",
                    "queued_at": now_iso(),
                    "worktree_path": str(worktree_path),
                },
            )
        save_state(state)

    return result_payload


def apply_fix_branch(repo_root: Path, sha: str, mode: str = "cherry-pick") -> Dict[str, Any]:
    info = get_commit_info(repo_root, sha)
    short_sha = info["short_sha"] if info else sha[:7]
    full_sha = info["sha"] if info else sha
    fix_branch = f"fix/qa-{short_sha}"

    # 1. Check if the active working tree has uncommitted modifications
    rc_st, st_out, _ = run_git(repo_root, ["status", "--porcelain"])
    if rc_st == 0 and st_out.strip():
        dirty_lines = [l for l in st_out.splitlines() if not l.strip().endswith(".antigravity/") and ".antigravity/" not in l]
        if dirty_lines:
            return {
                "ok": False,
                "error": "Working tree has uncommitted changes. Please commit or stash your changes before applying fixes.",
                "dirty_files": dirty_lines[:5],
            }

    # 2. Check if fix_branch exists
    rc_b, _, _ = run_git(repo_root, ["rev-parse", "--verify", f"refs/heads/{fix_branch}"])
    if rc_b != 0:
        return {"ok": False, "error": f"Branch {fix_branch} no longer exists or was already applied."}

    # 3. Find commits on fix_branch ahead of full_sha
    rc, commits_out, err = run_git(repo_root, ["rev-list", "--reverse", f"{full_sha}..{fix_branch}"])
    if rc != 0 or not commits_out:
        return {"ok": False, "error": f"No fix commits found on {fix_branch} ahead of {short_sha}."}

    commits = [c.strip() for c in commits_out.splitlines() if c.strip()]

    # 4. Get active branch name
    _, current_branch, _ = run_git(repo_root, ["rev-parse", "--abbrev-ref", "HEAD"])
    current_branch = current_branch.strip() or "HEAD"

    # Check if changes on fix_branch are already present in current_branch
    rc_d, diff_out, _ = run_git(repo_root, ["diff", f"{current_branch}..{fix_branch}"])
    if rc_d == 0 and not diff_out.strip():
        slug = repo_slug(repo_root)
        worktree_path = WORKTREES_DIR / f"{slug}-{short_sha}"
        if worktree_path.exists():
            run_git(repo_root, ["worktree", "remove", "--force", str(worktree_path)])
            shutil.rmtree(worktree_path, ignore_errors=True)
        run_git(repo_root, ["branch", "-D", fix_branch])

        job_id = f"{slug}-{short_sha}"
        _, new_head_sha, _ = run_git(repo_root, ["rev-parse", "HEAD"])
        new_head_sha = new_head_sha.strip()
        new_short_sha = new_head_sha[:7] if new_head_sha else ""

        with StateLock():
            state = load_state()
            for j in state["jobs"]:
                if j.get("id") == job_id or j.get("short_sha") == short_sha:
                    j["fixes_applied"] = True
                    j["fixes_committed"] = False
                    j["fix_branch"] = None
                    if new_head_sha:
                        j["applied_commit_sha"] = new_head_sha
                        j["applied_short_sha"] = new_short_sha
                    break
            repo_key = str(repo_root)
            if repo_key in state.get("repos", {}) and new_head_sha:
                state["repos"][repo_key]["baseline_sha"] = new_head_sha
                state["repos"][repo_key]["youngest_short_sha"] = new_short_sha
                state["repos"][repo_key]["updated_at"] = now_iso()
            save_state(state)

        return {
            "ok": True,
            "branch": current_branch,
            "fix_branch": fix_branch,
            "commits": [],
            "applied_count": 0,
            "message": f"Fix commit(s) from '{fix_branch}' are already fully present in '{current_branch}'.",
        }

    # 5. Apply the commits
    if mode == "merge":
        rc_m, out_m, err_m = run_git(
            repo_root, ["merge", "--no-ff", fix_branch, "-m", f"Merge {fix_branch} [auto-review]"]
        )
        if rc_m != 0:
            run_git(repo_root, ["merge", "--abort"])
            return {"ok": False, "error": f"Merge conflict while merging {fix_branch}: {err_m or out_m}"}
    else:
        rc_cp, out_cp, err_cp = run_git(repo_root, ["cherry-pick"] + commits)
        if rc_cp != 0:
            run_git(repo_root, ["cherry-pick", "--abort"])
            return {
                "ok": False,
                "error": f"Conflict while applying fix commit(s) onto {current_branch}. The operation was safely aborted.",
                "details": err_cp or out_cp,
            }

    # 6. Cleanup worktree and delete the temporary fix branch
    slug = repo_slug(repo_root)
    worktree_path = WORKTREES_DIR / f"{slug}-{short_sha}"
    if worktree_path.exists():
        run_git(repo_root, ["worktree", "remove", "--force", str(worktree_path)])
        shutil.rmtree(worktree_path, ignore_errors=True)
    run_git(repo_root, ["branch", "-D", fix_branch])

    # 7. Update state.json to mark fixes_applied = True and record applied commit
    job_id = f"{slug}-{short_sha}"
    _, new_head_sha, _ = run_git(repo_root, ["rev-parse", "HEAD"])
    new_head_sha = new_head_sha.strip()
    new_short_sha = new_head_sha[:7] if new_head_sha else ""

    with StateLock():
        state = load_state()
        for j in state["jobs"]:
            if j.get("id") == job_id or j.get("short_sha") == short_sha:
                j["fixes_applied"] = True
                j["fixes_committed"] = False
                j["fix_branch"] = None
                if new_head_sha:
                    j["applied_commit_sha"] = new_head_sha
                    j["applied_short_sha"] = new_short_sha
                break
        repo_key = str(repo_root)
        if repo_key in state.get("repos", {}) and new_head_sha:
            state["repos"][repo_key]["baseline_sha"] = new_head_sha
            state["repos"][repo_key]["youngest_short_sha"] = new_short_sha
            state["repos"][repo_key]["updated_at"] = now_iso()
        save_state(state)

    return {
        "ok": True,
        "branch": current_branch,
        "fix_branch": fix_branch,
        "commits": commits,
        "applied_count": len(commits),
        "message": f"Successfully applied {len(commits)} fix commit(s) to branch '{current_branch}'.",
    }


def main() -> int:
    cache_ls_env()
    parser = argparse.ArgumentParser(description="Antigravity QA Watchdog Controller")
    sub = parser.add_subparsers(dest="cmd")

    p_status = sub.add_parser("status", help="Show QA Watchdog status and jobs")
    p_status.add_argument("--repo", default="", help="Optional repository path filter")
    p_status.add_argument("--json", action="store_true", help="Output JSON")

    p_sync = sub.add_parser(
        "sync",
        help="Scan git history across workspace & nested repos and resolve the youngest commit",
    )
    p_sync.add_argument("--repo", action="append", default=[], help="Workspace or repository path(s) to sync")

    p_prep = sub.add_parser("prepare", help="Prepare isolated Git worktree for a commit")
    p_prep.add_argument("--repo", required=True)
    p_prep.add_argument("--sha", default="YOUNGEST")

    p_queue = sub.add_parser("queue", help="Queue a commit for QA Watchdog review")
    p_queue.add_argument("--repo", required=True)
    p_queue.add_argument("--sha", default="YOUNGEST")
    p_queue.add_argument("--base-sha", default="")
    p_queue.add_argument("--comment", default="", help="Optional user comment or focus note for the audit")
    p_queue.add_argument("--no-dispatch", action="store_true")
    p_queue.add_argument("--force", action="store_true")

    p_comp = sub.add_parser("complete", help="Mark a QA Watchdog review job complete")
    p_comp.add_argument("--repo", required=True)
    p_comp.add_argument("--sha", required=True)
    p_comp.add_argument("--verdict", default="PASS")
    p_comp.add_argument("--summary", default="Audit completed.")
    p_comp.add_argument("--bugs-count", type=int, default=0)
    p_comp.add_argument("--fixes-committed", default="false")

    p_apply = sub.add_parser("apply-fix", help="Cherry-pick or merge a fix/qa-<sha> branch into current branch")
    p_apply.add_argument("--repo", required=True)
    p_apply.add_argument("--sha", required=True)
    p_apply.add_argument("--mode", choices=["cherry-pick", "merge"], default="cherry-pick")

    p_pause = sub.add_parser("pause", help="Pause automatic QA Watchdog triggers")
    p_resume = sub.add_parser("resume", help="Resume automatic QA Watchdog triggers")

    p_disp = sub.add_parser("dispatch", help="Dispatch a queued QA Watchdog review job")
    p_disp.add_argument("--job-id", default="", help="Specific job ID to dispatch")

    p_base = sub.add_parser("init-baseline", help="Initialize baseline commit SHA for a repository")
    p_base.add_argument("--repo", required=True)

    # Next Steps commands
    p_ns = sub.add_parser("next-steps", help="Synthesize up to 4 structured /plan proposals for repository")
    p_ns.add_argument("--repo", required=True)
    p_ns.add_argument("--force", action="store_true")
    p_ns.add_argument("--json", action="store_true")

    p_goal = sub.add_parser("goal", help="Get or set project goal")
    p_goal.add_argument("--repo", required=True)
    p_goal.add_argument("--set", dest="set_goal", default="")
    p_goal.add_argument("--clear", action="store_true")

    p_conv = sub.add_parser("conversations", help="List Antigravity conversations associated with repository")
    p_conv.add_argument("--repo", required=True)
    p_conv.add_argument("--json", action="store_true")

    p_trans = sub.add_parser("transcript", help="Get recent user requests from a conversation transcript")
    p_trans.add_argument("--conversation-id", required=True)
    p_trans.add_argument("--limit", type=int, default=5)

    p_exec = sub.add_parser("execute-plan", help="Launch or prepare agent prompt for an approved next step plan")
    p_exec.add_argument("--repo", required=True)
    p_exec.add_argument("--plan-id", required=True)

    args = parser.parse_args()

    if args.cmd == "sync":
        res = sync_git_history(args.repo or [])
        print(json.dumps(res, indent=2))
        return 0

    if args.cmd == "status" or not args.cmd:
        state = load_state()
        if getattr(args, "repo", ""):
            root = resolve_git_root(args.repo)
            if root:
                state["jobs"] = [j for j in state["jobs"] if j.get("repo_path") == str(root)]
        if getattr(args, "json", False):
            print(json.dumps(state, indent=2))
        else:
            print(f"QA Watchdog Status: {'PAUSED' if state.get('paused') else 'ACTIVE'}")
            print(f"Auto-Dispatch:      {state.get('auto_dispatch', True)}")
            print(f"Tracked Repos:      {len(state.get('repos', {}))}")
            print(f"Jobs ({len(state.get('jobs', []))}):")
            for j in state.get("jobs", [])[:10]:
                print(
                    f"  - [{j['status'].upper()}] {j['repo_name']} @ {j['short_sha']} ({j['verdict']}): {j['commit_msg']}"
                )
        return 0

    if args.cmd == "prepare":
        root = resolve_git_root(args.repo)
        if not root:
            print(json.dumps({"ok": False, "error": f"Not a git repository: {args.repo}"}))
            return 1
        wt_path, fix_branch, report_path = prepare_worktree(root, args.sha)
        print(
            json.dumps(
                {
                    "ok": True,
                    "repo_path": str(root),
                    "worktree_path": str(wt_path),
                    "fix_branch": fix_branch,
                    "report_path": str(report_path),
                },
                indent=2,
            )
        )
        return 0

    if args.cmd == "queue":
        root = resolve_git_root(args.repo)
        if not root:
            print(json.dumps({"ok": False, "error": f"Not a git repository: {args.repo}"}))
            return 1
        job = queue_commit(
            root,
            sha=args.sha,
            base_sha=args.base_sha,
            dispatch_now=not args.no_dispatch,
            force=args.force,
            user_comment=getattr(args, "comment", ""),
        )
        if not job:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "skipped": True,
                        "reason": "Commit skipped (tag, docs-only, or already queued).",
                    }
                )
            )
            return 0
        job["prompt"] = build_qa_prompt(job)
        print(json.dumps({"ok": True, "job": job}, indent=2))
        return 0

    if args.cmd == "complete":
        root = resolve_git_root(args.repo) or Path(args.repo).resolve()
        fixes_bool = str(args.fixes_committed).lower() in ("true", "1", "yes")
        res = complete_job(
            root,
            sha=args.sha,
            verdict=args.verdict,
            summary=args.summary,
            bugs_count=args.bugs_count,
            fixes_committed=fixes_bool,
        )
        print(json.dumps({"ok": True, "result": res}, indent=2))
        return 0

    if args.cmd == "apply-fix":
        root = resolve_git_root(args.repo)
        if not root:
            print(json.dumps({"ok": False, "error": f"Not a git repository: {args.repo}"}))
            return 1
        res = apply_fix_branch(root, args.sha, mode=args.mode)
        print(json.dumps(res, indent=2))
        return 0 if res.get("ok") else 1

    if args.cmd in ("pause", "resume"):
        with StateLock():
            state = load_state()
            state["paused"] = args.cmd == "pause"
            save_state(state)
        print(json.dumps({"ok": True, "paused": state["paused"]}))
        return 0

    if args.cmd == "dispatch":
        with StateLock():
            state = load_state()
            job = None
            if args.job_id:
                for j in state.get("jobs", []):
                    if j.get("id") == args.job_id:
                        job = j
                        break
            elif state.get("jobs"):
                for j in state.get("jobs", []):
                    if j.get("status") == "queued":
                        job = j
                        break
            if not job:
                print(json.dumps({"ok": False, "error": "No matching job found to dispatch."}))
                return 1

        dispatched = spawn_detached_agent(job)
        if dispatched:
            with StateLock():
                state = load_state()
                for j in state.get("jobs", []):
                    if j.get("id") == job["id"]:
                        j["status"] = "running"
                        j["started_at"] = now_iso()
                        j["summary"] = "Autonomous QA Watchdog review in progress…"
                        break
                save_state(state)
            print(json.dumps({"ok": True, "job_id": job["id"], "dispatched": True}))
            return 0
        else:
            print(json.dumps({"ok": False, "error": "Failed to spawn agent conversation."}))
            return 1

    if args.cmd == "init-baseline":
        root = resolve_git_root(args.repo)
        if not root:
            print(json.dumps({"ok": False, "error": f"Not a git repository: {args.repo}"}))
            return 1
        youngest, _ = get_youngest_commit(root, limit=3)
        if not youngest:
            print(json.dumps({"ok": False, "error": "Repository has no commits yet."}))
            return 1
        with StateLock():
            state = load_state()
            state.setdefault("repos", {})[str(root)] = {
                "name": root.name,
                "baseline_sha": youngest["sha"],
                "updated_at": now_iso(),
            }
            save_state(state)
        print(json.dumps({"ok": True, "repo": str(root), "baseline_sha": youngest["sha"]}))
        return 0

    if args.cmd == "next-steps":
        root = resolve_git_root(args.repo) or Path(args.repo).resolve()
        res = synthesize_next_steps(root, force=args.force)
        print(json.dumps(res, indent=2))
        return 0

    if args.cmd == "goal":
        root = resolve_git_root(args.repo) or Path(args.repo).resolve()
        if args.clear:
            res = clear_goal_override(root)
        elif args.set_goal:
            res = save_goal_override(root, args.set_goal)
        else:
            res = load_goal(root)
        print(json.dumps({"ok": True, "goal": res}, indent=2))
        return 0

    if args.cmd == "conversations":
        root = resolve_git_root(args.repo) or Path(args.repo).resolve()
        convs = get_project_conversations(root)
        print(json.dumps({"ok": True, "repo": str(root), "count": len(convs), "conversations": convs}, indent=2))
        return 0

    if args.cmd == "transcript":
        reqs = get_conversation_user_requests(args.conversation_id, limit=args.limit)
        print(json.dumps({"ok": True, "conversationId": args.conversation_id, "requests": reqs}, indent=2))
        return 0

    if args.cmd == "execute-plan":
        root = resolve_git_root(args.repo) or Path(args.repo).resolve()
        res = execute_plan_in_agent(root, args.plan_id)
        print(json.dumps(res, indent=2))
        return 0

    return 0


if __name__ == "__main__":
    sys.exit(main())
