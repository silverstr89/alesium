import { expect, test } from 'vitest';
import { apply } from '../src/apply.ts';
import { Engine } from '../src/engine.ts';
import { MemoryJournal } from '../src/journal.ts';
import { newAccount, type Command } from '../src/model.ts';
import { FakePayoutProvider, PayoutTimeout, type PayoutProvider, type PayoutRequest, type PayoutStatus } from '../src/payout-provider.ts';
import { settlePayouts } from '../src/payouts.ts';
import { entry, open, PROGRAM, usd } from './helpers.ts';

const at = (iso: string) => new Date(iso);
const clock = () => at('2026-01-12T12:00:00Z');
const payout = (cmdId: string): Command => ({ type: 'payout', cmdId });
const TRADER = 'trader-1';

/** An engine whose account made 1,000.01 of profit (expected values worked out in PLAN.md). */
async function withProfit(accountId = 'acc-1') {
  const journal = new MemoryJournal();
  const engine = Engine.create(PROGRAM, journal, at('2026-01-12T08:00:00Z'), {}, accountId);
  await engine.system({ type: 'adjust', amount: usd('1000.01'), reason: 'closed P&L' }, at('2026-01-12T09:00:00Z'));
  return { journal, engine };
}

test('a payout pays 80% of the profit above the initial balance; the balance goes back to it', async () => {
  const { engine } = await withProfit();
  expect(await engine.submit(payout('pay-1'), at('2026-01-12T10:00:00Z'))).toEqual({ ok: true, payoutId: 'payout-2' });
  const a = engine.account;
  expect(a.balance).toBe(PROGRAM.initialBalance);
  expect(a.payouts).toEqual([
    { id: 'payout-2', cmdId: 'pay-1', amount: usd('800.01'), firmShare: usd('200.00'), status: 'requested', requestedAt: '2026-01-12T10:00:00.000Z', floorShift: 0n, reference: 'acc-1:payout-2' },
  ]);
});

test('a payout is refused while positions are open, without profit, and on a failed account', () => {
  const a = newAccount(PROGRAM, at('2026-01-12T08:00:00Z'));
  expect(apply(a, entry(1, '2026-01-12T09:00:00Z', payout('p0')))).toEqual({ ok: false, reason: 'no-profit' });
  apply(a, entry(2, '2026-01-12T09:00:00Z', { type: 'adjust', amount: usd('500'), reason: 'P&L' }));
  apply(a, entry(3, '2026-01-12T09:01:00Z', open('buy', '1', '100')));
  const before = structuredClone(a);
  expect(apply(a, entry(4, '2026-01-12T09:02:00Z', payout('p1')))).toEqual({ ok: false, reason: 'positions-open' });
  expect({ ...a, seq: before.seq, commands: before.commands }).toEqual(before); // nothing but the record of the refusal changed

  const failed = newAccount(PROGRAM, at('2026-01-12T08:00:00Z'));
  failed.balance += usd('500');
  failed.status = 'failed';
  expect(apply(failed, entry(1, '2026-01-12T09:00:00Z', payout('p2')))).toEqual({ ok: false, reason: 'account-failed' });
});

test('the same cmdId returns the same result and creates one payout', async () => {
  const { engine } = await withProfit();
  const first = await engine.submit(payout('pay-1'), at('2026-01-12T10:00:00Z'));
  const again = await engine.submit(payout('pay-1'), at('2026-01-12T10:00:05Z'));
  expect(again).toEqual(first);
  expect(engine.account.payouts).toHaveLength(1);
});

test('a payout is not a trading loss: it does not trip the daily limit', () => {
  const a = newAccount(PROGRAM, at('2026-01-12T08:00:00Z'));
  apply(a, entry(1, '2026-01-12T09:00:00Z', { type: 'adjust', amount: usd('10000'), reason: 'P&L' }));
  apply(a, entry(2, '2026-01-13T09:00:00Z', payout('pay-1'))); // a new day: the day base is 110,000
  expect(a.balance).toBe(PROGRAM.initialBalance); // 10% down from the day base, the limit is 5%
  expect(a.status).toBe('active');
});

/** 110,000 at the start of 13 January (floor 104,500), down 5,400 that day: 100.00 of loss room left. */
function downTodayUpOverall() {
  const a = newAccount(PROGRAM, at('2026-01-12T08:00:00Z'));
  apply(a, entry(1, '2026-01-12T09:00:00Z', { type: 'adjust', amount: usd('10000'), reason: 'P&L' }));
  apply(a, entry(2, '2026-01-13T09:00:00Z', { type: 'adjust', amount: usd('-5400'), reason: 'P&L' }));
  return a;
}

test('a payout on a losing day keeps the loss room left that day, no more and no less', () => {
  const a = downTodayUpOverall();
  expect(apply(a, entry(3, '2026-01-13T10:00:00Z', payout('pay-1')))).toEqual({ ok: true, payoutId: 'payout-3' });
  expect(a.payouts[0]!.amount).toBe(usd('3680.00')); // 4,600 × 80%
  expect({ balance: a.balance, status: a.status }).toEqual({ balance: usd('100000'), status: 'active' });
  apply(a, entry(4, '2026-01-13T11:00:00Z', { type: 'adjust', amount: usd('-99.99'), reason: 'P&L' }));
  expect(a.status).toBe('active');
  apply(a, entry(5, '2026-01-13T11:01:00Z', { type: 'adjust', amount: usd('-0.01'), reason: 'P&L' })); // 100.00 lost: the limit
  expect(a.status).toBe('failed');
});

test('a refused payout puts the day back as it was: the same loss room, and the trader can ask again', () => {
  const a = downTodayUpOverall();
  apply(a, entry(3, '2026-01-13T10:00:00Z', payout('pay-1')));
  apply(a, entry(4, '2026-01-13T10:05:00Z', { type: 'payout-result', payoutId: 'payout-3', outcome: 'rejected' }));
  expect({ balance: a.balance, status: a.status }).toEqual({ balance: usd('104600'), status: 'active' });
  const nextDay = structuredClone(a);
  expect(apply(nextDay, entry(5, '2026-01-14T09:00:00Z', payout('pay-2')))).toEqual({ ok: true, payoutId: 'payout-5' });
  apply(a, entry(5, '2026-01-13T11:00:00Z', { type: 'adjust', amount: usd('-99.99'), reason: 'P&L' }));
  expect(a.status).toBe('active');
  apply(a, entry(6, '2026-01-13T11:01:00Z', { type: 'adjust', amount: usd('-0.01'), reason: 'P&L' })); // 100.00 left, as before the request
  expect(a.status).toBe('failed');
});

test('after a payout the loss room is never more than a fresh account has', () => {
  const a = newAccount(PROGRAM, at('2026-01-12T08:00:00Z'));
  apply(a, entry(1, '2026-01-12T09:00:00Z', { type: 'adjust', amount: usd('10000'), reason: 'P&L' }));
  apply(a, entry(2, '2026-01-13T09:00:00Z', payout('pay-1'))); // 110,000 → 100,000; a fresh account fails at 95,000
  apply(a, entry(3, '2026-01-13T10:00:00Z', { type: 'adjust', amount: usd('-4999.99'), reason: 'P&L' }));
  expect(a.status).toBe('active');
  apply(a, entry(4, '2026-01-13T10:01:00Z', { type: 'adjust', amount: usd('-0.01'), reason: 'P&L' }));
  expect(a.status).toBe('failed');
});

test('the money reaches the provider exactly once: API retry and a restart before sending', async () => {
  const { journal, engine } = await withProfit();
  const snap = await engine.snapshot();
  const first = await engine.submit(payout('pay-1'), at('2026-01-12T10:00:00Z'));
  // The API got no answer and the engine restarts before anything was sent.
  const restarted = await Engine.restore(journal, snap);
  expect(await restarted.submit(payout('pay-1'), at('2026-01-12T10:00:30Z'))).toEqual(first); // the API retries
  const provider = new FakePayoutProvider();
  await settlePayouts(restarted, provider, TRADER, clock);
  await settlePayouts(restarted, provider, TRADER, clock); // running it again sends nothing
  expect(provider.paid).toEqual([{ reference: 'acc-1:payout-2', traderId: TRADER, amount: usd('800.01') }]);
  expect(restarted.account.payouts[0]!.status).toBe('paid');
});

test('the money reaches the provider exactly once: a restart after sending, before the outcome is journaled', async () => {
  const { journal, engine } = await withProfit();
  await engine.submit(payout('pay-1'), at('2026-01-12T10:00:00Z'));
  const snap = await engine.snapshot();
  const provider = new FakePayoutProvider();
  const crashing: PayoutProvider = {
    status: (reference) => provider.status(reference),
    send: async (request) => {
      await provider.send(request);
      throw new Error('the process died'); // the money left, the outcome was never written
    },
  };
  await expect(settlePayouts(engine, crashing, TRADER, clock)).rejects.toThrow('the process died');

  const restarted = await Engine.restore(journal, snap);
  await settlePayouts(restarted, provider, TRADER, clock);
  expect(provider.paid).toHaveLength(1);
  expect(restarted.account.payouts[0]!.status).toBe('paid');
});

test('nothing is sent before the request is in the journal', async () => {
  const { journal, engine } = await withProfit();
  journal.latencyMs = () => 20;
  const seenAtSend: number[][] = [];
  const provider = new FakePayoutProvider();
  const watching: PayoutProvider = {
    status: (reference) => provider.status(reference),
    send: async (request: PayoutRequest) => {
      seenAtSend.push(journal.entries.map((e) => e.seq));
      return provider.send(request);
    },
  };
  const submitted = engine.submit(payout('pay-1'), at('2026-01-12T10:00:00Z'));
  await settlePayouts(engine, watching, TRADER, clock); // started while the request is still being written
  await submitted;
  await settlePayouts(engine, watching, TRADER, clock);
  expect(seenAtSend).toHaveLength(1);
  expect(seenAtSend[0]).toContain(2); // the payout request (seq 2) was committed before the money moved
});

test('a refused payout puts the money back on the account', async () => {
  const { engine } = await withProfit();
  await engine.submit(payout('pay-1'), at('2026-01-12T10:00:00Z'));
  const provider = new FakePayoutProvider();
  provider.rejectNext = true;
  await settlePayouts(engine, provider, TRADER, clock);
  expect(provider.paid).toEqual([]);
  expect(engine.account.balance).toBe(usd('101000.01'));
  expect(engine.account.payouts[0]!.status).toBe('rejected');
  await settlePayouts(engine, provider, TRADER, clock); // nothing more happens
  expect(engine.account.balance).toBe(usd('101000.01'));
});

test('a timeout after the money left is not a failure: the next run finds it paid', async () => {
  const { engine } = await withProfit();
  await engine.submit(payout('pay-1'), at('2026-01-12T10:00:00Z'));
  const provider = new FakePayoutProvider();
  provider.timeoutNext = 'after-paying';
  await settlePayouts(engine, provider, TRADER, clock);
  expect(engine.account.balance).toBe(PROGRAM.initialBalance); // not put back
  expect(engine.account.payouts[0]!.status).toBe('requested');
  await settlePayouts(engine, provider, TRADER, clock);
  expect(provider.paid).toHaveLength(1);
  expect(engine.account.payouts[0]!.status).toBe('paid');
});

test('a timeout before the money left is not a failure: the next run sends it once', async () => {
  const { engine } = await withProfit();
  await engine.submit(payout('pay-1'), at('2026-01-12T10:00:00Z'));
  const provider = new FakePayoutProvider();
  provider.timeoutNext = 'before-paying';
  await settlePayouts(engine, provider, TRADER, clock);
  expect(provider.paid).toEqual([]);
  expect(engine.account.balance).toBe(PROGRAM.initialBalance);
  await settlePayouts(engine, provider, TRADER, clock);
  expect(provider.paid).toHaveLength(1);
  expect(engine.account.payouts[0]!.status).toBe('paid');
});

test('a late or repeated outcome changes nothing', async () => {
  const { engine } = await withProfit();
  await engine.submit(payout('pay-1'), at('2026-01-12T10:00:00Z'));
  await engine.system({ type: 'payout-result', payoutId: 'payout-2', outcome: 'rejected' }, at('2026-01-12T10:01:00Z'));
  await engine.system({ type: 'payout-result', payoutId: 'payout-2', outcome: 'rejected' }, at('2026-01-12T10:02:00Z'));
  await engine.system({ type: 'payout-result', payoutId: 'payout-2', outcome: 'paid' }, at('2026-01-12T10:03:00Z'));
  expect(engine.account.balance).toBe(usd('101000.01')); // put back once
  expect(engine.account.payouts[0]!.status).toBe('rejected');
});

test('a payout sent before a crash is not sent again even when the provider no longer ignores repeats', async () => {
  // The provider forgets a reference after 24 hours; status() is what stops a second payment then.
  const { journal, engine } = await withProfit();
  await engine.submit(payout('pay-1'), at('2026-01-12T10:00:00Z'));
  const snap = await engine.snapshot();
  const provider = new FakePayoutProvider();
  provider.ignoresRepeats = false;
  const crashing: PayoutProvider = {
    status: (reference) => provider.status(reference),
    send: async (request) => {
      await provider.send(request);
      throw new Error('the process died');
    },
  };
  await expect(settlePayouts(engine, crashing, TRADER, clock)).rejects.toThrow('the process died');
  const restarted = await Engine.restore(journal, snap);
  await settlePayouts(restarted, provider, TRADER, clock);
  expect(provider.paid).toHaveLength(1);
});

test('two sender runs at once and a refusal: the money is either paid or put back, never both', async () => {
  const { engine } = await withProfit();
  await engine.submit(payout('pay-1'), at('2026-01-12T10:00:00Z'));
  const provider = new FakePayoutProvider();
  provider.rejectNext = true;
  await Promise.all([settlePayouts(engine, provider, TRADER, clock), settlePayouts(engine, provider, TRADER, clock)]);
  expect(provider.paid).toEqual([]);
  expect(engine.account.balance).toBe(usd('101000.01'));
  expect(engine.account.payouts[0]!.status).toBe('rejected');
});

/** The provider as documented: it remembers a reference, for send() and status(), for 24 hours. */
class ForgetfulProvider implements PayoutProvider {
  readonly paid: PayoutRequest[] = [];
  timeoutAfterPaying = false;
  #seen = new Map<string, number>();
  constructor(private readonly now: () => Date) {}
  #remembers(reference: string): boolean {
    const sentAt = this.#seen.get(reference);
    return sentAt !== undefined && this.now().getTime() - sentAt < 24 * 3600_000;
  }
  async send(request: PayoutRequest): Promise<void> {
    if (!this.#remembers(request.reference)) {
      this.paid.push({ ...request });
      this.#seen.set(request.reference, this.now().getTime());
    }
    if (this.timeoutAfterPaying) {
      this.timeoutAfterPaying = false;
      throw new PayoutTimeout(request.reference);
    }
  }
  async status(reference: string): Promise<PayoutStatus> {
    return this.#remembers(reference) ? 'paid' : 'unknown';
  }
}

test('past 23 hours an unknown payout is held for a person, not sent again', async () => {
  const { engine } = await withProfit();
  await engine.submit(payout('pay-1'), at('2026-01-12T10:00:00Z'));
  let now = at('2026-01-12T10:05:00Z');
  const provider = new ForgetfulProvider(() => now);
  provider.timeoutAfterPaying = true;
  await settlePayouts(engine, provider, TRADER, () => now); // paid, but we never heard back
  now = at('2026-01-13T11:05:00Z'); // the sender was down for 25 hours; the provider has forgotten the reference
  await settlePayouts(engine, provider, TRADER, () => now);
  expect(provider.paid.map((p) => p.amount)).toEqual([usd('800.01')]);
  expect(engine.account.payouts[0]!.status).toBe('requested'); // for a person to settle
});

test('two accounts of one trader: each payout reaches the provider under its own reference', async () => {
  const A = await withProfit('acc-A');
  const B = await withProfit('acc-B');
  await A.engine.submit(payout('pay-1'), at('2026-01-12T10:00:00Z'));
  await B.engine.submit(payout('pay-1'), at('2026-01-12T10:00:00Z')); // payout-2 on both accounts
  const provider = new FakePayoutProvider();
  await settlePayouts(A.engine, provider, TRADER, clock);
  await settlePayouts(B.engine, provider, TRADER, clock);
  expect(provider.paid.map((p) => [p.reference, p.amount])).toEqual([
    ['acc-A:payout-2', usd('800.01')],
    ['acc-B:payout-2', usd('800.01')],
  ]);
});

test('a refusal after midnight counts the refund in the new day, as if it had been in the day base', () => {
  const a = newAccount(PROGRAM, at('2026-01-12T08:00:00Z'));
  apply(a, entry(1, '2026-01-12T09:00:00Z', { type: 'adjust', amount: usd('12000'), reason: 'P&L' }));
  apply(a, entry(2, '2026-01-13T09:00:00Z', { type: 'adjust', amount: usd('-2000'), reason: 'P&L' })); // 110,000
  apply(a, entry(3, '2026-01-13T21:55:00Z', payout('pay-1'))); // 23:55 in Nicosia
  apply(a, entry(4, '2026-01-13T22:05:00Z', { type: 'payout-result', payoutId: 'payout-3', outcome: 'rejected' })); // 00:05 on 14 Jan
  expect(a.balance).toBe(usd('110000'));
  apply(a, entry(5, '2026-01-14T09:00:00Z', { type: 'adjust', amount: usd('-5000'), reason: 'P&L' })); // floor 110,000 × 95% = 104,500
  expect(a.status).toBe('active');
  apply(a, entry(6, '2026-01-14T09:01:00Z', { type: 'adjust', amount: usd('-500'), reason: 'P&L' }));
  expect(a.status).toBe('failed');
});

test('a refusal the sender heard from status() puts the money back and sends nothing', async () => {
  const { engine } = await withProfit();
  await engine.submit(payout('pay-1'), at('2026-01-12T10:00:00Z'));
  const sent: PayoutRequest[] = [];
  const refusedEarlier: PayoutProvider = { status: async () => 'failed', send: async (request) => void sent.push(request) };
  await settlePayouts(engine, refusedEarlier, TRADER, clock);
  expect(sent).toEqual([]);
  expect(engine.account.balance).toBe(usd('101000.01'));
  expect(engine.account.payouts[0]!.status).toBe('rejected');
});

test('a sender run on a restarted engine waits for the run still going on the old one', async () => {
  const { journal, engine } = await withProfit();
  await engine.submit(payout('pay-1'), at('2026-01-12T10:00:00Z'));
  const restarted = await Engine.restore(journal, await engine.snapshot());
  const provider = new FakePayoutProvider();
  provider.rejectNext = true;
  const lateAnswer: PayoutProvider = {
    status: async (reference) => {
      const known = await provider.status(reference);
      await new Promise((r) => setTimeout(r, 20)); // the answer was 'unknown' when asked, it arrives late
      return known;
    },
    send: (request) => provider.send(request),
  };
  await Promise.all([settlePayouts(engine, lateAnswer, TRADER, clock), settlePayouts(restarted, provider, TRADER, clock)]);
  expect(provider.paid).toEqual([]);
  expect(restarted.account.balance).toBe(usd('101000.01'));
});
