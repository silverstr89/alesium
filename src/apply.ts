import { dayFloor, EXACT_PER_MICRO, fee, pnl, TRADER_SHARE_PCT, type Account, type Command, type CommandResult, type Entry, type SystemEvent } from './model.ts';
import { roundToCents, roundToCentsOf, type Micros } from './money.ts';
import { tradingDay } from './time.ts';

const KNOWN_TYPES: ReadonlySet<string> = new Set(['open', 'close', 'payout', 'adjust', 'payout-result']);

/** Applies one journal entry to the account, in place. Returns the result for a command. */
export function apply(a: Account, entry: Entry): CommandResult | undefined {
  // An entry this version does not know (one from a newer version) must stop a replay, not be taken for a close.
  if (!KNOWN_TYPES.has(entry.event.type)) throw new Error(`unknown event type "${entry.event.type}" at seq ${entry.seq}`);
  a.seq = entry.seq;
  startDayIfNew(a, new Date(entry.at));
  const event = entry.event;

  if (event.type === 'adjust') {
    a.balance += post(event.amount);
    checkDailyLoss(a);
    return undefined;
  }
  if (event.type === 'payout-result') {
    recordPayoutResult(a, event);
    return undefined;
  }

  const content = contentOf(event);
  const seen = Object.hasOwn(a.commands, event.cmdId) ? a.commands[event.cmdId] : undefined;
  if (seen) return seen.content === content ? seen.result : { ok: false, reason: 'cmd-id-reused' };
  const result = execute(a, event, entry.at);
  Object.defineProperty(a.commands, event.cmdId, { value: { content, result }, enumerable: true, writable: true, configurable: true });
  checkDailyLoss(a);
  return result;
}

/** What the trader asked for. The price is stamped by the sequencer, so a retry may carry another one. */
function contentOf(c: Command): string {
  if (c.type === 'open') return JSON.stringify(['open', c.symbol, c.side, c.qty.toString()]);
  return c.type === 'close' ? JSON.stringify(['close', c.positionId]) : JSON.stringify(['payout']);
}

function execute(a: Account, c: Command, at: string): CommandResult {
  if (c.type === 'payout') return requestPayout(a, c.cmdId, at);
  if (c.type === 'open') {
    if (a.status !== 'active') return { ok: false, reason: 'account-failed' };
    if (c.qty <= 0n || c.price <= 0n) return { ok: false, reason: 'bad-command' };
    const id = `p${a.nextPositionId++}`;
    a.positions.push({
      id,
      symbol: c.symbol,
      side: c.side,
      qty: c.qty,
      openPrice: c.price,
      openedAt: at,
    });
    a.balance -= postExact(fee(a.program, c.qty, c.price));
    return { ok: true, positionId: id };
  }

  if (c.price <= 0n) return { ok: false, reason: 'bad-command' };
  const p = a.positions.find((x) => x.id === c.positionId);
  if (!p) return { ok: false, reason: 'no-position' };
  a.balance += postExact(pnl(p, c.price) - fee(a.program, p.qty, c.price));
  a.positions = a.positions.filter((x) => x.id !== p.id);
  return { ok: true };
}

/**
 * Splits the profit above the initial balance: the trader's share is rounded to whole cents like every posting,
 * the firm gets the rest. The balance goes back to the initial balance. Nothing is sent here: apply() is pure;
 * the sender acts only on what is in the journal.
 */
function requestPayout(a: Account, cmdId: string, at: string): CommandResult {
  if (a.status !== 'active') return { ok: false, reason: 'account-failed' };
  if (a.positions.length > 0) return { ok: false, reason: 'positions-open' };
  const profit = a.balance - a.program.initialBalance;
  if (profit <= 0n) return { ok: false, reason: 'no-profit' };
  const amount = roundToCentsOf(profit * TRADER_SHARE_PCT, 100n);
  const id = `payout-${a.seq}`;
  // A payout is not a trading loss: the floor moves down with the balance, so the loss room left today stays.
  // But never below a fresh account's floor: profit made today must not buy extra room once it is withdrawn.
  const floor = max(a.dayFloor - profit, dayFloor(a.program, a.program.initialBalance));
  a.payouts.push({ id, cmdId, amount, firmShare: profit - amount, status: 'requested', requestedAt: at, floorShift: a.dayFloor - floor, reference: `${a.id}:${id}` });
  a.balance -= profit;
  a.dayFloor = floor;
  return { ok: true, payoutId: id };
}

/** The provider's final answer. Only a requested payout changes; a repeated or late answer changes nothing. */
function recordPayoutResult(a: Account, e: Extract<SystemEvent, { type: 'payout-result' }>): void {
  const p = a.payouts.find((x) => x.id === e.payoutId);
  if (!p || p.status !== 'requested') return;
  p.status = e.outcome;
  if (e.outcome === 'rejected') {
    // Nothing was paid, so the split did not happen: the whole profit comes back (PLAN.md, question 1).
    const back = p.amount + p.firmShare;
    a.balance += back;
    // The shift belongs to the day of the request; on a later day the refund counts as if it had been in the day base.
    a.dayFloor += tradingDay(new Date(p.requestedAt)) === a.day ? p.floorShift : dayFloor(a.program, back);
  }
}

function startDayIfNew(a: Account, at: Date): void {
  const day = tradingDay(at);
  if (day <= a.day) return; // "YYYY-MM-DD" compares as a date; an earlier instant never reopens a day
  a.day = day;
  a.dayBase = a.balance;
  a.dayFloor = dayFloor(a.program, a.dayBase);
}

function checkDailyLoss(a: Account): void {
  if (a.status === 'active' && a.balance <= a.dayFloor) a.status = 'failed';
}

const max = (x: bigint, y: bigint): bigint => (x > y ? x : y);

/** An amount as posted to the balance: whole cents, half away from zero. */
function post(amount: Micros): Micros {
  return roundToCents(amount);
}

/** An exact P&L or fee as posted: whole cents, rounded once. */
function postExact(exact: bigint): Micros {
  return roundToCentsOf(exact, EXACT_PER_MICRO);
}
