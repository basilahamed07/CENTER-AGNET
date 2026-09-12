import { execFile } from 'child_process';
import fs from 'fs';
import { promisify } from 'util';
import { EventBus } from './eventBus';
import { logger } from './logger';
import { repository } from './repository';

const execFileAsync = promisify(execFile);

function parsePorcelain(output: string) {
  let staged = 0;
  let modified = 0;
  let untracked = 0;

  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    if (line.startsWith('??')) {
      untracked += 1;
      continue;
    }
    if (line[0] && line[0] !== ' ') staged += 1;
    if (line[1] && line[1] !== ' ') modified += 1;
  }

  return { staged, modified, untracked };
}

export async function refreshWorkspaceGit(workspaceId: string, events?: EventBus) {
  const workspace = repository.getWorkspace(workspaceId);
  if (!fs.existsSync(workspace.path)) {
    repository.updateWorkspaceGit(workspace.id, { branch: null, status: 'missing', modified: 0, staged: 0, untracked: 0 });
    return;
  }

  try {
    const branch = await execFileAsync('git', ['-C', workspace.path, 'branch', '--show-current'], { timeout: 5000 });
    const status = await execFileAsync('git', ['-C', workspace.path, 'status', '--porcelain'], { timeout: 5000 });
    const parsed = parsePorcelain(status.stdout);
    const gitState = {
      branch: branch.stdout.trim() || '(detached)',
      status: status.stdout.trim() ? 'dirty' : 'clean',
      ...parsed,
    };

    // Skip DB write + event when nothing changed (prevents git.changed event spam every tick).
    const unchanged = workspace.git_branch === gitState.branch
      && workspace.git_status === gitState.status
      && workspace.git_modified === gitState.modified
      && workspace.git_staged === gitState.staged
      && workspace.git_untracked === gitState.untracked;
    if (unchanged) return;

    repository.updateWorkspaceGit(workspace.id, gitState);
    events?.publish('git.changed', gitState, { workspaceId });
  } catch (error) {
    const status = 'not_git_or_unavailable';
    if (workspace.git_status !== status) {
      repository.updateWorkspaceGit(workspace.id, { branch: null, status, modified: 0, staged: 0, untracked: 0 });
      logger.warn('git monitor failed', { workspaceId, error: String(error) });
    }
  }
}

export function startGitMonitor(events: EventBus, intervalMs = 15000) {
  const tick = async () => {
    const workspaces = repository.listWorkspaces();
    for (const workspace of workspaces) {
      await refreshWorkspaceGit(workspace.id, events);
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return () => clearInterval(timer);
}
