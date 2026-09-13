'use client'

import { useState } from 'react'
import { api } from '@/lib/api'
import type { AgentDefinition, AgentSession, LauncherType, Workspace } from '@/lib/types'

export function WorkspaceForm({ onDone, onError }: { onDone: () => void; onError: (message: string) => void }) {
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
  { value: 'cmd', label: 'cmd', hint: '.cmd shim (Windows)' },
  { value: 'bat', label: 'bat', hint: '.bat batch file (Windows)' },
  { value: 'shell', label: 'shell', hint: '.sh script (Linux/macOS)' },
]

export function AgentForm({ workspaceName, workspaceId, onDone, onError }: {
  workspaceName?: string
  workspaceId?: string
  onDone: (result?: { id: string }) => void
  onError: (message: string) => void
}) {
  const [displayName, setDisplayName] = useState('Claude Code')
  const [command, setCommand] = useState('claude')
  const [launcherType, setLauncherType] = useState<LauncherType>('direct')
  const [supportsResume, setSupportsResume] = useState(false)
  const [busy, setBusy] = useState(false)

  // Auto-select the launcher type from the command's file extension as the
  // user types (kept in the change handler instead of a state-syncing effect).
  function updateCommand(next: string) {
    setCommand(next)
    const lower = next.toLowerCase()
    if (lower.endsWith('.bat')) setLauncherType('bat')
    else if (lower.endsWith('.cmd')) setLauncherType('cmd')
    else if (lower.endsWith('.sh')) setLauncherType('shell')
  }

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
        <input className="form-input mono" value={command} onChange={(event) => updateCommand(event.target.value)} placeholder="claude  ·  C:\path\to\agent.cmd  ·  /path/to/agent.sh" />
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
      <div className="form-actions">
        <button type="button" className="secondary-button" onClick={() => onDone()}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy || !displayName.trim() || !command.trim()}>{busy ? (workspaceId ? 'Creating & launching…' : 'Saving…') : (workspaceId ? 'Create & launch here' : 'Add agent')}</button>
      </div>
    </form>
  )
}
