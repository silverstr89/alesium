import { expect, test } from 'vitest';
import { apply } from '../src/apply.ts';
import { newAccount, type Program } from '../src/model.ts';
import { close, entry, open, PROGRAM, usd } from './helpers.ts';

const fresh = () => newAccount(PROGRAM, new Date('2026-01-12T08:00:00Z'));

test('open and close: P&L and fees on both sides', () => {
  const a = fresh();
  expect(apply(a, entry(1, '2026-01-12T09:00:00Z', open('buy', '0.5', '60000')))).toEqual({ ok: true, positionId: 'p1' });
  expect(apply(a, entry(2, '2026-01-12T10:00:00Z', close('p1', '61000')))).toEqual({ ok: true });
  expect(a.balance).toBe(usd('100487.90')); // +500 − 6.00 − 6.10 fees
  expect(a.positions).toEqual([]);
  expect(a.seq).toBe(2);
});

test('a repeated command is applied once', () => {
  const a = fresh();
  const cmd = open('buy', '1', '100', 'same');
  const first = apply(a, entry(1, '2026-01-12T09:00:00Z', cmd));
  const again = apply(a, entry(2, '2026-01-12T09:00:01Z', cmd));
  expect(again).toEqual(first);
  expect(a.positions).toHaveLength(1);
});

test('bad commands are refused', () => {
  const a = fresh();
  expect(apply(a, entry(1, '2026-01-12T09:00:00Z', open('buy', '0', '100')))).toEqual({ ok: false, reason: 'bad-command' });
  expect(apply(a, entry(2, '2026-01-12T09:00:00Z', close('p9', '100')))).toEqual({ ok: false, reason: 'no-position' });
});

test('the daily loss limit fails the account; a failed account only closes', () => {
  const a = fresh();
  apply(a, entry(1, '2026-01-12T09:00:00Z', open('buy', '1', '60000')));
  apply(a, entry(2, '2026-01-12T09:00:00Z', open('buy', '1', '60000')));
  apply(a, entry(3, '2026-01-12T10:00:00Z', close('p1', '55000'))); // −5,000 − fees
  expect(a.status).toBe('failed');
  expect(apply(a, entry(4, '2026-01-12T10:01:00Z', open('buy', '1', '55000')))).toEqual({ ok: false, reason: 'account-failed' });
  expect(apply(a, entry(5, '2026-01-12T10:02:00Z', close('p2', '55000')))).toEqual({ ok: true });
});

test('the day base resets at the first entry of a new trading day', () => {
  const a = fresh();
  apply(a, entry(1, '2026-01-12T09:00:00Z', { type: 'adjust', amount: usd('250'), reason: 'promo' }));
  apply(a, entry(2, '2026-01-13T09:00:00Z', { type: 'adjust', amount: usd('-50'), reason: 'fee refund reversal' }));
  expect(a.day).toBe('2026-01-13');
  expect(a.dayBase).toBe(usd('100250'));
  expect(a.balance).toBe(usd('100200'));
});

test('fees are charged on open and on close', () => {
  const a = fresh();
  apply(a, entry(1, '2026-01-12T09:00:00Z', open('buy', '2', '50000')));
  expect(a.balance).toBe(usd('99980.00')); // fee 2 × 50,000 × 0.02% = 20.00
  apply(a, entry(2, '2026-01-12T09:30:00Z', close('p1', '50500')));
  expect(a.balance).toBe(usd('100959.80')); // + 2 × 500 − 2 × 50,500 × 0.02% = + 1,000 − 20.20
});

test('a fee is rounded to cents once, from its exact value', () => {
  const a = fresh();
  apply(a, entry(1, '2026-01-12T09:00:00Z', open('buy', '0.25', '99.99'))); // fee 0.0049995 → 0.00
  expect(a.balance).toBe(usd('100000.00'));
  apply(a, entry(2, '2026-01-12T09:01:00Z', open('buy', '0.5', '49.994999'))); // fee 0.0049994999 → 0.00
  expect(a.balance).toBe(usd('100000.00'));
});

test('a close posts P&L minus fee rounded once', () => {
  const a = fresh();
  apply(a, entry(1, '2026-01-12T09:00:00Z', open('sell', '0.25', '100'))); // fee 0.005 → 0.01
  apply(a, entry(2, '2026-01-12T09:01:00Z', close('p1', '149.99'))); // −12.4975 − 0.0074995 = −12.5049995 → −12.50
  expect(a.balance).toBe(usd('99987.49'));
});

test('a cent lost to double rounding cannot fail the account', () => {
  const a = newAccount({ ...PROGRAM, feeBps: 0n }, new Date('2026-01-12T08:00:00Z'));
  apply(a, entry(1, '2026-01-12T09:00:00Z', open('buy', '0.5', '20000')));
  apply(a, entry(2, '2026-01-12T09:01:00Z', close('p1', '10000.010001'))); // −4,999.9949995 → −4,999.99; the floor is 95,000.00
  expect({ balance: a.balance, status: a.status }).toEqual({ balance: usd('95000.01'), status: 'active' });
});

test('every posting is the exact amount rounded to cents once (seeded trades)', () => {
  // Oracle: exact integers in 1e-16 of a unit (micros × micros × basis points), one rounding half away from zero.
  const toCents = (n: bigint) => {
    const d = 10n ** 14n;
    const x = n < 0n ? -n : n;
    const q = x / d + ((x % d) * 2n >= d ? 1n : 0n);
    return (n < 0n ? -q : q) * 10_000n;
  };
  let seed = 20261021; // mulberry32
  const rnd = (n: number) => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
  const program: Program = PROGRAM;
  const wrong: string[] = [];
  for (let i = 0; i < 300_000 && wrong.length < 3; i++) {
    const qty = BigInt(1 + rnd(50_000)) * 100n; // 0.0001 .. 5.0000
    const p1 = BigInt(100 + rnd(10_000_000)) * 10_000n; // 1.00 .. 100,000.99
    const p2 = BigInt(100 + rnd(10_000_000)) * 10_000n;
    const side = rnd(2) === 0 ? 'buy' : 'sell';
    const a = newAccount(program, new Date('2026-01-12T08:00:00Z'));
    apply(a, entry(1, '2026-01-12T09:00:00Z', { type: 'open', cmdId: 'o', symbol: 'X', side, qty, price: p1 }));
    const afterOpen = program.initialBalance - toCents(qty * p1 * program.feeBps);
    const move = side === 'buy' ? p2 - p1 : p1 - p2;
    const afterClose = afterOpen + toCents(move * qty * 10_000n - qty * p2 * program.feeBps);
    const opened = a.balance;
    apply(a, entry(2, '2026-01-12T09:01:00Z', { type: 'close', cmdId: 'c', positionId: 'p1', price: p2 }));
    if (opened !== afterOpen || a.balance !== afterClose) wrong.push(`${side} ${qty} @ ${p1} → ${p2}`);
  }
  expect(wrong).toEqual([]);
});

test('an unknown event type is refused before anything changes', () => {
  const a = fresh();
  const before = structuredClone(a);
  expect(() => apply(a, entry(1, '2026-01-13T09:00:00Z', { type: 'withdraw', cmdId: 'w' } as never))).toThrow('unknown event type');
  expect(a).toEqual(before);
});

test('the same cmdId with different content is rejected', () => {
  const a = fresh();
  apply(a, entry(1, '2026-01-12T09:00:00Z', open('buy', '1', '100', 'same')));
  const reused = apply(a, entry(2, '2026-01-12T09:00:01Z', open('sell', '5', '200', 'same')));
  expect(reused).toMatchObject({ ok: false });
  expect(a.positions).toHaveLength(1);
});

test('a retry of a command with a newly stamped price returns the first result', () => {
  // The sequencer stamps the price, so a retry may carry another one: that is still the same command.
  const a = fresh();
  const first = apply(a, entry(1, '2026-01-12T09:00:00Z', open('buy', '1', '100', 'retry')));
  const again = apply(a, entry(2, '2026-01-12T09:00:05Z', open('buy', '1', '105', 'retry')));
  expect(again).toEqual(first);
  expect(a.positions).toHaveLength(1);
});

test('a cmdId named like an Object.prototype member is an ordinary id', () => {
  for (const id of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    const a = fresh();
    const first = apply(a, entry(1, '2026-01-12T09:00:00Z', open('buy', '1', '100', id)));
    expect(first, id).toEqual({ ok: true, positionId: 'p1' });
    const copy = structuredClone(a); // what a snapshot and a restore do
    expect(apply(copy, entry(2, '2026-01-12T09:00:01Z', open('buy', '1', '100', id))), id).toEqual(first);
    expect(copy.positions, id).toHaveLength(1);
    expect(Object.getPrototypeOf(copy.commands), id).toBe(Object.prototype);
  }
});

test('posting rounds to whole cents half away from zero, exactly', () => {
  for (const [amount, balance] of [['-0.125', '99999.87'], ['1.005', '100001.01'], ['-1.005', '99998.99'], ['0.125', '100000.13']] as const) {
    const a = fresh();
    apply(a, entry(1, '2026-01-12T09:00:00Z', { type: 'adjust', amount: usd(amount), reason: 'test' }));
    expect(a.balance, amount).toBe(usd(balance));
  }
});

test('openedAt comes from the entry, never from the clock', () => {
  const a = fresh();
  apply(a, entry(1, '2026-01-12T09:00:00Z', open('buy', '1', '100')));
  expect(a.positions[0]!.openedAt).toBe('2026-01-12T09:00:00Z');
});

test('the trading day never moves backwards', () => {
  const a = fresh();
  const adjust = (amount: string) => ({ type: 'adjust' as const, amount: usd(amount), reason: 'test' });
  apply(a, entry(1, '2026-01-12T21:59:00Z', adjust('0')));
  apply(a, entry(2, '2026-01-12T22:01:00Z', adjust('-1000'))); // 13 Jan in Nicosia: base 100000
  apply(a, entry(3, '2026-01-12T21:58:00Z', adjust('0'))); // an earlier instant: still 13 Jan
  apply(a, entry(4, '2026-01-12T22:02:00Z', adjust('0')));
  expect(a.day).toBe('2026-01-13');
  expect(a.dayBase).toBe(usd('100000'));
});

test('a close at a price of zero or below is refused', () => {
  const a = fresh();
  apply(a, entry(1, '2026-01-12T09:00:00Z', open('buy', '1', '100')));
  expect(apply(a, entry(2, '2026-01-12T09:00:01Z', close('p1', '0')))).toEqual({ ok: false, reason: 'bad-command' });
  expect(a.positions).toHaveLength(1);
});

test('the daily floor is base × (1 − pct%) rounded down to a micro, never up', () => {
  const a = newAccount({ ...PROGRAM, initialBalance: usd('100000.000001') }, new Date('2026-01-12T08:00:00Z'));
  apply(a, entry(1, '2026-01-12T09:00:00Z', { type: 'adjust', amount: usd('-5000'), reason: 'P&L' }));
  expect(a.balance).toBe(usd('95000.000001')); // above the exact floor 95,000.00000095
  expect(a.status).toBe('active');
});
