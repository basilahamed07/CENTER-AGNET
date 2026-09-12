# CENTER-AGNET — Local Coding Agent Control Center

A Windows-first, local web application that acts as a centralized mission control for multiple CLI-based coding agents (Claude Code, Codex, Gemini CLI, custom `.cmd`/`.bat` launchers).

Real interactive terminals (xterm.js + node-pty/ConPTY), workspace organization, SQLite persistence, live process/resource monitoring, stuck-agent detection, and session resume — all running on your machine.

> This is **not** a replacement for coding agents and **not** a fake chat UI — it drives real CLI agents in real terminals.

## Features

- **Workspace management** — register local project folders; each becomes an agent working directory with Git branch/status monitoring.
- **Agent registry** — manually configure agents (`direct`, `cmd`, or `bat` launcher types) with per-agent env vars, default args, and resume support.
- **Workspace-scoped agents** — create/assign an agent directly from a workspace; it is created and launched in that workspace in one step.
- **Real terminals** — xterm.js frontend wired over Socket.IO to node-pty (ConPTY) with live tabs (workspace scope / agent-only scope), output buffering, and reconnect-safe attach.
- **Session lifecycle** — start, stop (graceful Ctrl+C), force-terminate, restart, and resume (`--resume`) sessions; full history stored in SQLite.
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
│   ├── dist/         # Compiled output (gitignored)
│   └── runtime/      # SQLite database (gitignored)
├── FRONETEND/        # Next.js dashboard (xterm.js UI)
└── docs/             # Design notes
```

## Getting Started

### Prerequisites

- Windows 10/11 (ConPTY-based terminals)
- Node.js 20+
- At least one CLI coding agent installed (e.g. Claude Code, Codex, Gemini CLI)

### 1. Start the backend (manager)

```bash
cd BACKEND
npm install
npm run build
npm start
```

The manager listens on `http://127.0.0.1:4242`. To keep it alive in the background:

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

- Windows may block ConPTY named pipes under certain endpoint-security policies; if launches fail with `EPERM pipe\conpty`, run the manager from a normal (unrestricted) terminal.
- The SQLite database and all build artifacts are gitignored — nothing machine-specific is committed.
