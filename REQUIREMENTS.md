# Phase 1 — Local Multi-Agent Coding Agent Control Center

## Role
Senior full-stack engineer and systems architect.

## Goal
Build a production-quality Windows-first local web application that acts as a centralized control center for multiple CLI-based coding agents.

## Core Features
- Manage multiple coding agents (Claude Code, Codex, Gemini CLI, .cmd, .bat).
- Workspace/Project organization.
- Launch agents from UI.
- Unified view of running agents.
- Real interactive terminals (xterm.js, tabs, 2-4 pane split views).
- Persistent backend (remains alive when frontend is closed).
- Reconnect terminal streams.
- SQLite persistence (metadata, history, workspaces).
- Session resume capability.
- Workspace monitoring (Git, CPU, RAM).
- Stuck agent detection.
- Configurable agent registry.

## Constraints
- **NOT** a replacement for coding agents.
- **NOT** a fake chat UI (must be real CLI terminal).
- **Windows-first** (ConPTY).
- **Backend must be independent** of Frontend lifecycle.
- **Manual configuration** (no auto-scan for agents).
- **Workspace-first** model.
- **SQLite** as source of truth.
- **No LLM Brain** in Phase 1.

## Tech Stack
- Frontend: Next.js, TypeScript, TailwindCSS (detected in project).
- Backend: Node.js service (to be built).
- Database: SQLite.
- Terminal: xterm.js, node-pty.

## Implementation Stages
1. Project foundation
2. Workspace management
3. Agent registry
4. Process manager
5. PTY/ConPTY
6. WebSocket layer
7. Session manager
8. Main UI
9. Terminal UX
10. Monitoring
11. Polish
12. Testing
