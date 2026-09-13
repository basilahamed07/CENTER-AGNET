import { db } from './db';
import { commandExistsOnPath } from './launcher';
import { logger } from './logger';

/**
 * Seeds the built-in agent definitions for the 15 agents installed by
 * install_agnet.sh. Idempotent: INSERT ... ON CONFLICT with deterministic ids
 * ("def-<key>"), so re-running never duplicates and user edits survive.
 *
 * The deterministic ids are load-bearing: the external-session scanner keys
 * sessions by the same agent keys, and the resume endpoint maps
 * DiscoveredSession.agent -> agent_definitions.id to launch a resume.
 *
 * Resume flags were verified from each installed binary's --help on this
 * machine; session store locations are documented in sessionDiscovery.ts.
 */
interface SeedAgent {
  key: string;
  name: string;
  command: string;
  launcher: 'direct';
  resume: 'appendArgs' | 'none';
  sessionArg: string | null;
}

const SEED: SeedAgent[] = [
  // --- Agents with verified per-id resume flags -----------------------------
  { key: 'claude', name: 'Claude Code', command: 'claude', launcher: 'direct', resume: 'appendArgs', sessionArg: '--resume' },
  { key: 'codex', name: 'Codex CLI', command: 'codex', launcher: 'direct', resume: 'appendArgs', sessionArg: 'resume' },
  { key: 'gemini', name: 'Gemini CLI', command: 'gemini', launcher: 'direct', resume: 'appendArgs', sessionArg: '-r' },
  { key: 'pi', name: 'Pi Agent', command: 'pi', launcher: 'direct', resume: 'appendArgs', sessionArg: '--session' },
  { key: 'aider', name: 'Aider', command: 'aider', launcher: 'direct', resume: 'appendArgs', sessionArg: '--restore-chat-history' },
  { key: 'continue', name: 'Continue CLI', command: 'cn', launcher: 'direct', resume: 'appendArgs', sessionArg: '--resume' },
  { key: 'goose', name: 'Goose', command: 'goose', launcher: 'direct', resume: 'appendArgs', sessionArg: '--resume' },
  { key: 'opencode', name: 'OpenCode', command: 'opencode', launcher: 'direct', resume: 'appendArgs', sessionArg: '--session' },
  // --- Agents without a verified per-id resume flag --------------------------
  { key: 'kilo', name: 'Kilo Code', command: 'kilo', launcher: 'direct', resume: 'none', sessionArg: null },
  { key: 'hermes', name: 'Hermes Agent', command: 'hermes', launcher: 'direct', resume: 'none', sessionArg: null },
  { key: 'crush', name: 'Crush', command: 'crush', launcher: 'direct', resume: 'none', sessionArg: null },
  { key: 'openclaw', name: 'OpenClaw', command: 'openclaw', launcher: 'direct', resume: 'none', sessionArg: null },
  { key: 'openhands', name: 'OpenHands CLI', command: 'openhands', launcher: 'direct', resume: 'none', sessionArg: null },
  { key: 'plandex', name: 'Plandex', command: 'plandex', launcher: 'direct', resume: 'none', sessionArg: null },
  { key: 'mentat', name: 'Mentat', command: 'mentat', launcher: 'direct', resume: 'none', sessionArg: null },
];

export function seedAgentDefinitions(options: { forceEnabled?: boolean } = {}) {
  const inserted: Array<{ id: string; enabled: boolean }> = [];
  const disabledMissingBinary: string[] = [];
  for (const agent of SEED) {
    const id = `def-${agent.key}`;
    const enabled = (options.forceEnabled || commandExistsOnPath(agent.command)) ? 1 : 0;
    if (!enabled) disabledMissingBinary.push(agent.key);
    const supportsResume = agent.resume === 'appendArgs' ? 1 : 0;
    db.prepare(`
      INSERT INTO agent_definitions (
        id, display_name, command, default_args, env_json, launcher_type,
        supports_resume, resume_strategy, resume_command, resume_args, session_id_arg
      )
      VALUES (
        @id, @displayName, @command, '[]', '{}', @launcherType,
        @supportsResume, @resumeStrategy, NULL, '[]', @sessionArg
      )
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        command = excluded.command,
        updated_at = CURRENT_TIMESTAMP
    `).run({
      id,
      displayName: agent.name,
      command: agent.command,
      launcherType: agent.launcher,
      supportsResume,
      resumeStrategy: agent.resume,
      sessionArg: agent.sessionArg,
    });
    // Keep enabled state aligned with PATH reality on every boot.
    db.prepare('UPDATE agent_definitions SET enabled = ? WHERE id = ?').run(enabled, id);
    inserted.push({ id, enabled: enabled === 1 });
  }
  logger.info('agent definitions seeded', {
    total: inserted.length,
    enabled: inserted.filter((row) => row.enabled).length,
    disabledMissingBinary,
  });
  return { inserted, disabledMissingBinary };
}
