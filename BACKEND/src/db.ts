import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { logger } from './logger';

function candidateDbPaths(): string[] {
  if (process.env.MANAGER_DB_PATH) return [process.env.MANAGER_DB_PATH];

  const candidates = [path.join(process.cwd(), 'runtime')];

  const paths: string[] = [];
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      paths.push(path.join(candidate, 'control-center-v2.sqlite'));
    } catch (error) {
      logger.warn('database directory unavailable', { candidate, error: String(error) });
    }
  }

  return paths;
}

function openDatabase() {
  const candidates = candidateDbPaths();
  for (const candidate of candidates) {
    try {
      const database = new Database(candidate);
      try {
        database.pragma('journal_mode = TRUNCATE');
      } catch (error) {
        logger.warn('sqlite journal mode change unavailable for candidate', { candidate, error: String(error) });
      }
      database.pragma('synchronous = NORMAL');
      database.pragma('foreign_keys = ON');
      database.prepare('CREATE TABLE IF NOT EXISTS __db_smoke (id INTEGER PRIMARY KEY)').run();
      database.prepare('DROP TABLE IF EXISTS __db_smoke').run();
      return { database, path: candidate };
    } catch (error) {
      logger.warn('database candidate unavailable', { candidate, error: String(error) });
    }
  }
  throw new Error('No usable SQLite database path found');
}

const opened = openDatabase();
const DB_PATH = opened.path;
export const db = opened.database;

export function initDb() {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      git_branch TEXT,
      git_status TEXT,
      git_modified INTEGER NOT NULL DEFAULT 0,
      git_staged INTEGER NOT NULL DEFAULT 0,
      git_untracked INTEGER NOT NULL DEFAULT 0,
      last_git_check_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS agent_definitions (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      command TEXT NOT NULL,
      default_args TEXT NOT NULL DEFAULT '[]',
      env_json TEXT NOT NULL DEFAULT '{}',
      launcher_type TEXT NOT NULL DEFAULT 'direct',
      enabled INTEGER NOT NULL DEFAULT 1,
      supports_resume INTEGER NOT NULL DEFAULT 0,
      resume_strategy TEXT NOT NULL DEFAULT 'none',
      resume_command TEXT,
      resume_args TEXT NOT NULL DEFAULT '[]',
      session_id_arg TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      agent_definition_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      process_id INTEGER,
      parent_process_id INTEGER,
      agent_session_id TEXT,
      working_directory TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      stopped_at TEXT,
      last_activity_at TEXT,
      last_terminal_activity_at TEXT,
      exit_code INTEGER,
      resume_capability TEXT NOT NULL DEFAULT 'unsupported',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      cpu REAL NOT NULL DEFAULT 0,
      memory REAL NOT NULL DEFAULT 0,
      stuck_score REAL NOT NULL DEFAULT 0,
      stuck_confidence TEXT NOT NULL DEFAULT 'none',
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id),
      FOREIGN KEY(agent_definition_id) REFERENCES agent_definitions(id)
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS session_events (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      workspace_id TEXT,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS application_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  db.prepare('CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON agent_sessions(workspace_id)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_sessions_status ON agent_sessions(status)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id, created_at)').run();
  db.prepare("INSERT OR IGNORE INTO migrations (id, name) VALUES (1, 'initial_phase_1_schema')").run();

  logger.info('database initialized', { path: DB_PATH });
}

export function markInterruptedSessionsResumable() {
  db.prepare(`
    UPDATE agent_sessions
    SET status = CASE WHEN resume_capability = 'supported' THEN 'RESUMABLE' ELSE 'DISCONNECTED' END,
        process_id = NULL,
        stopped_at = COALESCE(stopped_at, CURRENT_TIMESTAMP)
    WHERE status IN ('CREATED', 'STARTING', 'RUNNING', 'IDLE', 'WAITING', 'STOPPING')
  `).run();
}
