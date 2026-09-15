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

/**
 * A git worktree isolating one agent's parallel edits from the main working
 * tree (spec §17-19). Rows survive removal (removed_at set) so session
 * history keeps pointing at real work.
 */
export interface AgentWorktree {
  id: string;
  workspace_id: string;
  agent_definition_id: string | null;
  session_id: string | null;
  path: string;
  branch: string;
  base_branch: string | null;
  task_name: string;
  created_at: string;
  removed_at: string | null;
}

export interface AppEvent<T = unknown> {
  id: string;
  type: string;
  sessionId?: string;
  workspaceId?: string;
  payload: T;
  createdAt: string;
}

// ---- Phase 2: goal orchestration (docs/PHASE_2_ARCHITECTURE.md §5) --------

export const GOAL_STATUSES = [
  'draft', 'planning', 'awaiting_plan_approval', 'ready', 'running',
  'verifying', 'awaiting_review', 'merging', 'complete', 'failed', 'cancelled',
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const GOAL_TASK_STATUSES = [
  'blocked', 'ready', 'assigned', 'running', 'verifying',
  'done', 'failed', 'dead', 'cancelled',
] as const;
export type GoalTaskStatus = (typeof GOAL_TASK_STATUSES)[number];

export type GoalTaskKind = 'code' | 'test' | 'docs' | 'review' | 'chore';
export type GoalTaskRisk = 'low' | 'medium' | 'high';

export interface Goal {
  id: string;
  workspace_id: string;
  title: string;
  description: string;
  status: GoalStatus;
  planner_definition_id: string | null;
  planner_session_id: string | null;
  plan_json: string | null;
  concurrency_limit: number;
  attempt_budget: number;
  reviews_enabled: number;
  autonomy: 'gated' | 'semi' | 'auto';
  failed_attempts: number;
  created_at: string;
  updated_at: string;
}

export interface GoalTask {
  id: string;
  goal_id: string;
  plan_key: string;
  title: string;
  description: string;
  kind: GoalTaskKind;
  risk: GoalTaskRisk;
  depends_on_json: string;
  status: GoalTaskStatus;
  attempts: number;
  assigned_definition_id: string | null;
  session_id: string | null;
  worktree_id: string | null;
  branch: string | null;
  verification_json: string | null;
  failure_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface GoalEvent {
  id: string;
  goal_id: string;
  task_id: string | null;
  type: string;
  payload_json: string;
  created_at: string;
}
