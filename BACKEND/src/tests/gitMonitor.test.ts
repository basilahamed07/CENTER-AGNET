import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePorcelain } from '../gitMonitor';

test('porcelain parsing counts staged, modified and untracked entries', () => {
  const output = [
    '?? newfile.txt',
    'M  staged-only.ts',
    'MM staged-and-modified.ts',
    ' M worktree-modified.ts',
    'D  staged-deletion.ts',
    '',
  ].join('\n');

  const parsed = parsePorcelain(output);
  assert.equal(parsed.untracked, 1);
  // M  and MM and D  have a non-space first column.
  assert.equal(parsed.staged, 3);
  // MM and ' M' have a non-space second column.
  assert.equal(parsed.modified, 2);
});

test('porcelain parsing handles empty and CRLF output', () => {
  assert.deepEqual(parsePorcelain(''), { staged: 0, modified: 0, untracked: 0 });
  const crlf = '?? a.txt\r\n M b.txt\r\n';
  const parsed = parsePorcelain(crlf);
  assert.equal(parsed.untracked, 1);
  assert.equal(parsed.modified, 1);
  assert.equal(parsed.staged, 0);
});

test('porcelain parsing counts renames and copied entries as staged', () => {
  const parsed = parsePorcelain('R  old.ts -> new.ts\nC  copied.ts -> copy2.ts\n');
  assert.equal(parsed.staged, 2);
});
