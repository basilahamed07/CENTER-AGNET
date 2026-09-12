# Agent Control Center Status

Last updated: 2026-09-08

## Completion

**29 / 40 items complete (~73%)** — all core features are built; the remaining work is mostly verification, terminal UX polish, and frontend tests.

## Current Summary

- Core backend and frontend are in place.
- The app builds successfully on both sides (re-verified 2026-09-08: backend `tsc` + 7 tests pass, frontend `tsc` + production build pass).
- Live backend state, session management, agent registry, workspace management, monitoring, and split terminals are implemented.
- The UI issue with cramped terminal height and launcher labels has been improved.
- Real PTY launch still depends on how the backend is started on Windows.

## Completed

- Backend TypeScript service scaffolded in `BACKEND`.
- SQLite persistence added with current-project runtime DB:
  - `BACKEND/runtime/control-center-v2.sqlite`
- SQLite journal mode fixed for this Windows environment:
  - uses `TRUNCATE`
- Workspace table and APIs implemented.
- Agent definition table and APIs implemented.
- Session table and lifecycle metadata implemented.
- Session events table implemented.
- Socket.IO WebSocket server implemented.
- `node-pty` integrated for real terminal sessions.
- Direct command launch behavior fixed for Windows:
  - command names launch through `%ComSpec%`
- `.cmd` and `.bat` launchers supported with path quoting.
- Graceful stop, force terminate, restart, and resume endpoints added.
- Duplicate manager port handling added.
- Detached manager start script added:
  - `npm run start:detached`
- Frontend wired to live backend state.
- xterm.js terminal panes added.
- 1-4 pane split view added.
- Terminal viewport height increased and main canvas widened.
- xterm fit handling now runs on pane/container resize so wide CLI tables are less likely to clip.
- Agent registry labels now show display name plus readable launcher filename/path tooltip instead of cramped repeated text.
- Agent delete UI added.
- Clear all agents/session history UI and API added.
- High-frequency event flicker reduced:
  - terminal output/input/resource events are not persisted into `/api/state`
- System CPU/RAM added to backend `/api/state`.
- System CPU/RAM shown in frontend sidebar/stat cards.
- Backend tests added and passing.
- Frontend production build passing with webpack.
- Documentation added:
  - `docs/ARCHITECTURE.md`
  - `docs/API.md`
  - `docs/WEBSOCKET.md`
  - `docs/SETUP.md`
  - `docs/WINDOWS_MANUAL_TEST_CHECKLIST.md`
- Probe DB cleanup added:
  - `POST /api/maintenance/cleanup-probe-dbs` removes stale `probe*.sqlite*` files from the runtime directory.
  - Existing probe/old DB leftovers removed from `BACKEND/runtime` (only `control-center-v2.sqlite` remains).
- Performance fix (2026-09-09):
  - Frontend no longer refetches full state on every WebSocket event; uses 30s polling plus instant sync on agent lifecycle events only.
  - `git.changed` events only publish when git state actually changes (removed ~15s event spam).
  - xterm panes no longer remount on every state refresh (terminal lag fix).
- Workspace-scoped UI (2026-09-09):
  - Workspace selection now shows only that workspace's agents/sessions.
  - "Agents working here" card strip with per-agent Launch/Terminal buttons.
  - ALL AGENTS panel is workspace-scoped and separated from session history.
- Session detail view (2026-09-09):
  - Individual session page with metadata table, live terminal, and lifecycle event log.
  - New backend endpoint `GET /api/sessions/:id/events`.

## Current Limitation

- Real PTY launch depends on the process that starts the backend.
- When the backend is started from the restricted Codex/tool context, Windows can block ConPTY named pipes:
  - `EPERM: operation not permitted, open \\.\pipe\conpty-...`
- The backend now handles that as a clean API error instead of crashing:
  - `PTY_PERMISSION_BLOCKED`
- For real interactive terminal validation, start the backend manually from a normal Windows `cmd.exe` or PowerShell session.

## Remaining Work

- Verify real `cmd.exe` PTY launch from a normal user-started backend.
- Verify `.cmd` launcher with `gemini.cmd`.
- Verify `.bat` launcher with a local `.bat` file.
- Add a dedicated fullscreen terminal/focus mode.
- Improve agent registry and workspace editing with proper forms instead of prompt dialogs.
- Add workspace delete/archive UI.
- Add session detail drawer.
- Add command palette.
- Add better empty states and error panels.
- Add frontend tests.
- Run the full Windows manual acceptance pass.

## Next Focus

1. Prove terminal launch from a normal Windows shell.
2. Verify `.cmd` and `.bat` launchers end to end.
3. Add fullscreen terminal mode.
4. Replace prompt-based CRUD with proper forms.
