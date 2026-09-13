# CENTER-AGNET — Local Coding Agent Control Center

A cross-platform (Windows, Linux, macOS), local web application that acts as a centralized mission control for multiple CLI-based coding agents (Claude Code, Codex, Gemini CLI, custom `.cmd`/`.bat`/`.sh` launchers).

Real interactive terminals (xterm.js + node-pty/ConPTY), workspace organization, SQLite persistence, live process/resource monitoring, stuck-agent detection, and session resume — all running on your machine.

> This is **not** a replacement for coding agents and **not** a fake chat UI — it drives real CLI agents in real terminals.

## Features

- **Workspace management** — register local project folders; each becomes an agent working directory with Git branch/status monitoring.
- **Agent registry** — manually configure agents (`direct`, `cmd`, or `bat` launcher types) with per-agent env vars, default args, and resume support.
- **Workspace-scoped agents** — create/assign an agent directly from a workspace; it is created and launched in that workspace in one step.
- **Real terminals** — xterm.js frontend wired over Socket.IO to node-pty (ConPTY on Windows, OpenPTY on Linux/macOS) with live tabs (workspace scope / agent-only scope), output buffering, and reconnect-safe attach.
- **Session lifecycle** — start, stop (graceful Ctrl+C), force-terminate, restart, and resume (`--resume`) sessions; full history stored in SQLite.
- **External session discovery** — scans the local session stores of installed CLI agents (Claude Code, Codex, Kilo, Pi, Gemini CLI, Goose, OpenCode, OpenClaw, Aider) and lists past conversations per workspace, matched by working directory. Claude/Codex/Pi-style sessions can be resumed with one click.
- **Built-in agent catalog** — the 15 agents from the all-in-one installer script are seeded automatically at boot (idempotent `def-<agent>` ids) with verified resume flags; agents not found on `PATH` are disabled instead of failing at launch.
- **Monitoring** — per-session CPU/RAM sampling (pidusage), system-wide resources, and stuck-agent confidence signals based on inactivity + usage.
- **Resilient backend** — the manager keeps running and stays reachable even when the frontend is closed; interrupted sessions are marked resumable on boot.

## Tech Stack

| Layer    | Tech                                                        |
| -------- | ----------------------------------------------------------- |
| Frontend | Next.js (App Router), React, TypeScript, xterm.js, Socket.IO client |
| Backend  | Node.js, Express, Socket.IO, node-pty (ConPTY), better-sqlite3, Zod |
| Database | SQLite (`BACKEND/runtime/control-center-v2.sqlite`)          |

## Project Structure

```
├── BACKEND/          # Manager service (Express + Socket.IO + node-pty + SQLite)
│   ├── src/          # TypeScript source (index, routes, processManager, launcher, ...)
│   │   ├── sessionDiscovery.ts   # external session store scanners (per agent)
│   │   └── agentSeed.ts          # built-in agent catalog seeding
│   ├── dist/         # Compiled output (gitignored)
│   └── runtime/      # SQLite database (gitignored)
├── FRONETEND/        # Next.js dashboard (xterm.js UI)
└── docs/             # Design notes
```

## External Session Discovery

Every CLI agent keeps its own conversation history on disk, each in a different format. The manager scans those stores (read-only) and matches sessions to your registered workspaces by working directory:

| Agent | Store scanned | Match key | Resume |
| ----- | ------------- | --------- | ------ |
| Claude Code | `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` | encoded cwd slug | `claude --resume <id>` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` + `session_index.jsonl` | `session_meta.cwd` | `codex resume <id>` |
| Kilo | `~/.local/share/kilo/kilo.db` (SQLite, read-only) | `session.directory` | view only |
| Pi | `~/.pi/agent/sessions/` | encoded cwd | `pi --session <id>` |
| Gemini CLI | `~/.gemini/tmp/<project-hash>/` | hash (not reversible) | view only |
| Goose | `~/.local/share/goose/sessions/` | cwd field | view only |
| OpenCode | `~/.local/share/opencode/storage/session/` | directory field | view only |
| OpenClaw | `~/.openclaw/agents/*/sessions/sessions.json` | cwd field | view only |
| Aider | `.aider.chat.history.md` inside each workspace | in-repo file | `--restore-chat-history` |

Agents without a stable, verifiable on-disk format (Hermes, Crush, OpenHands, Plandex, Mentat, Continue) are reported honestly as `unsupported` in the UI coverage footer rather than guessed.

Matching is exact-path first, then Claude-slug equality, then subdirectory prefix. Results are cached for 30 seconds; use **Rescan** in the UI or `?force=1` to refresh immediately.

### API

```text
GET  /api/external-sessions                     # all discovered sessions + per-agent coverage
GET  /api/workspaces/:id/external-sessions      # sessions matched to one workspace
POST /api/external-sessions/resume              # { agentKey, agentSessionId, workspaceId }
```

Resume maps the discovered agent key to its seeded definition (`def-claude`, `def-codex`, ...) and launches it through the same PTY pipeline as managed sessions, appending the definition's `session_id_arg` plus the external session id. Agents without a verified per-id resume flag are rejected with `RESUME_UNSUPPORTED`.

## Getting Started

### Prerequisites

- Node.js 20+
- Windows 10/11 (ConPTY terminals), Linux, or macOS (OpenPTY terminals)
- At least one CLI coding agent installed (e.g. Claude Code, Codex, Gemini CLI)

### 1. Start the backend (manager)

```bash
cd BACKEND
npm install
npm run build
npm start
```

The manager listens on `http://127.0.0.1:4242`. To keep it alive in the background (works on Windows, Linux and macOS):

```bash
npm run start:detached
```

### 2. Start the frontend

```bash
cd FRONETEND
npm install
npm run dev
```

Open `http://localhost:3000`.

`NEXT_PUBLIC_MANAGER_URL` can override the manager URL (defaults to `http://127.0.0.1:4242`).

### 3. Using the app

1. **Add a workspace** — point it at an existing project folder on disk.
2. **Assign an agent** — from the workspace panel, click **Assign agent** to create an agent and launch it in that workspace immediately, or register agents globally in the sidebar **Agent Registry** and launch them later.
3. Work with the live terminal tabs; use Stop / Restart / Resume / Force from the terminal bar or session detail page.

## Running Tests

```bash
cd BACKEND
npm test
```

## Notes

- **Windows**: may block ConPTY named pipes under certain endpoint-security policies; if launches fail with `EPERM pipe\conpty`, run the manager from a normal (unrestricted) terminal.
- **Linux/macOS**: bare `direct` commands are resolved on `PATH` at launch time; use the `shell` launcher type for `.sh` wrapper scripts.
- The SQLite database and all build artifacts are gitignored — nothing machine-specific is committed.
