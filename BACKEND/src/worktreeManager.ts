import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import type { AgentWorktree } from './domain';
import { badRequest, notFound } from './errors';
import { logger } from './logger';
import { repository } from './repository';

const execFileAsync = promisify(execFile);

/**
 * Git worktree isolation for parallel agents (spec §17-23).
 *
 * One worktree + branch per agent so two agents never edit the same working
 * files. Git is the source of truth for what changed; this manager only
 * orchestrates safe git operations.
 *
 * Safety rules (spec §20, §23) enforced here:
 *  - NEVER merge, rebase, reset, discard, or force-checkout anything.
 *  - NEVER remove a worktree with uncommitted changes without explicit
 *    confirmation (forceRemove requires the caller to have warned the user).
 *  - All git invocations use execFile argument arrays — no shell, no string
 *    concatenation of user input (spec §25).
 */

const GIT_TIMEOUT_MS = 15_000;

interface GitOutput {
  stdout: string;
  stderr: string;
}

async function git(args: string[], cwd?: string): Promise<GitOutput> {
  try {
    return await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS });
  } catch (error) {
    // Surface git's own stderr — it is precise and actionable.
    const err = error as { stderr?: string; message?: string };
    const detail = (err.stderr ?? err.message ?? 'git failed').trim();
    throw badRequest(detail.slice(0, 500));
  }
}

/** git diff --no-index exits 1 when differences exist — that is success here. */
async function gitDiffTolerant(args: string[], cwd?: string): Promise<string> {
  try {
    const result = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS });
    return result.stdout;
  } catch (error) {
    const err = error as { code?: number; stdout?: string };
    if (err.code === 1 && typeof err.stdout === 'string') return err.stdout;
    return '';
  }
}

export async function isGitRepository(directory: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--is-inside-work-tree'], directory);
    return true;
  } catch {
    return false;
  }
}

async function currentBranch(directory: string): Promise<string | null> {
  const result = await git(['branch', '--show-current'], directory);
  const branch = result.stdout.trim();
  return branch.length > 0 ? branch : null;
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

/** Dirty = uncommitted changes (staged, unstaged, or untracked) in the worktree. */
async function isDirty(worktreePath: string): Promise<boolean> {
  const result = await git(['status', '--porcelain'], worktreePath);
  return result.stdout.trim().length > 0;
}

/** Validate a task name into a safe branch suffix: letters, digits, dash, underscore. */
export function sanitizeTaskName(taskName: string): string {
  const cleaned = taskName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (cleaned.length === 0) throw badRequest('Task name must contain letters or digits');
  return cleaned;
}

export interface CreateWorktreeInput {
  workspaceId: string;
  agentDefinitionId?: string;
  sessionId?: string;
  taskName: string;
  /** Optional distinct worktree dir name; defaults to the task name. */
  directoryName?: string;
}

export async function createWorktree(input: CreateWorktreeInput): Promise<AgentWorktree> {
  const workspace = repository.getWorkspace(input.workspaceId);
  if (!(await isGitRepository(workspace.path))) {
    throw badRequest(`Not a git repository: ${workspace.path}`);
  }

  const task = sanitizeTaskName(input.taskName);
  const dirName = input.directoryName
    ? sanitizeTaskName(input.directoryName)
    : task;
  const branch = `agent/${dirName}`;

  if (await branchExists(workspace.path, branch)) {
    throw badRequest(`Branch already exists: ${branch}. Pick another task name.`);
  }

  // Sibling directory: <repo>-worktrees/<task> (spec §18). Reserved name
  // collision is virtually impossible but must fail loudly, not overwrite.
  const baseDir = `${path.basename(workspace.path)}-worktrees`;
  const parentDir = path.join(path.dirname(workspace.path), baseDir);
  const worktreePath = path.join(parentDir, dirName);
  if (fs.existsSync(worktreePath)) {
    throw badRequest(`Worktree directory already exists: ${worktreePath}`);
  }

  // Stale active row whose directory is gone (deleted by hand, tmp wipe, ...)
  // would collide on the UNIQUE path column — tombstone it first (spec §11).
  repository.reconcileMissingWorktree(worktreePath);
  // Drop stale git registrations for worktrees whose directories vanished.
  // Prune only touches missing paths — healthy worktrees are unaffected —
  // and prevents "already registered" failures on re-creation (spec §11).
  await git(['worktree', 'prune'], workspace.path);

  const baseBranch = await currentBranch(workspace.path);
  // Argument-array invocation: git worktree add <path> -b <branch>
  await git(['worktree', 'add', worktreePath, '-b', branch], workspace.path);
  logger.info('worktree created', { workspaceId: workspace.id, path: worktreePath, branch });

  try {
    return repository.createWorktreeRecord({
      workspaceId: workspace.id,
      agentDefinitionId: input.agentDefinitionId ?? null,
      sessionId: input.sessionId ?? null,
      path: worktreePath,
      branch,
      baseBranch,
      taskName: dirName,
    });
  } catch (error) {
    // The git side succeeded but the manager could not record it. Leave no
    // untracked git worktree behind: roll back our own just-created checkout
    // so the next attempt starts clean. The branch survives (created by git
    // from HEAD); removal safety rules are untouched.
    await git(['worktree', 'remove', '--force', worktreePath], workspace.path).catch(() => {});
    throw error;
  }
}

export function listWorktrees(workspaceId: string): AgentWorktree[] {
  return repository.listWorktrees(workspaceId);
}

export interface WorktreeStatus {
  worktree: AgentWorktree;
  branch: string;
  dirty: boolean;
  aheadOfBase: number;
  behindBase: number;
  changedFiles: Array<{ path: string; state: string }>;
  lastCommitSubject: string | null;
}

export async function getWorktreeStatus(worktreeId: string): Promise<WorktreeStatus> {
  const worktree = repository.getWorktree(worktreeId);
  if (worktree.removed_at) throw badRequest('Worktree was already removed');
  if (!fs.existsSync(worktree.path)) {
    throw badRequest(`Worktree directory is missing on disk: ${worktree.path}`);
  }

  const status = await git(['status', '--porcelain', '--branch'], worktree.path);
  const changedFiles: Array<{ path: string; state: string }> = [];
  for (const line of status.stdout.split(/\r?\n/).filter(Boolean)) {
    if (line.startsWith('##')) continue;
    const state = `${line.slice(0, 2).trim() || '-'}${line.startsWith('??') ? '' : line.slice(2, 3).trim() || ''}`.trim();
    changedFiles.push({ path: line.slice(3).trim(), state });
  }
  const dirty = changedFiles.length > 0;

  let aheadOfBase = 0;
  let behindBase = 0;
  if (worktree.base_branch) {
    try {
      const rev = await git(
        ['rev-list', '--left-right', '--count', `${worktree.base_branch}...HEAD`],
        worktree.path,
      );
      const parts = rev.stdout.trim().split(/\s+/).map(Number);
      behindBase = Number.isFinite(parts[0]) ? (parts[0] as number) : 0;
      aheadOfBase = Number.isFinite(parts[1]) ? (parts[1] as number) : 0;
    } catch {
      // Base branch may have been deleted; counts stay 0 rather than failing the view.
    }
  }

  let lastCommitSubject: string | null = null;
  try {
    const log = await git(['log', '-1', '--format=%s'], worktree.path);
    lastCommitSubject = log.stdout.trim() || null;
  } catch {
    // Fresh worktree with zero commits.
  }

  return {
    worktree,
    branch: await currentBranch(worktree.path) ?? worktree.branch,
    dirty,
    aheadOfBase,
    behindBase,
    changedFiles,
    lastCommitSubject,
  };
}

/** Unified diff of all uncommitted changes inside the worktree (spec §21). */
const MAX_UNTRACKED_DIFFS = 20;

export async function getWorktreeDiff(worktreeId: string): Promise<string> {
  const worktree = repository.getWorktree(worktreeId);
  if (worktree.removed_at) throw badRequest('Worktree was already removed');
  if (!fs.existsSync(worktree.path)) throw badRequest(`Worktree directory is missing: ${worktree.path}`);
  const staged = await git(['diff', '--cached'], worktree.path);
  const unstaged = await git(['diff'], worktree.path);
  // New (untracked) files have no diff at all — synthesize one per file with
  // --no-index so reviewers see what the agent created, not just filenames.
  const untracked = (await git(['ls-files', '--others', '--exclude-standard'], worktree.path))
    .stdout.trim().split(/\r?\n/).filter(Boolean);
  let untrackedDiffs = '';
  for (const file of untracked.slice(0, MAX_UNTRACKED_DIFFS)) {
    const fileDiff = await gitDiffTolerant(['diff', '--no-index', '--', '/dev/null', file], worktree.path);
    if (fileDiff) untrackedDiffs += fileDiff;
  }
  const unlisted = untracked.length > MAX_UNTRACKED_DIFFS
    ? `\n# ... ${untracked.length - MAX_UNTRACKED_DIFFS} more untracked files not expanded\n`
    : '';
  return `${staged.stdout}${unstaged.stdout}${untrackedDiffs}${unlisted}`.slice(0, 400_000);
}

/**
 * Removal with dirty-state safety (spec §23). forceRemove=true bypasses the
 * dirty check ONLY after the UI has shown an explicit warning — this manager
 * still never touches branches with the work.
 */
export async function removeWorktree(worktreeId: string, options: { forceRemove?: boolean } = {}): Promise<AgentWorktree> {
  const worktree = repository.getWorktree(worktreeId);
  if (worktree.removed_at) return worktree;
  const workspace = repository.getWorkspace(worktree.workspace_id);

  if (fs.existsSync(worktree.path)) {
    if (!options.forceRemove && (await isDirty(worktree.path))) {
      throw badRequest(
        'This worktree contains uncommitted changes. Review or commit them first, or explicitly confirm force removal.',
      );
    }
    // --force is git's own requirement for removing dirty checkouts; the UI
    // confirmation IS the human gate (spec §23) — git never touches branches.
    const args = options.forceRemove
      ? ['worktree', 'remove', '--force', worktree.path]
      : ['worktree', 'remove', worktree.path];
    await git(args, workspace.path);
  }

  logger.info('worktree removed', { worktreeId, path: worktree.path });
  return repository.markWorktreeRemoved(worktreeId);
}
