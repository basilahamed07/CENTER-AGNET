'use client'

import { useEffect, useState } from 'react'
import { FileDiff, GitBranch, Play, RefreshCw, Square, SquareTerminal, Trash2, X } from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { ErrorBoundary } from '@/components/error-boundary'
import { Modal } from '@/components/modal'
import { StatusDot } from '@/components/status-dot'
import { TerminalPane } from '@/components/terminal-pane'
import { api } from '@/lib/api'
import { formatBytes } from '@/lib/format'
import type { ManagerState, SessionAction, SessionEvent, WorktreeStatus } from '@/lib/types'

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
  // Git isolation card (spec §21-23): the worktree this session runs in.
  const [worktreeStatus, setWorktreeStatus] = useState<WorktreeStatus | null>(null)
  const [showDiff, setShowDiff] = useState(false)
  const [diff, setDiff] = useState<string | null>(null)
  const [worktreeBusy, setWorktreeBusy] = useState(false)

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

  // Which worktree (if any) hosts this session.
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    api<{ id: string } | null>(`/api/sessions/${sessionId}/worktree`)
      .then((worktree) => { if (!cancelled && worktree) return api<WorktreeStatus>(`/api/worktrees/${worktree.id}/status`) })
      .then((status) => { if (!cancelled && status) setWorktreeStatus(status) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [sessionId])

  async function refreshWorktreeStatus() {
    if (!worktreeStatus) return
    setWorktreeBusy(true)
    try {
      setWorktreeStatus(await api<WorktreeStatus>(`/api/worktrees/${worktreeStatus.worktree.id}/status`))
    } catch {
      // Status refresh is best-effort.
    } finally {
      setWorktreeBusy(false)
    }
  }

  async function openDiff() {
    if (!worktreeStatus) return
    setWorktreeBusy(true)
    try {
      const result = await api<{ diff: string }>(`/api/worktrees/${worktreeStatus.worktree.id}/diff`)
      setDiff(result.diff || '(no changes)')
      setShowDiff(true)
    } catch {
      setDiff('(diff unavailable)')
      setShowDiff(true)
    } finally {
      setWorktreeBusy(false)
    }
  }

  /** Removal asks once; a dirty worktree triggers a second explicit force confirm. */
  async function removeWorktree() {
    if (!worktreeStatus) return
    const worktree = worktreeStatus.worktree
    if (!window.confirm(`Remove worktree "${worktree.task_name}" (${worktree.branch})?`)) return
    let forceRemove = false
    try {
      setWorktreeBusy(true)
      await api(`/api/worktrees/${worktree.id}/remove`, { method: 'POST', body: JSON.stringify({ forceRemove }) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/uncommitted changes/i.test(message)) return
      if (!window.confirm('This worktree contains UNCOMMITTED changes.\n\nForce removal deletes those changes from disk. The branch itself is kept.\n\nForce remove?')) return
      forceRemove = true
      try {
        await api(`/api/worktrees/${worktree.id}/remove`, { method: 'POST', body: JSON.stringify({ forceRemove }) })
      } catch {
        return
      }
    } finally {
      setWorktreeBusy(false)
    }
    setWorktreeStatus(null)
  }

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
    {showDiff && <Modal title={`Diff — ${worktreeStatus?.worktree.task_name ?? ''}`} kicker="GIT ISOLATION" onClose={() => setShowDiff(false)} wide>
      <pre className="mono" style={{ maxHeight: '60vh', overflow: 'auto', fontSize: 11, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{diff}</pre>
    </Modal>}
    <div className="session-detail-grid">
      <section className="panel"><div className="panel-heading"><div><div className="panel-kicker">LIVE TERMINAL</div><h2>Session terminal</h2></div></div><div className="terminal-section detail-terminal"><ErrorBoundary><TerminalPane session={session} socket={socket} /></ErrorBoundary></div></section>
      <section className="panel"><div className="panel-heading"><div><div className="panel-kicker">DETAILS</div><h2>Session metadata</h2></div></div><div className="meta-table">{meta.map(([label, value]) => <div className="meta-row" key={label}><span>{label}</span><b>{value}</b></div>)}</div></section>
    </div>
    {worktreeStatus && <section className="panel"><div className="panel-heading"><div><div className="panel-kicker">GIT ISOLATION</div><h2>Worktree</h2><p className="mono">{worktreeStatus.worktree.branch} · {worktreeStatus.worktree.path}</p></div><div className="heading-actions"><button className="secondary-button" disabled={worktreeBusy} onClick={() => void refreshWorktreeStatus()}><RefreshCw /> Status</button><button className="secondary-button" disabled={worktreeBusy} onClick={() => void openDiff()}><FileDiff /> View diff</button><button className="danger-button" disabled={worktreeBusy} onClick={() => void removeWorktree()}><Trash2 /> Remove</button></div></div>
      <div className="meta-table">
        <div className="meta-row" key="branch"><span>Branch</span><b className="mono">{worktreeStatus.worktree.branch}</b></div>
        <div className="meta-row" key="base"><span>Base</span><b>{worktreeStatus.worktree.base_branch ?? '-'}</b></div>
        <div className="meta-row" key="state"><span>Working tree</span><b>{worktreeStatus.dirty ? 'DIRTY (uncommitted changes)' : 'clean'}</b></div>
        <div className="meta-row" key="changed"><span>Changed files</span><b>{worktreeStatus.changedFiles.length}</b></div>
        <div className="meta-row" key="ahead"><span>Commits ahead of base</span><b>{worktreeStatus.aheadOfBase}</b></div>
        <div className="meta-row" key="last"><span>Last commit</span><b>{worktreeStatus.lastCommitSubject ?? '(no commits yet)'}</b></div>
      </div>
      {worktreeStatus.dirty && <div className="form-hint">Contains uncommitted changes — removal will ask for explicit confirmation. Merging into {worktreeStatus.worktree.base_branch ?? 'base'} stays manual.</div>}
    </section>}
    <section className="panel"><div className="panel-heading"><div><div className="panel-kicker">SESSION LOG</div><h2>Lifecycle events</h2><p>Every start, stop, crash, and stuck-signal recorded for this session.</p></div></div><div className="activity-timeline">{events.length === 0 ? <div className="empty-state">No lifecycle events recorded.</div> : events.map((event) => <div className="activity-row" key={event.id}><span className={`activity-dot ${event.type.includes('crash') || event.type.includes('stuck') ? 'warning' : 'info'}`} /><div><p><b>{event.type}</b> <span className="mono muted">{event.payload_json.slice(0, 120)}</span></p><small>{event.created_at}</small></div></div>)}</div></section>
  </section>
}
