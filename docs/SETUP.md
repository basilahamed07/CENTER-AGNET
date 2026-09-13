# Setup

Works on Windows, Linux and macOS.

## Backend

```bash
cd BACKEND
npm install
npm run build
npm start
```

The manager binds to `127.0.0.1:4242`.

`npm start` is a foreground server command. If it succeeds, it keeps running and does not return to the prompt until stopped. To start the manager detached for normal UI use:

```bash
cd BACKEND
npm run start:detached
```

The default SQLite database stays inside the current project folder:

```text
BACKEND/runtime/control-center-v2.sqlite
```

SQLite uses `TRUNCATE` journal mode on Windows (default `DELETE` mode caused `SQLITE_IOERR_DELETE` there) and `WAL` on Linux/macOS.

## Frontend

The frontend uses pnpm (there is a `pnpm-lock.yaml`; no npm lockfile is kept):

```powershell
cd FRONETEND
pnpm install
npx next build --webpack
pnpm dev
```

Open the URL printed by Next.js, normally `http://localhost:3000`.

## Configure Agents

Claude Code direct command (works on all platforms; resolved on `PATH`):

```json
{ "displayName": "Claude Code", "command": "claude", "launcherType": "direct" }
```

Codex `.cmd` (Windows):

```json
{ "displayName": "Codex", "command": "C:\\Users\\you\\AppData\\Roaming\\npm\\codex.cmd", "launcherType": "cmd" }
```

Custom `.bat` (Windows):

```json
{ "displayName": "Custom Agent", "command": "C:\\Agents\\start-agent.bat", "launcherType": "bat" }
```

Custom `.sh` (Linux/macOS):

```json
{ "displayName": "Custom Agent", "command": "/home/you/agents/start-agent.sh", "launcherType": "shell" }
```

The manager executes `.bat` and `.cmd` launchers through `cmd.exe` on Windows. On Linux/macOS, `direct` commands are resolved on `PATH` and kept alive inside your default shell; `shell` launchers run `.sh` scripts.

## Add Workspace

Use the sidebar `Add workspace` button or call:

```bash
curl -X POST http://127.0.0.1:4242/api/workspaces -H 'Content-Type: application/json' -d '{"name":"MyApp","path":"/home/you/Projects/MyApp"}'
```

## Resume Sessions

Resume requires the agent definition to set `supportsResume` and resume args. Unsupported agents show as unavailable and are not faked.
