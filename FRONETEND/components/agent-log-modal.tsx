'use client'

import { Bot, MoreHorizontal, Play, Square, SquareTerminal } from 'lucide-react'
import { Modal } from '@/components/modal'
import { StatusDot } from '@/components/status-dot'
import { fileLabel, formatBytes } from '@/lib/format'
import { LIVE_STATUSES, type ManagerState, type SessionAction } from '@/lib/types'

export function AgentLogModal({ state, workspaceId, workspaceName, onClose, onOpenSession, onOpenTerminal, onAction }: {
  state: ManagerState
  workspaceId: string
  workspaceName: string
  onClose: () => void
  onOpenSession: (id: string) => void
  onOpenTerminal: (id: string) => void
  onAction: (id: string, action: SessionAction) => Promise<void>
}) {
  const scoped = workspaceId ? state.sessions.filter((session) => session.workspace_id === workspaceId) : state.sessions
  const running = scoped.filter((session) => LIVE_STATUSES.includes(session.status))
  const history = scoped.filter((session) => !LIVE_STATUSES.includes(session.status))

  return (
    <Modal title={`Agent log — ${workspaceName}`} kicker="ALL AGENTS · SESSION HISTORY" onClose={onClose} wide>
      <section className="log-section">
        <div className="log-heading">Working now <span className="log-count">{running.length}</span></div>
        {running.length === 0
          ? <div className="empty-state">No agents are working in this workspace right now.</div>
          : running.map((session) => {
            const agent = state.agentDefinitions.find((item) => item.id === session.agent_definition_id)
            return <div className="session-row mission-row" key={session.id}>
              <span className="session-main"><span className="session-name-line"><StatusDot status={session.status} /><b>{session.display_name}</b></span><small><span className="agent-chip"><Bot /> {agent?.display_name ?? 'Agent'}</span></small></span>
              <span className={`status-label ${session.status.toLowerCase()}`}>{session.status}</span>
              <span className="resource-cell"><span>{session.cpu.toFixed(1)}% CPU</span><span>{formatBytes(session.memory)}</span></span>
              <span className="log-actions">
                <button className="mini-action" title="Open terminal" onClick={() => onOpenTerminal(session.id)}><SquareTerminal /></button>
                <button className="mini-action" title="Open session detail" onClick={() => onOpenSession(session.id)}><MoreHorizontal /></button>
                <button className="mini-action danger" title="Stop" onClick={() => void onAction(session.id, 'stop')}><Square /></button>
              </span>
            </div>
          })}
      </section>
      <section className="log-section">
        <div className="log-heading">History <span className="log-count">{history.length}</span></div>
        {history.length === 0
          ? <div className="empty-state">No past sessions in this workspace.</div>
          : history.map((session) => {
            const agent = state.agentDefinitions.find((item) => item.id === session.agent_definition_id)
            return <div className="session-row mission-row" key={session.id}>
              <span className="session-main"><span className="session-name-line"><StatusDot status={session.status} /><b>{session.display_name}</b></span><small><span className="agent-chip"><Bot /> {agent?.display_name ?? 'Agent'}</span><span>{session.stopped_at ?? session.started_at ?? ''}</span></small></span>
              <span className={`status-label ${session.status.toLowerCase()}`}>{session.status}</span>
              <span className="resource-cell"><span>Exit {session.exit_code ?? '-'}</span><span>{session.resume_capability}</span></span>
              <span className="log-actions">
                <button className="mini-action" title="Open session detail" onClick={() => onOpenSession(session.id)}><MoreHorizontal /></button>
                {session.status === 'RESUMABLE' && <button className="mini-action" title="Resume" onClick={() => void onAction(session.id, 'resume')}><Play /></button>}
              </span>
            </div>
          })}
      </section>
    </Modal>
  )
}
