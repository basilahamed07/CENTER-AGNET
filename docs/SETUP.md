# Setup

## Backend

```powershell
cd BACKEND
npm install
npm run build
npm start
```

The manager binds to `127.0.0.1:4242`.

`npm start` is a foreground server command. If it succeeds, it keeps running and does not return to the prompt until stopped. To start the manager detached for normal UI use:

```powershell
cd BACKEND
npm run start:detached
```

The default SQLite database stays inside the current project folder:

```text
BACKEND\runtime\control-center-v2.sqlite
```

SQLite uses `TRUNCATE` journal mode in this environment because default `DELETE` journal mode caused `SQLITE_IOERR_DELETE` on Windows.

## Frontend

```powershell
cd FRONETEND
npm install
npx next build --webpack
npm run dev
```

Open the URL printed by Next.js, normally `http://localhost:3000`.

## Configure Agents

Claude Code direct command:

```json
{ "displayName": "Claude Code", "command": "claude", "launcherType": "direct" }
```

Codex `.cmd`:

```json
{ "displayName": "Codex", "command": "C:\\Users\\you\\AppData\\Roaming\\npm\\codex.cmd", "launcherType": "cmd" }
```

Custom `.bat`:

```json
{ "displayName": "Custom Agent", "command": "C:\\Agents\\start-agent.bat", "launcherType": "bat" }
```

The manager executes `.bat` and `.cmd` launchers unchanged through `cmd.exe`.

## Add Workspace

Use the sidebar `Add workspace` button or call:

```powershell
Invoke-RestMethod http://127.0.0.1:4242/api/workspaces -Method Post -ContentType application/json -Body '{"name":"MyApp","path":"C:\\Projects\\MyApp"}'
```

## Resume Sessions

Resume requires the agent definition to set `supportsResume` and resume args. Unsupported agents show as unavailable and are not faked.
