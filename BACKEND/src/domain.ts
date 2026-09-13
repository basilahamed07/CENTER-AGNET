export const AGENT_STATUSES = [
  'CREATED',
  'STARTING',
  'RUNNING',
  'IDLE',
  'WAITING',
  'STOPPING',
  'STOPPED',
  'CRASHED',
  'DISCONNECTED',
  'RESUMABLE',
] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];
export type LauncherType = 'direct' | 'cmd' | 'bat' | 'shell';
export type ResumeStrategy = 'none' | 'appendArgs' | 'command';

export interface Workspace {
  id: string;
  name: string;
  path: string;
  archived: number;
  git_branch: string | null;
  git_status: string | null;
  git_modified: number;
  git_staged: number;
  git_untracked: number;
  last_git_check_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentDefinition {
  id: string;
  display_name: string;
  command: string;
  default_args: string;
  env_json: string;
  launcher_type: LauncherType;
  enabled: number;
  supports_resume: number;
  resume_strategy: ResumeStrategy;
  resume_command: string | null;
  resume_args: string;
  session_id_arg: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentSession {
  id: string;
  workspace_id: string;
  agent_definition_id: string;
  display_name: string;
  process_id: number | null;
  parent_process_id: number | null;
  agent_session_id: string | null;
  working_directory: string;
  status: AgentStatus;
  created_at: string;
  started_at: string | null;
  stopped_at: string | null;
  last_activity_at: string | null;
  last_terminal_activity_at: string | null;
  exit_code: number | null;
  resume_capability: string;
  metadata_json: string;
  cpu: number;
  memory: number;
  stuck_score: number;
  stuck_confidence: 'none' | 'low' | 'medium' | 'high';
}

export interface WorkspaceAgentAssignment {
  id: string;
  workspace_id: string;
  agent_definition_id: string;
  created_at: string;
}

export interface AppEvent<T = unknown> {
  id: string;
  type: string;
  sessionId?: string;
  workspaceId?: string;
  payload: T;
  createdAt: string;
}
