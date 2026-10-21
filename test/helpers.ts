import type { Command, Entry, Program } from '../src/model.ts';
import { toMicros } from '../src/money.ts';

export const usd = toMicros;

export const PROGRAM: Program = { initialBalance: usd('100000'), dailyLossPct: 5n, feeBps: 2n };

let n = 0;
export const open = (side: 'buy' | 'sell', qty: string, price: string, cmdId = `c${++n}`): Command => ({
  type: 'open',
  cmdId,
  symbol: 'BTCUSD',
  side,
  qty: usd(qty),
  price: usd(price),
});

export const close = (positionId: string, price: string, cmdId = `c${++n}`): Command => ({
  type: 'close',
  cmdId,
  positionId,
  price: usd(price),
});

export const entry = (seq: number, at: string, event: Entry['event']): Entry => ({ seq, at, event });
