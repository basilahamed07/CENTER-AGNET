import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import pidusage from 'pidusage';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AgentSession } from './domain';
import { EventBus } from './eventBus';
import { AppError } from './errors';
import { buildResumeArgs, buildSpawnSpec } from './launcher';
import { logger } from './logger';
import { repository } from './repository';

const execFileAsync = promisify(execFile);

interface ManagedPty {
  pty: IPty;
  outputBuffer: string[];
  startedAt: number;
  lastOutputAt: number;
}

export class ProcessManager {
  private readonly processes = new Map<string, ManagedPty>();

  constructor(private readonly events: EventBus) {}

  listRunningSessionIds() {
    return [...this.processes.keys()];
  }

  reconcilePersistedSessions() {
    repository.markSessionsDisconnectedExcept(this.listRunningSessionIds());
  }

  getBufferedOutput(sessionId: string) {
    return this.processes.get(sessionId)?.outputBuffer.join('') ?? '';
  }

  async launch(workspaceId: string, agentDefinitionId: string, resumeOfSessionId?: string): Promise<AgentSession> {
    const workspace = repository.getWorkspace(workspaceId);
    const definition = repository.getAgentDefinition(agentDefinitionId);
    if (!definition.enabled) throw new AppError(400, 'Agent definition is disabled', 'AGENT_DISABLED');

    const prior = resumeOfSessionId ? repository.getSession(resumeOfSessionId) : null;
    const resumeArgs = prior ? buildResumeArgs(definition, prior.agent_session_id) : [];
    const spawnSpec = buildSpawnSpec(definition, resumeArgs);
    const session = repository.createSession({
      workspaceId,
      agentDefinitionId,
      displayName: repository.nextSessionName(definition.display_name),
      workingDirectory: workspace.path,
      resumeCapability: definition.supports_resume ? 'supported' : 'unsupported',
    });

    repository.setSessionStatus(session.id, 'STARTING');
    this.events.publish('agent.starting', { sessionId: session.id, displayName: session.display_name }, { sessionId: session.id, workspaceId });

    try {
      const child = pty.spawn(spawnSpec.file, spawnSpec.args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 32,
        cwd: workspace.path,
        env: { ...process.env, ...spawnSpec.env },
        useConpty: true,
      });

      const managed: ManagedPty = { pty: child, outputBuffer: [], startedAt: Date.now(), lastOutputAt: Date.now() };
      this.processes.set(session.id, managed);

      child.onData((data) => {
        managed.lastOutputAt = Date.now();
        managed.outputBuffer.push(data);
        if (managed.outputBuffer.length > 400) managed.outputBuffer.splice(0, managed.outputBuffer.length - 400);
        repository.updateSession(session.id, {
          last_activity_at: new Date().toISOString(),
          last_terminal_activity_at: new Date().toISOString(),
        });
        this.events.publish('terminal.output', { data }, { sessionId: session.id, workspaceId });
      });

      child.onExit(({ exitCode }) => {
        this.processes.delete(session.id);
        const status = exitCode === 0 ? 'STOPPED' : 'CRASHED';
        repository.setSessionStatus(session.id, status, {
          process_id: null,
          exit_code: exitCode,
          stopped_at: new Date().toISOString(),
        });
        this.events.publish(status === 'STOPPED' ? 'agent.stopped' : 'agent.crashed', { exitCode }, { sessionId: session.id, workspaceId });
        logger.info('agent exited', { sessionId: session.id, exitCode });
      });

      const running = repository.setSessionStatus(session.id, 'RUNNING', {
        process_id: child.pid,
        started_at: new Date().toISOString(),
        last_activity_at: new Date().toISOString(),
        last_terminal_activity_at: new Date().toISOString(),
      });
      this.events.publish('agent.started', { pid: child.pid }, { sessionId: session.id, workspaceId });
      logger.info('agent launched', { sessionId: session.id, pid: child.pid, command: definition.command });
      return running;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      repository.setSessionStatus(session.id, 'CRASHED', {
        stopped_at: new Date().toISOString(),
        metadata_json: JSON.stringify({ launchError: message }),
      });
      this.events.publish('agent.crashed', { launchError: message }, { sessionId: session.id, workspaceId });
      logger.error('agent launch failed', { sessionId: session.id, error: message });
      if (message.includes('EPERM') && message.includes('pipe')) {
        throw new AppError(503, 'Windows blocked ConPTY named pipe access for node-pty. Run the manager from a normal, unrestricted terminal or adjust endpoint security policy.', 'PTY_PERMISSION_BLOCKED');
      }
      throw error;
    }
  }

  write(sessionId: string, data: string) {
    const managed = this.processes.get(sessionId);
    if (!managed) throw new AppError(404, 'Terminal is not attached to a running process', 'PTY_NOT_FOUND');
    managed.pty.write(data);
    this.events.publish('agent.input', { bytes: data.length }, { sessionId });
  }

  resize(sessionId: string, cols: number, rows: number) {
    const managed = this.processes.get(sessionId);
    if (!managed) return;
    managed.pty.resize(cols, rows);
  }

  async stop(sessionId: string) {
    const managed = this.processes.get(sessionId);
    const session = repository.getSession(sessionId);
    if (!managed) return repository.setSessionStatus(sessionId, 'STOPPED', { stopped_at: new Date().toISOString(), process_id: null });

    repository.setSessionStatus(sessionId, 'STOPPING');
    this.events.publish('agent.stopping', {}, { sessionId, workspaceId: session.workspace_id });
    managed.pty.write('\x03');
    await new Promise((resolve) => setTimeout(resolve, 2500));
    if (this.processes.has(sessionId)) {
      throw new AppError(409, 'Process did not stop gracefully.', 'GRACEFUL_STOP_FAILED');
    }
    return repository.getSession(sessionId);
  }

  async forceTerminate(sessionId: string) {
    const managed = this.processes.get(sessionId);
    const session = repository.getSession(sessionId);
    if (!managed) return session;
    managed.pty.kill();
    this.processes.delete(sessionId);
    this.events.publish('agent.force_terminated', {}, { sessionId, workspaceId: session.workspace_id });
    return repository.setSessionStatus(sessionId, 'STOPPED', {
      process_id: null,
      stopped_at: new Date().toISOString(),
    });
  }

  async stopAll() {
    for (const sessionId of this.listRunningSessionIds()) {
      await this.forceTerminate(sessionId);
    }
  }

  async restart(sessionId: string) {
    const session = repository.getSession(sessionId);
    try {
      await this.stop(sessionId);
    } catch {
      await this.forceTerminate(sessionId);
    }
    return this.launch(session.workspace_id, session.agent_definition_id);
  }

  async resume(sessionId: string) {
    const session = repository.getSession(sessionId);
    return this.launch(session.workspace_id, session.agent_definition_id, sessionId);
  }

  async sampleResources() {
    for (const [sessionId, managed] of this.processes) {
      try {
        const usage = await pidusage(managed.pty.pid);
        repository.updateSession(sessionId, { cpu: usage.cpu, memory: usage.memory });
        this.events.publish('resource.updated', { cpu: usage.cpu, memory: usage.memory }, { sessionId });
      } catch (error) {
        logger.warn('resource sample failed', { sessionId, error: String(error) });
      }
    }
  }

  async processAlive(pid: number) {
    try {
      await execFileAsync('tasklist.exe', ['/FI', `PID eq ${pid}`]);
      return true;
    } catch {
      return false;
    }
  }

  computeStuckSignals() {
    const now = Date.now();
    for (const [sessionId, managed] of this.processes) {
      const inactiveMs = now - managed.lastOutputAt;
      const session = repository.getSession(sessionId);
      let score = 0;
      if (inactiveMs > 8 * 60 * 1000) score += 35;
      if (inactiveMs > 20 * 60 * 1000) score += 25;
      if (session.cpu < 1 && inactiveMs > 8 * 60 * 1000) score += 20;
      const confidence = score >= 60 ? 'medium' : score >= 35 ? 'low' : 'none';
      repository.updateSession(sessionId, { stuck_score: score, stuck_confidence: confidence });
      if (confidence !== 'none') {
        this.events.publish('agent.possibly_stuck', { confidence, inactiveMs, score }, { sessionId, workspaceId: session.workspace_id });
      }
    }
  }
}
