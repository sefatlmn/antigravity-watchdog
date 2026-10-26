#!/usr/bin/env python3
"""
Watchdog Sidepanel UI Launcher (panel_launcher.py)

Ensures the shared `sidecars/panel/main.mjs` server is running in standalone mode
and optionally opens the Watchdog & Next Steps sidepanel UI window for Claude Code
or any external editor.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path
from typing import Any, Dict, Optional

HOME = Path.home()
WATCHDOG_DIR = HOME / ".gemini" / "antigravity" / "watchdog"
PANEL_SERVER_FILE = WATCHDOG_DIR / "panel_server.json"
LOGS_DIR = WATCHDOG_DIR / "logs"

SCRIPT_DIR = Path(__file__).resolve().parent
PLUGIN_ROOT = SCRIPT_DIR.parent
MAIN_MJS = PLUGIN_ROOT / "sidecars" / "panel" / "main.mjs"


def find_node_bin() -> str:
    candidates = [
        os.environ.get("NODE_BIN", ""),
        shutil.which("node") or "",
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ]
    for c in candidates:
        if c and Path(c).exists():
            return c
    return "node"


def check_health(base_url: str, timeout: float = 1.0) -> bool:
    try:
        req = urllib.request.Request(f"{base_url}/api/health", method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status == 200:
                data = json.loads(resp.read().decode("utf-8"))
                return bool(data.get("ok"))
    except Exception:
        pass
    return False


def get_running_panel_url() -> Optional[str]:
    if PANEL_SERVER_FILE.exists():
        try:
            info = json.loads(PANEL_SERVER_FILE.read_text(encoding="utf-8"))
            url = info.get("url")
            if url and check_health(url):
                return url
        except Exception:
            pass

    default_url = f"http://127.0.0.1:{os.environ.get('WATCHDOG_PANEL_PORT', '4891')}"
    if check_health(default_url):
        return default_url
    return None


def start_panel_server(repo_path: Optional[str] = None) -> str:
    existing = get_running_panel_url()
    if existing:
        if repo_path:
            register_active_workspace(existing, repo_path)
        return existing

    WATCHDOG_DIR.mkdir(parents=True, exist_ok=True)
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOGS_DIR / "panel_server.log"

    node_bin = find_node_bin()
    env = dict(os.environ)
    env["WATCHDOG_PANEL_QUIET"] = "1"
    if repo_path:
        env["WATCHDOG_REPO"] = str(Path(repo_path).resolve())

    with open(log_path, "a", encoding="utf-8") as lf:
        subprocess.Popen(
            [node_bin, str(MAIN_MJS)],
            cwd=str(PLUGIN_ROOT),
            env=env,
            stdout=lf,
            stderr=lf,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )

    for _ in range(25):
        time.sleep(0.15)
        url = get_running_panel_url()
        if url:
            if repo_path:
                register_active_workspace(url, repo_path)
            return url

    fallback_url = f"http://127.0.0.1:{os.environ.get('WATCHDOG_PANEL_PORT', '4891')}"
    return fallback_url


def register_active_workspace(base_url: str, repo_path: str) -> None:
    try:
        resolved = str(Path(repo_path).resolve())
        payload = json.dumps({"repoPath": resolved}).encode("utf-8")
        req = urllib.request.Request(
            f"{base_url}/api/active-workspace",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=1.5):
            pass
    except Exception:
        pass


def open_sidepanel_window(url: str, repo_path: Optional[str] = None) -> bool:
    target_url = url
    if repo_path:
        resolved = str(Path(repo_path).resolve())
        target_url = f"{url}/?repo={urllib.parse.quote(resolved)}"

    if sys.platform == "darwin":
        mac_browsers = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
        for bin_path in mac_browsers:
            if Path(bin_path).exists():
                try:
                    subprocess.Popen(
                        [
                            bin_path,
                            f"--app={target_url}",
                            "--window-size=400,900",
                            "--window-position=1280,40",
                        ],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        stdin=subprocess.DEVNULL,
                        start_new_session=True,
                    )
                    return True
                except Exception:
                    pass
        try:
            subprocess.Popen(
                ["open", target_url],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return True
        except Exception:
            pass

    try:
        webbrowser.open(target_url)
        return True
    except Exception:
        return False


def ensure_panel(repo_path: Optional[str] = None, open_window: bool = False) -> Dict[str, Any]:
    url = start_panel_server(repo_path)
    opened = False
    if open_window:
        opened = open_sidepanel_window(url, repo_path)
    target_url = (
        f"{url}/?repo={urllib.parse.quote(str(Path(repo_path).resolve()))}"
        if repo_path
        else url
    )
    return {
        "ok": True,
        "url": target_url,
        "baseUrl": url,
        "repo": str(Path(repo_path).resolve()) if repo_path else None,
        "opened": opened,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Launch Watchdog Sidepanel UI")
    parser.add_argument("--repo", default="", help="Active repository path")
    parser.add_argument("--open", action="store_true", help="Open sidepanel window")
    parser.add_argument("--json", action="store_true", help="Output JSON")
    args = parser.parse_args()

    repo = args.repo.strip() or os.getcwd()
    res = ensure_panel(repo_path=repo, open_window=args.open)
    if args.json:
        print(json.dumps(res, indent=2))
    else:
        print(f"Watchdog Sidepanel UI active at: {res['url']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
