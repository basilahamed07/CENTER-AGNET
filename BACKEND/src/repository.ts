import { randomUUID } from 'crypto';
import type { AgentDefinition, AgentSession, AgentStatus, AgentWorktree, LauncherType, Workspace, WorkspaceAgentAssignment } from './domain';
import { db } from './db';
import { badRequest, notFound } from './errors';

// Columns updateSession may write. Anything else is rejected instead of
// being interpolated into SQL (defense in depth — callers are internal,
// but a typo'd key should fail loudly, not create an injection-shaped bug).
const SESSION_MUTABLE_COLUMNS = new Set([
  'status', 'process_id', 'parent_process_id', 'agent_session_id',
  'started_at', 'stopped_at', 'last_activity_at', 'last_terminal_activity_at',
  'exit_code', 'resume_capability', 'metadata_json', 'cpu', 'memory',
  'stuck_score', 'stuck_confidence',
]);

export const repository = {
  listWorkspaces(): Workspace[] {
    return db.prepare('SELECT * FROM workspaces WHERE archived = 0 ORDER BY name').all() as Workspace[];
  },

  getWorkspace(id: string): Workspace {
    const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Workspace | undefined;
    if (!row) throw notFound('Workspace');
    return row;
  },

  createWorkspace(input: { name: string; path: string }): Workspace {
    const id = randomUUID();
    db.prepare('INSERT INTO workspaces (id, name, path) VALUES (@id, @name, @path)').run({ id, ...input });
    return this.getWorkspace(id);
  },

  archiveWorkspace(id: string) {
    db.prepare('UPDATE workspaces SET archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  },

  listAgentDefinitions(): AgentDefinition[] {
    return db.prepare('SELECT * FROM agent_definitions ORDER BY display_name').all() as AgentDefinition[];
  },

  getAgentDefinition(id: string): AgentDefinition {
    const row = db.prepare('SELECT * FROM agent_definitions WHERE id = ?').get(id) as AgentDefinition | undefined;
    if (!row) throw notFound('Agent definition');
    return row;
  },

  createAgentDefinition(input: {
    displayName: string;
    command: string;
    launcherType: LauncherType;
    defaultArgs?: string[];
    env?: Record<string, string>;
    supportsResume?: boolean;
    resumeStrategy?: string;
    resumeCommand?: string;
    resumeArgs?: string[];
    sessionIdArg?: string;
  }): AgentDefinition {
    const id = randomUUID();
    db.prepare(`
      INSERT INTO agent_definitions (
        id, display_name, command, default_args, env_json, launcher_type,
        supports_resume, resume_strategy, resume_command, resume_args, session_id_arg
      )
      VALUES (
        @id, @displayName, @command, @defaultArgs, @envJson, @launcherType,
        @supportsResume, @resumeStrategy, @resumeCommand, @resumeArgs, @sessionIdArg
      )
    `).run({
      id,
      displayName: input.displayName,
      command: input.command,
      defaultArgs: JSON.stringify(input.defaultArgs ?? []),
      envJson: JSON.stringify(input.env ?? {}),
      launcherType: input.launcherType,
      supportsResume: input.supportsResume ? 1 : 0,
      resumeStrategy: input.resumeStrategy ?? 'none',
      resumeCommand: input.resumeCommand ?? null,
      resumeArgs: JSON.stringify(input.resumeArgs ?? []),
      sessionIdArg: input.sessionIdArg ?? null,
    });
    return this.getAgentDefinition(id);
  },

  updateAgentEnabled(id: string, enabled: boolean) {
    db.prepare('UPDATE agent_definitions SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(enabled ? 1 : 0, id);
    return this.getAgentDefinition(id);
  },

  deleteAgentDefinition(id: string) {
    this.getAgentDefinition(id);
    db.prepare('UPDATE agent_definitions SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    return { deleted: true };
  },

  clearAgentDefinitions() {
    db.prepare('UPDATE agent_definitions SET enabled = 0, updated_at = CURRENT_TIMESTAMP').run();
    return { cleared: true };
  },

  listSessions(): AgentSession[] {
    return db.prepare('SELECT * FROM agent_sessions ORDER BY created_at DESC').all() as AgentSession[];
  },

  getSession(id: string): AgentSession {
    const row = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id) as AgentSession | undefined;
    if (!row) throw notFound('Session');
    return row;
  },

  createSession(input: {
    workspaceId: string;
    agentDefinitionId: string;
    displayName: string;
    workingDirectory: string;
    resumeCapability: 'supported' | 'unsupported';
  }): AgentSession {
    const id = randomUUID();
    db.prepare(`
      INSERT INTO agent_sessions (
        id, workspace_id, agent_definition_id, display_name, working_directory, status, resume_capability
      )
      VALUES (@id, @workspaceId, @agentDefinitionId, @displayName, @workingDirectory, 'CREATED', @resumeCapability)
    `).run({ id, ...input });
    return this.getSession(id);
  },

  updateSession(id: string, fields: Record<string, unknown>): AgentSession {
    const entries = Object.entries(fields);
    if (entries.length === 0) return this.getSession(id);
    for (const [key] of entries) {
      if (!SESSION_MUTABLE_COLUMNS.has(key)) throw new Error(`updateSession: illegal column "${key}"`);
    }
    const setClause = entries.map(([key]) => `${key} = @${key}`).join(', ');
    db.prepare(`UPDATE agent_sessions SET ${setClause} WHERE id = @id`).run({ id, ...fields });
    return this.getSession(id);
  },

  markSessionsDisconnectedExcept(runningIds: string[]) {
    const active = ['CREATED', 'STARTING', 'RUNNING', 'IDLE', 'WAITING', 'STOPPING'];
    const sessions = this.listSessions().filter((session) => active.includes(session.status) && !runningIds.includes(session.id));
    for (const session of sessions) {
      this.updateSession(session.id, {
        status: session.resume_capability === 'supported' ? 'RESUMABLE' : 'DISCONNECTED',
        process_id: null,
        stopped_at: session.stopped_at ?? new Date().toISOString(),
      });
    }
  },

  listAssignments(): WorkspaceAgentAssignment[] {
    return db.prepare(`
      SELECT a.id, a.workspace_id, a.agent_definition_id, a.created_at
      FROM workspace_agent_assignments a
      JOIN workspaces w ON w.id = a.workspace_id
      JOIN agent_definitions d ON d.id = a.agent_definition_id
      WHERE w.archived = 0 AND d.enabled = 1
      ORDER BY a.created_at
    `).all() as WorkspaceAgentAssignment[];
  },

  listAssignmentsForAgent(agentDefinitionId: string): WorkspaceAgentAssignment[] {
    this.getAgentDefinition(agentDefinitionId);
    return db.prepare(`
      SELECT a.id, a.workspace_id, a.agent_definition_id, a.created_at
      FROM workspace_agent_assignments a
      JOIN workspaces w ON w.id = a.workspace_id
      JOIN agent_definitions d ON d.id = a.agent_definition_id
      WHERE a.agent_definition_id = ? AND w.archived = 0 AND d.enabled = 1
      ORDER BY a.created_at
    `).all(agentDefinitionId) as WorkspaceAgentAssignment[];
  },

  assignAgentToWorkspace(workspaceId: string, agentDefinitionId: string): WorkspaceAgentAssignment {
    this.getWorkspace(workspaceId);
    const agent = this.getAgentDefinition(agentDefinitionId);
    if (!agent.enabled) throw badRequest('Agent is disabled and cannot be assigned');
    const id = randomUUID();
    db.prepare(`
      INSERT INTO workspace_agent_assignments (id, workspace_id, agent_definition_id)
      VALUES (@id, @workspaceId, @agentDefinitionId)
      ON CONFLICT(workspace_id, agent_definition_id) DO NOTHING
    `).run({ id, workspaceId, agentDefinitionId });
    const existing = db.prepare('SELECT * FROM workspace_agent_assignments WHERE workspace_id = ? AND agent_definition_id = ?')
      .get(workspaceId, agentDefinitionId) as WorkspaceAgentAssignment | undefined;
    if (!existing) throw new Error('Assignment insert failed');
    return existing;
  },

  unassignAgentFromWorkspace(workspaceId: string, agentDefinitionId: string): { removed: boolean } {
    const result = db.prepare('DELETE FROM workspace_agent_assignments WHERE workspace_id = ? AND agent_definition_id = ?')
      .run(workspaceId, agentDefinitionId);
    if (result.changes === 0) throw notFound('Assignment');
    return { removed: true };
  },

  clearSessionHistory() {
    db.prepare('DELETE FROM session_events').run();
    db.prepare('DELETE FROM agent_sessions').run();
    return { cleared: true };
  },

  // ---- Worktrees (spec §18-23) -------------------------------------------

  createWorktreeRecord(input: {
    workspaceId: string;
    agentDefinitionId: string | null;
    sessionId: string | null;
    path: string;
    branch: string;
    baseBranch: string | null;
    taskName: string;
  }): AgentWorktree {
    // Rows are tombstoned on removal (removed_at), not deleted, so session
    // history keeps pointing at real work. The path column is UNIQUE, so a
    // historical row for the SAME directory must be renamed out of the way
    // before a new row can claim it — otherwise re-creating a worktree with
    // the same task name dies on a raw UNIQUE constraint error (spec §11:
    // stale worktree metadata must be handled, not surfaced as a 500).
    const historical = db.prepare(
      'SELECT id FROM agent_worktrees WHERE path = ? AND removed_at IS NOT NULL',
    ).get(input.path) as { id: string } | undefined;
    if (historical) {
      db.prepare('UPDATE agent_worktrees SET path = ? WHERE id = ?').run(
        `${input.path} (removed ${new Date().toISOString()})`,
        historical.id,
      );
    }
    const id = randomUUID();
    db.prepare(`
      INSERT INTO agent_worktrees (id, workspace_id, agent_definition_id, session_id, path, branch, base_branch, task_name)
      VALUES (@id, @workspaceId, @agentDefinitionId, @sessionId, @path, @branch, @baseBranch, @taskName)
    `).run({
      id,
      workspaceId: input.workspaceId,
      agentDefinitionId: input.agentDefinitionId,
      sessionId: input.sessionId,
      path: input.path,
      branch: input.branch,
      baseBranch: input.baseBranch,
      taskName: input.taskName,
    });
    return this.getWorktree(id);
  },

  getWorktree(id: string): AgentWorktree {
    const row = db.prepare('SELECT * FROM agent_worktrees WHERE id = ?').get(id) as AgentWorktree | undefined;
    if (!row) throw notFound('Worktree');
    return row;
  },

  listWorktrees(workspaceId: string): AgentWorktree[] {
    return db.prepare('SELECT * FROM agent_worktrees WHERE workspace_id = ? AND removed_at IS NULL ORDER BY created_at DESC').all(workspaceId) as AgentWorktree[];
  },

  /**
   * A historical active row whose directory vanished from disk (deleted by
   * hand, tmp cleanup, ...) must not block re-creating that worktree forever.
   * Tombstone it so the path frees up; the work is simply gone — that is
   * reality, and the row must reflect it.
   */
  reconcileMissingWorktree(path: string): boolean {
    const stale = db.prepare(
      'SELECT id FROM agent_worktrees WHERE path = ? AND removed_at IS NULL',
    ).get(path) as { id: string } | undefined;
    if (!stale) return false;
    db.prepare('UPDATE agent_worktrees SET removed_at = CURRENT_TIMESTAMP WHERE id = ?').run(stale.id);
    return true;
  },

  markWorktreeRemoved(id: string): AgentWorktree {
    db.prepare('UPDATE agent_worktrees SET removed_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    return this.getWorktree(id);
  },

  linkWorktreeSession(id: string, sessionId: string) {
    db.prepare('UPDATE agent_worktrees SET session_id = ? WHERE id = ?').run(sessionId, id);
  },

  findWorktreeBySession(sessionId: string): AgentWorktree | null {
    const row = db.prepare('SELECT * FROM agent_worktrees WHERE session_id = ? AND removed_at IS NULL ORDER BY created_at DESC LIMIT 1').get(sessionId) as AgentWorktree | undefined;
    return row ?? null;
  },

  setSessionStatus(id: string, status: AgentStatus, fields: Record<string, unknown> = {}) {
    return this.updateSession(id, { status, ...fields });
  },

  nextSessionName(agentDisplayName: string): string {
    const like = `${agentDisplayName} #%`;
    const row = db.prepare('SELECT COUNT(*) as count FROM agent_sessions WHERE display_name LIKE ?').get(like) as { count: number };
    return `${agentDisplayName} #${row.count + 1}`;
  },

  updateWorkspaceGit(id: string, git: {
    branch: string | null;
    status: string | null;
    modified: number;
    staged: number;
    untracked: number;
  }) {
    db.prepare(`
      UPDATE workspaces
      SET git_branch = @branch,
          git_status = @status,
          git_modified = @modified,
          git_staged = @staged,
          git_untracked = @untracked,
          last_git_check_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run({ id, ...git });
  },

  listEvents(limit = 100) {
    return db.prepare(`
      SELECT * FROM session_events
      WHERE type NOT IN ('terminal.output', 'agent.input', 'resource.updated')
      ORDER BY created_at DESC LIMIT ?
    `).all(limit);
  },

  listSessionEvents(sessionId: string, limit = 200) {
    return db.prepare(`
      SELECT * FROM session_events
      WHERE session_id = ?
        AND type NOT IN ('terminal.output', 'agent.input', 'resource.updated')
      ORDER BY created_at DESC LIMIT ?
    `).all(sessionId, limit);
  },
};
