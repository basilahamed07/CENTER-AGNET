import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentDefinition } from '../domain';
import { buildResumeArgs, buildSpawnSpec, isWindows, validateLauncher } from '../launcher';
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

test('direct command name resolves through cmd.exe on Windows', { skip: !isWindows() ? 'Windows-only behavior' : false }, () => {
  const spec = buildSpawnSpec(definition({}));
  assert.match(spec.file.toLowerCase(), /cmd\.exe$/);
  assert.equal(spec.args, '/d /s /k "node --version"');
  assert.equal(spec.env.LOCAL_ONLY, '1');
});

test('direct command name resolves on PATH and wraps in POSIX shell', { skip: isWindows() ? 'POSIX-only behavior' : false }, () => {
  const spec = buildSpawnSpec(definition({}));
  // node is guaranteed on PATH where tests run.
  assert.ok(path.isAbsolute(spec.file), `expected absolute shell path, got ${spec.file}`);
  assert.equal(spec.args[0], '-c');
  assert.ok(String(spec.args[1]).includes('--version'));
  assert.equal(spec.env.LOCAL_ONLY, '1');
});

test('direct command not on PATH is rejected on POSIX', { skip: isWindows() ? 'POSIX-only behavior' : false }, () => {
  assert.throws(() => buildSpawnSpec(definition({ command: 'definitely-missing-agent-cli-xyz' })), /not found on PATH/);
});

test('cmd.exe direct command launches the shell itself', { skip: !isWindows() ? 'Windows-only behavior' : false }, () => {
  const spec = buildSpawnSpec(definition({ command: 'cmd.exe', default_args: '[]' }));
  assert.match(spec.file.toLowerCase(), /cmd\.exe$/);
  assert.deepEqual(spec.args, ['/k']);
});

test('bat launcher is executed unchanged through cmd.exe', { skip: !isWindows() ? 'Windows-only behavior' : false }, () => {
  const file = path.join(os.tmpdir(), `agent-${Date.now()}.bat`);
  fs.writeFileSync(file, '@echo off\r\necho ok\r\n');
  const spec = buildSpawnSpec(definition({ command: file, launcher_type: 'bat', default_args: '["--flag"]' }));
  assert.match(spec.file.toLowerCase(), /cmd\.exe$/);
  assert.equal(spec.args, `/d /s /k "\\"${file}\\" --flag"`);
  fs.unlinkSync(file);
});

test('shell launcher runs .sh through the POSIX shell', { skip: isWindows() ? 'POSIX-only behavior' : false }, () => {
  const file = path.join(os.tmpdir(), `agent-${Date.now()}.sh`);
  fs.writeFileSync(file, '#!/bin/sh\necho ok\n');
  fs.chmodSync(file, 0o755);
  const spec = buildSpawnSpec(definition({ command: file, launcher_type: 'shell', default_args: '["--flag"]' }));
  assert.ok(path.isAbsolute(spec.file), `expected absolute shell path, got ${spec.file}`);
  assert.equal(spec.args[0], '-c');
  fs.unlinkSync(file);
});

test('shell launcher requires .sh extension', () => {
  const file = path.join(os.tmpdir(), `agent-${Date.now()}.txt`);
  fs.writeFileSync(file, 'echo ok\n');
  assert.throws(() => validateLauncher(definition({ command: file, launcher_type: 'shell' })), /extension must be \.sh/);
  fs.unlinkSync(file);
});

test('missing cmd launcher is rejected', () => {
  const missing = path.join(os.tmpdir(), `missing-${Date.now()}.cmd`);
  assert.throws(() => validateLauncher(definition({ command: missing, launcher_type: 'cmd' })), /does not exist/);
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

test('agent create validation supports cmd, bat and shell launchers', () => {
  const parsed = agentCreateSchema.parse({ displayName: 'Codex', command: 'codex.cmd', launcherType: 'cmd' });
  assert.equal(parsed.launcherType, 'cmd');
  assert.deepEqual(parsed.defaultArgs, []);
  const sh = agentCreateSchema.parse({ displayName: 'Helper', command: '/usr/local/bin/helper.sh', launcherType: 'shell' });
  assert.equal(sh.launcherType, 'shell');
});
