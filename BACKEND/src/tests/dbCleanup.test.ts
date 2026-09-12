import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupProbeDbs } from '../utils/dbCleanup';

test('cleanupProbeDbs removes probe sqlite files and journals only', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-cleanup-'));
  const live = path.join(directory, 'control-center-v2.sqlite');
  const probe = path.join(directory, 'probe.sqlite');
  const probeJournal = path.join(directory, 'probe.sqlite-journal');
  const probeNamed = path.join(directory, 'probe-memory.sqlite');
  const other = path.join(directory, 'notes.txt');
  fs.writeFileSync(live, 'live');
  fs.writeFileSync(probe, 'probe');
  fs.writeFileSync(probeJournal, 'journal');
  fs.writeFileSync(probeNamed, 'probe-memory');
  fs.writeFileSync(other, 'keep');

  const previous = process.env.MANAGER_DB_PATH;
  process.env.MANAGER_DB_PATH = path.join(directory, 'control-center-v2.sqlite');
  try {
    const removed = cleanupProbeDbs();
    assert.ok(removed.includes('probe.sqlite'));
    assert.ok(removed.includes('probe.sqlite-journal'));
    assert.ok(removed.includes('probe-memory.sqlite'));
    assert.equal(fs.existsSync(probe), false);
    assert.equal(fs.existsSync(probeJournal), false);
    assert.equal(fs.existsSync(probeNamed), false);
    assert.equal(fs.existsSync(live), true);
    assert.equal(fs.existsSync(other), true);
  } finally {
    if (previous === undefined) delete process.env.MANAGER_DB_PATH;
    else process.env.MANAGER_DB_PATH = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});