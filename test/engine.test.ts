import { expect, test } from 'vitest';
import { Engine } from '../src/engine.ts';
import { MemoryJournal } from '../src/journal.ts';
import type { Account } from '../src/model.ts';
import { close, open, PROGRAM, usd } from './helpers.ts';

const at = (iso: string) => new Date(iso);

test('submits commands and journals them in seq order', async () => {
  const journal = new MemoryJournal();
  const engine = Engine.create(PROGRAM, journal, at('2026-01-12T08:00:00Z'));
  expect(await engine.submit(open('buy', '0.5', '60000'), at('2026-01-12T09:00:00Z'))).toEqual({ ok: true, positionId: 'p1' });
  expect(await engine.submit(close('p1', '61000'), at('2026-01-12T10:00:00Z'))).toEqual({ ok: true });
  await engine.drain();
  expect(journal.entries.map((e) => e.seq)).toEqual([1, 2]);
  expect(engine.account.balance).toBe(usd('100487.90'));
});

test('a restart from a snapshot gives the same account', async () => {
  const journal = new MemoryJournal();
  const engine = Engine.create(PROGRAM, journal, at('2026-01-12T08:00:00Z'));
  await engine.submit(open('buy', '1', '60000'), at('2026-01-12T09:00:00Z'));
  await engine.submit(open('sell', '2', '60100'), at('2026-01-12T09:01:00Z'));
  const snap = await engine.snapshot();
  await engine.submit(close('p1', '60500'), at('2026-01-12T09:30:00Z'));
  await engine.drain();

  const restored = await Engine.restore(journal, snap);
  expect(restored.account.balance).toBe(engine.account.balance);
  expect(restored.account.positions.map((p) => p.id)).toEqual(engine.account.positions.map((p) => p.id));
});

test('a snapshot waits for pending writes', async () => {
  const journal = new MemoryJournal();
  journal.latencyMs = () => 20;
  const engine = Engine.create(PROGRAM, journal, at('2026-01-12T08:00:00Z'));
  await engine.submit(open('buy', '1', '100'), at('2026-01-12T09:00:00Z'));
  const snap = await engine.snapshot();
  expect(snap.seq).toBe(1);
  expect(journal.entries.map((e) => e.seq)).toEqual([1]);
});

test('commands are written to the journal in the background', async () => {
  const journal = new MemoryJournal();
  const engine = Engine.create(PROGRAM, journal, at('2026-01-12T08:00:00Z'));
  void engine.submit(open('buy', '1', '100'), at('2026-01-12T09:00:00Z'));
  void engine.submit(open('buy', '1', '101'), at('2026-01-12T09:00:01Z'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(journal.entries).toHaveLength(2);
});

test('a command is answered only after its batch has committed', async () => {
  const journal = new MemoryJournal();
  journal.latencyMs = () => 20;
  const engine = Engine.create(PROGRAM, journal, at('2026-01-12T08:00:00Z'));
  await engine.submit(open('buy', '1', '100'), at('2026-01-12T09:00:00Z'));
  expect(journal.entries.map((e) => e.seq)).toEqual([1]);
});

test('a failed commit fails the command and stops the engine', async () => {
  const journal = new MemoryJournal();
  journal.failNextAppend = true;
  const engine = Engine.create(PROGRAM, journal, at('2026-01-12T08:00:00Z'));
  await expect(engine.submit(open('buy', '1', '100'), at('2026-01-12T09:00:00Z'))).rejects.toThrow();
  await expect(engine.submit(open('buy', '1', '100'), at('2026-01-12T09:00:01Z'))).rejects.toThrow(/stopped/);
  expect(journal.entries).toEqual([]);
});

test('a restart does not apply the snapshot\'s own entry again', async () => {
  const journal = new MemoryJournal();
  const engine = Engine.create(PROGRAM, journal, at('2026-01-12T08:00:00Z'));
  await engine.system({ type: 'adjust', amount: usd('250'), reason: 'promo' }, at('2026-01-12T09:00:00Z'));
  const snap = await engine.snapshot();
  const restored = await Engine.restore(journal, snap);
  expect(restored.account).toEqual(engine.account); // README: field for field
});

test('batches commit in seq order, one at a time', async () => {
  const journal = new MemoryJournal();
  journal.latencyMs = (call) => (call === 0 ? 30 : 0); // the first commit is slow
  const engine = Engine.create(PROGRAM, journal, at('2026-01-12T08:00:00Z'));
  const first = engine.submit(open('buy', '1', '100'), at('2026-01-12T09:00:00Z'));
  await new Promise((resolve) => setTimeout(resolve, 1)); // the first batch is in flight
  const second = engine.submit(open('buy', '1', '101'), at('2026-01-12T09:00:01Z'));
  await Promise.all([first, second]);
  expect(journal.entries.map((e) => e.seq)).toEqual([1, 2]);
});

test('a restored account equals the account before the restart, field for field', async () => {
  const journal = new MemoryJournal();
  const engine = Engine.create(PROGRAM, journal, at('2026-01-12T08:00:00Z'));
  await engine.submit(open('buy', '1', '60000'), at('2026-01-12T09:00:00Z'));
  const snap = await engine.snapshot();
  await engine.submit(open('sell', '2', '60100'), at('2026-01-12T09:01:00Z'));
  await engine.system({ type: 'adjust', amount: usd('-0.125'), reason: 'fee' }, at('2026-01-12T09:02:00Z'));
  await new Promise((resolve) => setTimeout(resolve, 5)); // a restart happens later, on another clock
  const restored = await Engine.restore(journal, snap);
  expect(restored.account).toEqual(engine.account);
});

test('restore refuses a journal with a gap', async () => {
  const journal = new MemoryJournal();
  const engine = Engine.create(PROGRAM, journal, at('2026-01-12T08:00:00Z'));
  const snap = await engine.snapshot();
  for (let i = 0; i < 3; i++) await engine.submit(open('buy', '1', '100'), at('2026-01-12T09:00:00Z'));
  journal.entries.splice(1, 1); // seq 2 is missing
  await expect(Engine.restore(journal, snap)).rejects.toThrow(/gap/);
});

test('a snapshot resolves under steady traffic', async () => {
  const journal = new MemoryJournal();
  journal.latencyMs = () => 5;
  const engine = Engine.create(PROGRAM, journal, at('2026-01-12T08:00:00Z'));
  let traffic = true;
  const pump = (async () => {
    while (traffic) {
      void engine.submit(open('buy', '0.001', '100'), at('2026-01-12T09:00:00Z'));
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const snap = await Promise.race([engine.snapshot(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 200))]);
  traffic = false;
  await pump;
  await engine.drain();
  expect(snap).not.toBeNull();
  expect(journal.entries.map((e) => e.seq)).toContain(snap!.seq); // everything in the snapshot is committed
});

test('maxBatchSize caps a batch', async () => {
  const journal = new MemoryJournal();
  const sizes: number[] = [];
  const append = journal.append.bind(journal);
  journal.append = async (batch) => {
    sizes.push(batch.length);
    return append(batch);
  };
  const engine = Engine.create(PROGRAM, journal, at('2026-01-12T08:00:00Z'), { maxBatchSize: 2 });
  await Promise.all(Array.from({ length: 5 }, () => engine.submit(open('buy', '0.001', '100'), at('2026-01-12T09:00:00Z'))));
  expect(sizes).toEqual([2, 2, 1]);
  expect(journal.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
});

test('flushIntervalMs collects a batch before writing it', async () => {
  const journal = new MemoryJournal();
  const sizes: number[] = [];
  const append = journal.append.bind(journal);
  journal.append = async (batch) => {
    sizes.push(batch.length);
    return append(batch);
  };
  const engine = Engine.create(PROGRAM, journal, at('2026-01-12T08:00:00Z'), { flushIntervalMs: 30 });
  const first = engine.submit(open('buy', '1', '100'), at('2026-01-12T09:00:00Z'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = engine.submit(open('buy', '1', '101'), at('2026-01-12T09:00:01Z'));
  await Promise.all([first, second]);
  expect(sizes).toEqual([2]);
});

test('the same trade sent twice at once opens one position', async () => {
  const journal = new MemoryJournal();
  const engine = Engine.create(PROGRAM, journal, at('2026-01-12T08:00:00Z'));
  const trade = open('buy', '1', '60000', 'trade-1');
  const [first, second] = await Promise.all([
    engine.submit(trade, at('2026-01-12T09:00:00Z')),
    engine.submit(trade, at('2026-01-12T09:00:00Z')),
  ]);
  expect(second).toEqual(first);
  expect(engine.account.positions).toHaveLength(1);
});

test('the same trade retried after a restart opens one position', async () => {
  const journal = new MemoryJournal();
  const engine = Engine.create(PROGRAM, journal, at('2026-01-12T08:00:00Z'));
  const snap = await engine.snapshot();
  const trade = open('buy', '1', '60000', 'trade-1');
  const first = await engine.submit(trade, at('2026-01-12T09:00:00Z'));
  // The API got no answer; the engine restarts from an older snapshot and the API retries.
  const restarted = await Engine.restore(journal, snap);
  expect(await restarted.submit(open('buy', '1', '60010', 'trade-1'), at('2026-01-12T09:00:30Z'))).toEqual(first);
  expect(restarted.account.positions).toHaveLength(1);
});

test('a throw inside apply stops the engine: no half-applied account, no gap in the journal', async () => {
  const journal = new MemoryJournal();
  const engine = Engine.create(PROGRAM, journal, at('2026-01-12T08:00:00Z'));
  await engine.submit(open('buy', '1', '100'), at('2026-01-12T09:00:00Z'));
  await expect(engine.submit({ type: 'withdraw', cmdId: 'w' } as never, at('2026-01-12T09:01:00Z'))).rejects.toThrow('unknown event type');
  await expect(engine.submit(open('buy', '1', '100'), at('2026-01-12T09:02:00Z'))).rejects.toThrow('engine stopped');
  expect(journal.entries.map((e) => e.seq)).toEqual([1]);
});

test('a snapshot from before payouts restores with its account id given, and takes a payout', async () => {
  const journal = new MemoryJournal();
  const engine = Engine.create(PROGRAM, journal, at('2026-01-12T08:00:00Z'), {}, 'acc-1');
  await engine.system({ type: 'adjust', amount: usd('1000.01'), reason: 'P&L' }, at('2026-01-12T09:00:00Z'));
  const snap = await engine.snapshot();
  const old: Partial<Account> = structuredClone(snap.account); // what the version before payouts stored
  delete old.id;
  delete old.payouts;
  delete old.dayFloor;
  const stored = { seq: snap.seq, account: old as Account };
  // A made-up id would differ on every restart and give the same payout a new reference.
  await expect(Engine.restore(journal, stored)).rejects.toThrow('no account id');
  const restarted = await Engine.restore(journal, stored, {}, 'acc-1');
  expect(await restarted.submit({ type: 'payout', cmdId: 'pay-1' }, at('2026-01-12T10:00:00Z'))).toEqual({ ok: true, payoutId: 'payout-2' });
  expect(restarted.account.payouts[0]!.reference).toBe('acc-1:payout-2');
  expect(journal.entries.map((e) => e.seq)).toEqual([1, 2]);
});
