import { randomUUID } from 'crypto';
import type { Goal, GoalEvent, GoalTask } from './domain';
import { GOAL_STATUSES, GOAL_TASK_STATUSES } from './domain';
import { badRequest, notFound } from './errors';
import { db } from './db';

function now() {
  return new Date().toISOString();
}

function touchGoal(id: string) {
  db.prepare('UPDATE goals SET updated_at = ? WHERE id = ?').run(now(), id);
}

/**
 * Phase-2 orchestration persistence (docs/PHASE_2_ARCHITECTURE.md §5).
 *
 * Goals and their tasks are bookkeeping rows layered OVER Phase-1 entities:
 * a task's execution is an agent_sessions row launched in an agent_worktrees
 * row — this repository never spawns anything and never touches processes.
 */
export const goalRepository = {
  createGoal(input: {
    workspaceId: string;
    title: string;
    description?: string;
    plannerDefinitionId?: string | null;
  }): Goal {
    const id = randomUUID();
    db.prepare(`
      INSERT INTO goals (id, workspace_id, title, description, planner_definition_id, status)
      VALUES (@id, @workspaceId, @title, @description, @plannerDefinitionId, 'draft')
    `).run({
      id,
      workspaceId: input.workspaceId,
      title: input.title,
      description: input.description ?? '',
      plannerDefinitionId: input.plannerDefinitionId ?? null,
    });
    return this.getGoal(id);
  },

  getGoal(id: string): Goal {
    const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as Goal | undefined;
    if (!row) throw notFound('Goal');
    return row;
  },

  listGoals(): Goal[] {
    return db.prepare('SELECT * FROM goals ORDER BY created_at DESC').all() as Goal[];
  },

  /** Guarded status transition: only known statuses, enforced here in one place. */
  setGoalStatus(id: string, status: Goal['status']) {
    if (!GOAL_STATUSES.includes(status)) throw badRequest(`Unknown goal status: ${status}`);
    db.prepare('UPDATE goals SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
    return this.getGoal(id);
  },

  setPlannerRun(id: string, plannerDefinitionId: string, plannerSessionId: string) {
    db.prepare('UPDATE goals SET planner_definition_id = ?, planner_session_id = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(plannerDefinitionId, plannerSessionId, 'planning', now(), id);
    return this.getGoal(id);
  },

  storePlan(id: string, planJson: string) {
    db.prepare('UPDATE goals SET plan_json = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(planJson, 'awaiting_plan_approval', now(), id);
    return this.getGoal(id);
  },

  incrementFailedAttempts(id: string): Goal {
    db.prepare('UPDATE goals SET failed_attempts = failed_attempts + 1, updated_at = ? WHERE id = ?').run(now(), id);
    return this.getGoal(id);
  },

  resetFailedAttempts(id: string): Goal {
    db.prepare('UPDATE goals SET failed_attempts = 0, updated_at = ? WHERE id = ?').run(now(), id);
    return this.getGoal(id);
  },

  updateGoal(id: string, fields: Partial<Pick<Goal, 'title' | 'description' | 'concurrency_limit' | 'attempt_budget' | 'reviews_enabled' | 'autonomy'>>): Goal {
    const allowed = new Set(['title', 'description', 'concurrency_limit', 'attempt_budget', 'reviews_enabled', 'autonomy']);
    // Drop undefined values: better-sqlite3 cannot bind undefined, and a
    // partially-specified update must only touch the fields it names.
    const entries = Object.entries(fields).filter(([key, value]) => allowed.has(key) && value !== undefined);
    if (entries.length === 0) return this.getGoal(id);
    const assignments = entries.map(([key]) => `${key} = @${key}`).join(', ');
    db.prepare(`UPDATE goals SET ${assignments}, updated_at = @updatedAt WHERE id = @id`)
      .run({ ...Object.fromEntries(entries), updatedAt: now(), id });
    return this.getGoal(id);
  },

  deleteGoal(id: string) {
    db.prepare('DELETE FROM goal_events WHERE goal_id = ?').run(id);
    db.prepare('DELETE FROM goal_tasks WHERE goal_id = ?').run(id);
    db.prepare('DELETE FROM goals WHERE id = ?').run(id);
  },

  // ---- Tasks ---------------------------------------------------------------

  createTask(input: {
    goalId: string;
    planKey: string;
    title: string;
    description?: string;
    kind?: GoalTask['kind'];
    risk?: GoalTask['risk'];
    dependsOn?: string[];      // plan keys
    assignedDefinitionId?: string | null;
  }): GoalTask {
    const id = randomUUID();
    db.prepare(`
      INSERT INTO goal_tasks (id, goal_id, plan_key, title, description, kind, risk, depends_on_json, assigned_definition_id)
      VALUES (@id, @goalId, @planKey, @title, @description, @kind, @risk, @dependsOnJson, @assignedDefinitionId)
    `).run({
      id,
      goalId: input.goalId,
      planKey: input.planKey,
      title: input.title,
      description: input.description ?? '',
      kind: input.kind ?? 'code',
      risk: input.risk ?? 'medium',
      dependsOnJson: JSON.stringify(input.dependsOn ?? []),
      assignedDefinitionId: input.assignedDefinitionId ?? null,
    });
    return this.getTask(id);
  },

  getTask(id: string): GoalTask {
    const row = db.prepare('SELECT * FROM goal_tasks WHERE id = ?').get(id) as GoalTask | undefined;
    if (!row) throw notFound('Goal task');
    return row;
  },

  listTasks(goalId: string): GoalTask[] {
    return db.prepare('SELECT * FROM goal_tasks WHERE goal_id = ? ORDER BY created_at').all(goalId) as GoalTask[];
  },

  /** Replace the whole task set (used when an approved plan is materialized). */
  replaceTasks(goalId: string, tasks: Array<{
    goalId: string;
    planKey: string;
    title: string;
    description?: string;
    kind?: GoalTask['kind'];
    risk?: GoalTask['risk'];
    dependsOn?: string[];
    assignedDefinitionId?: string | null;
  }>) {
    db.prepare('DELETE FROM goal_tasks WHERE goal_id = ?').run(goalId);
    for (const task of tasks) {
      this.createTask({ ...task, goalId });
    }
    touchGoal(goalId);
  },

  updateTask(id: string, fields: Partial<Pick<GoalTask, 'status' | 'assigned_definition_id' | 'session_id' | 'worktree_id' | 'branch' | 'attempts' | 'verification_json' | 'failure_json'>>) {
    const allowed = new Set(['status', 'assigned_definition_id', 'session_id', 'worktree_id', 'branch', 'attempts', 'verification_json', 'failure_json']);
    const entries = Object.entries(fields).filter(([key, value]) => allowed.has(key) && value !== undefined);
    if (entries.length === 0) return this.getTask(id);
    const assignments = entries.map(([key]) => `${key} = @${key}`).join(', ');
    db.prepare(`UPDATE goal_tasks SET ${assignments}, updated_at = @updatedAt WHERE id = @id`)
      .run({ ...Object.fromEntries(entries), updatedAt: now(), id });
    return this.getTask(id);
  },

  findTaskBySession(sessionId: string): GoalTask | null {
    const row = db.prepare('SELECT * FROM goal_tasks WHERE session_id = ? ORDER BY created_at DESC LIMIT 1').get(sessionId) as GoalTask | undefined;
    return row ?? null;
  },

  // ---- Events (timeline) -----------------------------------------------------

  recordEvent(goalId: string, type: string, payload: Record<string, unknown> = {}, taskId?: string) {
    db.prepare(`
      INSERT INTO goal_events (id, goal_id, task_id, type, payload_json)
      VALUES (@id, @goalId, @taskId, @type, @payloadJson)
    `).run({ id: randomUUID(), goalId, taskId: taskId ?? null, type, payloadJson: JSON.stringify(payload) });
  },

  listEvents(goalId: string, limit = 100): GoalEvent[] {
    return db.prepare('SELECT * FROM goal_events WHERE goal_id = ? ORDER BY created_at DESC LIMIT ?').all(goalId, limit) as GoalEvent[];
  },
};
