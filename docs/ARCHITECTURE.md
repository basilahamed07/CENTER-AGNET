# Agent Control Center Architecture

Phase 1 is a Windows-first local management layer for CLI coding agents. It does not replace Claude Code, Codex, Gemini CLI, `.cmd`, or `.bat` launchers.

## Diagram

```text
Browser
  |
  | HTTP + Socket.IO WebSocket
  v
Next.js Frontend
  |
  v
Local Agent Manager :4242
  |
  +-- ProcessManager / node-pty / Windows ConPTY
  +-- Session repository / SQLite
  +-- Workspace Git monitor
  +-- Resource monitor
  +-- Stuck detection
  +-- Event bus
```

## Lifecycle

The manager service is independent of the browser. Closing the frontend does not stop PTY processes. Reopening the frontend calls `/api/state`, reconnects Socket.IO, and reattaches terminal panes to existing manager-held sessions.

After a reboot, running processes are gone. On manager startup, sessions previously marked active are changed to `RESUMABLE` when the agent definition supports resume, otherwise `DISCONNECTED`.

## Runtime Storage

SQLite metadata defaults to:

```text
%LOCALAPPDATA%\AgentControlCenter\manager.sqlite
```

Set `MANAGER_DB_PATH` to override this. Terminal byte streams are not persisted by default; only lifecycle metadata and events are stored.

## Status Model

Supported statuses:

```text
CREATED STARTING RUNNING IDLE WAITING STOPPING STOPPED CRASHED DISCONNECTED RESUMABLE
```

The backend is authoritative for process and session state.
