'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { io, type Socket } from 'socket.io-client'
import { Archive, Bell, Bot, Check, Command, Cpu, FileText, FolderKanban, Gauge, Menu, MoreHorizontal, Play, Plus, RefreshCw, ScrollText, Search, Settings2, Square, SquareTerminal, TerminalSquare, X, Zap } from 'lucide-react'

const MANAGER_URL = process.env.NEXT_PUBLIC_MANAGER_URL ?? 'http://127.0.0.1:4242'

type AgentStatus = 'CREATED' | 'STARTING' | 'RUNNING' | 'IDLE' | 'WAITING' | 'STOPPING' | 'STOPPED' | 'CRASHED' | 'DISCONNECTED' | 'RESUMABLE'
type LauncherType = 'direct' | 'cmd' | 'bat'
type View = { kind: 'dashboard' } | { kind: 'session'; sessionId: string }

interface Workspace { id: string; name: string; path: string; git_branch: string | null; git_status: string | null; git_modified: number; git_staged: number; git_untracked: number }
interface AgentDefinition { id: string; display_name: string; command: string; launcher_type: LauncherType; enabled: number; supports_resume: number }
interface AgentSession { id: string; workspace_id: string; agent_definition_id: string; display_name: string; process_id: number | null; agent_session_id: string | null; status: AgentStatus; working_directory: string; started_at: string | null; stopped_at: string | null; last_activity_at: string | null; exit_code: number | null; resume_capability: string; cpu: number; memory: number; stuck_confidence: string }
interface SystemResources { cpuPercent: number; memoryUsed: number; memoryTotal: number; memoryPercent: number; processCount: number }
interface SessionEvent { id: string; session_id: string | null; type: string; payload_json: string; created_at: string }
interface ManagerState { workspaces: Workspace[]; agentDefinitions: AgentDefinition[]; sessions: AgentSession[]; runningSessionIds: string[]; events: Array<{ id: string; type: string; created_at: string; payload_json: string }>; system?: SystemResources }

function StatusDot({ status }: { status: string }) { return <span className={`status-dot ${status.toLowerCase()}`} aria-label={status} /> }

function fileLabel(value: string) {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${MANAGER_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } })
  } catch {
    throw new Error(`Manager unreachable at ${MANAGER_URL} — start it with 'npm run start:detached' in BACKEND`)
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string }
    throw new Error(body.error ?? response.statusText)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

/* ============================ Shared modal shell ============================ */

function Modal({ title, kicker, onClose, children, wide, bodyClassName }: { title: string; kicker: string; onClose: () => void; children: React.ReactNode; wide?: boolean; bodyClassName?: string }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal-window ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="panel-kicker">{kicker}</div>
            <h2>{title}</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close"><X /></button>
        </div>
        <div className={`modal-body ${bodyClassName ?? ''}`}>{children}</div>
      </div>
    </div>
  )
}

/* ============================ Form components ============================ */

function WorkspaceForm({ onDone, onError }: { onDone: () => void; onError: (message: string) => void }) {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!path.trim()) return
    setBusy(true)
    try {
      const finalName = name.trim() || path.split(/[\\/]/).filter(Boolean).at(-1) || 'Workspace'
      await api<Workspace>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: finalName, path: path.trim() }) })
      onDone()
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Workspace failed')
      setBusy(false)
    }
  }

  return (
    <form className="modal-form" onSubmit={(event) => void submit(event)}>
      <label className="form-field">
        <span>Workspace path *</span>
        <input className="form-input mono" value={path} onChange={(event) => setPath(event.target.value)} placeholder="D:\projects\my-app" autoFocus />
      </label>
      <label className="form-field">
        <span>Display name</span>
        <input className="form-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Defaults to folder name" />
      </label>
      <div className="form-hint">The path must exist on this machine — it becomes the agent&apos;s working directory.</div>
      <div className="form-actions">
        <button type="button" className="secondary-button" onClick={onDone}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy || !path.trim()}>{busy ? 'Adding…' : 'Add workspace'}</button>
      </div>
    </form>
  )
}

const LAUNCHER_OPTIONS: Array<{ value: LauncherType; label: string; hint: string }> = [
  { value: 'direct', label: 'direct', hint: 'CLI on PATH (claude, codex…)' },
  { value: 'cmd', label: 'cmd', hint: '.cmd shim (npm global installs)' },
  { value: 'bat', label: 'bat', hint: '.bat batch file' },
]

function AgentForm({ workspaceName, workspaceId, onDone, onError }: { workspaceName?: string; workspaceId?: string; onDone: (result?: { id: string }) => void; onError: (message: string) => void }) {
  const [displayName, setDisplayName] = useState('Claude Code')
  const [command, setCommand] = useState('claude')
  const [launcherType, setLauncherType] = useState<LauncherType>('direct')
  const [supportsResume, setSupportsResume] = useState(false)
  const [launchAfter, setLaunchAfter] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const lower = command.toLowerCase()
    if (lower.endsWith('.bat')) setLauncherType('bat')
    else if (lower.endsWith('.cmd')) setLauncherType('cmd')
  }, [command])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!displayName.trim() || !command.trim()) return
    setBusy(true)
    try {
      const agent = await api<AgentDefinition>('/api/agents', { method: 'POST', body: JSON.stringify({ displayName: displayName.trim(), command: command.trim(), launcherType, defaultArgs: [], env: {}, supportsResume }) })
      // Workspace-scoped mode: immediately launch the new agent in that workspace.
      if (workspaceId) {
        const session = await api<AgentSession>('/api/sessions', { method: 'POST', body: JSON.stringify({ workspaceId, agentDefinitionId: agent.id }) })
        onDone(session ? { id: session.id } : undefined)
      } else {
        onDone(agent ? { id: agent.id } : undefined)
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Agent configuration failed')
      setBusy(false)
    }
  }

  return (
    <form className="modal-form" onSubmit={(event) => void submit(event)}>
      {workspaceName && <div className="form-hint">This agent will be created and launched in <b>{workspaceName}</b>.</div>}
      <label className="form-field">
        <span>Display name *</span>
        <input className="form-input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Claude Code" autoFocus />
      </label>
      <label className="form-field">
        <span>Command or launcher path *</span>
        <input className="form-input mono" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="claude  ·  C:\path\to\agent.cmd" />
      </label>
      <div className="form-field">
        <span>Launcher type</span>
        <div className="launcher-picker">{LAUNCHER_OPTIONS.map((option) => (
          <button type="button" key={option.value} className={`launcher-option ${launcherType === option.value ? 'selected' : ''}`} onClick={() => setLauncherType(option.value)}>
            <b>{option.label}</b>
            <small>{option.hint}</small>
          </button>
        ))}</div>
      </div>
      <label className="form-check">
        <input type="checkbox" checked={supportsResume} onChange={(event) => setSupportsResume(event.target.checked)} />
        <span>Agent supports session resume (--resume flag)</span>
      </label>
      {!workspaceId && <label className="form-check">
        <input type="checkbox" checked={launchAfter} onChange={(event) => setLaunchAfter(event.target.checked)} />
        <span>Launch in the active workspace right away</span>
      </label>}
      <div className="form-actions">
        <button type="button" className="secondary-button" onClick={() => onDone()}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy || !displayName.trim() || !command.trim()}>{busy ? (workspaceId ? 'Creating & launching…' : 'Saving…') : (workspaceId ? 'Create & launch here' : 'Add agent')}</button>
      </div>
    </form>
  )
}

/* ============================ Agent log modal ============================ */

function AgentLogModal({ state, workspaceId, workspaceName, onClose, onOpenSession, onOpenTerminal, onAction }: {
  state: ManagerState
  workspaceId: string
  workspaceName: string
  onClose: () => void
  onOpenSession: (id: string) => void
  onOpenTerminal: (id: string) => void
  onAction: (id: string, action: 'stop' | 'force-terminate' | 'restart' | 'resume') => Promise<void>
}) {
  const scoped = workspaceId ? state.sessions.filter((session) => session.workspace_id === workspaceId) : state.sessions
  const running = scoped.filter((session) => ['RUNNING', 'STARTING', 'IDLE', 'WAITING'].includes(session.status))
  const history = scoped.filter((session) => !['RUNNING', 'STARTING', 'IDLE', 'WAITING'].includes(session.status))

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

/* ============================ Main page ============================ */

export default function Page() {
  const [state, setState] = useState<ManagerState>({ workspaces: [], agentDefinitions: [], sessions: [], runningSessionIds: [], events: [] })
  const [socket, setSocket] = useState<Socket | null>(null)
  const [connected, setConnected] = useState(false)
  const [activeWorkspaceId, setActiveWorkspaceId] = useState('')
  const [activeSessionId, setActiveSessionId] = useState('')
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState('')
  const [mobileNav, setMobileNav] = useState(false)
  const [view, setView] = useState<View>({ kind: 'dashboard' })
  const [showAgentLog, setShowAgentLog] = useState(false)
  const [showTerminalFor, setShowTerminalFor] = useState<string | null>(null)
  const [terminalScope, setTerminalScope] = useState<'workspace' | 'agent'>('workspace')
  const [showWorkspaceForm, setShowWorkspaceForm] = useState(false)
  const [showAgentForm, setShowAgentForm] = useState(false)
  // Modal opened from the workspace panel: create the agent AND launch it here.
  const [showAssignAgent, setShowAssignAgent] = useState(false)
  // Registry rows are informational: clicking selects the agent, launching is explicit.
  const [selectedAgentId, setSelectedAgentId] = useState('')

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
      setNotice(error instanceof Error ? error.message : 'Manager unreachable')
    }
  }, [sync])

  useEffect(() => {
    void safeSync()
    const client = io(MANAGER_URL, { transports: ['websocket'], reconnection: true })
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

  const activeWorkspace = state.workspaces.find((workspace) => workspace.id === activeWorkspaceId)
  const activeSession = state.sessions.find((session) => session.id === showTerminalFor)
  // Workspace-scoped lists: only the agents/sessions that belong to the active workspace.
  const workspaceSessions = useMemo(() => state.sessions.filter((session) => session.workspace_id === activeWorkspaceId), [state.sessions, activeWorkspaceId])
  const workspaceAgentIds = useMemo(() => new Set(workspaceSessions.map((session) => session.agent_definition_id)), [workspaceSessions])
  const workspaceAgents = useMemo(
    () => state.agentDefinitions.filter((agent) => workspaceAgentIds.has(agent.id)),
    [state.agentDefinitions, workspaceAgentIds],
  )
  const workspaceRunning = workspaceSessions.filter((session) => session.status === 'RUNNING')
  const workspaceWaiting = workspaceSessions.filter((session) => session.status === 'WAITING' || session.status === 'IDLE')
  const workspaceLiveCount = workspaceSessions.filter((session) => LIVE_STATUSES.includes(session.status)).length

  function flash(message: string) { setNotice(message); window.setTimeout(() => setNotice(''), 2600) }

  async function launchAgent(agentDefinitionId?: string) {
    try {
      const workspaceId = activeWorkspaceId || state.workspaces[0]?.id
      const definitionId = agentDefinitionId || (selectedAgentId || state.agentDefinitions.find((definition) => definition.enabled)?.id)
      if (!workspaceId || !definitionId) { flash('Add a workspace and agent first'); return }
      const session = await api<AgentSession>('/api/sessions', { method: 'POST', body: JSON.stringify({ workspaceId, agentDefinitionId: definitionId }) })
      setActiveSessionId(session.id)
      setShowTerminalFor(session.id)
      flash('Agent launched')
      await safeSync()
    } catch (error) {
      flash(error instanceof Error ? error.message : 'Launch failed')
      await safeSync()
    }
  }

  async function sessionAction(id: string, action: 'stop' | 'force-terminate' | 'restart' | 'resume') {
    try {
      if (action === 'force-terminate' && !window.confirm('Force terminate this process?')) return
      await api<AgentSession>(`/api/sessions/${id}/${action}`, { method: 'POST' })
      flash(action === 'resume' ? 'Resume started' : 'Session updated')
      await safeSync()
    } catch (error) {
      flash(error instanceof Error ? error.message : 'Session action failed')
    }
  }

  async function deleteAgent(id: string, name: string) {
    try {
      if (!window.confirm(`Delete agent "${name}"? Existing session history remains visible.`)) return
      await api<{ deleted: boolean }>(`/api/agents/${id}`, { method: 'DELETE' })
      flash('Agent deleted')
      await safeSync()
    } catch (error) {
      flash(error instanceof Error ? error.message : 'Delete failed')
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
      flash(error instanceof Error ? error.message : 'Clear failed')
    }
  }

  function openTerminal(id: string) { setActiveSessionId(id); setShowTerminalFor(id) }

  // Opened from the workspace panel: create a new agent and run it in THIS workspace.
  function openAssignAgent() {
    if (!activeWorkspaceId) { flash('Add a workspace first'); return }
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
    const live = list.filter((session) => LIVE_STATUSES.includes(session.status))
    return live
  }, [showTerminalFor, terminalScope, state.sessions, workspaceSessions])

  function openSession(id: string) {
    setActiveSessionId(id)
    setShowAgentLog(false)
    setShowTerminalFor(null)
    setView({ kind: 'session', sessionId: id })
  }

  const filteredAgents = state.agentDefinitions.filter((agent) => `${agent.display_name} ${agent.command}`.toLowerCase().includes(query.toLowerCase()))

  return <main className="app-shell">
    {notice && <div className="toast"><Check /> {notice}</div>}
    <header className="topbar"><div className="brand"><div className="brand-mark"><Command /></div><div><strong>FORGE</strong><span>MISSION CONTROL</span></div></div><div className="command-trigger"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search agents" /></div><div className="topbar-center"><span className={`manager-pulse ${connected ? '' : 'offline'}`} /><span>{connected ? 'Manager online' : 'Manager reconnecting'}</span><span className="topbar-divider" /><span className="mono muted">{MANAGER_URL}</span></div><div className="topbar-actions"><button className={`topbar-nav-button ${showAgentLog ? 'active' : ''}`} onClick={() => setShowAgentLog(true)} title="Agent log"><ScrollText /> Agent log</button><button className="icon-button mobile-menu" onClick={() => setMobileNav(!mobileNav)} aria-label="Toggle navigation"><Menu /></button><button className="icon-button" aria-label="Settings"><Settings2 /></button></div></header>
    <div className="workspace-layout"><aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}><div className="sidebar-scroll"><div className="section-label"><span>WORKSPACES</span><span>{state.workspaces.length}</span></div>{state.workspaces.map((workspace) => <button key={workspace.id} className={`workspace-item ${workspace.id === activeWorkspaceId ? 'active' : ''}`} onClick={() => setActiveWorkspaceId(workspace.id)}><span className="workspace-icon cyan"><FolderKanban /></span><span className="workspace-copy"><b>{workspace.name}</b><small>{workspace.git_branch ?? workspace.git_status ?? 'No Git status'}</small></span></button>)}<button className="new-workspace" onClick={() => setShowWorkspaceForm(true)}><Plus /> Add workspace</button><div className="section-label"><span>AGENT REGISTRY</span><span>{state.agentDefinitions.length}</span></div>{filteredAgents.map((agent) => <div className="agent-config-row" key={agent.id}><button className={`nav-item agent-launch-item ${selectedAgentId === agent.id ? 'selected-agent' : ''}`} onClick={() => setSelectedAgentId(agent.id)} title={`${agent.command} — click to select, use Launch to run it in this workspace`}><Bot /><span className="agent-config-copy"><b>{agent.display_name}</b><small>{fileLabel(agent.command)}</small></span><span className="status-pill">{agent.launcher_type}</span></button><button className="agent-delete-button" onClick={() => void deleteAgent(agent.id, agent.display_name)} aria-label={`Delete ${agent.display_name}`}><X /></button></div>)}<button className="new-workspace" onClick={() => setShowAgentForm(true)}><Plus /> Add agent</button><button className="new-workspace danger-link" onClick={() => void clearAgents()}><X /> Clear all agents</button></div><div className="sidebar-footer"><div className="system-row"><span className="system-icon"><Cpu /></span><div><b>System resources</b><small>{state.system ? `${state.system.cpuPercent.toFixed(0)}% CPU / ${state.system.memoryPercent.toFixed(0)}% RAM` : `${workspaceRunning.length} running processes`}</small></div><span className="resource-health" /></div><div className="resource-bar"><span style={{ width: `${Math.min(100, state.system?.memoryPercent ?? 0)}%` }} /></div><div className="resource-meta"><span>CPU <b>{state.system?.cpuPercent.toFixed(0) ?? 0}%</b></span><span>RAM <b>{formatBytes(state.system?.memoryUsed ?? 0)}</b></span></div></div></aside>
      {view.kind === 'session'
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
            <div className="panel-heading"><div><div className="panel-kicker">THIS WORKSPACE</div><h2>Agents working here</h2><p>Only agents launched in {activeWorkspace?.name ?? 'this workspace'}.</p></div><div className="heading-actions"><button className="secondary-button" onClick={() => { const live = workspaceSessions.find((session) => LIVE_STATUSES.includes(session.status)); if (live) { setTerminalScope('workspace'); openTerminal(live.id) } else { flash('No live sessions in this workspace — launch an agent first') } }} disabled={workspaceLiveCount === 0} title="Open workspace terminal (live sessions only)"><SquareTerminal /> Terminal</button><button className="secondary-button" onClick={() => setShowAgentLog(true)} title="Open agent log"><FileText /> Agent log</button><button className="secondary-button" onClick={openAssignAgent} title="Create a new agent and run it in this workspace"><Bot /> Assign agent</button><button className="primary-button" onClick={() => void launchAgent()}><Plus /> Launch</button></div></div>
            <div className="workspace-agents">{workspaceAgents.length === 0
              ? <div className="empty-state">No agents launched in this workspace yet.</div>
              : workspaceAgents.map((agent) => {
                const agentSessions = workspaceSessions.filter((session) => session.agent_definition_id === agent.id)
                const live = agentSessions.filter((session) => ['RUNNING', 'STARTING', 'IDLE', 'WAITING'].includes(session.status))
                const latest = live[0] ?? agentSessions[0]
                return <div className="workspace-agent-card" key={agent.id}>
                  <div className="workspace-agent-head"><span className="workspace-icon cyan"><Bot /></span><div className="workspace-agent-copy"><b>{agent.display_name}</b><small>{fileLabel(agent.command)} · {agent.launcher_type}</small></div><span className={`status-pill ${live.length > 0 ? 'live' : ''}`}>{live.length > 0 ? `${live.length} running` : 'idle'}</span></div>
                  <div className="workspace-agent-actions"><button className="secondary-button" onClick={() => void launchAgent(agent.id)}><Plus /> Launch</button>                <button className="secondary-button" onClick={() => { setTerminalScope('agent'); openTerminal(latest.id) }}><SquareTerminal /> Terminal</button></div>
                </div>
              })}</div>
          </section>
        </section>}
    </div>

    {/* Modals */}
    {showAgentLog && activeWorkspace && <AgentLogModal state={state} workspaceId={activeWorkspace.id} workspaceName={activeWorkspace.name} onClose={() => setShowAgentLog(false)} onOpenSession={openSession} onOpenTerminal={openTerminal} onAction={sessionAction} />}
    {showTerminalFor && <TerminalModal sessions={terminalSessions} activeSessionId={showTerminalFor} socket={socket} workspaceName={activeWorkspace?.name} workspaceAgents={workspaceAgents} scope={terminalScope} onScope={(scope) => setTerminalScope(scope)} onSelect={(id) => { setActiveSessionId(id); setShowTerminalFor(id) }} onClose={() => setShowTerminalFor(null)} onAction={sessionAction} onDetail={(id) => { setShowTerminalFor(null); openSession(id) }} />}
    {showWorkspaceForm && <Modal title="Add workspace" kicker="NEW WORKSPACE" onClose={() => setShowWorkspaceForm(false)}><WorkspaceForm onDone={() => { setShowWorkspaceForm(false); flash('Workspace added'); void safeSync() }} onError={(message) => flash(message)} /></Modal>}
    {showAgentForm && <Modal title="Add agent" kicker="AGENT REGISTRY" onClose={() => setShowAgentForm(false)}><AgentForm onDone={() => { setShowAgentForm(false); flash('Agent configured'); void safeSync() }} onError={(message) => flash(message)} /></Modal>}
    {showAssignAgent && activeWorkspace && <Modal title={`New agent — ${activeWorkspace.name}`} kicker="THIS WORKSPACE" onClose={() => setShowAssignAgent(false)}><AgentForm workspaceId={activeWorkspace.id} workspaceName={activeWorkspace.name} onDone={(result) => { setShowAssignAgent(false); if (result?.id) openTerminal(result.id); flash('Agent created and launched in this workspace'); void safeSync() }} onError={(message) => flash(message)} /></Modal>}
  </main>
}

/* ============================ Terminal modal ============================ */

const LIVE_STATUSES = ['RUNNING', 'STARTING', 'IDLE', 'WAITING']

function TerminalModal({ sessions, activeSessionId, socket, workspaceName, workspaceAgents, scope, onScope, onSelect, onClose, onAction, onDetail }: {
  sessions: AgentSession[]
  activeSessionId: string
  socket: Socket | null
  workspaceName?: string
  workspaceAgents: AgentDefinition[]
  scope: 'workspace' | 'agent'
  onScope: (scope: 'workspace' | 'agent') => void
  onSelect: (id: string) => void
  onClose: () => void
  onAction: (id: string, action: 'stop' | 'force-terminate' | 'restart' | 'resume') => Promise<void>
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

/* ============================ Session detail (full page view) ============================ */

function SessionDetail({ sessionId, state, socket, onBack, onAction, onOpenTerminal }: {
  sessionId: string
  state: ManagerState
  socket: Socket | null
  onBack: () => void
  onAction: (id: string, action: 'stop' | 'force-terminate' | 'restart' | 'resume') => Promise<void>
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
      <section className="panel"><div className="panel-heading"><div><div className="panel-kicker">LIVE TERMINAL</div><h2>Session terminal</h2></div></div><div className="terminal-section detail-terminal"><TerminalPane session={session} socket={socket} /></div></section>
      <section className="panel"><div className="panel-heading"><div><div className="panel-kicker">DETAILS</div><h2>Session metadata</h2></div></div><div className="meta-table">{meta.map(([label, value]) => <div className="meta-row" key={label}><span>{label}</span><b>{value}</b></div>)}</div></section>
    </div>
    <section className="panel"><div className="panel-heading"><div><div className="panel-kicker">SESSION LOG</div><h2>Lifecycle events</h2><p>Every start, stop, crash, and stuck-signal recorded for this session.</p></div></div><div className="activity-timeline">{events.length === 0 ? <div className="empty-state">No lifecycle events recorded.</div> : events.map((event) => <div className="activity-row" key={event.id}><span className={`activity-dot ${event.type.includes('crash') || event.type.includes('stuck') ? 'warning' : 'info'}`} /><div><p><b>{event.type}</b> <span className="mono muted">{event.payload_json.slice(0, 120)}</span></p><small>{event.created_at}</small></div></div>)}</div></section>
  </section>
}

/* ============================ xterm pane ============================ */

function TerminalPane({ session, visible, socket }: { session?: AgentSession; visible?: boolean; socket: Socket | null }) {
  const ref = useRef<HTMLDivElement | null>(null)
  // Use the stable session id (not the object) as the effect dependency so a
  // 30s state poll that produces a new session object does not remount xterm.
  const sessionRef = useRef(session)
  sessionRef.current = session
  const sessionId = session?.id
  const fitRef = useRef<(() => void) | null>(null)
  const isLive = !!session && LIVE_STATUSES.includes(session.status)
  const [outputSeen, setOutputSeen] = useState(false)
  useEffect(() => { setOutputSeen(false); }, [sessionId])
  useEffect(() => {
    if (!ref.current || !sessionId || !socket || !isLive) return
    const terminal = new Terminal({ cursorBlink: true, fontFamily: 'JetBrains Mono, Consolas, monospace', fontSize: 12, theme: { background: '#05080d', foreground: '#c9d6e4', cursor: '#29e0ff', cursorAccent: '#05080d', selectionBackground: '#12414d', black: '#0c1017', green: '#34e8b0', cyan: '#29e0ff', brightBlack: '#5c6b80' } })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(ref.current)
    const fitTerminal = () => {
      fit.fit()
      // Guard: skip resize while the pane has no real layout (xterm defaults 80x24,
      // and a fit on a hidden/zero-size pane can produce tiny rows that the
      // manager would reject).
      if (terminal.cols < 20 || terminal.rows < 5) return
      socket.emit('terminal.resize', { sessionId, cols: terminal.cols, rows: terminal.rows })
    }
    fitRef.current = fitTerminal
    window.setTimeout(fitTerminal, 0)
    window.setTimeout(fitTerminal, 120)
    socket.emit('terminal.attach', { sessionId })
    const outputHandler = (event: { sessionId?: string; payload?: { data?: string } }) => { if (event.sessionId === sessionId && event.payload?.data) { setOutputSeen(true); terminal.write(event.payload.data) } }
    socket.on('terminal.output', outputHandler)
    terminal.onData((data) => socket.emit('terminal.input', { sessionId, data }))
    const observer = new ResizeObserver(() => fitTerminal())
    observer.observe(ref.current)
    window.addEventListener('resize', fitTerminal)
    return () => { fitRef.current = null; observer.disconnect(); window.removeEventListener('resize', fitTerminal); socket.off('terminal.output', outputHandler); terminal.dispose() }
  }, [sessionId, socket, isLive])
  // Refit when this pane becomes the visible tab (it had zero size while hidden).
  useEffect(() => {
    if (!visible) return
    const t1 = window.setTimeout(() => fitRef.current?.(), 0)
    const t2 = window.setTimeout(() => fitRef.current?.(), 80)
    return () => { window.clearTimeout(t1); window.clearTimeout(t2) }
  }, [visible])
  if (!session) return <div className="terminal-pane"><div className="empty-state">No session selected.</div></div>
  if (!isLive) return <div className="terminal-pane"><div className="terminal-pane-header"><span><span className="terminal-dot-dead" /> {session.display_name}</span><small>{session.working_directory}</small><MoreHorizontal /></div><div className="terminal-dead-note"><b>{session.status}</b> — this session is not running, so there is no live terminal. Use <b>Resume</b> (if supported) or <b>Restart</b> from the session detail, or launch the agent again.</div></div>
  return <div className="terminal-pane"><div className="terminal-pane-header"><span><span className="terminal-green" /> {session.display_name}</span><small>{session.working_directory}</small><MoreHorizontal /></div><div className="xterm-host" ref={ref} />{!outputSeen && <div className="terminal-waiting-note">Waiting for output from the agent process… (PID {session.process_id ?? '-'})</div>}</div>
}

function formatBytes(value: number) { return value ? `${(value / 1024 / 1024).toFixed(0)} MB` : '0 MB' }
