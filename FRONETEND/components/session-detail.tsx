'use client'

import { useEffect, useState } from 'react'
import { Play, RefreshCw, Square, SquareTerminal, X } from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { ErrorBoundary } from '@/components/error-boundary'
import { StatusDot } from '@/components/status-dot'
import { TerminalPane } from '@/components/terminal-pane'
import { api } from '@/lib/api'
import { formatBytes } from '@/lib/format'
import type { ManagerState, SessionAction, SessionEvent } from '@/lib/types'

export function SessionDetail({ sessionId, state, socket, onBack, onAction, onOpenTerminal }: {
  sessionId: string
  state: ManagerState
  socket: Socket | null
  onBack: () => void
  onAction: (id: string, action: SessionAction) => Promise<void>
  onOpenTerminal: (id: string) => void
}) {
  const session = state.sessions.find((item) => item.id === sessionId)
  const workspace = state.workspaces.find((item) => item.id === session?.workspace_id)
  const agent = state.agentDefinitions.find((item) => item.id === session?.agent_definition_id)
  const [events, setEvents] = useState<SessionEvent[]>([])

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    const load = () => {
      api<SessionEvent[]>(`/api/sessions/${sessionId}/events`)
        .then((rows) => { if (!cancelled) setEvents(rows) })
        .catch(() => undefined)
    }
    load()
    const timer = window.setInterval(load, 30_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [sessionId])

  if (!session) {
    return <section className="main-content"><button className="back-button" onClick={onBack}>&larr; Back to dashboard</button><div className="empty-state">Session not found (it may have been cleared).</div></section>
  }

  const meta: Array<[string, string]> = [
    ['Status', session.status],
    ['PID', session.process_id ? String(session.process_id) : '-'],
    ['Exit code', session.exit_code === null ? '-' : String(session.exit_code)],
    ['Workspace', workspace?.name ?? session.workspace_id],
    ['Agent', agent?.display_name ?? session.agent_definition_id],
    ['Working dir', session.working_directory],
    ['Started', session.started_at ?? '-'],
    ['Stopped', session.stopped_at ?? '-'],
    ['Last activity', session.last_activity_at ?? '-'],
    ['CPU', `${session.cpu.toFixed(1)}%`],
    ['Memory', formatBytes(session.memory)],
    ['Resume', session.resume_capability],
  ]

  return <section className="main-content session-detail">
    <button className="back-button" onClick={onBack}>&larr; Back to dashboard</button>
    <div className="session-title">
      <StatusDot status={session.status} />
      <h1>{session.display_name}</h1>
      <div className="session-controls">
        {session.status === 'RESUMABLE' && <button className="secondary-button" onClick={() => void onAction(session.id, 'resume')}><Play /> Resume</button>}
        <button className="secondary-button" onClick={() => onOpenTerminal(session.id)}><SquareTerminal /> Open in terminal</button>
        <button className="secondary-button" onClick={() => void onAction(session.id, 'restart')}><RefreshCw /> Restart</button>
        <button className="secondary-button" onClick={() => void onAction(session.id, 'stop')}><Square /> Stop</button>
        <button className="danger-button" onClick={() => void onAction(session.id, 'force-terminate')}><X /> Force</button>
      </div>
    </div>
    <div className="session-detail-grid">
      <section className="panel"><div className="panel-heading"><div><div className="panel-kicker">LIVE TERMINAL</div><h2>Session terminal</h2></div></div><div className="terminal-section detail-terminal"><ErrorBoundary><TerminalPane session={session} socket={socket} /></ErrorBoundary></div></section>
      <section className="panel"><div className="panel-heading"><div><div className="panel-kicker">DETAILS</div><h2>Session metadata</h2></div></div><div className="meta-table">{meta.map(([label, value]) => <div className="meta-row" key={label}><span>{label}</span><b>{value}</b></div>)}</div></section>
    </div>
    <section className="panel"><div className="panel-heading"><div><div className="panel-kicker">SESSION LOG</div><h2>Lifecycle events</h2><p>Every start, stop, crash, and stuck-signal recorded for this session.</p></div></div><div className="activity-timeline">{events.length === 0 ? <div className="empty-state">No lifecycle events recorded.</div> : events.map((event) => <div className="activity-row" key={event.id}><span className={`activity-dot ${event.type.includes('crash') || event.type.includes('stuck') ? 'warning' : 'info'}`} /><div><p><b>{event.type}</b> <span className="mono muted">{event.payload_json.slice(0, 120)}</span></p><small>{event.created_at}</small></div></div>)}</div></section>
  </section>
}
