'use client'

import { MoreHorizontal, RefreshCw, Square, X } from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { Modal } from '@/components/modal'
import { StatusDot } from '@/components/status-dot'
import { TerminalPane } from '@/components/terminal-pane'
import { fileLabel } from '@/lib/format'
import { LIVE_STATUSES, type AgentDefinition, type AgentSession, type SessionAction } from '@/lib/types'

export function TerminalModal({ sessions, activeSessionId, socket, workspaceName, workspaceAgents, scope, onScope, onSelect, onClose, onAction, onDetail }: {
  sessions: AgentSession[]
  activeSessionId: string
  socket: Socket | null
  workspaceName?: string
  workspaceAgents: AgentDefinition[]
  scope: 'workspace' | 'agent'
  onScope: (scope: 'workspace' | 'agent') => void
  onSelect: (id: string) => void
  onClose: () => void
  onAction: (id: string, action: SessionAction) => Promise<void>
  onDetail: (id: string) => void
}) {
  const current = sessions.find((session) => session.id === activeSessionId)
  // Every tab just went dead (e.g. the agent exited while the modal was open):
  // render an explicit empty state instead of a blank modal.
  if (!current) return <Modal title="Terminal" kicker="LIVE TERMINAL" onClose={onClose} wide><div className="empty-state">No live sessions. Launch an agent in this workspace to see its terminal here.</div></Modal>
  return (
    <Modal title={current.display_name} kicker={scope === 'agent' ? 'LIVE TERMINAL · AGENT' : 'LIVE TERMINAL · WORKSPACE'} onClose={onClose} wide bodyClassName="modal-terminal-body">
      {sessions.length > 1 && <div className="terminal-tab-strip">
        <div className="terminal-tabs-scroll">
          <div className="terminal-scope-switch">
            <button className={`scope-chip ${scope === 'workspace' ? 'selected' : ''}`} onClick={() => onScope('workspace')} title="All sessions in this workspace">{workspaceName ?? 'Workspace'}</button>
            <button className={`scope-chip ${scope === 'agent' ? 'selected' : ''}`} onClick={() => onScope('agent')} title="Only this agent's sessions">Agent only</button>
          </div>
          {sessions.map((session) => {
            const agent = workspaceAgents.find((item) => item.id === session.agent_definition_id)
            return <div key={session.id} role="tab" aria-selected={session.id === activeSessionId} tabIndex={0} className={`terminal-tab ${session.id === activeSessionId ? 'active' : ''}`} onClick={() => onSelect(session.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect(session.id) }}>
              <span className={`terminal-tab-dot ${LIVE_STATUSES.includes(session.status) ? 'live' : ''}`} />
              <span className="terminal-tab-label">{session.display_name}</span>
              <small>{agent ? fileLabel(agent.command) : session.status.toLowerCase()}</small>
              <button className="terminal-tab-close" title="Open session detail" onClick={(event) => { event.stopPropagation(); onDetail(session.id) }}><MoreHorizontal /></button>
            </div>
          })}
        </div>
      </div>}
      <div className="terminal-body-stack">
        {sessions.map((session) => <div key={session.id} className={`terminal-body ${session.id === activeSessionId ? 'visible' : 'hidden'}`}><TerminalPane session={session} visible={session.id === activeSessionId} socket={socket} /></div>)}
      </div>
      <div className="session-meta modal-terminal-meta"><span><StatusDot status={current.status} /> {current.status}</span><span>PID {current.process_id ?? '-'}</span><span>Exit {current.exit_code ?? '-'}</span><span className="meta-spacer" /><button className="secondary-button" onClick={() => onDetail(current.id)}>Detail</button><button className="secondary-button" onClick={() => void onAction(current.id, 'restart')}><RefreshCw /> Restart</button><button className="secondary-button" onClick={() => void onAction(current.id, 'stop')}><Square /> Stop</button><button className="danger-button" onClick={() => void onAction(current.id, 'force-terminate')}><X /> Force</button></div>
    </Modal>
  )
}
