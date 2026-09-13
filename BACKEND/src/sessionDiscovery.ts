import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { logger } from './logger';
import type { Workspace } from './domain';

/*
 * Universal external-session discovery.
 *
 * Every terminal coding agent persists its own sessions locally, each with a
 * different layout. This module scans those stores, normalizes them into
 * DiscoveredSession rows, and matches them to managed workspaces by working
 * directory so the UI can list and resume past agent conversations.
 *
 * Storage kinds (researched + verified on-disk):
 *  - claude:   ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl (JSONL, metadata in every line)
 *  - codex:    ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl (line 1 = session_meta with cwd)
 *              titles merged from ~/.codex/session_index.jsonl
 *  - kilo:     ~/.local/share/kilo/kilo.db (SQLite: session.directory, session.title)
 *  - pi:       ~/.pi/agent/sessions/<encoded-cwd>/ jsonl files
 *  - gemini:   ~/.gemini/tmp/<project-hash>/ (JSON logs; best-effort)
 *  - goose:    ~/.local/share/goose/sessions/ json files (GOOSE_DATA_DIR override respected)
 *  - opencode: ~/.local/share/opencode/storage/session/ json files (best-effort)
 *  - openclaw: ~/.openclaw/agents/<agent>/sessions/sessions.json (index) + JSONL transcripts (best-effort)
 *  - aider:    .aider.chat.history.md inside each workspace (in-repo, no session id)
 *
 * Agents without a documented/verifiable on-disk format (hermes, crush,
 * openhands, plandex, mentat, continue) report status 'unsupported' instead
 * of guessing — see COVERAGE NOTES at the bottom of this file.
 */

export interface DiscoveredSession {
  agent: string;
  agentSessionId: string | null;
  workspacePath: string | null;
  title: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  source: string;
  resumeSupported: boolean;
}

export type ScanStatus = 'ok' | 'not-found' | 'unsupported';

export interface AgentScanReport {
  agent: string;
  status: ScanStatus;
  sessions: number;
  basePaths: string[];
  note?: string;
}

export interface DiscoveryResult {
  sessions: DiscoveredSession[];
  coverage: AgentScanReport[];
}

export interface MatchedExternalSession extends DiscoveredSession {
  matchedWorkspaceId: string | null;
  matchKind: 'exact' | 'subdirectory' | 'none';
}

const TTL_MS = 30_000;
const MAX_FILES_PER_AGENT = 400;

const discoveryCache = new Map<string, { at: number; result: DiscoveryResult }>();

export function clearDiscoveryCache() {
  discoveryCache.clear();
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return resolved.length > 1 && resolved.endsWith(path.sep) ? resolved.slice(0, -1) : resolved;
}

/**
 * Claude Code (and Pi) encode the session cwd into a directory name by
 * replacing every non-alphanumeric character with '-'. Encoding the workspace
 * path the same way and comparing slugs is more reliable than trying to decode
 * the slug (e.g. "-home-basil-Documents-Projects--" is ambiguous in reverse).
 */
export function encodeCwdSlug(value: string): string {
  return value.replace(/[^a-zA-Z0-9-]/g, '-');
}

function safeMtimeIso(file: string): string | null {
  try {
    return epochMsToIso(fs.statSync(file).mtimeMs);
  } catch {
    return null;
  }
}

function listFiles(root: string, extension: string, limit = MAX_FILES_PER_AGENT): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0 && found.length < limit) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(extension)) found.push(full);
    }
  }
  // Most recent first so the cap keeps the newest sessions.
  return found
    .sort((a, b) => {
      try {
        return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    })
    .slice(0, limit);
}

function readFirstJsonLines(file: string, maxLines: number): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  try {
    const content = fs.readFileSync(file, 'utf8');
    for (const line of content.split('\n')) {
      if (lines.length >= maxLines) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') lines.push(parsed as Record<string, unknown>);
      } catch {
        // Skip malformed lines; JSONL writers tolerate partial lines mid-crash.
      }
    }
  } catch {
    // File vanished mid-scan or unreadable permissions — treat as empty.
  }
  return lines;
}

function firstString(record: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function truncateTitle(value: string | null): string | null {
  if (!value) return null;
  const flattened = value.replace(/\s+/g, ' ').trim();
  return flattened.length === 0 ? null : flattened.slice(0, 120);
}

function epochMsToIso(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 1_000_000_000_000) return new Date(value).toISOString();
  if (typeof value === 'number' && Number.isFinite(value) && value > 1_000_000_000) return new Date(value * 1000).toISOString();
  if (typeof value === 'string') {
    if (/^\d{10}$/.test(value)) return new Date(Number(value) * 1000).toISOString();
    if (/^\d{13}$/.test(value)) return new Date(Number(value)).toISOString();
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

interface AdapterContext {
  home: string;
  workspacePaths: string[];
}

interface AgentAdapter {
  agent: string;
  resumeSupported: boolean;
  /** Returns sessions plus the store base paths that actually existed. */
  scan(context: AdapterContext): { sessions: DiscoveredSession[]; basePaths: string[] };
}

const claudeAdapter: AgentAdapter = {
  agent: 'claude',
  resumeSupported: true,
  scan({ home }) {
    const base = path.join(home, '.claude', 'projects');
    const files = listFiles(base, '.jsonl');
    const sessions: DiscoveredSession[] = [];
    for (const file of files) {
      const head = readFirstJsonLines(file, 30);
      if (head.length === 0) continue;
      const sessionId = firstString(head[0], ['sessionId', 'session_id']) ?? path.basename(file, '.jsonl');
      const slug = path.basename(path.dirname(file));
      const workspacePath = slug ? decodeClaudeSlug(slug, home) : null;
      const firstUser = head.find((line) => line.type === 'user' && line.message != null) as
        | { message?: { content?: unknown } }
        | undefined;
      const title = truncateTitle(extractTextContent(firstUser?.message?.content));
      const timestamps = head.map((line) => epochMsToIso(line.timestamp)).filter((v): v is string => v !== null);
      const mtime = safeMtimeIso(file);
      sessions.push({
        agent: 'claude',
        agentSessionId: sessionId,
        workspacePath,
        title,
        startedAt: timestamps[0] ?? mtime,
        lastActivityAt: mtime,
        source: file,
        resumeSupported: true,
      });
    }
    return { sessions, basePaths: fs.existsSync(base) ? [base] : [] };
  },
};

/**
 * Claude slug decode is inherently lossy ('-' stands for '/', '.', ' ', ...).
 * Strategy: check well-known workspace roots for a directory whose encoded
 * slug matches; fall back to a naive '-'→'/' reconstruction.
 */
function decodeClaudeSlug(slug: string, home: string): string | null {
  const roots = [home, path.join(home, 'Documents'), path.join(home, 'projects'), path.join(home, 'Projects'), '/home', '/workspace', '/workspaces'];
  for (const root of roots) {
    const candidate = path.join(root, ...slug.split('-').filter(Boolean));
    if (fs.existsSync(candidate)) return normalizePath(candidate);
  }
  const naive = slug.split('-').filter(Boolean).join('/');
  return naive ? `/${naive}` : null;
}

function extractTextContent(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object' && 'text' in part && typeof (part as { text: unknown }).text === 'string') {
        return (part as { text: string }).text;
      }
    }
  }
  return null;
}

const codexAdapter: AgentAdapter = {
  agent: 'codex',
  resumeSupported: true,
  scan({ home }) {
    const base = path.join(home, '.codex', 'sessions');
    // session_index.jsonl is Codex's own ready-made index: id -> thread_name.
    // It lets us attach titles without parsing every rollout file.
    const indexFile = path.join(home, '.codex', 'session_index.jsonl');
    const titles = new Map<string, string>();
    if (fs.existsSync(indexFile)) {
      for (const line of readFirstJsonLines(indexFile, 2000)) {
        const id = firstString(line, ['id', 'session_id']);
        const name = firstString(line, ['thread_name', 'name', 'title']);
        if (id && name) titles.set(id, name);
      }
    }
    const sessions: DiscoveredSession[] = [];
    for (const file of listFiles(base, '.jsonl')) {
      const head = readFirstJsonLines(file, 3);
      const meta = head.find((line) => line.type === 'session_meta') as { payload?: Record<string, unknown> } | undefined;
      const payload = meta?.payload ?? head[0];
      if (!payload) continue;
      const sessionId = firstString(payload, ['session_id', 'id']) ?? path.basename(file, '.jsonl');
      sessions.push({
        agent: 'codex',
        agentSessionId: sessionId,
        workspacePath: firstString(payload, ['cwd']) ?? null,
        title: truncateTitle(titles.get(sessionId) ?? null),
        startedAt: epochMsToIso(payload.timestamp) ?? safeMtimeIso(file),
        lastActivityAt: safeMtimeIso(file),
        source: file,
        resumeSupported: true,
      });
    }
    return { sessions, basePaths: fs.existsSync(base) ? [base] : [] };
  },
};

const kiloAdapter: AgentAdapter = {
  agent: 'kilo',
  resumeSupported: false,
  scan({ home }) {
    const dbPath = path.join(home, '.local', 'share', 'kilo', 'kilo.db');
    const basePaths = fs.existsSync(dbPath) ? [dbPath] : [];
    if (basePaths.length === 0) return { sessions: [], basePaths };
    const sessions: DiscoveredSession[] = [];
    try {
      // Read-only URI open: Kilo owns this DB and keeps a WAL; never write.
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const rows = db
          .prepare(
            `SELECT id, directory, title, time_created, time_updated
             FROM session
             WHERE time_archived IS NULL
             ORDER BY time_updated DESC
             LIMIT ?`,
          )
          .all(MAX_FILES_PER_AGENT) as Array<{
          id: string;
          directory: string | null;
          title: string | null;
          time_created: number | null;
          time_updated: number | null;
        }>;
        for (const row of rows) {
          sessions.push({
            agent: 'kilo',
            agentSessionId: row.id,
            workspacePath: row.directory ? normalizePath(row.directory) : null,
            title: truncateTitle(row.title),
            startedAt: epochMsToIso(row.time_created),
            lastActivityAt: epochMsToIso(row.time_updated),
            source: dbPath,
            resumeSupported: false,
          });
        }
      } finally {
        db.close();
      }
    } catch (error) {
      logger.warn('kilo session store scan failed', { dbPath, error: String(error) });
    }
    return { sessions, basePaths };
  },
};

const piAdapter: AgentAdapter = {
  agent: 'pi',
  resumeSupported: true,
  scan({ home }) {
    const base = path.join(home, '.pi', 'agent', 'sessions');
    const files = listFiles(base, '.jsonl');
    const sessions: DiscoveredSession[] = [];
    for (const file of files) {
      const head = readFirstJsonLines(file, 5);
      if (head.length === 0) continue;
      const header = head[0];
      const sessionId =
        firstString(header, ['id', 'sessionId', 'session_id']) ??
        path.basename(file, path.extname(file));
      const cwd =
        firstString(header, ['cwd', 'cwdPath', 'workingDirectory', 'working_directory']) ??
        decodeClaudeSlug(path.basename(path.dirname(file)), home);
      const timestamps = head.map((line) => epochMsToIso(line.timestamp)).filter((v): v is string => v !== null);
      const mtime = safeMtimeIso(file);
      sessions.push({
        agent: 'pi',
        agentSessionId: sessionId,
        workspacePath: cwd ? normalizePath(cwd) : null,
        title: null,
        startedAt: timestamps[0] ?? mtime,
        lastActivityAt: mtime,
        source: file,
        resumeSupported: true,
      });
    }
    return { sessions, basePaths: fs.existsSync(base) ? [base] : [] };
  },
};

const geminiAdapter: AgentAdapter = {
  agent: 'gemini',
  resumeSupported: false,
  scan({ home }) {
    // Gemini CLI: ~/.gemini/tmp/<project-hash>/ holds session logs; the hash
    // is not reversible, so sessions are listed without a workspace match
    // until Gemini exposes cwd in the file contents.
    const base = path.join(home, '.gemini', 'tmp');
    const files = [...listFiles(base, '.json'), ...listFiles(base, '.jsonl')];
    const sessions: DiscoveredSession[] = [];
    for (const file of files) {
      const head = readFirstJsonLines(file, 2);
      const record = head[0];
      if (!record) continue;
      const sessionId = firstString(record, ['sessionId', 'session_id', 'id']);
      if (!sessionId) continue;
      const mtime = safeMtimeIso(file);
      sessions.push({
        agent: 'gemini',
        agentSessionId: sessionId,
        workspacePath: null,
        title: truncateTitle(firstString(record, ['title', 'name'])),
        startedAt: epochMsToIso(record.timestamp) ?? mtime,
        lastActivityAt: mtime,
        source: file,
        resumeSupported: false,
      });
    }
    return { sessions, basePaths: fs.existsSync(base) ? [base] : [] };
  },
};

const gooseAdapter: AgentAdapter = {
  agent: 'goose',
  resumeSupported: false,
  scan({ home }) {
    const base =
      process.env.GOOSE_DATA_DIR ??
      process.env.GOOSE_DATA_HOME ??
      path.join(home, '.local', 'share', 'goose', 'sessions');
    const files = listFiles(base, '.json');
    const sessions: DiscoveredSession[] = [];
    for (const file of files) {
      const head = readFirstJsonLines(file, 1);
      const record = head[0];
      if (!record) continue;
      const sessionId = firstString(record, ['id', 'session_id', 'sessionId']) ?? path.basename(file, '.json');
      const cwd = firstString(record, ['cwd', 'working_dir', 'working_directory', 'directory']);
      const mtime = safeMtimeIso(file);
      sessions.push({
        agent: 'goose',
        agentSessionId: sessionId,
        workspacePath: cwd ? normalizePath(cwd) : null,
        title: truncateTitle(firstString(record, ['title', 'name', 'description'])),
        startedAt: epochMsToIso(record.created_at ?? record.timestamp) ?? mtime,
        lastActivityAt: epochMsToIso(record.updated_at) ?? mtime,
        source: file,
        resumeSupported: false,
      });
    }
    return { sessions, basePaths: fs.existsSync(base) ? [base] : [] };
  },
};

const opencodeAdapter: AgentAdapter = {
  agent: 'opencode',
  resumeSupported: false,
  scan({ home }) {
    const candidates = [
      path.join(home, '.local', 'share', 'opencode', 'storage', 'session'),
      path.join(home, '.config', 'opencode', 'storage', 'session'),
    ];
    const sessions: DiscoveredSession[] = [];
    const basePaths: string[] = [];
    for (const base of candidates) {
      if (!fs.existsSync(base)) continue;
      basePaths.push(base);
      for (const file of listFiles(base, '.json')) {
        const record = readFirstJsonLines(file, 1)[0];
        if (!record) continue;
        const sessionId = firstString(record, ['id', 'session_id']) ?? path.basename(file, '.json');
        const cwd = firstString(record, ['directory', 'cwd', 'worktree', 'path']);
        const time = record.time as Record<string, unknown> | undefined;
        const mtime = safeMtimeIso(file);
        sessions.push({
          agent: 'opencode',
          agentSessionId: sessionId,
          workspacePath: cwd ? normalizePath(cwd) : null,
          title: truncateTitle(firstString(record, ['title', 'name'])),
          startedAt: epochMsToIso(time?.created) ?? mtime,
          lastActivityAt: epochMsToIso(time?.updated) ?? mtime,
          source: file,
          resumeSupported: false,
        });
      }
    }
    return { sessions, basePaths };
  },
};

const openclawAdapter: AgentAdapter = {
  agent: 'openclaw',
  resumeSupported: true,
  scan({ home }) {
    const base = path.join(home, '.openclaw', 'agents');
    const indexFiles: string[] = [];
    if (fs.existsSync(base)) {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(base, entry.name, 'sessions', 'sessions.json');
        if (fs.existsSync(candidate)) indexFiles.push(candidate);
      }
    }
    const sessions: DiscoveredSession[] = [];
    for (const indexFile of indexFiles) {
      const raw = fs.readFileSync(indexFile, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      const entries = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? Object.values(parsed) : [];
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        const sessionId = firstString(record, ['id', 'sessionId', 'session_id']);
        if (!sessionId) continue;
        const cwd = firstString(record, ['cwd', 'directory', 'workingDirectory', 'path']);
        const mtime = epochMsToIso(record.updatedAt ?? record.updated_at);
        sessions.push({
          agent: 'openclaw',
          agentSessionId: sessionId,
          workspacePath: cwd ? normalizePath(cwd) : null,
          title: truncateTitle(firstString(record, ['title', 'name', 'label'])),
          startedAt: epochMsToIso(record.createdAt ?? record.created_at),
          lastActivityAt: mtime,
          source: indexFile,
          resumeSupported: true,
        });
      }
    }
    return { sessions, basePaths: indexFiles.length > 0 ? [path.join(home, '.openclaw')] : [] };
  },
};

const aiderAdapter: AgentAdapter = {
  agent: 'aider',
  resumeSupported: true,
  scan({ workspacePaths }) {
    // Aider keeps history inside the repo it runs in; there is no central
    // store. Check each known workspace for its history files.
    const sessions: DiscoveredSession[] = [];
    const basePaths: string[] = [];
    for (const workspace of workspacePaths) {
      const history = path.join(workspace, '.aider.chat.history.md');
      if (!fs.existsSync(history)) continue;
      basePaths.push(history);
      const mtime = safeMtimeIso(history);
      sessions.push({
        agent: 'aider',
        agentSessionId: null,
        workspacePath: normalizePath(workspace),
        title: 'Aider chat history',
        startedAt: null,
        lastActivityAt: mtime,
        source: history,
        resumeSupported: true,
      });
    }
    return { sessions, basePaths };
  },
};

const ADAPTERS: AgentAdapter[] = [
  claudeAdapter,
  codexAdapter,
  kiloAdapter,
  piAdapter,
  geminiAdapter,
  gooseAdapter,
  opencodeAdapter,
  openclawAdapter,
  aiderAdapter,
];

/**
 * Agents researched but not implemented: no stable documented on-disk format
 * was verifiable. They are reported as 'unsupported' so the UI can show
 * honest coverage instead of silently missing sessions.
 *   hermes  (~/.hermes/<profile>/home — python state modules, format private)
 *   crush   (~/.local/share/crush — not installed here to verify layout)
 *   openhands / plandex / mentat / continue (cn) — undocumented formats
 */
const UNSUPPORTED_AGENTS: Array<{ agent: string; note: string }> = [
  { agent: 'hermes', note: 'state format is private to ~/.hermes profile store' },
  { agent: 'crush', note: 'store layout at ~/.local/share/crush not yet verified' },
  { agent: 'openhands', note: 'no documented session store location' },
  { agent: 'plandex', note: 'plans stored server-side per project; no local scan' },
  { agent: 'mentat', note: 'keeps no resumable session store' },
  { agent: 'continue', note: 'cn --resume exists but store location undocumented' },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function scanExternalSessions(options: { homeDir?: string; workspacePaths?: string[]; force?: boolean } = {}): DiscoveryResult {
  const home = options.homeDir ?? os.homedir();
  const workspacePaths = (options.workspacePaths ?? []).map(normalizePath);
  const cacheKey = JSON.stringify({ home, workspacePaths });

  const cached = discoveryCache.get(cacheKey);
  if (!options.force && cached && Date.now() - cached.at < TTL_MS) return cached.result;

  const sessions: DiscoveredSession[] = [];
  const coverage: AgentScanReport[] = [];

  for (const adapter of ADAPTERS) {
    try {
      const { sessions: found, basePaths } = adapter.scan({ home, workspacePaths });
      sessions.push(...found);
      coverage.push({
        agent: adapter.agent,
        status: basePaths.length === 0 ? 'not-found' : 'ok',
        sessions: found.length,
        basePaths,
      });
    } catch (error) {
      logger.warn('agent session scan failed', { agent: adapter.agent, error: String(error) });
      coverage.push({ agent: adapter.agent, status: 'not-found', sessions: 0, basePaths: [], note: String(error) });
    }
  }

  for (const unsupported of UNSUPPORTED_AGENTS) {
    coverage.push({ agent: unsupported.agent, status: 'unsupported', sessions: 0, basePaths: [], note: unsupported.note });
  }

  const result: DiscoveryResult = { sessions, coverage };
  discoveryCache.set(cacheKey, { at: Date.now(), result });
  return result;
}

export function matchSessionsToWorkspaces(sessions: DiscoveredSession[], workspaces: Workspace[]): MatchedExternalSession[] {
  const byPath = new Map<string, Workspace>();
  for (const workspace of workspaces) byPath.set(normalizePath(workspace.path), workspace);
  // Also index encoded slugs so Claude's lossy folder names can be matched.
  const bySlug = new Map<string, Workspace>();
  for (const workspace of workspaces) bySlug.set(encodeCwdSlug(workspace.path), workspace);

  return sessions.map((session) => {
    if (!session.workspacePath) {
      return { ...session, matchedWorkspaceId: null, matchKind: 'none' as const };
    }
    const normalized = normalizePath(session.workspacePath);
    const exact = byPath.get(normalized) ?? bySlug.get(encodeCwdSlug(normalized));
    if (exact) return { ...session, matchedWorkspaceId: exact.id, matchKind: 'exact' as const };

    // Subdirectory match: session ran inside the workspace tree.
    for (const workspace of workspaces) {
      const root = normalizePath(workspace.path);
      if (normalized.startsWith(root + path.sep)) {
        return { ...session, matchedWorkspaceId: workspace.id, matchKind: 'subdirectory' as const };
      }
    }
    return { ...session, matchedWorkspaceId: null, matchKind: 'none' as const };
  });
}

export function listExternalSessionsForWorkspace(
  workspaceId: string,
  workspaces: Workspace[],
  options: { homeDir?: string; force?: boolean } = {},
): { sessions: MatchedExternalSession[]; coverage: AgentScanReport[] } {
  const discovery = scanExternalSessions({
    homeDir: options.homeDir,
    force: options.force,
    workspacePaths: workspaces.map((workspace) => workspace.path),
  });
  const matched = matchSessionsToWorkspaces(discovery.sessions, workspaces);
  const sessions = matched
    .filter((session) => session.matchedWorkspaceId === workspaceId)
    .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  return { sessions, coverage: discovery.coverage };
}
