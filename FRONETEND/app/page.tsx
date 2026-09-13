'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { io } from 'socket.io-client'
import { Archive, AlertTriangle, Bell, Bot, Check, Command, Cpu, FileText, FolderKanban, Gauge, Menu, Plus, RefreshCw, ScrollText, Search, Settings2, SquareTerminal, X, Zap } from 'lucide-react'
import { AgentLogModal } from '@/components/agent-log-modal'
import { ErrorBoundary } from '@/components/error-boundary'
import { AgentForm, WorkspaceForm } from '@/components/forms'
import { ExternalSessionsPanel } from '@/components/external-sessions-panel'
import { Modal } from '@/components/modal'
import { SessionDetail } from '@/components/session-detail'
import { TerminalModal } from '@/components/terminal-modal'
import { api, MANAGER_URL } from '@/lib/api'
import { fileLabel, formatBytes } from '@/lib/format'
import { LIVE_STATUSES, type AgentSession, type ManagerState, type SessionAction, type View } from '@/lib/types'

type Notice = { message: string; tone: 'success' | 'error' }

export default function Page() {
  const [state, setState] = useState<ManagerState>({ workspaces: [], agentDefinitions: [], assignments: [], sessions: [], runningSessionIds: [], events: [] })
  const [socket, setSocket] = useState<Socket | null>(null)
  const [connected, setConnected] = useState(false)
  const [activeWorkspaceId, setActiveWorkspaceId] = useState('')
  const [activeSessionId, setActiveSessionId] = useState('')
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [mobileNav, setMobileNav] = useState(false)
  const [view, setView] = useState<View>({ kind: 'dashboard' })
  const [showAgentLog, setShowAgentLog] = useState(false)
  const [showTerminalFor, setShowTerminalFor] = useState<string | null>(null)
  const [terminalScope, setTerminalScope] = useState<'workspace' | 'agent'>('workspace')
  const [showWorkspaceForm, setShowWorkspaceForm] = useState(false)
  const [showAgentForm, setShowAgentForm] = useState(false)
  // Data-driven attributes (e.g. disabled={workspaceLiveCount === 0}) can
  // differ between the SSR snapshot and the first client render once
  // /api/state has landed, which trips React hydration. Render a stable
  // loading state until the client has mounted, then swap in the dashboard.
  const [ready, setReady] = useState(false)
  // Modal opened from the workspace panel: create the agent AND launch it here.
  const [showAssignAgent, setShowAssignAgent] = useState(false)
  // Registry rows are informational: clicking selects the agent, launching is explicit.
  const [selectedAgentId, setSelectedAgentId] = useState('')
  // Drag & drop: agent id currently dragged out of the registry, and the
  // workspace item currently highlighted as a drop target.
  const [dragAgentId, setDragAgentId] = useState<string | null>(null)
  const [dropHoverWorkspaceId, setDropHoverWorkspaceId] = useState<string | null>(null)
  const noticeTimer = useRef<number | null>(null)

  const flash = useCallback((message: string, tone: Notice['tone'] = 'success') => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    setNotice({ message, tone })
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2600)
  }, [])

  const sync = useCallback(async () => {
    const next = await api<ManagerState>('/api/state')
    setState(next)
    setActiveWorkspaceId((current) => current || next.workspaces[0]?.id || '')
    setActiveSessionId((current) => current || next.sessions.find((session) => session.status === 'RUNNING')?.id || next.sessions[0]?.id || '')
  }, [])

  const safeSync = useCallback(async () => {
    try {
      await sync()
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'Manager unreachable', tone: 'error' })
    }
  }, [sync])

  useEffect(() => {
    // Initial data fetch: setState happens in the async fetch callback, which
    // is exactly what effects are for — the rule just cannot see past the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void safeSync()
    const client = io(MANAGER_URL, { transports: ['websocket'], reconnection: true })
    // Sharing the connection object with children (terminal panes attach to it
    // on mount) requires storing it in state once.
    setSocket(client)
    client.on('connect', () => { setConnected(true); void safeSync() })
    client.on('disconnect', () => setConnected(false))
    // Only re-sync immediately for real lifecycle changes; high-frequency events
    // (terminal output, git.changed, resources) are covered by the 30s poll.
    const lifecycleEvent = (event: { type?: string }) => {
      if (event && typeof event.type === 'string' && event.type.startsWith('agent.')) void safeSync()
    }
    client.on('manager.event', lifecycleEvent)
    const poll = window.setInterval(() => void safeSync(), 30_000)
    return () => {
      client.close()
      window.clearInterval(poll)
    }
  }, [safeSync])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReady(true)
  }, [])

  const activeWorkspace = state.workspaces.find((workspace) => workspace.id === activeWorkspaceId)
  // Workspace-scoped lists: only the agents/sessions that belong to the active workspace.
  const workspaceSessions = useMemo(() => state.sessions.filter((session) => session.workspace_id === activeWorkspaceId), [state.sessions, activeWorkspaceId])
  const workspaceAgentIds = useMemo(() => new Set(workspaceSessions.map((session) => session.agent_definition_id)), [workspaceSessions])
  const workspaceAgents = useMemo(
    () => state.agentDefinitions.filter((agent) => workspaceAgentIds.has(agent.id)),
    [state.agentDefinitions, workspaceAgentIds],
  )
  // Agents explicitly assigned to the active workspace (drag & drop or API).
  const workspaceAssignedAgentIds = useMemo(
    () => new Set(state.assignments.filter((assignment) => assignment.workspace_id === activeWorkspaceId).map((assignment) => assignment.agent_definition_id)),
    [state.assignments, activeWorkspaceId],
  )
  // The workspace panel shows assigned agents plus any agent that has run here.
  const workspacePanelAgents = useMemo(() => {
    const ids = new Set<string>([...workspaceAgentIds, ...workspaceAssignedAgentIds])
    return state.agentDefinitions.filter((agent) => ids.has(agent.id))
  }, [state.agentDefinitions, workspaceAgentIds, workspaceAssignedAgentIds])
  const workspaceRunning = workspaceSessions.filter((session) => session.status === 'RUNNING')
  const workspaceWaiting = workspaceSessions.filter((session) => session.status === 'WAITING' || session.status === 'IDLE')
  const workspaceLiveCount = workspaceSessions.filter((session) => LIVE_STATUSES.includes(session.status)).length

  async function launchAgent(agentDefinitionId?: string) {
    try {
      const workspaceId = activeWorkspaceId || state.workspaces[0]?.id
      const definitionId = agentDefinitionId || (selectedAgentId || state.agentDefinitions.find((definition) => definition.enabled)?.id)
      if (!workspaceId || !definitionId) { flash('Add a workspace and agent first', 'error'); return }
      const session = await api<AgentSession>('/api/sessions', { method: 'POST', body: JSON.stringify({ workspaceId, agentDefinitionId: definitionId }) })
      setActiveSessionId(session.id)
      setShowTerminalFor(session.id)
      flash('Agent launched')
      await safeSync()
    } catch (error) {
      flash(error instanceof Error ? error.message : 'Launch failed', 'error')
      await safeSync()
    }
  }

  const sessionAction = useCallback(async (id: string, action: SessionAction) => {
    try {
      if (action === 'force-terminate' && !window.confirm('Force terminate this process?')) return
      await api<AgentSession>(`/api/sessions/${id}/${action}`, { method: 'POST' })
      flash(action === 'resume' ? 'Resume started' : 'Session updated')
      await safeSync()
    } catch (error) {
      flash(error instanceof Error ? error.message : 'Session action failed', 'error')
    }
  }, [flash, safeSync])

  async function deleteAgent(id: string, name: string) {
    try {
      if (!window.confirm(`Delete agent "${name}"? Existing session history remains visible.`)) return
      await api<{ deleted: boolean }>(`/api/agents/${id}`, { method: 'DELETE' })
      flash('Agent deleted')
      await safeSync()
    } catch (error) {
      flash(error instanceof Error ? error.message : 'Delete failed', 'error')
    }
  }

  async function clearAgents() {
    try {
      if (!window.confirm('Clear all agents and session history? Running managed sessions will be force stopped.')) return
      await api<{ cleared: boolean }>('/api/maintenance/clear-agents', { method: 'POST' })
      setActiveSessionId('')
      setShowTerminalFor(null)
      setView({ kind: 'dashboard' })
      flash('Agents and sessions cleared')
      await safeSync()
    } catch (error) {
      flash(error instanceof Error ? error.message : 'Clear failed', 'error')
    }
  }

  async function assignAgent(agentDefinitionId: string, workspaceId: string) {
    try {
      await api(`/api/workspaces/${workspaceId}/agents`, { method: 'POST', body: JSON.stringify({ agentDefinitionId }) })
      flash('Agent assigned to workspace')
      await safeSync()
    } catch (error) {
      flash(error instanceof Error ? error.message : 'Assign failed', 'error')
    }
  }

  async function unassignAgent(workspaceId: string, agentDefinitionId: string) {
    try {
      await api<{ removed: boolean }>(`/api/workspaces/${workspaceId}/agents/${agentDefinitionId}`, { method: 'DELETE' })
      flash('Agent removed from workspace')
      await safeSync()
    } catch (error) {
      flash(error instanceof Error ? error.message : 'Unassign failed', 'error')
    }
  }

  function handleWorkspaceDrop(event: React.DragEvent, workspaceId: string) {
    event.preventDefault()
    setDropHoverWorkspaceId(null)
    const agentId = event.dataTransfer.getData('application/x-agent-id') || dragAgentId
    setDragAgentId(null)
    if (!agentId) return
    setActiveWorkspaceId(workspaceId)
    void assignAgent(agentId, workspaceId)
  }

  function openTerminal(id: string) { setActiveSessionId(id); setShowTerminalFor(id) }

  // Opened from the workspace panel: create a new agent and run it in THIS workspace.
  function openAssignAgent() {
    if (!activeWorkspaceId) { flash('Add a workspace first', 'error'); return }
    setShowAssignAgent(true)
  }

  const terminalSessions = useMemo(() => {
    if (!showTerminalFor) return []
    const active = state.sessions.find((session) => session.id === showTerminalFor)
    if (!active) return []
    const list = terminalScope === 'agent'
      ? state.sessions.filter((session) => session.agent_definition_id === active.agent_definition_id && session.workspace_id === active.workspace_id)
      : workspaceSessions
    // Tabs show LIVE sessions only, so stopped history does not clutter the strip.
    return list.filter((session) => LIVE_STATUSES.includes(session.status))
  }, [showTerminalFor, terminalScope, state.sessions, workspaceSessions])

  function openSession(id: string) {
    setActiveSessionId(id)
    setShowAgentLog(false)
    setShowTerminalFor(null)
    setView({ kind: 'session', sessionId: id })
  }

  const filteredAgents = useMemo(
    () => state.agentDefinitions.filter((agent) => `${agent.display_name} ${agent.command}`.toLowerCase().includes(query.toLowerCase())),
    [state.agentDefinitions, query],
  )

  return <main className="app-shell">
    {notice && <div className={`toast ${notice.tone === 'error' ? 'toast-error' : ''}`}>{notice.tone === 'error' ? <AlertTriangle /> : <Check />} {notice.message}</div>}
    <header className="topbar"><div className="brand"><div className="brand-mark"><Command /></div><div><strong>FORGE</strong><span>MISSION CONTROL</span></div></div><div className="command-trigger"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search agents" /></div><div className="topbar-center"><span className={`manager-pulse ${connected ? '' : 'offline'}`} /><span>{connected ? 'Manager online' : 'Manager reconnecting'}</span><span className="topbar-divider" /><span className="mono muted">{MANAGER_URL}</span></div><div className="topbar-actions"><button className={`topbar-nav-button ${showAgentLog ? 'active' : ''}`} onClick={() => setShowAgentLog(true)} title="Agent log"><ScrollText /> Agent log</button><button className="icon-button mobile-menu" onClick={() => setMobileNav(!mobileNav)} aria-label="Toggle navigation"><Menu /></button><button className="icon-button" aria-label="Settings"><Settings2 /></button></div></header>
    <div className="workspace-layout"><aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}><div className="sidebar-scroll"><div className="section-label"><span>WORKSPACES</span><span>{state.workspaces.length}</span></div>{dragAgentId && <div className="drag-hint">Drop on a workspace to assign</div>}{state.workspaces.map((workspace) => <button key={workspace.id} className={`workspace-item ${workspace.id === activeWorkspaceId ? 'active' : ''} ${dropHoverWorkspaceId === workspace.id ? 'drop-hover' : ''}`} onClick={() => setActiveWorkspaceId(workspace.id)} onDragOver={(event) => { if (!dragAgentId) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropHoverWorkspaceId(workspace.id) }} onDragLeave={() => setDropHoverWorkspaceId((current) => (current === workspace.id ? null : current))} onDrop={(event) => handleWorkspaceDrop(event, workspace.id)}><span className="workspace-icon cyan"><FolderKanban /></span><span className="workspace-copy"><b>{workspace.name}</b><small>{workspace.git_branch ?? workspace.git_status ?? 'No Git status'}</small></span></button>)}<button className="new-workspace" onClick={() => setShowWorkspaceForm(true)}><Plus /> Add workspace</button><div className="section-label"><span>AGENT REGISTRY</span><span>{state.agentDefinitions.length}</span></div>{filteredAgents.map((agent) => <div className={`agent-config-row ${dragAgentId === agent.id ? 'dragging' : ''}`} key={agent.id} draggable onDragStart={(event) => { event.dataTransfer.setData('application/x-agent-id', agent.id); event.dataTransfer.setData('text/plain', agent.id); event.dataTransfer.effectAllowed = 'copyMove'; setDragAgentId(agent.id) }} onDragEnd={() => { setDragAgentId(null); setDropHoverWorkspaceId(null) }}><button className={`nav-item agent-launch-item ${selectedAgentId === agent.id ? 'selected-agent' : ''}`} onClick={() => setSelectedAgentId(agent.id)} title={`${agent.command} — click to select, use Launch to run it in this workspace`}><Bot /><span className="agent-config-copy"><b>{agent.display_name}</b><small>{fileLabel(agent.command)}</small></span><span className="status-pill">{agent.launcher_type}</span></button><button className="agent-delete-button" onClick={() => void deleteAgent(agent.id, agent.display_name)} aria-label={`Delete ${agent.display_name}`}><X /></button></div>)}<button className="new-workspace" onClick={() => setShowAgentForm(true)}><Plus /> Add agent</button><button className="new-workspace danger-link" onClick={() => void clearAgents()}><X /> Clear all agents</button></div><div className="sidebar-footer"><div className="system-row"><span className="system-icon"><Cpu /></span><div><b>System resources</b><small>{state.system ? `${state.system.cpuPercent.toFixed(0)}% CPU / ${state.system.memoryPercent.toFixed(0)}% RAM` : `${workspaceRunning.length} running processes`}</small></div><span className="resource-health" /></div><div className="resource-bar"><span style={{ width: `${Math.min(100, state.system?.memoryPercent ?? 0)}%` }} /></div><div className="resource-meta"><span>CPU <b>{state.system?.cpuPercent.toFixed(0) ?? 0}%</b></span><span>RAM <b>{formatBytes(state.system?.memoryUsed ?? 0)}</b></span></div></div></aside>
      <ErrorBoundary>
        {!ready
          ? <section className="main-content"><div className="empty-state">Connecting to manager…</div></section>
        : view.kind === 'session'
          ? <SessionDetail
              sessionId={view.sessionId}
              state={state}
              socket={socket}
              onBack={() => setView({ kind: 'dashboard' })}
              onAction={sessionAction}
              onOpenTerminal={openTerminal}
            />
          : <section className="main-content">
          <div className="mission-banner"><div><div className="eyebrow"><span className="eyebrow-line" /> LOCAL OPERATIONS</div><h1>{activeWorkspace?.name ?? 'Agent Control Center'}</h1><p>{activeWorkspace?.path ?? 'Add a workspace and configure an agent to begin.'}</p></div><div className="banner-actions"><button className="secondary-button" onClick={() => void safeSync()}><RefreshCw /> Sync</button><button className="secondary-button" onClick={openAssignAgent}><Bot /> Create agent for this workspace</button><button className="primary-button" onClick={() => void launchAgent()}><Plus /> Launch agent</button></div></div>
          <div className="stat-grid mission-stats"><div className="stat-card accent-cyan"><div className="stat-icon cyan"><Zap /></div><div><span>Running</span><strong>{workspaceRunning.length}</strong></div></div><div className="stat-card accent-orange"><div className="stat-icon orange"><Bell /></div><div><span>Waiting</span><strong>{workspaceWaiting.length}</strong></div></div><div className="stat-card accent-blue"><div className="stat-icon blue"><Archive /></div><div><span>RAM used</span><strong>{state.system?.memoryPercent.toFixed(0) ?? 0}<small>%</small></strong></div></div><div className="stat-card accent-violet"><div className="stat-icon violet"><Gauge /></div><div><span>System CPU</span><strong>{state.system?.cpuPercent.toFixed(0) ?? 0}<small>%</small></strong></div></div></div>

          {/* Landing page: ONLY the workspace-scoped agent panel. */}
          <section className="panel workspace-agents-panel">
            <div className="panel-heading"><div><div className="panel-kicker">THIS WORKSPACE</div><h2>Agents working here</h2><p>Only agents launched in {activeWorkspace?.name ?? 'this workspace'}.</p></div><div className="heading-actions"><button className="secondary-button" onClick={() => { const live = workspaceSessions.find((session) => LIVE_STATUSES.includes(session.status)); if (live) { setTerminalScope('workspace'); openTerminal(live.id) } else { flash('No live sessions in this workspace — launch an agent first', 'error') } }} disabled={workspaceLiveCount === 0} title="Open workspace terminal (live sessions only)"><SquareTerminal /> Terminal</button><button className="secondary-button" onClick={() => setShowAgentLog(true)} title="Open agent log"><FileText /> Agent log</button><button className="secondary-button" onClick={openAssignAgent} title="Create a new agent and run it in this workspace"><Bot /> Assign agent</button><button className="primary-button" onClick={() => void launchAgent()}><Plus /> Launch</button></div></div>
            <div className="workspace-agents">{workspacePanelAgents.length === 0
              ? <div className="empty-state">No agents assigned to this workspace yet. Drag an agent from the registry onto the workspace, or use Launch.</div>
              : workspacePanelAgents.map((agent) => {
                const agentSessions = workspaceSessions.filter((session) => session.agent_definition_id === agent.id)
                const live = agentSessions.filter((session) => LIVE_STATUSES.includes(session.status))
                const latest = live[0] ?? agentSessions[0]
                const isAssigned = workspaceAssignedAgentIds.has(agent.id)
                return <div className="workspace-agent-card" key={agent.id}>
                  <div className="workspace-agent-head"><span className="workspace-icon cyan"><Bot /></span><div className="workspace-agent-copy"><b>{agent.display_name}</b><small>{fileLabel(agent.command)} · {agent.launcher_type}</small></div><span className={`status-pill ${live.length > 0 ? 'live' : ''}`}>{live.length > 0 ? `${live.length} running` : 'idle'}</span>{isAssigned && <button className="agent-delete-button" title="Remove from workspace" aria-label={`Remove ${agent.display_name} from workspace`} onClick={() => activeWorkspaceId && void unassignAgent(activeWorkspaceId, agent.id)}><X /></button>}</div>
                  <div className="workspace-agent-actions"><button className="secondary-button" onClick={() => void launchAgent(agent.id)}><Plus /> Launch</button>                <button className="secondary-button" disabled={!latest} onClick={() => { if (!latest) return; setTerminalScope('agent'); openTerminal(latest.id) }}><SquareTerminal /> Terminal</button></div>
                </div>
              })}</div>
          </section>
          <ExternalSessionsPanel workspaceId={activeWorkspaceId} workspaceName={activeWorkspace?.name ?? 'this workspace'} onResumeStarted={(message, tone) => flash(message, tone)} />
        </section>}
      </ErrorBoundary>
    </div>

    {/* Modals */}
    <ErrorBoundary>
      {showAgentLog && activeWorkspace && <AgentLogModal state={state} workspaceId={activeWorkspace.id} workspaceName={activeWorkspace.name} onClose={() => setShowAgentLog(false)} onOpenSession={openSession} onOpenTerminal={openTerminal} onAction={sessionAction} />}
      {showTerminalFor && <TerminalModal sessions={terminalSessions} activeSessionId={showTerminalFor} socket={socket} workspaceName={activeWorkspace?.name} workspaceAgents={workspaceAgents} scope={terminalScope} onScope={(scope) => setTerminalScope(scope)} onSelect={(id) => { setActiveSessionId(id); setShowTerminalFor(id) }} onClose={() => setShowTerminalFor(null)} onAction={sessionAction} onDetail={(id) => { setShowTerminalFor(null); openSession(id) }} />}
      {showWorkspaceForm && <Modal title="Add workspace" kicker="NEW WORKSPACE" onClose={() => setShowWorkspaceForm(false)}><WorkspaceForm onDone={() => { setShowWorkspaceForm(false); flash('Workspace added'); void safeSync() }} onError={(message) => flash(message, 'error')} /></Modal>}
      {showAgentForm && <Modal title="Add agent" kicker="AGENT REGISTRY" onClose={() => setShowAgentForm(false)}><AgentForm onDone={() => { setShowAgentForm(false); flash('Agent configured'); void safeSync() }} onError={(message) => flash(message, 'error')} /></Modal>}
      {showAssignAgent && activeWorkspace && <Modal title={`New agent — ${activeWorkspace.name}`} kicker="THIS WORKSPACE" onClose={() => setShowAssignAgent(false)}><AgentForm workspaceId={activeWorkspace.id} workspaceName={activeWorkspace.name} onDone={(result) => { setShowAssignAgent(false); if (result?.id) openTerminal(result.id); flash('Agent created and launched in this workspace'); void safeSync() }} onError={(message) => flash(message, 'error')} /></Modal>}
    </ErrorBoundary>
  </main>
}
