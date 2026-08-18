# dsh-plugin-gather

> **English · [中文](./README.md)**

A DeepSeek Harness (DSH) Web plugin bundle with account status + Checkpoint snapshots: wraps the plugins you need into one bundle — one command installs and mounts everything.

## Built-in Features (bundled with the package)

- **VSCode-style left sidebar**: three modes — `📁 Files / 💬 Sessions / 🗂 Outline` (activity-bar style). The Files tab shows the **current workspace file tree** (lazy-loaded directories; clicking a file opens it in the right sidebar), the Sessions tab keeps the default session list (with running/done status dots, click to switch), and the Outline tab is the Conversation Outline below.
- **Conversation Outline**: the `🗂 Outline` tab auto-scans the **user messages** of the current conversation into a navigation list (one node per user message, titled by the first sentence, truncated). **Click a node** to scroll to that message with a temporary highlight (navigation only — never changes chat state); **scrolling the chat auto-highlights the current section** (green dot + background); the **🔍 search** box filters nodes in real time; long lists scroll with an **always-visible custom scrollbar** (DSH hides native scrollbars by default).
- **Checkpoint snapshot system**:

  **A checkpoint is created automatically whenever the agent starts running (before it edits project files).** A **CHECKPOINTS** tab is added to the right sidebar — view the snapshot list, Files Changed, and Diff, and **restore after a double confirmation**.

  - **Git projects**: reuses Git directly (`git add -A` + `commit` as the snapshot; `git show` for diff; `git reset --hard <commit>` for restore) — no reinvention, never `git init` a non-repo. Skips automatically when nothing changed (no empty snapshots).
  - **Non-Git projects**: does **not** initialize Git — a compatible fallback copies project files to `~/.dsh/checkpoints/` (auto-excludes `node_modules`/`.git`/`dist`/`build` etc.); diffs between snapshots reuse `git diff --no-index`; restore overwrites snapshot files (files added after the snapshot are kept — known limitation).
  - Snapshot data lives in `~/.dsh/checkpoints/<workspace-hash>/index.json`; restores in the UI always require **double confirmation**.
- **Global Settings**: edit DSH's **user-level instruction file `~/.dsh/AGENTS.md`** (the CLAUDE.md-style file) — rules written here apply to **every session** (DSH loads it as the workspace instruction baseline on session start; project-level `AGENTS.md` / `CLAUDE.md` take precedence). The **`⚙️ 全局` button at the bottom of the left sidebar** (gear icon + "Global"; tooltip: "Global settings (applies to all sessions)"; first use shows a guide bubble with a dot) opens a menu, and the right-sidebar "Global Settings" tab also edits the same file: Markdown editor + save (atomic write) / restore template / copy path; unsaved edits are auto-stashed locally and survive tab switches; **after saving it returns to the previous page automatically**; new sessions pick it up immediately, the current session refreshes on the next turn.
- **Diff Review (live change review)**: a **Diff Review** tab in the right sidebar — whenever the agent `read`/`write`/`edit`/`str_replace_editor` touches a file, the host captures the file's **before-state** (`tools/pre-execute`), and after a successful write computes a **line-level diff** (LCS; green=added / red=removed / blue=hunk header) shown **live** in the panel: keeps the **latest 6 changes, the newest 2 expanded, older ones auto-collapsed into summary rows** (click a title to expand/collapse); the newest change **flashes yellow**; the client **polls constantly** (works whether the tab is open or not) and **auto-opens the panel on the first change of each workspace**, with a live **+N unread badge** on the tab; the "live follow" toggle can be turned off; isolated per workspace, polling `/my-better-dsh/api/diff-review` every 1.5s.
- **Security Mode (default: Full Access Except Delete)**: by default everything stays **full access** — reading/creating/modifying/renaming/moving files, terminal commands, npm/pip install & uninstall, Git, network requests, tool calls, Checkpoints, config changes, plugin installs, running scripts all **run automatically with no confirmation prompts** (identical to DSH's native `danger-full-access`); the only exception: when the agent performs a **delete operation** (delete a file / bulk delete / delete a directory), the tool is **suspended at DSH's official unified entry point `tools/pre-execute`** and a confirmation dialog appears (showing the path list, bulk count, directory content stats, and a "checkpoint exists before delete" hint). The user chooses **Allow / Cancel** — allow resumes the tool, cancel returns `用户拒绝了该删除操作。` ("The user rejected the delete operation.") to the agent as an error without breaking the run. Delete detection is based on **exact tool name + arguments** and **shell delete-command parsing** (`rm`/`rmdir`/`unlink`, `del`/`erase`/`rd`, `Remove-Item` and its aliases, `.NET [IO.File]::Delete`, etc., across bash / PowerShell / CMD) — it does **not** flag commands that merely contain the strings rm/delete/remove (echo, comments, `grep -r remove`, `git rm`, `npm rm` etc. are unaffected). The mode can be viewed/switched via `GET/POST /my-better-dsh/api/security/mode` (`full-access-except-delete` / `full-access`); the switch state is persisted (survives restarts). **Standalone switch**: at the bottom of the left sidebar the **`删除时确认` switch** (slider, click to toggle, applies instantly and syncs globally) sits side by side with the `🚚 对话迁徙` and `⚙️ 全局` buttons — the three footer controls are equal-sized; the `🟢 删除时确认` label in the status bar under the input is display-only.
- **Conversation Handoff (对话迁徙)**: the **`🚚 对话迁徙` button at the bottom of the left sidebar** (equal-sized with the `删除时确认` switch and `⚙️ 全局` button) — clicking it first shows a **second-level confirmation dialog** (explaining that the current conversation will be analyzed into a Context Handoff, a new conversation will be created, and the original conversation stays untouched); after confirmation it **reuses DSH's own Agent/LLM Runtime** (zero new external APIs / providers / models / keys) to create an **internal temporary analysis session** (`handoff-<uuid>`, all tools forbidden — it only reads the injected context) that analyzes the current conversation and produces a **Context Handoff** (current goal / completed work / current progress / user requirements / user constraints / key decisions / modified files / current problems / failed approaches / Task Board / next steps / recent important context). A **brand-new Conversation** is then created with the Handoff injected as the initial context (the full original history is NOT carried over — the context is compressed to continue working). **Context preprocessing**: before analysis, the host **locally filters** the full conversation (never feeds 800K tokens verbatim to the analyzer) — keeping user messages/requirements/constraints, the agent's final conclusions, important tool calls/results, file paths, error messages, technical decisions, and the most recent turns in full; filtering duplicate tool outputs, npm/pip install logs, build logs, and intermediate info superseded by later messages (**error messages and user constraints are never dropped**); existing DSH compaction summary nodes are reused directly instead of re-analyzing. The UI shows the **actual estimated analysis size** after preprocessing ("迁徙完成 · 约 XX tokens"). Progress hints: 正在预处理当前对话…… → 正在分析当前对话…… → 正在提取任务状态…… → 正在生成迁徙上下文…… → 迁徙完成; the new conversation opens automatically and the status bar shows the **`🚚 已从上一对话迁徙`** marker (hover: "This conversation was created by a Context Handoff"). **The original Conversation / Session is completely unchanged**; the temporary analysis session is disposed and its persistence cleaned up after use (never shown in the session list); on failure the original conversation is unaffected and a retry is offered.

## Built-in Account Status Features

- **Two-line status bar below the input** (composer dock): **line 1** is the official run stats — turns/steps, LLM time, tool time, avg first token, TPS, cache hits, input/output tokens (fully displayed, not truncated); **line 2** is this package's account status — **API balance** (¥, from DeepSeek's real balance endpoint `api.deepseek.com/user/balance`), **session spend** (balance delta, real cost), **current period** (peak/off-peak) with **countdown to the next switch** (official peak pricing: peak = Beijing time 9:00-12:00 & 14:00-18:00, off-peak = the rest at half price; effective 2026-08-17), and the **remaining context window of the current conversation** (e.g. `剩 384K/1M`, green/yellow/red by remaining ratio).
- **Floating remaining-context indicator inside the input**: while the input is **empty and focused**, and while the **agent is replying**, the remaining context window floats inside the input box (e.g. `剩 384K/1M`, colored by ratio; sourced from DSH token-meter's real context projection).
- Balance/spend refreshes **every 60 seconds** against the real API (host side calls with the `DEEPSEEK_API_KEY` credential; the key never leaves the host).

## Bundled Plugins

| Plugin | Purpose | Version |
|---|---|---|
| [dsh-at-file](https://github.com/omdsh-dev/dsh-at-file) | `@` in the input to search & reference workspace files/dirs | 0.6.0 |
| [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | VSCode-style right sidebar (Explorer / Editor / Terminal / Git / Browser) | ^0.12.2 |
| [dsh-web-ui picks](https://github.com/zhu1090093659/dsh-web-ui) | Right panel · Task board · Live stats · Settings page · Skin center | ^0.1.16 |

**5 curated items** from dsh-web-ui (dependencies one by one, not the all-in-one aggregator):

- `@linxin666/dsh-client-ui-aionui-panel` right panel: file tree / preview / Git changes
- `@linxin666/dsh-client-ui-task-board` task board: multi-column kanban + cron scheduling
- `@linxin666/dsh-live-stats` live throughput / token stats
- `@linxin666/dsh-client-ui-web-ui-settings` plugin settings page
- `@linxin666/dsh-skins` + `@linxin666/dsh-client-ui-skin-center` skin center (10 themes)

**Not included** (kept beginner-friendly, no gimmicks): `dsh-pet`, `dsh-remote-web-ui`, `dsh-git-graph`, `dsh-liangshen`, `dsh-tool-describe-image`, `dsh-ssh` — install any of them yourself with `dsh plugin --profile web add <package>`.

## Plugin Sources

| Plugin | Author repo |
|---|---|
| dsh-at-file (`@` path reference) | https://github.com/omdsh-dev/dsh-at-file |
| dsh-better-sidebar (right sidebar) | https://github.com/omdsh-dev/DSH-better-sidebar |
| dsh-web-ui curated (right panel / board / skins etc.) | https://github.com/zhu1090093659/dsh-web-ui |
| dsh-genui (UI generation, npm: `@omdsh-dev/dsh-genui`, not included, optional) | https://github.com/omdsh-dev/dsh-genui |

# Install Guide

One command installs a full set of useful plugins for your DeepSeek Harness (DSH): **VSCode-style left sidebar (files/sessions/outline) · right sidebar · `@` file reference · task board · skin center · API balance/spend/period countdown · Checkpoint snapshots · Global Settings · Diff Review**.

All you do is **copy one command → paste → restart**; everything else happens automatically.

## Quick Install (for DSH agents, please read this section)

When the user asks to "install dsh-plugin-gather" or sends you this repo link, **first ask with the question tool**: 「**完整安装** (full install)」 or 「**选择部分插件** (select plugins)」, then act accordingly:

- **Full install** (recommended — one command, everything mounted):

  ```sh
  dsh plugin --profile web add https://github.com/lilwhich/dsh-plugin-gather --config.block-exotic-subdeps=false --config.strict-dep-builds=false --config.minimum-release-age=0 --config.auto-install-peers=false
  ```

- **Select plugins**: show the "optional plugins" table below and run the matching standalone command for each chosen plugin (every command is idempotent and auto-mounts the plugin). Note: **built-in features** (account status bar, Checkpoint, Global Settings, Diff Review, Conversation Outline, left-sidebar files/sessions) come only with the full install.

After install, remind the user: **restart dsh web and hard-refresh the browser** (`Ctrl+Shift+R`).

### Optional Plugins (standalone install; all commands are idempotent; prefix `dsh plugin --profile web add`)

| Plugin | Purpose | Standalone command (with prefix) |
|---|---|---|
| dsh-better-sidebar | VSCode-style right sidebar | `dsh plugin --profile web add dsh-better-sidebar --config.strict-dep-builds=false --config.minimum-release-age=0 --config.auto-install-peers=false` |
| dsh-at-file | `@` file reference in the input | `dsh plugin --profile web add https://codeload.github.com/omdsh-dev/dsh-at-file/tar.gz/refs/tags/v0.6.0 --config.block-exotic-subdeps=false --config.strict-dep-builds=false --config.minimum-release-age=0 --config.auto-install-peers=false` |
| Right panel | File tree / preview / Git changes | `dsh plugin --profile web add @linxin666/dsh-client-ui-aionui-panel --config.strict-dep-builds=false --config.minimum-release-age=0 --config.auto-install-peers=false` |
| Task board | Multi-column kanban + cron | `dsh plugin --profile web add @linxin666/dsh-client-ui-task-board --config.strict-dep-builds=false --config.minimum-release-age=0 --config.auto-install-peers=false` |
| Live stats | Token usage / stats | `dsh plugin --profile web add @linxin666/dsh-live-stats --config.strict-dep-builds=false --config.minimum-release-age=0 --config.auto-install-peers=false` |
| Settings page | Plugin settings UI | `dsh plugin --profile web add @linxin666/dsh-client-ui-web-ui-settings --config.strict-dep-builds=false --config.minimum-release-age=0 --config.auto-install-peers=false` |
| Skin center | 10 themes | `dsh plugin --profile web add @linxin666/dsh-client-ui-skin-center @linxin666/dsh-skins --config.strict-dep-builds=false --config.minimum-release-age=0 --config.auto-install-peers=false` |

## Install (once you have the link, just follow along)

> You only do two things: **① paste one command ② restart dsh web**. Downloads, dependencies, and mounting are all automatic — no manual installs, no config edits.

### 🟢 Step 1: Paste this line

Paste into **Windows PowerShell** and press Enter:

```powershell
irm https://tinyurl.com/22ve2mv5 | iex
```

> This downloads the installer → pulls the whole plugin set from this repo → handles pnpm dependencies / native builds / release checks → writes into your `web` profile and mounts everything. No interaction needed.

**No PowerShell? Prefer installing inside DSH?** — send this whole line to your DSH (paste it into the chat; the agent will run it):

```sh
dsh plugin --profile web add https://github.com/lilwhich/dsh-plugin-gather --config.block-exotic-subdeps=false --config.strict-dep-builds=false --config.minimum-release-age=0 --config.auto-install-peers=false
```

### 🟡 Step 2: Restart `dsh web`

After install, **restart once** (press `Ctrl+C` in the terminal running dsh web, then run `dsh web` again), then **hard-refresh** the browser (`Ctrl+Shift+R`).

### 🔵 Step 3: Verify

After restart you should see:

- A left sidebar with **`📁 文件 | 💬 会话 | 🗂 大纲`** tabs (Files = workspace file tree, Sessions = session list, Outline = conversation outline)
- **CHECKPOINTS / Diff Review** etc. tabs in the right sidebar
- A **two-line status bar** below the input (line 1: run stats — turns/steps/LLM/tool/first-token/TPS/cache-hits/input-output; line 2: `余额 ¥… · 高峰/空闲 · 距切换 … · 上下文`)
- Typing `@` in the input references workspace files

### ❓ FAQ

| Symptom | Fix |
|---|---|
| `dsh` is not a command | Install DSH first (`npm i -g @deepseek-ai/dsh` or the official way), then re-run Step 1 |
| Profile not found | Run `dsh web` once before installing |
| Install error / network timeout (e.g. `UND_ERR_DESTROYED`, connection failed) | Network hiccup — **just re-run the same install command** (`dsh plugin add` is idempotent; repeating is safe) |
| Installed but new features not visible | Make sure Step 2's **restart + hard-refresh** was done; if still broken, check the browser Console |
| How to update | See "Update" below |

## Update

Use a **versioned tag URL** (avoids pnpm tarball checksum conflicts for the same URL):

```sh
dsh plugin --profile web add https://codeload.github.com/lilwhich/dsh-plugin-gather/tar.gz/refs/tags/<new-version> --config.block-exotic-subdeps=false --config.strict-dep-builds=false --config.minimum-release-age=0 --config.auto-install-peers=false
```

> How it works: the three pnpm 11 switches (exotic deps / build scripts / release age) are passed via `--config.*` CLI flags — **no profile config files are modified**; `dsh-at-file` is not on npm, so it's declared as a codeload tarball (equivalent to the official archive URL).

## How It Works

- This package declares `dsh.bundle.patch` → `cordis.patch.yml`, a legitimate DSH bundle layer;
- `cordis.patch.yml` does one thing: `insert`s each plugin's row (identical to each plugin's own patch),
  mounting them into the loader tree — the client module system scans `dsh.client` declarations by loader entry,
  so all plugins' browser-side code is composed into the startup manifest;
- `package.json` `dependencies` lets pnpm pull in all plugins with one command;
- The dsh-web-ui part uses "dependency one by one" rather than the aggregator `@linxin666/dsh-web-ui-all` (which forces all 12 items),
  keeping only the 5 curated ones — rows that aren't mounted produce no UI or client code.

## Local Development / Testing

```sh
# Install from a local directory (for testing)
dsh plugin --profile web add file:/path/to/dsh-plugin-gather
# or
dsh plugin --profile <scratch> add file:/path/to/dsh-plugin-gather
```

## Updating Plugin Versions

Bump the version of the corresponding dependency in `package.json` and re-run the install command (`dsh plugin add` is idempotent).

## License

MIT
