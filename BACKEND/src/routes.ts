import type { Request, Response, NextFunction, Router } from 'express';
import express from 'express';
import { AppError } from './errors';
import { refreshWorkspaceGit } from './gitMonitor';
import { logger } from './logger';
import type { ProcessManager } from './processManager';
import { repository } from './repository';
import { sampleSystemResources } from './systemMonitor';
import { cleanupProbeDbs } from './utils/dbCleanup';
import { agentCreateSchema, launchSessionSchema, workspaceCreateSchema } from './validation';

export function createApiRouter(processManager: ProcessManager): Router {
  const router = express.Router();

  router.get('/state', (_req, res) => {
    processManager.reconcilePersistedSessions();
    const runningSessionIds = processManager.listRunningSessionIds();
    res.json({
      workspaces: repository.listWorkspaces(),
      agentDefinitions: repository.listAgentDefinitions().filter((agent) => agent.enabled),
      sessions: repository.listSessions(),
      runningSessionIds,
      events: repository.listEvents(100),
      system: sampleSystemResources(runningSessionIds.length),
    });
  });

  router.get('/workspaces', (_req, res) => res.json(repository.listWorkspaces()));
  router.post('/workspaces', (req, res) => {
    const parsed = workspaceCreateSchema.parse(req.body);
    const workspace = repository.createWorkspace(parsed);
    void refreshWorkspaceGit(workspace.id);
    res.status(201).json(workspace);
  });
  router.delete('/workspaces/:id', (req, res) => {
    repository.archiveWorkspace(req.params.id);
    res.status(204).end();
  });

  router.get('/agents', (_req, res) => res.json(repository.listAgentDefinitions()));
  router.post('/agents', (req, res) => {
    const parsed = agentCreateSchema.parse(req.body);
    res.status(201).json(repository.createAgentDefinition(parsed));
  });
  router.patch('/agents/:id/enabled', (req, res) => {
    res.json(repository.updateAgentEnabled(req.params.id, Boolean(req.body.enabled)));
  });
  router.delete('/agents/:id', (req, res) => {
    res.json(repository.deleteAgentDefinition(req.params.id));
  });
  router.post('/maintenance/clear-agents', async (_req, res, next) => {
    try {
      await processManager.stopAll();
      repository.clearSessionHistory();
      repository.clearAgentDefinitions();
      res.json({ cleared: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/maintenance/cleanup-probe-dbs', (_req, res) => {
    res.json({ cleaned: true, removed: cleanupProbeDbs() });
  });

  router.get('/sessions', (_req, res) => res.json(repository.listSessions()));
  router.get('/sessions/:id/events', (req, res) => res.json(repository.listSessionEvents(req.params.id)));
  router.post('/sessions', async (req, res, next) => {
    try {
      const parsed = launchSessionSchema.parse(req.body);
      res.status(201).json(await processManager.launch(parsed.workspaceId, parsed.agentDefinitionId));
    } catch (error) {
      next(error);
    }
  });
  router.post('/sessions/:id/stop', async (req, res, next) => {
    try {
      res.json(await processManager.stop(req.params.id));
    } catch (error) {
      next(error);
    }
  });
  router.post('/sessions/:id/force-terminate', async (req, res, next) => {
    try {
      res.json(await processManager.forceTerminate(req.params.id));
    } catch (error) {
      next(error);
    }
  });
  router.post('/sessions/:id/restart', async (req, res, next) => {
    try {
      res.json(await processManager.restart(req.params.id));
    } catch (error) {
      next(error);
    }
  });
  router.post('/sessions/:id/resume', async (req, res, next) => {
    try {
      res.json(await processManager.resume(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export function errorMiddleware(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof AppError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return;
  }

  if (error && typeof error === 'object' && 'issues' in error) {
    res.status(400).json({ error: 'Invalid request payload', code: 'VALIDATION_ERROR', details: error });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  logger.error('request failed', { error: error instanceof Error ? error.stack ?? error.message : message });
  res.status(500).json({ error: message || 'Internal manager error', code: 'INTERNAL_ERROR' });
}
