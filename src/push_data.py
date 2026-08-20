# -*- coding: utf-8 -*-
"""检查、提交并推送当前看板仓库。

凭证读取顺序：
1. GITHUB_TOKEN 环境变量；
2. 仓库根目录 .env；
3. 已被 Git 忽略的 src/push_config.local.json；
4. 已被 Git 忽略的 src/push_config.json。
未配置显式 Token 时，脚本会回退到系统 Git 凭证助手（macOS Keychain）。

脚本只暂存看板源码、构建脚本与发布产物，不暂存任何本地凭证文件。
"""
import base64
import datetime
import json
import os
import re
import subprocess
import sys


BASE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(BASE)
CFG = os.path.join(BASE, "push_config.json")
LOCAL_CFG = os.path.join(BASE, "push_config.local.json")
EXAMPLE_CFG = os.path.join(BASE, "push_config.example.json")
ENV_FILE = os.path.join(REPO_ROOT, ".env")

PUBLISH_PATHS = [
    ".gitignore",
    ".env.example",
    "src/live-dashboard.html",
    "src/lingxing_auto.js",
    "src/push_config.example.json",
    "src/refresh_dashboard.py",
    "src/push_data.py",
    "tests/cloud_update_module.test.cjs",
    "amz-data.json",
    "cloud-status.json",
    "dashboard.html",
    "index.html",
    "version.json",
]
SECRET_FILE_NAMES = {".env", "push_config.json", "push_config.local.json"}
TOKEN_PATTERN = re.compile(r"(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})")
TOKEN_VALUE_PATTERN = re.compile(r"^(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$")


def run(cmd, cwd=None, env=None):
    p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)
    return p.returncode, p.stdout, p.stderr


def git(args, env=None):
    return run(["git", "-C", REPO_ROOT] + args, env=env)


def load_json(path):
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print("ERROR: 配置文件解析失败 %s: %s" % (path, e))
        sys.exit(2)


def load_env_file(path):
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            if line.startswith("export "):
                line = line[7:].strip()
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def auth_environment(token):
    encoded = base64.b64encode(("x-access-token:" + token).encode("utf-8")).decode("ascii")
    env = os.environ.copy()
    env["GIT_CONFIG_COUNT"] = "1"
    env["GIT_CONFIG_KEY_0"] = "http.https://github.com/.extraheader"
    env["GIT_CONFIG_VALUE_0"] = "AUTHORIZATION: basic " + encoded
    return env


def staged_files():
    rc, out, err = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
    if rc != 0:
        print("ERROR: 无法读取暂存区:", err.strip())
        sys.exit(4)
    return [line.strip() for line in out.splitlines() if line.strip()]


def verify_no_staged_secrets(paths):
    for path in paths:
        if os.path.basename(path) in SECRET_FILE_NAMES:
            print("ERROR: 检测到本地凭证文件进入暂存区，已停止推送:", path)
            return False
        if path in ("amz-data.json", "dashboard.html", "index.html"):
            continue
        rc, content, _ = git(["show", ":" + path])
        if rc == 0 and TOKEN_PATTERN.search(content):
            print("ERROR: 检测到疑似 GitHub Token，已停止推送。文件:", path)
            return False
    return True


def main():
    if not os.path.isdir(os.path.join(REPO_ROOT, ".git")):
        print("ERROR: 当前目录不是已克隆的 Git 仓库:", REPO_ROOT)
        return 2

    load_env_file(ENV_FILE)
    defaults = load_json(EXAMPLE_CFG)
    cfg = load_json(CFG)
    local_cfg = load_json(LOCAL_CFG)
    repo = (local_cfg.get("repo") or cfg.get("repo") or defaults.get("repo") or "").strip()
    branch = (local_cfg.get("branch") or cfg.get("branch") or defaults.get("branch") or "main").strip()
    config_token = (local_cfg.get("token") or cfg.get("token") or "").strip()
    token = (os.environ.get("GITHUB_TOKEN") or config_token or "").strip()

    if not repo:
        print("ERROR: push_config.json 需包含 repo。")
        return 2
    has_token = bool(TOKEN_VALUE_PATTERN.fullmatch(token))
    if token and not has_token:
        print("INFO: 配置中的 Token 是占位值，将尝试使用系统 Git 凭证。")
    required = ["src/live-dashboard.html", "dashboard.html", "index.html", "version.json"]
    missing = [p for p in required if not os.path.exists(os.path.join(REPO_ROOT, p))]
    if missing:
        print("ERROR: 缺少发布文件，请先运行 refresh_dashboard.py:", ", ".join(missing))
        return 3

    auth_env = auth_environment(token) if has_token else None
    rc, _, err = git(["fetch", "origin", branch], env=auth_env)
    if rc != 0:
        print("FETCH_FAIL:", err.strip())
        return 5
    rc, remote_head, err = git(["rev-parse", "FETCH_HEAD"])
    if rc != 0:
        print("ERROR: 无法确认远端分支:", err.strip())
        return 5
    rc, local_head, err = git(["rev-parse", "HEAD"])
    if rc != 0:
        print("ERROR: 无法读取本地提交:", err.strip())
        return 4
    remote_head = remote_head.strip()
    local_head = local_head.strip()
    ahead_of_remote = remote_head != local_head
    if ahead_of_remote:
        rc, _, _ = git(["merge-base", "--is-ancestor", remote_head, local_head])
        if rc != 0:
            print("ERROR: 远端 main 已有本地未包含的新提交，请先同步后再发布。")
            return 6

    existing_paths = [p for p in PUBLISH_PATHS if os.path.exists(os.path.join(REPO_ROOT, p))]
    rc, _, err = git(["add", "--"] + existing_paths)
    if rc != 0:
        print("STAGE_FAIL:", err.strip())
        return 4

    paths = staged_files()
    if not paths:
        if not ahead_of_remote:
            print("NO_CHANGE: 看板源码和发布文件均无变化。")
            return 0
        print("INFO: 没有新的工作区变更，继续推送本地尚未发布的提交。")
    else:
        if not verify_no_staged_secrets(paths):
            return 7

        rc, _, _ = git(["config", "user.name"])
        if rc != 0:
            git(["config", "user.name", "KevinZuo-AMZ"])
        rc, _, _ = git(["config", "user.email"])
        if rc != 0:
            git(["config", "user.email", "kevinzuo-amz@users.noreply.github.com"])

        message = os.environ.get("AMZ_COMMIT_MESSAGE") or (
            "dashboard update " + datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
        )
        rc, out, err = git(["commit", "-m", message])
        if rc != 0:
            print("COMMIT_FAIL:", (err or out).strip())
            return 4

    rc, out, err = git(["push", "origin", "HEAD:" + branch], env=auth_env)
    if rc != 0:
        print("PUSH_FAIL:", err.strip())
        return 5
    print("PUSH_SUCCESS: https://github.com/%s/tree/%s" % (repo, branch))
    print("PUBLISHED_FILES:", ", ".join(paths))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
