import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('git worktree manager: create, status, diff, dirty-safety, removal', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktrees-'));
  process.env.MANAGER_DB_PATH = path.join(tmpDir, 'test.sqlite');

  const { initDb } = await import('../db');
  initDb();
  const { repository } = await import('../repository');
  const {
    createWorktree,
    getWorktreeDiff,
    getWorktreeStatus,
    isGitRepository,
    listWorktrees,
    removeWorktree,
    sanitizeTaskName,
  } = await import('../worktreeManager');

  // Real git repo as workspace, with an initial commit (worktree needs HEAD).
  const repoPath = path.join(tmpDir, 'demo-repo');
  fs.mkdirSync(repoPath);
  const run = (args: string[], cwd = repoPath) => execFileAsync('git', args, { cwd });
  await run(['init', '-b', 'main']);
  await run(['config', 'user.email', 'test@example.com']);
  await run(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# demo\n');
  await run(['add', '.']);
  await run(['commit', '-m', 'init']);

  const workspace = repository.createWorkspace({ name: 'Worktree WS', path: repoPath });

  await t.test('non-git directories are rejected', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-'));
    const notRepo = repository.createWorkspace({ name: 'Plain', path: plain });
    await assert.rejects(() => createWorktree({ workspaceId: notRepo.id, taskName: 't1' }), /Not a git repository/);
    assert.equal(await isGitRepository(plain), false);
    fs.rmSync(plain, { recursive: true, force: true });
  });

  await t.test('create worktree: sibling dir + agent/ branch on disk', async () => {
    assert.equal(await isGitRepository(repoPath), true);
    const worktree = await createWorktree({ workspaceId: workspace.id, taskName: 'claude auth' });
    assert.equal(worktree.branch, 'agent/claude-auth');
    assert.ok(fs.existsSync(worktree.path), 'worktree directory should exist');
    assert.ok(fs.existsSync(path.join(worktree.path, 'README.md')), 'worktree should contain repo files');
    const expectedDir = path.join(path.dirname(repoPath), 'demo-repo-worktrees', 'claude-auth');
    assert.equal(worktree.path, expectedDir);
    assert.equal(worktree.base_branch, 'main');
  });

  await t.test('duplicate branch and duplicate directory are rejected', async () => {
    await assert.rejects(() => createWorktree({ workspaceId: workspace.id, taskName: 'claude-auth' }), /already exists/);
  });

  await t.test('status and diff see agent edits inside the worktree only', async () => {
    const worktree = listWorktrees(workspace.id)[0]!;
    fs.writeFileSync(path.join(worktree.path, 'src.ts'), 'export const x = 1;\n');

    const status = await getWorktreeStatus(worktree.id);
    assert.equal(status.dirty, true);
    assert.ok(status.changedFiles.some((file) => file.path === 'src.ts'));
    assert.equal(status.aheadOfBase, 0, 'uncommitted work is not ahead');

    const diff = await getWorktreeDiff(worktree.id);
    assert.ok(diff.includes('src.ts'));
    assert.ok(diff.includes('+export const x = 1;'));

    // The MAIN repo working tree stays clean — that is the whole point (spec §17).
    const mainStatus = await run(['status', '--porcelain']);
    assert.equal(mainStatus.stdout.trim(), '');
  });

  await t.test('dirty worktree removal is blocked without explicit force', async () => {
    const worktree = listWorktrees(workspace.id)[0]!;
    await assert.rejects(() => removeWorktree(worktree.id), /uncommitted changes/);
    // Force still does NOT delete the branch with work — only the checkout dir.
    await removeWorktree(worktree.id, { forceRemove: true });
    assert.equal(fs.existsSync(worktree.path), false);
    assert.equal(listWorktrees(workspace.id).length, 0);
    const branches = await run(['branch', '--list', 'agent/claude-auth']);
    assert.ok(branches.stdout.includes('agent/claude-auth'), 'branch with work must survive removal');
  });

  await t.test('clean worktree removes without force; idempotent re-remove', async () => {
    const clean = await createWorktree({ workspaceId: workspace.id, taskName: 'codex-tests' });
    const removed = await removeWorktree(clean.id);
    assert.ok(removed.removed_at);
    await assert.rejects(() => getWorktreeStatus(clean.id), /removed/);
    const again = await removeWorktree(clean.id);
    assert.ok(again.removed_at, 'second remove is a no-op, not a 404');
  });

  await t.test('task names are sanitized into safe branch names', () => {
    assert.equal(sanitizeTaskName('Claude Auth Refactor!'), 'claude-auth-refactor');
    assert.equal(sanitizeTaskName('../../etc/passwd'), 'etc-passwd');
    assert.throws(() => sanitizeTaskName('///'), /must contain/);
  });

  await t.test('worktree can be re-created after out-of-band branch/dir deletion (spec §11 stale metadata)', async (t) => {
    // After removal the tombstoned row still holds the UNIQUE path column.
    // The branch was deleted OUT OF BAND (user action, repo re-clone) so the
    // branch-exists guard no longer fires: createWorktree used to die on a
    // raw UNIQUE constraint error AFTER git had already created the directory.
    await run(['branch', '-D', 'agent/claude-auth']);
    const reused = await createWorktree({ workspaceId: workspace.id, taskName: 'claude-auth' });
    assert.ok(fs.existsSync(reused.path), 're-created worktree directory exists');
    assert.equal(reused.branch, 'agent/claude-auth');
    assert.equal(listWorktrees(workspace.id).filter((w) => w.task_name === 'claude-auth').length, 1, 'exactly one active row');

    // Re-create where the directory was deleted by hand (stale active row).
    // Out-of-band cleanup sequence a user would actually run: rm the dir,
    // prune stale git registrations, delete the branch — then re-create in
    // the UI. Only the tombstoned DB row remains, holding the UNIQUE path.
    const doomed = await createWorktree({ workspaceId: workspace.id, taskName: 'ghost-task' });
    fs.rmSync(doomed.path, { recursive: true, force: true });
    await run(['worktree', 'prune']);
    await run(['branch', '-D', 'agent/ghost-task']);
    const ghost = await createWorktree({ workspaceId: workspace.id, taskName: 'ghost-task' });
    assert.ok(fs.existsSync(ghost.path), 're-created over a stale row works');
    await removeWorktree(ghost.id);
    await removeWorktree(reused.id);
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
