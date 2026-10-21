import type { Entry } from './model.ts';

/** The engine's journal. Production: Postgres (db/schema.sql). Tests: MemoryJournal. */
export interface Journal {
  /** Writes a batch in one transaction. Resolves once it is committed. */
  append(batch: Entry[]): Promise<void>;
  /** Entries with seq >= fromSeq, in seq order. */
  read(fromSeq?: number): Promise<Entry[]>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class MemoryJournal implements Journal {
  /** Committed entries, in commit order. */
  readonly entries: Entry[] = [];
  /** Test hook: commit latency for the nth append call (0-based). */
  latencyMs: (call: number) => number = () => 0;
  /** Test hook: the next append fails. */
  failNextAppend = false;
  #calls = 0;

  async append(batch: Entry[]): Promise<void> {
    await sleep(this.latencyMs(this.#calls++));
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error('commit failed');
    }
    this.entries.push(...structuredClone(batch));
  }

  async read(fromSeq = 1): Promise<Entry[]> {
    return structuredClone(this.entries.filter((e) => e.seq >= fromSeq).sort((a, b) => a.seq - b.seq));
  }
}
