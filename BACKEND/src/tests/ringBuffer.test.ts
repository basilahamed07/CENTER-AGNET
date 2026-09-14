import assert from 'node:assert/strict';
import test from 'node:test';
import { OutputRingBuffer } from '../ringBuffer';

test('ring buffer keeps recent bytes under the cap', () => {
  const buffer = new OutputRingBuffer(100);
  buffer.push('a'.repeat(60));
  buffer.push('b'.repeat(60));
  // Second push must have evicted the first chunk to stay bounded.
  assert.ok(buffer.byteLength <= 100, `expected <= 100 bytes, got ${buffer.byteLength}`);
  const drained = buffer.drain();
  assert.ok(drained.startsWith('b'), 'oldest chunk should be evicted first');
  assert.ok(!drained.includes('a'));
});

test('ring buffer handles one chunk larger than the cap', () => {
  const buffer = new OutputRingBuffer(50);
  buffer.push('x'.repeat(500));
  assert.ok(buffer.byteLength <= 50 + 10, `expected bounded, got ${buffer.byteLength}`);
});

test('ring buffer ignores empty chunks and clears', () => {
  const buffer = new OutputRingBuffer(10);
  buffer.push('');
  assert.equal(buffer.byteLength, 0);
  buffer.push('12345');
  buffer.clear();
  assert.equal(buffer.drain(), '');
  assert.equal(buffer.byteLength, 0);
});

test('ring buffer rejects non-positive caps', () => {
  assert.throws(() => new OutputRingBuffer(0), /must be positive/);
  assert.throws(() => new OutputRingBuffer(-5), /must be positive/);
});
