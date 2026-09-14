import { z } from 'zod';

export const workspaceCreateSchema = z.object({
  name: z.string().min(1).max(120),
  path: z.string().min(1).max(1000),
});

export const agentCreateSchema = z.object({
  displayName: z.string().min(1).max(120),
  command: z.string().min(1).max(1000),
  launcherType: z.enum(['direct', 'cmd', 'bat', 'shell']),
  defaultArgs: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  supportsResume: z.boolean().default(false),
  resumeStrategy: z.enum(['none', 'appendArgs', 'command']).default('none'),
  resumeCommand: z.string().optional(),
  resumeArgs: z.array(z.string()).default([]),
  sessionIdArg: z.string().optional(),
});

export const launchSessionSchema = z.object({
  workspaceId: z.string().min(1),
  agentDefinitionId: z.string().min(1),
  /** Optional git worktree: the session runs inside it (spec §18). */
  worktreeId: z.string().min(1).optional(),
});

export const worktreeCreateSchema = z.object({
  taskName: z.string().min(1).max(80),
  agentDefinitionId: z.string().min(1).optional(),
});

export const worktreeRemoveSchema = z.object({
  forceRemove: z.boolean().default(false),
});

export const assignmentSchema = launchSessionSchema;

export const externalResumeSchema = z.object({
  /** Scanner agent key, e.g. 'claude' | 'codex' | 'pi'. Maps to def-<key>. */
  agentKey: z.string().min(1).max(40),
  /** Session id inside the agent's own store (UUID, ses_..., etc). */
  agentSessionId: z.string().min(1).max(200),
  /** Managed workspace to launch the resumed agent in. */
  workspaceId: z.string().min(1),
});

export const resizeSchema = z.object({
  sessionId: z.string().min(1),
  cols: z.number().int().min(20).max(300),
  rows: z.number().int().min(5).max(120),
});

export const inputSchema = z.object({
  sessionId: z.string().min(1),
  data: z.string(),
});
