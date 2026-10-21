import { expect, test } from 'vitest';
import { MemoryJournal } from '../src/journal.ts';
import type { Entry } from '../src/model.ts';

const entry = (seq: number): Entry => ({
  seq,
  at: '2026-01-15T10:00:00.000Z',
  event: { type: 'adjust', amount: 1n, reason: 'test' },
});

test('reads entries from a seq, in seq order', async () => {
  const j = new MemoryJournal();
  await j.append([entry(1), entry(2)]);
  await j.append([entry(3)]);
  expect((await j.read(2)).map((e) => e.seq)).toEqual([2, 3]);
  expect((await j.read()).map((e) => e.seq)).toEqual([1, 2, 3]);
});

test('a failed append writes nothing', async () => {
  const j = new MemoryJournal();
  j.failNextAppend = true;
  await expect(j.append([entry(1)])).rejects.toThrow('commit failed');
  expect(j.entries).toEqual([]);
});
