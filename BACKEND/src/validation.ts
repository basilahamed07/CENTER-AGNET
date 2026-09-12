import { z } from 'zod';

export const workspaceCreateSchema = z.object({
  name: z.string().min(1).max(120),
  path: z.string().min(1).max(1000),
});

export const agentCreateSchema = z.object({
  displayName: z.string().min(1).max(120),
  command: z.string().min(1).max(1000),
  launcherType: z.enum(['direct', 'cmd', 'bat']),
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
