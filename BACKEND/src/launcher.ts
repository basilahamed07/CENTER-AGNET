import fs from 'fs';
import path from 'path';
import type { AgentDefinition } from './domain';
import { AppError } from './errors';

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

function assertPathExists(command: string, label: string) {
  if (!fs.existsSync(command)) {
    throw new AppError(400, `${label} does not exist: ${command}`, 'LAUNCHER_MISSING');
  }
}

export function validateLauncher(definition: AgentDefinition) {
  if (!['direct', 'cmd', 'bat'].includes(definition.launcher_type)) {
    throw new AppError(400, `Unsupported launcher type: ${definition.launcher_type}`, 'INVALID_LAUNCHER_TYPE');
  }

  if (definition.launcher_type === 'cmd' || definition.launcher_type === 'bat') {
    assertPathExists(definition.command, `${definition.launcher_type.toUpperCase()} launcher`);
    const extension = path.extname(definition.command).toLowerCase();
    if (extension !== `.${definition.launcher_type}`) {
      throw new AppError(400, `Launcher extension must be .${definition.launcher_type}`, 'INVALID_LAUNCHER_EXTENSION');
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

function cmdKeepOpen(commandLine: string) {
  return `/d /s /k "${commandLine}"`;
}

export function buildSpawnSpec(definition: AgentDefinition, resumeArgs: string[] = []): SpawnSpec {
  validateLauncher(definition);
  const configuredArgs = parseJsonArray(definition.default_args);
  const args = [...configuredArgs, ...resumeArgs];
  const env = parseEnv(definition.env_json);

  if (definition.launcher_type === 'bat' || definition.launcher_type === 'cmd') {
    return {
      file: comspec(),
      args: cmdKeepOpen(buildCommandLine(definition.command, args, true)),
      env,
    };
  }

  if (isCmdShell(definition.command)) {
    return {
      file: comspec(),
      args: args.length > 0 ? args : ['/k'],
      env,
    };
  }

  if (!looksLikePath(definition.command)) {
    return {
      file: comspec(),
      args: cmdKeepOpen(buildCommandLine(definition.command, args)),
      env,
    };
  }

  return {
    file: definition.command,
    args,
    env,
  };
}

export function buildResumeArgs(definition: AgentDefinition, agentSessionId: string | null): string[] {
  if (!definition.supports_resume || definition.resume_strategy === 'none') {
    throw new AppError(400, 'Resume unavailable for this agent', 'RESUME_UNSUPPORTED');
  }

  const configured = parseJsonArray(definition.resume_args);
  if (!agentSessionId || !definition.session_id_arg) return configured;
  return [...configured, definition.session_id_arg, agentSessionId];
}
