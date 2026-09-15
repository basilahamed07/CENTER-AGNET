import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('phase-2 orchestrator: plan extraction, approval, readiness, budget stop', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-'));
  process.env.MANAGER_DB_PATH = path.join(tmpDir, 'test.sqlite');

  const { initDb } = await import('../db');
  initDb();
  const { goalRepository } = await import('../goalRepository');
  const { extractPlan, Orchestrator } = await import('../orchestrator');
  const { EventBus } = await import('../eventBus');

  await t.test('extractPlan parses a valid fenced plan', () => {
    const plan = extractPlan([
      'Some reasoning about the codebase...',
      '```forge-plan',
      JSON.stringify({
        summary: 'Build auth',
        tasks: [
          { key: 'implement', title: 'Implement auth', description: 'do it', kind: 'code', dependsOn: [], risk: 'medium' },
          { key: 'test', title: 'Test auth', description: 'test it', kind: 'test', dependsOn: ['implement'], risk: 'low' },
        ],
      }),
      '```',
    ].join('\n'));
    assert.equal(plan.tasks.length, 2);
    assert.deepEqual(plan.tasks[1]?.dependsOn, ['implement']);
  });

  await t.test('extractPlan rejects missing fence, bad JSON, unknown deps, and cycles', () => {
    assert.throws(() => extractPlan('no fence here'), /forge-plan/);
    assert.throws(() => extractPlan('```forge-plan\n{not json}\n```'), /valid JSON/);
    assert.throws(() => extractPlan([
      '```forge-plan',
      JSON.stringify({ summary: 's', tasks: [{ key: 'a', title: 'A', description: 'd', dependsOn: ['ghost'] }] }),
      '```',
    ].join('\n')), /unknown task/);
    const cyclic = extractPlan; // label clarity only
    assert.throws(() => (cyclic)([
      '```forge-plan',
      JSON.stringify({
        summary: 's',
        tasks: [
          { key: 'a', title: 'A', description: 'd', dependsOn: ['b'] },
          { key: 'b', title: 'B', description: 'd', dependsOn: ['a'] },
        ],
      }),
      '```',
    ].join('\n')), /cycle/);
  });

  await t.test('plan approval materializes tasks and unblocks dependents on done', async () => {
    const ws = (await import('../repository')).repository.createWorkspace({ name: 'WS', path: '/tmp' });
    const goal = goalRepository.createGoal({ workspaceId: ws.id, title: 'Auth goal' });
    goalRepository.storePlan(goal.id, JSON.stringify({
      summary: 's',
      tasks: [
        { key: 'a', title: 'A', description: 'da', kind: 'code', dependsOn: [], risk: 'low' },
        { key: 'b', title: 'B', description: 'db', kind: 'test', dependsOn: ['a'], risk: 'low' },
      ],
    })).status;

    const orchestrator = new Orchestrator({ on: () => {}, publish: () => {} } as never, { getBufferedOutput: () => '' } as never);
    const { tasks } = orchestrator.approvePlan(goal.id);

    assert.equal(tasks.length, 2);
    assert.equal(tasks[0]?.status, 'ready', 'no deps → ready');
    assert.equal(tasks[1]?.status, 'blocked', 'dep not done → blocked');
    assert.equal(goalRepository.getGoal(goal.id).status, 'ready');

    // Simulate the session-exit path for task A (as index.ts would trigger it).
    const taskA = tasks[0]!;
    goalRepository.updateTask(taskA.id, { status: 'running', session_id: 'fake-session-1' });
    orchestrator.onSessionExit('fake-session-1', 0, false);
    const afterA = goalRepository.listTasks(goal.id);
    assert.equal(afterA.find((row) => row.plan_key === 'a')?.status, 'done');
    assert.equal(afterA.find((row) => row.plan_key === 'b')?.status, 'ready', 'dependent unblocked by A done');
  });

  await t.test('failed attempts accumulate and hard-stop the goal at budget', async () => {
    const ws = (await import('../repository')).repository.createWorkspace({ name: 'WS2', path: '/tmp' });
    const goal = goalRepository.createGoal({ workspaceId: ws.id, title: 'Fragile goal' });
    goalRepository.updateGoal(goal.id, { attempt_budget: 2 });
    goalRepository.setGoalStatus(goal.id, 'running');

    const orchestrator = new Orchestrator({ on: () => {}, publish: () => {} } as never, { getBufferedOutput: () => '' } as never);

    // Two crashes: each counts, second must flip the goal to failed.
    for (let i = 1; i <= 2; i++) {
      const task = goalRepository.createTask({ goalId: goal.id, planKey: `t${i}`, title: `T${i}` });
      goalRepository.updateTask(task.id, { status: 'running', session_id: `s-${i}` });
      orchestrator.onSessionExit(`s-${i}`, 1, true);
    }
    const after = goalRepository.getGoal(goal.id);
    assert.equal(after.failed_attempts, 2);
    assert.equal(after.status, 'failed', 'budget stop fired');
    const eventsList = goalRepository.listEvents(goal.id);
    assert.ok(eventsList.some((e) => e.type === 'goal.budget_exhausted'));
  });

  await t.test('updateGoal partial PATCH: fields left undefined are ignored, others persist', async () => {
    const ws = (await import('../repository')).repository.createWorkspace({ name: 'WS2b', path: '/tmp' });
    const goal = goalRepository.createGoal({ workspaceId: ws.id, title: 'Patchable' });
    // Simulates the route spreading a partially-parsed body: reviews_enabled
    // is present-but-undefined and must NOT corrupt the update (better-sqlite3
    // cannot bind undefined — regression for the silent PATCH 500).
    const updated = goalRepository.updateGoal(goal.id, {
      attempt_budget: 3,
      reviews_enabled: undefined,
    } as never);
    assert.equal(updated.attempt_budget, 3, 'named field persisted');
    assert.equal(updated.reviews_enabled, 1, 'unspecified field untouched at default');
    assert.equal(updated.title, 'Patchable', 'other fields untouched');
  });

  await t.test('cancelGoal marks live tasks cancelled', async () => {
    const ws = (await import('../repository')).repository.createWorkspace({ name: 'WS3', path: '/tmp' });
    const goal = goalRepository.createGoal({ workspaceId: ws.id, title: 'Cancel me' });
    const task = goalRepository.createTask({ goalId: goal.id, planKey: 'x', title: 'X' });
    goalRepository.updateTask(task.id, { status: 'running', session_id: 'sess-x' });
    goalRepository.setGoalStatus(goal.id, 'running');

    const orchestrator = new Orchestrator(
      { on: () => {}, emit: () => {}, publish: () => {} } as never,
      {
        getBufferedOutput: () => '',
        stop: async () => { throw new Error('not stopping gracefully'); },
        forceTerminate: async () => ({}),
      } as never,
    );
    const cancelled = await orchestrator.cancelGoal(goal.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(goalRepository.getTask(task.id).status, 'cancelled');
  });

  await t.test('extractPlan takes the LAST forge-plan fence (echoed example must not win)', () => {
    // Planners often echo the system prompt's example plan before their real one.
    const text = [
      'Understood. Here is the format:',
      '```forge-plan',
      JSON.stringify({ summary: 'ECHOED EXAMPLE — must be ignored', tasks: [{ key: 'echo', title: 'Echo', description: 'x', kind: 'code', dependsOn: [], risk: 'low' }] }),
      '```',
      'Now my actual plan for the requested goal:',
      '```forge-plan',
      JSON.stringify({ summary: 'real plan', tasks: [{ key: 'real', title: 'Real task', description: 'do the real work', kind: 'code', dependsOn: [], risk: 'medium' }] }),
      '```',
    ].join('\n');
    const plan = extractPlan(text);
    assert.equal(plan.summary, 'real plan');
    assert.equal(plan.tasks[0]?.key, 'real');
  });

  await t.test('extractPlan still rejects a trailing unclosed fence (incomplete output stays pending)', () => {
    const text = [
      '```forge-plan',
      JSON.stringify({ summary: 'old complete plan', tasks: [{ key: 'a', title: 'A', description: 'd', kind: 'code', dependsOn: [], risk: 'low' }] }),
      '```',
      '```forge-plan',
      '{ "summary": "still typing…"',
    ].join('\n');
    // The last COMPLETE fence is still the first one; the partial tail must not crash.
    const plan = extractPlan(text);
    assert.equal(plan.summary, 'old complete plan');
    assert.throws(() => extractPlan('```forge-plan\n{ "summary": "only partial'), /forge-plan/);
  });

  await t.test('failed task attempts accumulate: 1st failure → failed, 2nd → dead', async () => {
    const ws = (await import('../repository')).repository.createWorkspace({ name: 'WS4', path: '/tmp' });
    const goal = goalRepository.createGoal({ workspaceId: ws.id, title: 'Retry ladder' });
    goalRepository.setGoalStatus(goal.id, 'running');
    const orchestrator = new Orchestrator({ on: () => {}, publish: () => {} } as never, { getBufferedOutput: () => '' } as never);

    const task = goalRepository.createTask({ goalId: goal.id, planKey: 'r1', title: 'R1' });
    goalRepository.updateTask(task.id, { status: 'running', session_id: 'sess-r1-a' });
    orchestrator.onSessionExit('sess-r1-a', 1, true);
    const afterFirst = goalRepository.getTask(task.id);
    assert.equal(afterFirst.status, 'failed', 'first failure marks the task failed (retryable)');
    assert.equal(afterFirst.attempts, 1, 'attempts counts the completed failed run');

    // Same task relaunched, fails again → now dead.
    goalRepository.updateTask(task.id, { status: 'running', session_id: 'sess-r1-b' });
    orchestrator.onSessionExit('sess-r1-b', 1, true);
    const afterSecond = goalRepository.getTask(task.id);
    assert.equal(afterSecond.status, 'dead', 'a failed retry is dead');
    assert.equal(afterSecond.attempts, 2);
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
