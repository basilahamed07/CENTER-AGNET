'use client'

import { useCallback, useEffect, useState } from 'react'
import { Clock, History, Play, RefreshCw, Search } from 'lucide-react'
import { api } from '@/lib/api'
import type { AgentScanReport, DiscoveredSession } from '@/lib/types'

/**
 * Lists past conversations discovered in each agent's own local session store
 * (Claude ~/.claude/projects, Codex ~/.codex/sessions, Kilo kilo.db, ...),
 * matched to this workspace by working directory. "Resume" spawns the agent
 * via the manager with the discovered session id appended.
 */
export function ExternalSessionsPanel({ workspaceId, workspaceName, onResumeStarted }: {
  workspaceId: string
  workspaceName: string
  onResumeStarted?: (message: string, tone?: 'success' | 'error') => void
}) {
  const [sessions, setSessions] = useState<DiscoveredSession[]>([])
  const [coverage, setCoverage] = useState<AgentScanReport[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [resumingKey, setResumingKey] = useState<string | null>(null)

  const load = useCallback(async (force = false) => {
    setLoading(true)
    try {
      const result = await api<{ sessions: DiscoveredSession[]; coverage: AgentScanReport[] }>(
        `/api/workspaces/${workspaceId}/external-sessions${force ? '?force=1' : ''}`,
      )
      setSessions(result.sessions)
      setCoverage(result.coverage)
    } catch {
      // Manager unreachable or scan failed: show empty state, panel is informational.
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    void load()
  }, [load])

  const visible = sessions.filter((session) => {
    if (!query.trim()) return true
    const haystack = `${session.agent} ${session.title ?? ''} ${session.workspacePath ?? ''}`.toLowerCase()
    return haystack.includes(query.toLowerCase())
  })

  async function resume(session: DiscoveredSession) {
    if (!session.agentSessionId) return
    setResumingKey(`${session.agent}:${session.agentSessionId}`)
    try {
      await api('/api/external-sessions/resume', {
        method: 'POST',
        body: JSON.stringify({ agentKey: session.agent, agentSessionId: session.agentSessionId, workspaceId }),
      })
      onResumeStarted?.(`Resumed ${session.agent} session`, 'success')
    } catch (error) {
      onResumeStarted?.(error instanceof Error ? error.message : 'Resume failed', 'error')
    } finally {
      setResumingKey(null)
    }
  }

  const scannedAgents = coverage.filter((report) => report.status === 'ok')
  const missingAgents = coverage.filter((report) => report.status === 'not-found')
  const unsupportedAgents = coverage.filter((report) => report.status === 'unsupported')

  return (
    <section className="panel external-sessions-panel">
      <div className="panel-heading">
        <div>
          <div className="panel-kicker">DISCOVERED ON THIS MACHINE</div>
          <h2>Past agent sessions</h2>
          <p>
            Sessions the CLI agents wrote to their own local stores that match {workspaceName} by working directory.
            {scannedAgents.length > 0 && ` Scanned: ${scannedAgents.map((report) => report.agent).join(', ')}.`}
          </p>
        </div>
        <div className="heading-actions">
          <input
            className="external-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter sessions"
            aria-label="Filter external sessions"
          />
          <button className="secondary-button" onClick={() => void load(true)} disabled={loading}>
            <RefreshCw /> {loading ? 'Scanning…' : 'Rescan'}
          </button>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="empty-state">
          {loading
            ? 'Scanning local agent session stores…'
            : sessions.length === 0
              ? 'No past sessions discovered for this workspace. Agents that have run here before (Claude Code, Codex, Kilo, Pi, …) will appear automatically.'
              : 'No sessions match the filter.'}
        </div>
      ) : (
        <div className="external-session-list">
          {visible.map((session) => {
            const key = `${session.agent}:${session.agentSessionId ?? session.source}`
            const busy = resumingKey === key
            return (
              <div className="external-session-row" key={key}>
                <span className="external-agent-badge">{session.agent}</span>
                <div className="external-session-copy">
                  <b>{session.title ?? session.agentSessionId ?? '(untitled session)'}</b>
                  <small className="mono">
                    {session.workspacePath ?? 'unknown directory'}
                    {session.matchKind === 'subdirectory' ? ' · in subdirectory' : ''}
                    {session.lastActivityAt ? ` · ${session.lastActivityAt.slice(0, 16).replace('T', ' ')}` : ''}
                  </small>
                </div>
                <div className="external-session-actions">
                  {session.resumeSupported && session.agentSessionId ? (
                    <button className="secondary-button" disabled={busy} onClick={() => void resume(session)}>
                      <Play /> {busy ? 'Resuming…' : 'Resume'}
                    </button>
                  ) : (
                    <span className="status-pill" title="This agent has no verified per-id resume flag yet">view only</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="external-coverage mono">
        <History />
        <span>
          {missingAgents.length > 0 && `No local store: ${missingAgents.map((report) => report.agent).join(', ')}. `}
          {unsupportedAgents.length > 0 && `Not scannable yet: ${unsupportedAgents.map((report) => report.agent).join(', ')}.`}
          {missingAgents.length === 0 && unsupportedAgents.length === 0 && 'All known agent stores scanned.'}
        </span>
      </div>
    </section>
  )
}
