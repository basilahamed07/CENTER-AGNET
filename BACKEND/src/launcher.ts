import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AgentDefinition } from './domain';
import { AppError } from './errors';
import { logger } from './logger';

export const LAUNCHER_TYPES = ['direct', 'cmd', 'bat', 'shell'] as const;

export function isWindows(): boolean {
  return process.platform === 'win32';
}

export function isPosix(): boolean {
  return !isWindows();
}

export interface SpawnSpec {
  file: string;
  args: string[] | string;
  env: Record<string, string>;
}

function comspec() {
  return process.env.ComSpec || process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe';
}

function looksLikePath(command: string) {
  return command.includes('\\') || command.includes('/') || path.isAbsolute(command);
}

function isCmdShell(command: string) {
  const normalized = command.toLowerCase().replaceAll('/', '\\');
  return normalized === 'cmd' || normalized === 'cmd.exe' || normalized.endsWith('\\cmd.exe');
}

function isPosixShell(command: string) {
  const normalized = command.toLowerCase().replaceAll('\\', '/');
  return (
    normalized === 'bash' ||
    normalized === 'sh' ||
    normalized === 'zsh' ||
    normalized === 'fish' ||
    normalized === 'dash' ||
    normalized === 'ksh' ||
    normalized.endsWith('/bash') ||
    normalized.endsWith('/sh') ||
    normalized.endsWith('/zsh') ||
    normalized.endsWith('/fish') ||
    normalized.endsWith('/dash') ||
    normalized.endsWith('/ksh')
  );
}

function assertPathExists(command: string, label: string) {
  if (!fs.existsSync(command)) {
    throw new AppError(400, `${label} does not exist: ${command}`, 'LAUNCHER_MISSING');
  }
}

/**
 * Resolve a bare command name (no path separators) to an executable on the
 * system PATH. On Windows cmd.exe resolves PATH itself, so this only matters
 * on POSIX where direct execution needs an absolute file.
 */
function resolveOnPath(command: string): string | null {
  if (looksLikePath(command)) return null;
  const pathEnv = process.env.PATH ?? '';
  const extensions = isWindows() ? ['.exe', '.cmd', '.bat', ''] : [''];
  const directories = pathEnv.split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Keep searching.
      }
    }
  }
  return null;
}

/** Best-effort PATH lookup used for validation warnings and UI checks. */
export function commandExistsOnPath(command: string): boolean {
  if (looksLikePath(command)) return fs.existsSync(command);
  return resolveOnPath(command) !== null;
}

export function validateLauncher(definition: AgentDefinition) {
  if (!LAUNCHER_TYPES.includes(definition.launcher_type as (typeof LAUNCHER_TYPES)[number])) {
    throw new AppError(400, `Unsupported launcher type: ${definition.launcher_type}`, 'INVALID_LAUNCHER_TYPE');
  }

  if (definition.launcher_type === 'cmd' || definition.launcher_type === 'bat') {
    assertPathExists(definition.command, `${definition.launcher_type.toUpperCase()} launcher`);
    const extension = path.extname(definition.command).toLowerCase();
    if (extension !== `.${definition.launcher_type}`) {
      throw new AppError(400, `Launcher extension must be .${definition.launcher_type}`, 'INVALID_LAUNCHER_EXTENSION');
    }
  }

  if (definition.launcher_type === 'shell') {
    assertPathExists(definition.command, 'Shell script');
    const extension = path.extname(definition.command).toLowerCase();
    if (extension !== '.sh') {
      throw new AppError(400, 'Shell launcher extension must be .sh', 'INVALID_LAUNCHER_EXTENSION');
    }
  }

  if (definition.launcher_type === 'direct' && looksLikePath(definition.command)) {
    assertPathExists(definition.command, 'Executable path');
  }
}

function parseJsonArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value || '[]');
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function parseEnv(value: string): Record<string, string> {
  const parsed: unknown = JSON.parse(value || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item)]));
}

function quoteCmdArg(value: string) {
  if (!/[\s"&|<>^]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function buildCommandLine(command: string, args: string[], forceQuoteCommand = false) {
  const commandPart = forceQuoteCommand ? `"${command.replace(/"/g, '""')}"` : quoteCmdArg(command);
  return [commandPart, ...args.map(quoteCmdArg)].join(' ');
}

function quotePosixArg(value: string) {
  if (value !== '' && !/[^A-Za-z0-9_@%+=:,./-]/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildPosixCommandLine(command: string, args: string[]) {
  return [quotePosixArg(command), ...args.map(quotePosixArg)].join(' ');
}

function cmdKeepOpen(commandLine: string) {
  return `/d /s /k "${commandLine}"`;
}

/**
 * Pick the default interactive shell used to keep a bare command alive inside
 * the PTY on POSIX. Prefers $SHELL, falls back to bash then sh.
 */
function defaultPosixShell(): string {
  return process.env.SHELL || '/bin/bash';
}

export function buildSpawnSpec(definition: AgentDefinition, resumeArgs: string[] = []): SpawnSpec {
  validateLauncher(definition);
  const configuredArgs = parseJsonArray(definition.default_args);
  const args = [...configuredArgs, ...resumeArgs];
  const env = parseEnv(definition.env_json);

  // Windows launchers: .cmd / .bat always go through cmd.exe; on POSIX we
  // execute them via bash for compatibility (they are usually trivial scripts).
  if (definition.launcher_type === 'bat' || definition.launcher_type === 'cmd') {
    if (isWindows()) {
      return {
        file: comspec(),
        args: cmdKeepOpen(buildCommandLine(definition.command, args, true)),
        env,
      };
    }
    return {
      file: defaultPosixShell(),
      args: ['-c', `${buildPosixCommandLine(definition.command, args)}; exec ${quotePosixArg(defaultPosixShell())}`],
      env,
    };
  }

  // Explicit POSIX .sh launcher.
  if (definition.launcher_type === 'shell') {
    if (isWindows()) {
      // Windows has no native bash; try WSL bash, else run via cmd.exe keep-open.
      const wslBash = resolveOnPath('bash');
      if (wslBash) {
        return { file: wslBash, args, env };
      }
      return {
        file: comspec(),
        args: cmdKeepOpen(buildCommandLine(definition.command, args, true)),
        env,
      };
    }
    return { file: defaultPosixShell(), args: ['-c', `${buildPosixCommandLine(definition.command, args)}; exec ${quotePosixArg(defaultPosixShell())}`], env };
  }

  if (isCmdShell(definition.command)) {
    return {
      file: comspec(),
      args: args.length > 0 ? args : ['/k'],
      env,
    };
  }

  if (isPosixShell(definition.command)) {
    return {
      file: resolveOnPath(definition.command) ?? defaultPosixShell(),
      args: args.length > 0 ? args : [],
      env,
    };
  }

  if (!looksLikePath(definition.command)) {
    if (isWindows()) {
      // cmd.exe resolves PATH itself (including .cmd/.bat shims).
      return {
        file: comspec(),
        args: cmdKeepOpen(buildCommandLine(definition.command, args)),
        env,
      };
    }
    // POSIX: bare command names need absolute resolution before direct exec.
    const resolved = resolveOnPath(definition.command);
    if (!resolved) {
      throw new AppError(400, `Command not found on PATH: ${definition.command}`, 'LAUNCHER_MISSING');
    }
    return {
      file: defaultPosixShell(),
      args: ['-c', `${buildPosixCommandLine(resolved, args)}; exec ${quotePosixArg(defaultPosixShell())}`],
      env,
    };
  }

  return {
    file: definition.command,
    args,
    env,
  };
}

/**
 * Session resume: append configured resume args (plus optional session-id
 * argument) to the launch args.
 */
export function buildResumeArgs(definition: AgentDefinition, agentSessionId: string | null): string[] {
  if (!definition.supports_resume || definition.resume_strategy === 'none') {
    throw new AppError(400, 'Resume unavailable for this agent', 'RESUME_UNSUPPORTED');
  }

  const configured = parseJsonArray(definition.resume_args);
  if (!agentSessionId || !definition.session_id_arg) return configured;
  return [...configured, definition.session_id_arg, agentSessionId];
}

export function logPlatformInfo() {
  logger.info('launcher platform', { platform: process.platform, windows: isWindows(), posix: isPosix(), tmp: os.tmpdir() });
}
