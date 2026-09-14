/**
 * Shared domain types — keep in sync with BACKEND/src/domain.ts.
 * The backend validates payloads with zod; these interfaces describe the
 * JSON shape the manager API returns.
 */

export type AgentStatus =
  | 'CREATED'
  | 'STARTING'
  | 'RUNNING'
  | 'IDLE'
  | 'WAITING'
  | 'STOPPING'
  | 'STOPPED'
  | 'CRASHED'
  | 'DISCONNECTED'
  | 'RESUMABLE'

export type LauncherType = 'direct' | 'cmd' | 'bat' | 'shell'

export type View = { kind: 'dashboard' } | { kind: 'session'; sessionId: string }

export type SessionAction = 'stop' | 'force-terminate' | 'restart' | 'resume'

export interface Workspace {
  id: string
  name: string
  path: string
  git_branch: string | null
  git_status: string | null
  git_modified: number
  git_staged: number
  git_untracked: number
}

export interface AgentDefinition {
  id: string
  display_name: string
  command: string
  launcher_type: LauncherType
  enabled: number
  supports_resume: number
}

export interface AgentSession {
  id: string
  workspace_id: string
  agent_definition_id: string
  display_name: string
  process_id: number | null
  agent_session_id: string | null
  status: AgentStatus
  working_directory: string
  started_at: string | null
  stopped_at: string | null
  last_activity_at: string | null
  exit_code: number | null
  resume_capability: string
  cpu: number
  memory: number
  stuck_confidence: string
}

export interface SystemResources {
  cpuPercent: number
  memoryUsed: number
  memoryTotal: number
  memoryPercent: number
  processCount: number
}

export interface SessionEvent {
  id: string
  session_id: string | null
  type: string
  payload_json: string
  created_at: string
}

export interface WorkspaceAgentAssignment {
  id: string
  workspace_id: string
  agent_definition_id: string
  created_at: string
}

/** One agent's isolated git worktree (branch agent/<task>). */
export interface AgentWorktree {
  id: string
  workspace_id: string
  agent_definition_id: string | null
  session_id: string | null
  path: string
  branch: string
  base_branch: string | null
  task_name: string
  created_at: string
  removed_at: string | null
}

export interface WorktreeStatus {
  worktree: AgentWorktree
  branch: string
  dirty: boolean
  aheadOfBase: number
  behindBase: number
  changedFiles: Array<{ path: string; state: string }>
  lastCommitSubject: string | null
}

export interface ManagerState {
  workspaces: Workspace[]
  agentDefinitions: AgentDefinition[]
  assignments: WorkspaceAgentAssignment[]
  sessions: AgentSession[]
  runningSessionIds: string[]
  events: Array<{ id: string; type: string; created_at: string; payload_json: string }>
  system?: SystemResources
}

/** Sessions in these states have a live process with an attachable terminal. */
export const LIVE_STATUSES: AgentStatus[] = ['RUNNING', 'STARTING', 'IDLE', 'WAITING']

/** A past conversation discovered in an agent's own local session store. */
export interface DiscoveredSession {
  agent: string
  agentSessionId: string | null
  workspacePath: string | null
  title: string | null
  startedAt: string | null
  lastActivityAt: string | null
  source: string
  resumeSupported: boolean
  matchedWorkspaceId: string | null
  matchKind: 'exact' | 'subdirectory' | 'none'
}

export interface AgentScanReport {
  agent: string
  status: 'ok' | 'not-found' | 'unsupported'
  sessions: number
  basePaths: string[]
  note?: string
}
