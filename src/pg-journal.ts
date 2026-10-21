import type { Journal } from './journal.ts';
import type { Entry } from './model.ts';

/** The part of a node-postgres client the journal needs. */
export interface Sql {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const BIGINT_FIELDS = new Set(['qty', 'price', 'amount']);

/**
 * The production journal: one row per entry, a batch is one multi-row INSERT (one transaction).
 * The column stays `payload`: renaming it in one step breaks the old version during a rolling deploy.
 * The code calls it `event`; a real rename would be expand → migrate → contract over three deploys.
 */
export class PgJournal implements Journal {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async append(batch: Entry[]): Promise<void> {
    if (batch.length === 0) return;
    const rows = batch.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(', ');
    const values = batch.flatMap((e) => [e.seq, e.at, JSON.stringify(e.event, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))]);
    await this.#sql.query(`INSERT INTO journal (seq, at, payload) VALUES ${rows}`, values);
  }

  async read(fromSeq = 1): Promise<Entry[]> {
    // No catch: an empty result on a failed read would restart the engine without its journal.
    const { rows } = await this.#sql.query('SELECT seq, at, payload AS event FROM journal WHERE seq >= $1 ORDER BY seq', [fromSeq]);
    return rows.map((r) => ({
      seq: Number(r.seq),
      at: (r.at as Date).toISOString(),
      event: JSON.parse(JSON.stringify(r.event), (k, v: unknown) => (BIGINT_FIELDS.has(k) ? BigInt(v as string) : v)),
    }));
  }
}
