import { apply } from './apply.ts';
import type { Journal } from './journal.ts';
import { dayFloor, newAccount, type Account, type Command, type CommandResult, type Entry, type Program, type SystemEvent } from './model.ts';

export interface Snapshot {
  /** The account after entry `seq`. */
  seq: number;
  account: Account;
}

export interface EngineOptions {
  /** At most this many entries per batch. Default 100. */
  maxBatchSize?: number;
  /** How long to collect a batch before writing it. Default 0: write on the next tick. */
  flushIntervalMs?: number;
}

/** An applied entry waiting for its batch to commit, and the caller waiting for the answer. */
interface Waiter {
  entry: Entry;
  committed: () => void;
  failed: (err: Error) => void;
}

/** Someone waiting until everything up to `seq` is committed (a snapshot, a drain). */
interface SeqWaiter {
  seq: number;
  reached: () => void;
  failed: (err: Error) => void;
}

/**
 * The single writer for one account: applies events in order and journals them in batches.
 * Events that arrive while a batch is being written go into the next batch.
 * One batch is written at a time, so batches commit in seq order.
 * A failed commit stops the engine: the in-memory account is then ahead of the journal,
 * and only a restart from snapshot + journal is safe. Nothing is retried: a failed commit may still have landed.
 * A throw inside apply() stops it too: the account may be half-applied.
 */
export class Engine {
  #account: Account;
  #journal: Journal;
  #maxBatchSize: number;
  #flushIntervalMs: number;
  #pending: Waiter[] = [];
  #seqWaiters: SeqWaiter[] = [];
  #writing: Promise<void> | null = null;
  #scheduled = false;
  #committed: number;
  #stopped: Error | null = null;

  private constructor(account: Account, journal: Journal, options: EngineOptions) {
    const { maxBatchSize = 100, flushIntervalMs = 0 } = options;
    if (!(Number.isInteger(maxBatchSize) && maxBatchSize >= 1)) throw new Error(`maxBatchSize must be an integer >= 1, got ${maxBatchSize}`);
    if (!(Number.isFinite(flushIntervalMs) && flushIntervalMs >= 0)) throw new Error(`flushIntervalMs must be >= 0, got ${flushIntervalMs}`);
    this.#account = account;
    this.#journal = journal;
    this.#maxBatchSize = maxBatchSize;
    this.#flushIntervalMs = flushIntervalMs;
    this.#committed = account.seq;
  }

  /** `accountId` must be unique across the firm; by default a new UUID. */
  static create(program: Program, journal: Journal, at: Date, options: EngineOptions = {}, accountId?: string): Engine {
    return new Engine(newAccount(program, at, accountId), journal, options);
  }

  /**
   * Rebuilds the engine from a snapshot and the journal entries after it. Refuses a journal with a gap.
   * A snapshot from before payouts has no account id: pass it as `accountId`.
   */
  static async restore(journal: Journal, from: Snapshot, options: EngineOptions = {}, accountId?: string): Promise<Engine> {
    if (from.account.seq !== from.seq) throw new Error(`snapshot seq ${from.seq} does not match its account (${from.account.seq})`);
    const account = upgrade(structuredClone(from.account), accountId);
    // From the entry after the snapshot: the snapshot's own entry is already in it (system events have no cmdId).
    for (const entry of await journal.read(from.seq + 1)) {
      if (entry.seq !== account.seq + 1) throw new Error(`journal gap: expected seq ${account.seq + 1}, got ${entry.seq}`);
      apply(account, entry);
    }
    return new Engine(account, journal, options);
  }

  get accountId(): string {
    return this.#account.id;
  }

  get account(): Account {
    return structuredClone(this.#account);
  }

  /** Applies a trader's command and returns its result once its entry is committed. */
  async submit(command: Command, at: Date): Promise<CommandResult> {
    this.#assertRunning();
    // seq and apply stay synchronous: no await may come between them, or two submits could share a seq.
    const entry = this.#next(command, at);
    const result = this.#apply(entry)!;
    await this.#commit(entry);
    return result;
  }

  /** Applies a platform event, such as a balance adjustment by support. Resolves once committed. */
  async system(event: SystemEvent, at: Date): Promise<void> {
    this.#assertRunning();
    const entry = this.#next(event, at);
    this.#apply(entry);
    await this.#commit(entry);
  }

  /** The account as of now; resolves once everything in it is committed, even while traffic continues. */
  async snapshot(): Promise<Snapshot> {
    this.#assertRunning();
    const snapshot = { seq: this.#account.seq, account: structuredClone(this.#account) };
    await this.#committedThrough(snapshot.seq);
    return snapshot;
  }

  /** Resolves once everything applied so far has been written; rejects if the engine has stopped. */
  async drain(): Promise<void> {
    await this.#committedThrough(this.#account.seq);
  }

  #apply(entry: Entry): CommandResult | undefined {
    try {
      return apply(this.#account, entry);
    } catch (err) {
      this.#stopped = err instanceof Error ? err : new Error(String(err));
      throw err;
    }
  }

  #next(event: Entry['event'], at: Date): Entry {
    return { seq: this.#account.seq + 1, at: at.toISOString(), event };
  }

  #assertRunning(): void {
    if (this.#stopped) throw new Error('engine stopped', { cause: this.#stopped });
  }

  /** Queues the entry for a batch; resolves when that batch has committed. */
  #commit(entry: Entry): Promise<void> {
    return new Promise((committed, failed) => {
      this.#pending.push({ entry, committed, failed });
      this.#schedule();
    });
  }

  #committedThrough(seq: number): Promise<void> {
    if (this.#stopped) return Promise.reject(new Error('engine stopped', { cause: this.#stopped }));
    if (this.#committed >= seq) return Promise.resolve();
    return new Promise((reached, failed) => this.#seqWaiters.push({ seq, reached, failed }));
  }

  #schedule(): void {
    if (this.#writing !== null || this.#scheduled || this.#pending.length === 0) return;
    this.#scheduled = true;
    const run = () => {
      this.#scheduled = false;
      this.#flush();
    };
    if (this.#flushIntervalMs > 0) setTimeout(run, this.#flushIntervalMs);
    else queueMicrotask(run);
  }

  #flush(): void {
    if (this.#writing !== null || this.#pending.length === 0) return;
    const batch = this.#pending.splice(0, this.#maxBatchSize);
    this.#writing = this.#journal.append(batch.map((w) => w.entry)).then(
      () => {
        this.#writing = null;
        this.#committed = batch.at(-1)!.entry.seq;
        for (const w of batch) w.committed();
        const waiting = this.#seqWaiters;
        this.#seqWaiters = waiting.filter((w) => w.seq > this.#committed);
        for (const w of waiting) if (w.seq <= this.#committed) w.reached();
        this.#schedule(); // what arrived during this commit, or did not fit, is the next batch
      },
      (err: unknown) => {
        this.#writing = null;
        this.#stopped = err instanceof Error ? err : new Error(String(err));
        const failure = new Error('journal commit failed: engine stopped', { cause: this.#stopped });
        const unanswered = [...batch, ...this.#pending];
        const waiting = this.#seqWaiters;
        this.#pending = [];
        this.#seqWaiters = [];
        for (const w of unanswered) w.failed(failure);
        for (const w of waiting) w.failed(failure);
      },
    );
  }
}

/** What a snapshot from before payouts lacks. */
type StoredAccount = Omit<Account, 'id' | 'payouts' | 'dayFloor'> & Partial<Pick<Account, 'id' | 'payouts' | 'dayFloor'>>;

/** The id is never made up: a new one on each restart would give a requested payout a new reference, and it would be paid twice. */
function upgrade(stored: StoredAccount, accountId: string | undefined): Account {
  const id = stored.id ?? accountId;
  if (id === undefined) throw new Error('the snapshot has no account id: pass it to restore()');
  if (accountId !== undefined && accountId !== id) throw new Error(`the snapshot is of account ${id}, not ${accountId}`);
  return { ...stored, id, payouts: stored.payouts ?? [], dayFloor: stored.dayFloor ?? dayFloor(stored.program, stored.dayBase) };
}
