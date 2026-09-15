import { Router } from 'express';
import type { Orchestrator } from './orchestrator';
import { PlanSchema } from './orchestrator';
import { z } from 'zod';
import { badRequest } from './errors';
import { repository } from './repository';
import { goalRepository } from './goalRepository';

/**
 * Phase-2 orchestration API (docs/PHASE_2_ARCHITECTURE.md §11).
 * All routes validate payloads with zod, mirroring Phase-1 route patterns.
 */
export function createOrchestratorRouter(orchestrator: Orchestrator): Router {
  const router = Router();

  const createGoalSchema = z.object({
    workspaceId: z.string().min(1),
    title: z.string().min(1).max(200),
    description: z.string().max(4000).default(''),
    plannerDefinitionId: z.string().min(1).optional(),
  });

  router.post('/goals', (req, res) => {
    const parsed = createGoalSchema.parse(req.body);
    // Fail with a clean 404 instead of a raw FOREIGN KEY 500.
    repository.getWorkspace(parsed.workspaceId);
    const goal = goalRepository.createGoal(parsed);
    res.status(201).json(goal);
  });

  router.get('/goals', (_req, res) => {
    res.json(goalRepository.listGoals());
  });

  router.get('/goals/:id', (req, res) => {
    res.json(orchestrator.getGoalDetail(req.params.id));
  });

  router.post('/goals/:id/plan', async (req, res, next) => {
    try {
      const parsed = z.object({ plannerDefinitionId: z.string().min(1) }).parse(req.body);
      res.json(await orchestrator.runPlanner(req.params.id, parsed.plannerDefinitionId));
    } catch (error) { next(error); }
  });

  // Deterministic extraction from the planner session's ring buffer.
  router.post('/goals/:id/plan/extract', (req, res, next) => {
    try {
      res.json(orchestrator.tryExtractPlan(req.params.id));
    } catch (error) { next(error); }
  });

  router.post('/goals/:id/plan/approve', (req, res, next) => {
    try {
      const body = req.body as { plan?: unknown } | undefined;
      const editedPlan = body?.plan ? PlanSchema.parse(body.plan) : undefined;
      res.json(orchestrator.approvePlan(req.params.id, editedPlan));
    } catch (error) { next(error); }
  });

  router.post('/goals/:id/tasks/:taskId/launch', async (req, res, next) => {
    try {
      const parsed = z.object({ agentDefinitionId: z.string().min(1) }).parse(req.body);
      res.json(await orchestrator.launchTask(req.params.id, req.params.taskId, parsed.agentDefinitionId));
    } catch (error) { next(error); }
  });

  router.post('/goals/:id/tasks/:taskId/retry', async (req, res, next) => {
    try {
      const parsed = z.object({ agentDefinitionId: z.string().min(1).optional() }).parse(req.body ?? {});
      res.json(await orchestrator.retryTask(req.params.id, req.params.taskId, parsed.agentDefinitionId));
    } catch (error) { next(error); }
  });

  router.patch('/goals/:id', (req, res, next) => {
    try {
      const parsed = z.object({
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(4000).optional(),
        concurrency_limit: z.number().int().min(1).max(6).optional(),
        attempt_budget: z.number().int().min(1).max(100).optional(),
        reviews_enabled: z.boolean().optional(),
        autonomy: z.enum(['gated', 'semi', 'auto']).optional(),
      }).parse(req.body);
      const updates: Record<string, unknown> = { ...parsed };
      if (parsed.reviews_enabled !== undefined) updates.reviews_enabled = parsed.reviews_enabled ? 1 : 0;
      res.json(goalRepository.updateGoal(req.params.id, updates));
    } catch (error) { next(error); }
  });

  router.post('/goals/:id/cancel', async (req, res, next) => {
    try {
      res.json(await orchestrator.cancelGoal(req.params.id));
    } catch (error) { next(error); }
  });

  router.delete('/goals/:id', (req, res) => {
    // Refuse to delete a goal with live task sessions — stop it first.
    const detail = orchestrator.getGoalDetail(req.params.id);
    const live = detail.tasks.filter((task) => ['running', 'assigned'].includes(task.status));
    if (live.length > 0) throw badRequest('Cancel the goal before deleting it (tasks are still running)');
    goalRepository.deleteGoal(req.params.id);
    res.status(204).end();
  });

  return router;
}
