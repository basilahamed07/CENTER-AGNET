import { randomUUID } from 'crypto';
import type { AgentDefinition, AgentSession, AgentStatus, LauncherType, Workspace, WorkspaceAgentAssignment } from './domain';
import { db } from './db';
import { badRequest, notFound } from './errors';

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
