import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('repository CRUD, status transitions and validation', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-'));
  process.env.MANAGER_DB_PATH = path.join(tmpDir, 'test.sqlite');

  const { initDb } = await import('../db');
  initDb();
  const { repository } = await import('../repository');

  await t.test('workspace lifecycle: create, list, archive', () => {
    const workspace = repository.createWorkspace({ name: 'Repo WS', path: tmpDir });
    assert.ok(workspace.id.length > 0);
    assert.ok(repository.listWorkspaces().some((row) => row.id === workspace.id));

    repository.archiveWorkspace(workspace.id);
    assert.equal(repository.listWorkspaces().some((row) => row.id === workspace.id), false);
    // Archived workspaces still resolve by id (history remains readable).
    assert.equal(repository.getWorkspace(workspace.id).archived, 1);
  });

  await t.test('getWorkspace/getSession 404 on missing ids', () => {
    assert.throws(() => repository.getWorkspace('nope'), (error: unknown) => (error as { statusCode?: number }).statusCode === 404);
    assert.throws(() => repository.getSession('nope'), (error: unknown) => (error as { statusCode?: number }).statusCode === 404);
  });

  await t.test('agent definition create and soft delete', () => {
    const agent = repository.createAgentDefinition({
      displayName: 'Repo Bot',
      command: 'repo-bot',
      launcherType: 'direct',
      supportsResume: true,
      resumeStrategy: 'appendArgs',
      sessionIdArg: '--resume',
    });
    assert.equal(agent.supports_resume, 1);
    assert.equal(agent.session_id_arg, '--resume');

    const deleted = repository.deleteAgentDefinition(agent.id);
    assert.deepEqual(deleted, { deleted: true });
    // Soft delete: row still exists but disabled.
    assert.equal(repository.getAgentDefinition(agent.id).enabled, 0);
  });

  await t.test('session status transitions and interrupted-boot reconciliation', () => {
    const workspace = repository.createWorkspace({ name: 'Status WS', path: tmpDir });
    const agent = repository.createAgentDefinition({ displayName: 'Status Bot', command: 'status-bot', launcherType: 'direct' });
    const supported = repository.createSession({
      workspaceId: workspace.id,
      agentDefinitionId: agent.id,
      displayName: 'Status Bot #1',
      workingDirectory: tmpDir,
      resumeCapability: 'supported',
    });
    repository.setSessionStatus(supported.id, 'RUNNING', { process_id: 123456 });

    // Simulate a manager crash: RUNNING rows become RESUMABLE/DISCONNECTED.
    repository.markSessionsDisconnectedExcept([]);
    const after = repository.getSession(supported.id);
    assert.equal(after.status, 'RESUMABLE');
    assert.equal(after.process_id, null);
    assert.ok(after.stopped_at);
  });

  await t.test('updateSession rejects unknown columns', () => {
    const workspace = repository.createWorkspace({ name: 'Guard WS', path: tmpDir });
    const agent = repository.createAgentDefinition({ displayName: 'Guard Bot', command: 'guard-bot', launcherType: 'direct' });
    const session = repository.createSession({
      workspaceId: workspace.id,
      agentDefinitionId: agent.id,
      displayName: 'Guard Bot #1',
      workingDirectory: tmpDir,
      resumeCapability: 'unsupported',
    });
    assert.throws(() => repository.updateSession(session.id, { 'status = \'HACKED\', status': 1 }), /illegal column/);
  });

  await t.test('nextSessionName increments per agent display name', () => {
    const workspace = repository.createWorkspace({ name: 'Name WS', path: tmpDir });
    const agent = repository.createAgentDefinition({ displayName: 'Named Bot', command: 'named-bot', launcherType: 'direct' });
    const first = repository.nextSessionName(agent.display_name);
    assert.equal(first, 'Named Bot #1');
    repository.createSession({
      workspaceId: workspace.id,
      agentDefinitionId: agent.id,
      displayName: first,
      workingDirectory: tmpDir,
      resumeCapability: 'unsupported',
    });
    assert.equal(repository.nextSessionName(agent.display_name), 'Named Bot #2');
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
