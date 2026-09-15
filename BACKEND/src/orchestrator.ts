import { z } from 'zod';
import type { EventBus } from './eventBus';
import type { Goal, GoalTask } from './domain';
import { badRequest } from './errors';
import { logger } from './logger';
import type { ProcessManager } from './processManager';
import { goalRepository } from './goalRepository';
import { createWorktree, sanitizeTaskName } from './worktreeManager';
import { repository } from './repository';

/**
 * Phase-2 orchestration service (docs/PHASE_2_ARCHITECTURE.md §3-§7).
 *
 * Scope of this first increment (P2-1 + planning, owner decision 2026-09-15):
 *  - goal CRUD + timeline
 *  - AI planning: a chosen planner agent produces a structured plan (Gate 1)
 *  - deterministic plan extraction + validation (NO LLM inference anywhere)
 *  - manual task launch: each task runs in its own Phase-1 worktree via
 *    createWorktree + ProcessManager.launch — tasks are launched BY THE USER
 *    (auto-execution scheduler comes in P2-3, not this increment)
 *  - task exit handling: done/failed classification tied to Phase-1 session
 *    events, with the goal-level hard budget stop (owner decision)
 *
 * FORGE is a state machine, not a brain: the only LLM in the loop is the
 * installed CLI agent the user picked as planner (per-goal dropdown).
 */

// ---- Plan schema (§4) -------------------------------------------------------

export const PlanSchema = z.object({
  summary: z.string().min(1).max(2000),
  tasks: z.array(z.object({
    key: z.string().min(1).max(60).regex(/^[a-z0-9][a-z0-9-_]*$/i, 'task key must be a slug'),
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(4000),
    kind: z.enum(['code', 'test', 'docs', 'review', 'chore']).default('code'),
    dependsOn: z.array(z.string()).default([]),
    risk: z.enum(['low', 'medium', 'high']).default('medium'),
  })).min(1).max(50),
});
export type Plan = z.infer<typeof PlanSchema>;

// Global flag + matchAll: take the LAST complete fence, not the first —
// planner agents routinely echo the system prompt's plan example (which is
// itself a forge-plan fence) before producing their real plan. A trailing
// partial fence still can't match, so incomplete output stays "pending".
const PLAN_FENCE_RE = /```forge-plan\s*([\s\S]*?)```/g;

const PLANNER_SYSTEM_PROMPT = `You are a senior software planning assistant working inside FORGE, a local agent orchestration tool.

Produce an implementation plan for the goal given by the user.

RULES:
1. Output your FINAL plan inside ONE fenced code block tagged forge-plan, containing ONLY valid JSON (no comments, no trailing commas):
\`\`\`forge-plan
{
  "summary": "one paragraph describing the approach",
  "tasks": [
    { "key": "implement-auth", "title": "Implement auth module", "description": "precise instructions for the coding agent that will execute this task", "kind": "code", "dependsOn": [], "risk": "medium" }
  ]
}
\`\`\`
2. task.key: short unique slug (letters, digits, dash). 3-8 tasks total.
3. Each task must be small enough for one agent session in one worktree, and independently verifiable.
4. dependsOn lists keys of tasks that MUST be done first. No cycles.
5. kind is one of: code, test, docs, review, chore. Mark pure-verification tasks as test.
6. Write descriptions as direct instructions to a coding agent: files to touch, expected behavior, and how to verify.
7. Do NOT include tasks for merging or deployment — the human approves merges.

Before the fence, you may reason about the codebase freely. The fence must be your last output.`;

// ---- Validation helpers ------------------------------------------------------

function validatePlanGraph(plan: Plan): void {
  const keys = new Set(plan.tasks.map((task) => task.key));
  if (keys.size !== plan.tasks.length) {
    throw badRequest('Plan has duplicate task keys');
  }
  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      if (!keys.has(dep)) {
        throw badRequest(`Task "${task.key}" depends on unknown task "${dep}"`);
      }
    }
  }
  // Cycle check via DFS.
  const state = new Map<string, 'visiting' | 'done'>();
  const byKey = new Map(plan.tasks.map((task) => [task.key, task]));
  const visit = (key: string, path: string[]) => {
    const marker = state.get(key);
    if (marker === 'done') return;
    if (marker === 'visiting') {
      throw badRequest(`Plan has a dependency cycle: ${[...path, key].join(' → ')}`);
    }
    state.set(key, 'visiting');
    for (const dep of byKey.get(key)?.dependsOn ?? []) visit(dep, [...path, key]);
    state.set(key, 'done');
  };
  for (const task of plan.tasks) visit(task.key, []);
}

/**
 * The planner system prompt ships a forge-plan EXAMPLE (key `implement-auth`).
 * PTY echo puts that example into the ring buffer before the agent answers,
 * so an early extraction would otherwise approve the example as a real plan.
 * A fence whose every task is this exact known key+title is the echo — it is
 * never accepted as a plan (deterministic string check, not LLM inference).
 */
function isPromptExamplePlan(parsed: unknown): boolean {
  const candidate = PlanSchema.safeParse(parsed);
  if (!candidate.success) return false;
  const tasks = candidate.data.tasks;
  return tasks.length > 0 && tasks.every(
    (task) => task.key === 'implement-auth' && task.title === 'Implement auth module',
  );
}

export function extractPlan(text: string): Plan {
  const matches = [...text.matchAll(PLAN_FENCE_RE)];
  const match = matches[matches.length - 1];
  if (!match) {
    throw badRequest('Planner did not produce a forge-plan block. Ask it to re-run, or check the planner session terminal.');
  }
  let parsed: unknown;
  try {
    const fenced = match[1];
    if (fenced === undefined) throw badRequest('Planner produced an empty forge-plan block');
    parsed = JSON.parse(fenced.trim());
  } catch (error) {
    throw badRequest(`Planner output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (isPromptExamplePlan(parsed)) {
    throw badRequest('Planner has not produced its plan yet (only the prompt example is in the buffer). Try again once it answers.');
  }
  const result = PlanSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    if (!issue) throw badRequest('Plan failed validation (no details)');
    throw badRequest(`Plan failed validation at "${issue.path.join('.') || '(root)'}": ${issue.message}`);
  }
  validatePlanGraph(result.data);
  return result.data;
}

// ---- Service -----------------------------------------------------------------

export class Orchestrator {
  /**
   * Bounded output tails for goal-related sessions (planner + workers).
   *
   * Phase-1's ProcessManager drops a session's ring buffer when the process
   * exits — correct for terminal replay, but plan extraction happens AFTER
   * the planner finishes, so we must keep our own tail. Capped per session
   * and in session count; cleaned up when goals are deleted.
   */
  private readonly sessionTails = new Map<string, string>();
  private static readonly TAIL_MAX_BYTES = 400_000;
  private static readonly TAIL_MAX_SESSIONS = 50;

  constructor(
    private readonly events: EventBus,
    private readonly processManager: ProcessManager,
  ) {
    events.on('terminal.output', (event: unknown) => {
      const envelope = event as { sessionId?: string; payload?: { data?: string } };
      const sessionId = envelope?.sessionId;
      const data = envelope?.payload?.data ?? '';
      if (!sessionId || !data || !this.sessionTails.has(sessionId)) return;
      const next = (this.sessionTails.get(sessionId) ?? '') + data;
      this.sessionTails.set(sessionId, next.length > Orchestrator.TAIL_MAX_BYTES ? next.slice(-Orchestrator.TAIL_MAX_BYTES) : next);
    });
  }

  private trackSession(sessionId: string) {
    this.sessionTails.set(sessionId, '');
    while (this.sessionTails.size > Orchestrator.TAIL_MAX_SESSIONS) {
      const oldest = this.sessionTails.keys().next().value;
      if (oldest === undefined) break;
      this.sessionTails.delete(oldest);
    }
  }

  private sessionOutput(sessionId: string): string {
    return this.sessionTails.get(sessionId)
      ?? this.processManager.getBufferedOutput(sessionId); // live-session fallback
  }

  /** Stream a plan request into a planner agent session and return the session. */
  async runPlanner(goalId: string, plannerDefinitionId: string): Promise<Goal> {
    const goal = goalRepository.getGoal(goalId);
    if (!['draft', 'awaiting_plan_approval', 'failed'].includes(goal.status)) {
      throw badRequest(`Goal in status "${goal.status}" cannot be planned. Cancel it first.`);
    }
    const definition = repository.getAgentDefinition(plannerDefinitionId);
    if (!definition.enabled) throw badRequest(`Planner agent is disabled: ${definition.display_name}`);

    const session = await this.processManager.launch(goal.workspace_id, plannerDefinitionId);
    this.trackSession(session.id);
    const updated = goalRepository.setPlannerRun(goal.id, plannerDefinitionId, session.id);
    goalRepository.recordEvent(goal.id, 'goal.plan_started', { planner: definition.display_name, sessionId: session.id });

    // The prompt goes through the PTY so the user can watch the planner work
    // live in its Phase-1 terminal (design §4: "the planner is a CLI agent").
    const prompt = [
      PLANNER_SYSTEM_PROMPT,
      '',
      `GOAL TITLE: ${goal.title}`,
      `GOAL DESCRIPTION: ${goal.description || '(none provided)'}`,
      '',
      'Produce the forge-plan block now.',
    ].join('\n');
    this.processManager.write(session.id, prompt);
    return updated;
  }

  /**
   * Read the planner session's ring buffer and try to extract a plan.
   * Safe to call repeatedly; only succeeds when the fence is present.
   */
  tryExtractPlan(goalId: string): { status: 'extracted' | 'pending'; goal: Goal } {
    const goal = goalRepository.getGoal(goalId);
    if (!goal.planner_session_id) throw badRequest('No planner session for this goal yet');
    const text = this.sessionOutput(goal.planner_session_id);
    let plan: Plan;
    try {
      plan = extractPlan(text);
    } catch (error) {
      // "No plan yet" is the documented pending state (route §11), not an
      // error: the user simply re-extracts after the planner finishes.
      if (error instanceof Error && /has not produced its plan yet|forge-plan block/.test(error.message)) {
        return { status: 'pending', goal };
      }
      throw error;
    }
    goalRepository.storePlan(goal.id, JSON.stringify(plan));
    goalRepository.recordEvent(goal.id, 'goal.plan_extracted', { tasks: plan.tasks.length });
    return { status: 'extracted', goal: goalRepository.getGoal(goalId) };
  }

  /**
   * Gate 1 (§4): approve the pending plan — optionally after human edits —
   * and materialize it as goal tasks (still idle; launch is explicit).
   */
  approvePlan(goalId: string, editedPlan?: Plan): { goal: Goal; tasks: GoalTask[] } {
    const goal = goalRepository.getGoal(goalId);
    // Gate 1 accepts plans from two sources: the planner extraction flow
    // (awaiting_plan_approval) or a human-authored plan on a draft goal —
    // both are explicitly human-approved before any task exists.
    if (!['draft', 'awaiting_plan_approval'].includes(goal.status)) {
      throw badRequest(`Goal in status "${goal.status}" cannot accept a plan`);
    }
    if (!editedPlan && !goal.plan_json) {
      throw badRequest('No plan to approve — run the planner first or provide a plan');
    }
    const plan = editedPlan ?? (JSON.parse(goal.plan_json!) as Plan);
    const check = PlanSchema.safeParse(plan);
    if (!check.success) throw badRequest(`Plan invalid: ${check.error.issues[0]?.message}`);
    validatePlanGraph(check.data);
    if (editedPlan || goal.status === 'draft') goalRepository.storePlan(goal.id, JSON.stringify(check.data));

    goalRepository.replaceTasks(goal.id, check.data.tasks.map((task) => ({
      goalId: goal.id,
      planKey: task.key,
      title: task.title,
      description: task.description,
      kind: task.kind,
      risk: task.risk,
      dependsOn: task.dependsOn,
    })));
    // Tasks start 'blocked'; each becomes 'ready' when its deps are done.
    for (const task of goalRepository.listTasks(goal.id)) {
      this.refreshTaskReadiness(task);
    }
    goalRepository.setGoalStatus(goal.id, 'ready');
    goalRepository.recordEvent(goal.id, 'goal.plan_approved', { tasks: check.data.tasks.length });
    return { goal: goalRepository.getGoal(goalId), tasks: goalRepository.listTasks(goal.id) };
  }

  /** blocked → ready when all dependencies are done (called after every exit). */
  private refreshTaskReadiness(task: GoalTask): void {
    if (task.status !== 'blocked') return;
    const deps = JSON.parse(task.depends_on_json) as string[];
    const siblings = goalRepository.listTasks(task.goal_id);
    const byKey = new Map(siblings.map((row) => [row.plan_key, row]));
    const ready = deps.every((dep) => byKey.get(dep)?.status === 'done');
    if (ready) goalRepository.updateTask(task.id, { status: 'ready' });
  }

  /**
   * Launch one task (manual in this increment): worktree-per-task via the
   * Phase-1 worktree manager, then a Phase-1 session inside it. The task
   * brief is streamed through the PTY so the terminal shows the work live.
   */
  async launchTask(goalId: string, taskId: string, agentDefinitionId: string): Promise<GoalTask> {
    const goal = goalRepository.getGoal(goalId);
    if (!['ready', 'running'].includes(goal.status)) {
      throw badRequest(`Goal in status "${goal.status}" cannot launch tasks`);
    }
    const task = goalRepository.getTask(taskId);
    if (task.goal_id !== goalId) throw badRequest('Task does not belong to this goal');
    if (task.status !== 'ready') throw badRequest(`Task is not ready (status: ${task.status})`);

    const definition = repository.getAgentDefinition(agentDefinitionId);
    if (!definition.enabled) throw badRequest(`Agent is disabled: ${definition.display_name}`);

    // Deterministic slug: task key, disambiguated per attempt if needed.
    const baseName = sanitizeTaskName(`${goal.title.slice(0, 24)}-${task.plan_key}`.slice(0, 60));
    let worktree;
    try {
      worktree = await createWorktree({
        workspaceId: goal.workspace_id,
        taskName: task.attempts > 0 ? `${baseName}-${task.attempts + 1}` : baseName,
        agentDefinitionId: definition.id,
        sessionId: undefined,
      });
    } catch (error) {
      // Deterministic collisions (branch exists from an earlier goal run):
      // fall back to a unique suffix before giving up.
      const suffix = Date.now().toString(36);
      worktree = await createWorktree({
        workspaceId: goal.workspace_id,
        taskName: `${baseName}-${suffix}`.slice(0, 60),
        agentDefinitionId: definition.id,
      });
    }

    goalRepository.updateTask(task.id, {
      status: 'assigned',
      assigned_definition_id: definition.id,
      worktree_id: worktree.id,
      branch: worktree.branch,
    });

    try {
      const session = await this.processManager.launch(goal.workspace_id, definition.id, undefined, worktree.id);
      this.trackSession(session.id);
      goalRepository.updateTask(task.id, { status: 'running', session_id: session.id });
      goalRepository.setGoalStatus(goal.id, 'running');
      goalRepository.recordEvent(goal.id, 'goal.task_started', {
        task: task.title, agent: definition.display_name, branch: worktree.branch, sessionId: session.id,
      }, task.id);

      const deps = JSON.parse(task.depends_on_json) as string[];
      const depTitles = (goalRepository.listTasks(goalId) as GoalTask[])
        .filter((row) => deps.includes(row.plan_key))
        .map((row) => `- [${row.plan_key}] ${row.title} (already merged into this worktree's base branch: verify it)`);
      const brief = [
        `You are executing ONE task of a larger goal inside an isolated git worktree (branch: ${worktree.branch}).`,
        `GOAL: ${goal.title}`,
        goal.description ? `GOAL CONTEXT: ${goal.description}` : '',
        deps.length > 0 ? `DEPENDENCIES ALREADY PLANNED FOR:\n${depTitles.join('\n')}` : '',
        '',
        `YOUR TASK [${task.plan_key}] (${task.kind}, risk: ${task.risk}):`,
        task.title,
        '',
        task.description,
        '',
        'Work only inside this worktree. Do not merge. Commit your work when done.',
      ].filter(Boolean).join('\n');
      this.processManager.write(session.id, brief);
      return goalRepository.getTask(task.id);
    } catch (error) {
      goalRepository.updateTask(task.id, { status: 'failed', failure_json: JSON.stringify({ launchError: String(error) }) });
      goalRepository.recordEvent(goal.id, 'goal.task_failed', { error: String(error) }, task.id);
      throw error;
    }
  }

  /** Called from index.ts on agent.stopped / agent.crashed for task sessions. */
  onSessionExit(sessionId: string, exitCode: number, crashed: boolean): void {
    const task = goalRepository.findTaskBySession(sessionId);
    if (!task) return;
    const goal = goalRepository.getGoal(task.goal_id);

    if (!crashed && exitCode === 0) {
      goalRepository.updateTask(task.id, {
        status: 'done',
        verification_json: JSON.stringify({ exitCode, verifiedAt: new Date().toISOString(), note: 'process exited cleanly (machine verification: pending in this increment)' }),
      });
      goalRepository.recordEvent(task.goal_id, 'goal.task_done', { exitCode }, task.id);
      // Unblock dependents.
      for (const sibling of goalRepository.listTasks(task.goal_id)) {
        this.refreshTaskReadiness(sibling);
      }
      const tasks = goalRepository.listTasks(task.goal_id);
      const allDone = tasks.every((row) => ['done', 'cancelled'].includes(row.status));
      if (allDone) {
        goalRepository.setGoalStatus(task.goal_id, 'awaiting_review');
        goalRepository.recordEvent(task.goal_id, 'goal.awaiting_review', {});
      }
    } else {
      // attempts counts completed FAILED runs; it is only ever bumped here
      // (launch/retry never increment it), so the pre-increment value is the
      // attempt number that just failed: 1 → failed (one bad run), ≥2 → dead
      // (a retry already failed). retryTask resets status but keeps the count.
      const attempts = task.attempts + 1;
      goalRepository.updateTask(task.id, {
        status: attempts >= 2 ? 'dead' : 'failed',
        attempts,
        failure_json: JSON.stringify({ exitCode, crashed }),
      });
      goalRepository.recordEvent(task.goal_id, 'goal.task_failed', { exitCode, crashed }, task.id);

      // Hard budget stop (owner decision 2026-09-15).
      const updatedGoal = goalRepository.incrementFailedAttempts(task.goal_id);
      if (updatedGoal.failed_attempts >= updatedGoal.attempt_budget) {
        goalRepository.setGoalStatus(task.goal_id, 'failed');
        goalRepository.recordEvent(task.goal_id, 'goal.budget_exhausted', {
          failedAttempts: updatedGoal.failed_attempts, budget: updatedGoal.attempt_budget,
        });
      }
    }
    logger.info('goal task session exit', { sessionId, taskId: task.id, exitCode, crashed, goalId: goal.id });
  }

  async cancelGoal(goalId: string): Promise<Goal> {
    const goal = goalRepository.getGoal(goalId);
    const tasks = goalRepository.listTasks(goalId);
    for (const task of tasks) {
      if (task.session_id && ['running', 'assigned'].includes(task.status)) {
        try { await this.processManager.stop(task.session_id); } catch { /* force below */ }
        try { await this.processManager.forceTerminate(task.session_id); } catch { /* already gone */ }
      }
      if (!['done', 'cancelled'].includes(task.status)) {
        goalRepository.updateTask(task.id, { status: 'cancelled' });
      }
    }
    goalRepository.setGoalStatus(goalId, 'cancelled');
    goalRepository.recordEvent(goalId, 'goal.cancelled', { tasks: tasks.length });
    return goalRepository.getGoal(goalId);
  }

  /** Retry a failed/dead task: same worktree is NOT reused (branch churn); new attempt gets a fresh worktree. */
  async retryTask(goalId: string, taskId: string, agentDefinitionId?: string): Promise<GoalTask> {
    const task = goalRepository.getTask(taskId);
    if (!['failed', 'dead'].includes(task.status)) throw badRequest('Only failed tasks can be retried');
    const goal = goalRepository.getGoal(goalId);
    if (goal.status === 'failed') {
      // Human acknowledged the budget stop; resume the goal.
      goalRepository.resetFailedAttempts(goalId);
      goalRepository.setGoalStatus(goalId, 'ready');
    }
    goalRepository.updateTask(taskId, { status: 'ready' });
    goalRepository.recordEvent(goalId, 'goal.task_retry', { task: task.title }, taskId);
    return this.launchTask(goalId, taskId, agentDefinitionId ?? task.assigned_definition_id ?? (goal.planner_definition_id ?? ''));
  }

  getGoalDetail(goalId: string) {
    const goal = goalRepository.getGoal(goalId);
    return {
      goal,
      tasks: goalRepository.listTasks(goalId),
      events: goalRepository.listEvents(goalId),
    };
  }
}
