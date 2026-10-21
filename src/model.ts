import { randomUUID } from 'node:crypto';
import { ONE, type Micros } from './money.ts';
import { tradingDay } from './time.ts';

/** A funded trader keeps this share of the profit they withdraw; the firm keeps the rest. */
export const TRADER_SHARE_PCT = 80n;

export interface Program {
  initialBalance: Micros;
  /** Daily loss limit, % of the day base. */
  dailyLossPct: bigint;
  /** Fee per trade, in basis points (1/100 of a percent) of the notional. */
  feeBps: bigint;
}

export type Side = 'buy' | 'sell';

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  qty: Micros;
  openPrice: Micros;
  openedAt: string;
}

/** From traders, through the API. The sequencer stamps the fill price. */
export type Command =
  | { type: 'open'; cmdId: string; symbol: string; side: Side; qty: Micros; price: Micros }
  | { type: 'close'; cmdId: string; positionId: string; price: Micros }
  | { type: 'payout'; cmdId: string };

/** From the platform. No cmdId. */
export type SystemEvent =
  | { type: 'adjust'; amount: Micros; reason: string }
  | { type: 'payout-result'; payoutId: string; outcome: 'paid' | 'rejected' };

/** A payout of the trader's share, from its request until the provider's answer is journaled. */
export interface Payout {
  id: string;
  cmdId: string;
  /** The trader's share, sent to the provider. */
  amount: Micros;
  /** What the firm keeps: profit − amount, so the two add up to the profit exactly. */
  firmShare: Micros;
  status: 'requested' | 'paid' | 'rejected';
  requestedAt: string;
  /** How far the request lowered the day floor; a refusal raises it back by as much. */
  floorShift: Micros;
  /** Our id for the payout at the provider: `<account id>:<payout id>`, unique across accounts, fixed at the request. */
  reference: string;
}

/** One journal record. */
export interface Entry {
  seq: number;
  /** ISO 8601 UTC, stamped by the sequencer. */
  at: string;
  event: Command | SystemEvent;
}

export type CommandResult = { ok: true; positionId?: string; payoutId?: string } | { ok: false; reason: string };

export interface Account {
  /** Unique across the firm: it goes into every payout reference. */
  id: string;
  program: Program;
  status: 'active' | 'failed';
  balance: Micros;
  positions: Position[];
  /** The current trading day and the balance at its start. */
  day: string;
  dayBase: Micros;
  /** The account fails at or below this balance. Set from the day base; a payout and its refusal move it. */
  dayFloor: Micros;
  /**
   * Commands applied so far, by cmdId: what the command said and what it got.
   * Read with Object.hasOwn and written with defineProperty: a cmdId comes from a trader and may be
   * "constructor" or "__proto__". A plain object (not a Map) because the account is stored as JSON.
   */
  commands: Record<string, { content: string; result: CommandResult }>;
  payouts: Payout[];
  /** The last applied entry. */
  seq: number;
  nextPositionId: number;
}

export function newAccount(program: Program, at: Date, id: string = randomUUID()): Account {
  return {
    id,
    program,
    status: 'active',
    balance: program.initialBalance,
    positions: [],
    day: tradingDay(at),
    dayBase: program.initialBalance,
    dayFloor: dayFloor(program, program.initialBalance),
    commands: {},
    payouts: [],
    seq: 0,
    nextPositionId: 1,
  };
}

/** README: the account fails when the balance falls to `base × (1 − dailyLossPct%)` or lower. Rounded down to a micro. */
export function dayFloor(program: Program, base: Micros): Micros {
  return (base * (100n - program.dailyLossPct)) / 100n;
}

/**
 * P&L and fees stay exact until they are posted: micros × micros × basis points, 1e-16 of a unit.
 * Rounding them to micros first would round twice and move a posting by a cent.
 */
export const EXACT_PER_MICRO = ONE * 10_000n;

/** Profit or loss of a position if it closed at `price`, exact. */
export function pnl(p: Position, price: Micros): bigint {
  const move = p.side === 'buy' ? price - p.openPrice : p.openPrice - price;
  return move * p.qty * 10_000n;
}

/** The fee on a trade, exact. */
export function fee(program: Program, qty: Micros, price: Micros): bigint {
  return qty * price * program.feeBps;
}
