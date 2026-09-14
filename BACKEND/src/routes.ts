import type { Request, Response, NextFunction, Router } from 'express';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { AppError } from './errors';
import { refreshWorkspaceGit } from './gitMonitor';
import { logger } from './logger';
import type { ProcessManager } from './processManager';
import { repository } from './repository';
import { badRequest } from './errors';
import { sampleSystemResources } from './systemMonitor';
import { createWorktree, getWorktreeDiff, getWorktreeStatus, listWorktrees, removeWorktree } from './worktreeManager';
import { listExternalSessionsForWorkspace, scanExternalSessions } from './sessionDiscovery';
import { cleanupProbeDbs } from './utils/dbCleanup';
import { agentCreateSchema, assignmentSchema, externalResumeSchema, launchSessionSchema, worktreeCreateSchema, worktreeRemoveSchema, workspaceCreateSchema } from './validation';

export function createApiRouter(processManager: ProcessManager): Router {
  const router = express.Router();

  router.get('/state', (_req, res) => {
    processManager.reconcilePersistedSessions();
    const runningSessionIds = processManager.listRunningSessionIds();
    res.json({
      workspaces: repository.listWorkspaces(),
      agentDefinitions: repository.listAgentDefinitions().filter((agent) => agent.enabled),
      assignments: repository.listAssignments(),
      sessions: repository.listSessions(),
      runningSessionIds,
      events: repository.listEvents(100),
      system: sampleSystemResources(runningSessionIds.length),
    });
  });

  router.get('/workspaces', (_req, res) => res.json(repository.listWorkspaces()));
  router.post('/workspaces', (req, res) => {
    const parsed = workspaceCreateSchema.parse(req.body);
    // Validate before persisting: a workspace pointing at a missing directory
    // would fail later at launch time with a confusing PTY spawn error.
    const resolved = path.resolve(parsed.path);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw badRequest(`Workspace path does not exist on this machine: ${resolved}`);
    }
    if (!stat.isDirectory()) {
      throw badRequest(`Workspace path must be a directory: ${resolved}`);
    }
    const workspace = repository.createWorkspace({ ...parsed, path: resolved });
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

  router.get('/assignments', (_req, res) => res.json(repository.listAssignments()));
  router.get('/agents/:id/assignments', (req, res) => {
    res.json(repository.listAssignmentsForAgent(req.params.id));
  });
  router.post('/workspaces/:id/agents', (req, res, next) => {
    try {
      const parsed = assignmentSchema.pick({ agentDefinitionId: true }).parse(req.body);
      res.status(201).json(repository.assignAgentToWorkspace(req.params.id, parsed.agentDefinitionId));
    } catch (error) {
      next(error);
    }
  });
  router.delete('/workspaces/:id/agents/:agentDefinitionId', (req, res, next) => {
    try {
      res.json(repository.unassignAgentFromWorkspace(req.params.id, req.params.agentDefinitionId));
    } catch (error) {
      next(error);
    }
  });

  // ---- Worktrees (spec §18-23): one branch + dir per parallel agent ------
  router.get('/workspaces/:id/worktrees', (req, res) => {
    res.json(listWorktrees(req.params.id));
  });

  router.post('/workspaces/:id/worktrees', async (req, res, next) => {
    try {
      const parsed = worktreeCreateSchema.parse(req.body);
      const worktree = await createWorktree({ workspaceId: req.params.id, ...parsed });
      res.status(201).json(worktree);
    } catch (error) {
      next(error);
    }
  });

  router.get('/worktrees/:id/status', async (req, res, next) => {
    try {
      res.json(await getWorktreeStatus(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  router.get('/worktrees/:id/diff', async (req, res, next) => {
    try {
      res.json({ diff: await getWorktreeDiff(req.params.id) });
    } catch (error) {
      next(error);
    }
  });

  // Removal never merges, deletes branches, or discards work (spec §20, §23):
  // dirty worktrees require forceRemove after an explicit UI confirmation.
  router.post('/worktrees/:id/remove', async (req, res, next) => {
    try {
      const parsed = worktreeRemoveSchema.parse(req.body ?? {});
      res.json(await removeWorktree(req.params.id, parsed));
    } catch (error) {
      next(error);
    }
  });

  router.get('/sessions', (_req, res) => res.json(repository.listSessions()));

  // External sessions: past conversations the installed CLI agents wrote to
  // their own local stores. coverage reports per-agent scan status so the UI
  // can show honest "not scanned / no store found" states.
  router.get('/external-sessions', (req, res) => {
    const workspaces = repository.listWorkspaces();
    const discovery = scanExternalSessions({
      force: req.query.force === '1',
      workspacePaths: workspaces.map((workspace) => workspace.path),
    });
    res.json({ coverage: discovery.coverage, sessions: discovery.sessions });
  });
  router.get('/workspaces/:id/external-sessions', (req, res) => {
    const workspaces = repository.listWorkspaces();
    const workspace = repository.getWorkspace(req.params.id);
    const result = listExternalSessionsForWorkspace(workspace.id, workspaces, { force: req.query.force === '1' });
    res.json(result);
  });

  // Resume a session found by the external scanner: maps the discovered
  // agent key to a seeded agent definition and launches it with the
  // definition's resume args + discovered session id.
  router.post('/external-sessions/resume', async (req, res, next) => {
    try {
      const parsed = externalResumeSchema.parse(req.body);
      res.json(await processManager.launchExternalResume(parsed.agentKey, parsed.agentSessionId, parsed.workspaceId));
    } catch (error) {
      next(error);
    }
  });
  router.get('/sessions/:id/events', (req, res) => res.json(repository.listSessionEvents(req.params.id)));
  // The worktree this session runs in, if any (null when launched unisolated).
  router.get('/sessions/:id/worktree', (req, res) => {
    res.json(repository.findWorktreeBySession(req.params.id));
  });
  router.post('/sessions', async (req, res, next) => {
    try {
      const parsed = launchSessionSchema.parse(req.body);
      res.status(201).json(await processManager.launch(parsed.workspaceId, parsed.agentDefinitionId, undefined, parsed.worktreeId));
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
