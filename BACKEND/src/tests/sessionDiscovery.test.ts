import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { DiscoveredSession } from '../sessionDiscovery';

test('external session matching routes sessions to workspaces', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-'));
  process.env.MANAGER_DB_PATH = path.join(tmpDir, 'test.sqlite');

  const { initDb } = await import('../db');
  initDb();
  const { repository } = await import('../repository');
  const {
    matchSessionsToWorkspaces,
    scanExternalSessions,
  } = await import('../sessionDiscovery');

  const workspace = repository.createWorkspace({ name: 'Discovery WS', path: tmpDir });

  const session = (overrides: Partial<DiscoveredSession>): DiscoveredSession => ({
    agent: 'claude',
    agentSessionId: 's1',
    workspacePath: tmpDir,
    title: null,
    startedAt: null,
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    source: '/tmp/x.jsonl',
    resumeSupported: true,
    ...overrides,
  });

  await t.test('exact path match', () => {
    const [matched] = matchSessionsToWorkspaces([session({})], [workspace]);
    assert.ok(matched);
    assert.equal(matched.matchedWorkspaceId, workspace.id);
    assert.equal(matched.matchKind, 'exact');
  });

  await t.test('subdirectory match', () => {
    const nested = path.join(tmpDir, 'packages', 'app');
    const [matched] = matchSessionsToWorkspaces([session({ workspacePath: nested })], [workspace]);
    assert.ok(matched);
    assert.equal(matched.matchedWorkspaceId, workspace.id);
    assert.equal(matched.matchKind, 'subdirectory');
  });

  await t.test('unknown paths do not match', () => {
    const [matched] = matchSessionsToWorkspaces([session({ workspacePath: '/definitely/not/your/project' })], [workspace]);
    assert.ok(matched);
    assert.equal(matched.matchedWorkspaceId, null);
    assert.equal(matched.matchKind, 'none');
  });

  await t.test('missing workspace path yields no match, not a crash', () => {
    const [matched] = matchSessionsToWorkspaces([session({ workspacePath: null })], [workspace]);
    assert.ok(matched);
    assert.equal(matched.matchedWorkspaceId, null);
    assert.equal(matched.matchKind, 'none');
  });

  await t.test('unsupported agents are reported honestly in coverage', () => {
    const result = scanExternalSessions({ homeDir: tmpDir, workspacePaths: [tmpDir] });
    const unsupported = result.coverage.filter((report) => report.status === 'unsupported');
    assert.ok(unsupported.length > 0, 'expected unsupported agents in coverage');
    for (const report of unsupported) {
      assert.ok(report.note && report.note.length > 0, 'unsupported entries must carry a note');
    }
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
