import type { Micros } from './money.ts';

/** A payout to a trader, as the provider sees it. `reference` is our id for the payout. */
export interface PayoutRequest {
  reference: string;
  traderId: string;
  amount: Micros;
}

/** `unknown`: the provider has never seen this reference. */
export type PayoutStatus = 'paid' | 'failed' | 'unknown';

/** The payout provider. Production: its HTTP API. Tests: FakePayoutProvider. */
export interface PayoutProvider {
  /**
   * Sends the money and resolves once the provider has paid.
   * Throws `PayoutRejected` when the provider refuses: nothing was paid.
   * Throws `PayoutTimeout` when it does not answer in time: the money may or may not have left.
   * The provider remembers `reference` for 24 hours and ignores a repeat.
   */
  send(request: PayoutRequest): Promise<void>;
  /** What the provider knows about a payout. */
  status(reference: string): Promise<PayoutStatus>;
}

export class PayoutRejected extends Error {}
export class PayoutTimeout extends Error {}

/** In-memory provider for tests. Behaves like the real one; the hooks make it misbehave. */
export class FakePayoutProvider implements PayoutProvider {
  /** Every payment that actually left, in order. */
  readonly paid: PayoutRequest[] = [];
  /** Test hook: the next send is refused. */
  rejectNext = false;
  /** Test hook: the next send times out, before or after the money leaves. */
  timeoutNext: 'before-paying' | 'after-paying' | null = null;
  /** Test hook: a repeated `reference` is ignored (the real provider: yes, for 24 hours). */
  ignoresRepeats = true;
  #status = new Map<string, PayoutStatus>();

  async send(request: PayoutRequest): Promise<void> {
    if (this.rejectNext) {
      this.rejectNext = false;
      if (!this.#status.has(request.reference)) this.#status.set(request.reference, 'failed');
      throw new PayoutRejected(request.reference);
    }
    if (this.timeoutNext === 'before-paying') {
      this.timeoutNext = null;
      throw new PayoutTimeout(request.reference);
    }
    if (!(this.ignoresRepeats && this.#status.get(request.reference) === 'paid')) {
      this.paid.push({ ...request });
      this.#status.set(request.reference, 'paid');
    }
    if (this.timeoutNext === 'after-paying') {
      this.timeoutNext = null;
      throw new PayoutTimeout(request.reference);
    }
  }

  async status(reference: string): Promise<PayoutStatus> {
    return this.#status.get(reference) ?? 'unknown';
  }
}
