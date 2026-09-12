import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentDefinition } from '../domain';
import { buildResumeArgs, buildSpawnSpec, validateLauncher } from '../launcher';
import { agentCreateSchema } from '../validation';

function definition(overrides: Partial<AgentDefinition>): AgentDefinition {
  return {
    id: 'agent-1',
    display_name: 'Test Agent',
    command: 'node',
    default_args: '["--version"]',
    env_json: '{"LOCAL_ONLY":"1"}',
    launcher_type: 'direct',
    enabled: 1,
    supports_resume: 0,
    resume_strategy: 'none',
    resume_command: null,
    resume_args: '[]',
    session_id_arg: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

test('direct command name resolves through cmd.exe on Windows', () => {
  const spec = buildSpawnSpec(definition({}));
  assert.match(spec.file.toLowerCase(), /cmd\.exe$/);
  assert.equal(spec.args, '/d /s /k "node --version"');
  assert.equal(spec.env.LOCAL_ONLY, '1');
});

test('cmd.exe direct command launches the shell itself', () => {
  const spec = buildSpawnSpec(definition({ command: 'cmd.exe', default_args: '[]' }));
  assert.match(spec.file.toLowerCase(), /cmd\.exe$/);
  assert.deepEqual(spec.args, ['/k']);
});

test('bat launcher is executed unchanged through cmd.exe', () => {
  const file = path.join(os.tmpdir(), `agent-${Date.now()}.bat`);
  fs.writeFileSync(file, '@echo off\r\necho ok\r\n');
  const spec = buildSpawnSpec(definition({ command: file, launcher_type: 'bat', default_args: '["--flag"]' }));
  assert.match(spec.file.toLowerCase(), /cmd\.exe$/);
  assert.equal(spec.args, `/d /s /k "\"${file}\" --flag"`);
  fs.unlinkSync(file);
});

test('missing cmd launcher is rejected', () => {
  assert.throws(() => validateLauncher(definition({ command: 'C:\\missing\\agent.cmd', launcher_type: 'cmd' })), /does not exist/);
});

test('resume args append generic session id argument', () => {
  const args = buildResumeArgs(definition({
    supports_resume: 1,
    resume_strategy: 'appendArgs',
    resume_args: '["resume"]',
    session_id_arg: '--session',
  }), 'abc123');
  assert.deepEqual(args, ['resume', '--session', 'abc123']);
});

test('agent create validation supports cmd and bat launchers', () => {
  const parsed = agentCreateSchema.parse({ displayName: 'Codex', command: 'codex.cmd', launcherType: 'cmd' });
  assert.equal(parsed.launcherType, 'cmd');
  assert.deepEqual(parsed.defaultArgs, []);
});
