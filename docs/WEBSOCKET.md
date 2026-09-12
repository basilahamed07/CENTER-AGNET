# WebSocket Protocol

Socket.IO connects to:

```text
ws://127.0.0.1:4242
```

## Server Events

`manager.state`

Initial connection summary.

`manager.event`

Lifecycle and monitoring events, excluding high-volume terminal output.

Example:

```json
{
  "id": "...",
  "type": "agent.started",
  "sessionId": "...",
  "workspaceId": "...",
  "payload": { "pid": 1234 },
  "createdAt": "2026-09-08T12:00:00.000Z"
}
```

`terminal.output`

Terminal bytes for attached sessions.

```json
{
  "sessionId": "...",
  "payload": { "data": "..." }
}
```

## Client Events

`terminal.attach`

```json
{ "sessionId": "..." }
```

Joins the session stream and receives the manager's bounded live output buffer.

`terminal.input`

```json
{ "sessionId": "...", "data": "\r" }
```

`terminal.resize`

```json
{ "sessionId": "...", "cols": 120, "rows": 32 }
```
