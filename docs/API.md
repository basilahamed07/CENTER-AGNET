# HTTP API

Default manager URL:

```text
http://127.0.0.1:4242
```

## Endpoints

`GET /health`

Returns manager health and PID.

`GET /api/state`

Returns workspaces, agent definitions, sessions, running session IDs, and recent events.

`GET /api/workspaces`

Lists non-archived workspaces.

`POST /api/workspaces`

```json
{ "name": "MyApp", "path": "C:\\Projects\\MyApp" }
```

`DELETE /api/workspaces/:id`

Archives a workspace.

`GET /api/agents`

Lists configured agent definitions.

`POST /api/agents`

```json
{
  "displayName": "Claude Code",
  "command": "claude",
  "launcherType": "direct",
  "defaultArgs": [],
  "env": {},
  "supportsResume": false
}
```

`PATCH /api/agents/:id/enabled`

```json
{ "enabled": false }
```

`GET /api/sessions`

Lists active and historical sessions.

`POST /api/sessions`

```json
{ "workspaceId": "...", "agentDefinitionId": "..." }
```

`POST /api/sessions/:id/stop`

Sends Ctrl+C and waits for graceful exit.

`POST /api/sessions/:id/force-terminate`

Kills the PTY process. The frontend asks for confirmation before calling this.

`POST /api/sessions/:id/restart`

Stops the current session and creates a new running session.

`POST /api/sessions/:id/resume`

Starts a new session using the agent definition resume configuration.
