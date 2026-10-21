import { expect, test } from 'vitest';
import type { Entry } from '../src/model.ts';
import { PgJournal, type Sql } from '../src/pg-journal.ts';
import { open } from './helpers.ts';

/** A stand-in for Postgres: keeps the rows of the journal table as the INSERT names them. */
function fakeSql() {
  const rows: Record<string, unknown>[] = [];
  const queries: string[] = [];
  const sql: Sql = {
    async query(text, values = []) {
      queries.push(text);
      if (text.startsWith('INSERT')) {
        const columns = /\(([^)]*)\) VALUES/.exec(text)![1]!.split(',').map((c) => c.trim());
        for (let i = 0; i < values.length; i += columns.length) {
          rows.push(Object.fromEntries(columns.map((c, j) => [c, c === 'at' ? new Date(values[i + j] as string) : c === 'seq' ? String(values[i + j]) : JSON.parse(values[i + j] as string)])));
        }
        return { rows: [] };
      }
      const alias = /SELECT seq, at, (\w+) AS event/.exec(text);
      if (!alias) throw new Error(`unexpected query: ${text}`);
      return { rows: rows.filter((r) => Number(r.seq) >= Number(values[0])).map((r) => ({ seq: r.seq, at: r.at, event: r[alias[1]!] })) };
    },
  };
  return { sql, rows, queries };
}

test('the journal keeps the payload column, so the old and the new version can run side by side', async () => {
  const { sql, rows, queries } = fakeSql();
  const journal = new PgJournal(sql);
  const entry: Entry = { seq: 1, at: '2026-01-12T09:00:00.000Z', event: open('buy', '0.5', '60000.123456', 'c-1') };
  await journal.append([entry]);
  expect(queries[0]).toContain('(seq, at, payload)');
  expect(Object.keys(rows[0]!)).toEqual(['seq', 'at', 'payload']);
  expect(await journal.read(1)).toEqual([entry]); // bigints and time survive the round trip
});

test('a failed read fails loudly instead of returning an empty journal', async () => {
  const journal = new PgJournal({ query: async () => { throw new Error('connection reset'); } });
  await expect(journal.read(1)).rejects.toThrow('connection reset');
});
