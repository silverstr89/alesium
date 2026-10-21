import type { Engine } from './engine.ts';
import { PayoutRejected, PayoutTimeout, type PayoutProvider } from './payout-provider.ts';

/**
 * The provider remembers a reference for 24 hours. Past this age since the request, a payout it does not know
 * may have been paid and forgotten, so it is held for a person and never sent again.
 */
export const RESEND_WINDOW_MS = 23 * 3600_000;

const running = new Map<string, Promise<void>>();

/**
 * Sends every requested payout and journals the provider's final answer.
 * Safe to run any number of times, after a restart, or twice at once:
 * - runs for one account never overlap, even on an engine restarted in the same process: a later call waits
 *   for the one in flight, so a refusal journaled by one run cannot race a payment made by another
 *   (across processes this needs a lease per account);
 * - it works from a snapshot, which holds only what is committed, so nothing is sent before its request is in the journal;
 * - it asks status() first, so a payout sent before a crash is recorded, not sent again;
 * - a timeout is not a failure: the money may have left, so the payout stays requested and the next run asks status().
 */
export function settlePayouts(engine: Engine, provider: PayoutProvider, traderId: string, now: () => Date): Promise<void> {
  const key = engine.accountId;
  const run = (running.get(key) ?? Promise.resolve()).catch(() => {}).then(() => settleOnce(engine, provider, traderId, now));
  running.set(key, run);
  void run.catch(() => {}).then(() => running.get(key) === run && running.delete(key));
  return run;
}

async function settleOnce(engine: Engine, provider: PayoutProvider, traderId: string, now: () => Date): Promise<void> {
  const { account } = await engine.snapshot();
  for (const payout of account.payouts.filter((p) => p.status === 'requested')) {
    const known = await provider.status(payout.reference);
    if (known !== 'unknown') {
      await engine.system({ type: 'payout-result', payoutId: payout.id, outcome: known === 'paid' ? 'paid' : 'rejected' }, now());
      continue;
    }
    if (now().getTime() - Date.parse(payout.requestedAt) >= RESEND_WINDOW_MS) continue; // held for a person
    try {
      await provider.send({ reference: payout.reference, traderId, amount: payout.amount });
    } catch (err) {
      if (err instanceof PayoutTimeout) continue;
      if (!(err instanceof PayoutRejected)) throw err;
      await engine.system({ type: 'payout-result', payoutId: payout.id, outcome: 'rejected' }, now());
      continue;
    }
    await engine.system({ type: 'payout-result', payoutId: payout.id, outcome: 'paid' }, now());
  }
}
