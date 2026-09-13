import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('workspace agent assignments', async (t) => {
  // The repository binds to the db module at import time, so point
  // MANAGER_DB_PATH at a throwaway file before importing anything else.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assignments-'));
  process.env.MANAGER_DB_PATH = path.join(tmpDir, 'test.sqlite');

  const { initDb } = await import('../db');
  initDb();
  const { repository } = await import('../repository');
  const { badRequest, notFound } = await import('../errors');

  await t.test('assign round-trip with idempotency and 404s', () => {
    const workspace = repository.createWorkspace({ name: 'Assignments WS', path: os.tmpdir() });
    const agent = repository.createAgentDefinition({
      displayName: 'Assign Bot',
      command: 'assign-bot',
      launcherType: 'direct',
    });

    assert.equal(repository.listAssignmentsForAgent(agent.id).length, 0);

    // Assign (idempotent on the unique pair).
    const first = repository.assignAgentToWorkspace(workspace.id, agent.id);
    assert.equal(first.workspace_id, workspace.id);
    assert.equal(first.agent_definition_id, agent.id);
    const duplicate = repository.assignAgentToWorkspace(workspace.id, agent.id);
    assert.equal(duplicate.id, first.id);

    // Reads see exactly one assignment.
    assert.equal(repository.listAssignments().length, 1);
    assert.equal(repository.listAssignmentsForAgent(agent.id).length, 1);

    // Unknown ids surface clean 404s.
    assert.throws(() => repository.assignAgentToWorkspace('missing-ws', agent.id), (error: unknown) => {
      return error instanceof notFound('X').constructor && (error as { statusCode?: number }).statusCode === 404;
    });
    assert.throws(() => repository.assignAgentToWorkspace(workspace.id, 'missing-agent'), (error: unknown) => {
      return (error as { statusCode?: number }).statusCode === 404;
    });

    // Unassign removes the row; unassigning again is a clean 404.
    assert.deepEqual(repository.unassignAgentFromWorkspace(workspace.id, agent.id), { removed: true });
    assert.equal(repository.listAssignments().length, 0);
    assert.throws(() => repository.unassignAgentFromWorkspace(workspace.id, agent.id), (error: unknown) => {
      return (error as { statusCode?: number }).statusCode === 404;
    });
  });

  await t.test('disabled agents cannot be assigned', () => {
    const workspace = repository.createWorkspace({ name: 'Assignments WS 2', path: os.tmpdir() });
    const agent = repository.createAgentDefinition({
      displayName: 'Disabled Bot',
      command: 'disabled-bot',
      launcherType: 'direct',
    });
    repository.updateAgentEnabled(agent.id, false);
    assert.throws(() => repository.assignAgentToWorkspace(workspace.id, agent.id), (error: unknown) => {
      return (error as { statusCode?: number }).statusCode === 400;
    });
  });

  await t.test('deleted agents disappear from assignment listings', () => {
    const workspace = repository.createWorkspace({ name: 'Assignments WS 3', path: os.tmpdir() });
    const agent = repository.createAgentDefinition({
      displayName: 'Vanishing Bot',
      command: 'vanishing-bot',
      launcherType: 'direct',
    });
    repository.assignAgentToWorkspace(workspace.id, agent.id);
    assert.equal(repository.listAssignments().length, 1);

    repository.deleteAgentDefinition(agent.id);
    assert.equal(repository.listAssignments().length, 0);
    assert.equal(repository.listAssignmentsForAgent(agent.id).length, 0);
  });

  await t.test('error helpers expose correct status codes', () => {
    assert.equal(badRequest('nope').statusCode, 400);
    assert.equal(notFound('X').statusCode, 404);
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
