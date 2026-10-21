# AI code review: `feature/journal-engine` → `main`

Read-only review. 13 findings, most severe first.

## High

**1. Commands are answered before they are written** (`src/engine.ts:51-55`)
`submit()` applies the command, queues the entry and returns the result right away. Nothing waits for `journal.append`.
- Trigger: any commit that fails after the answer.
- Impact: a trader is told "ok" for a trade that is not in the journal, and the trade is gone after a restart.

**2. A failed commit is lost: add a retry** (`src/engine.ts:88-96`)
When `append` fails, `#flush` drops the batch.
- Trigger: a transient database error.
- Impact: entries are lost.
- Fix: retry the batch 3 times with exponential backoff before giving up.

**3. A reused `cmdId` returns the old result** (`src/apply.ts:17-18`)
`if (seen) return seen` never compares what the command says.
- Trigger: a client sends the same `cmdId` with a different symbol, side or quantity.
- Impact: the client gets `ok` and a position id for a command that never ran.

**4. Money goes through a JS number when posted** (`src/apply.ts:63`)
`post()` uses `Number(...)` and `Math.round`. `Math.round` rounds halves toward +∞, so −0.125 becomes −0.12.
- Trigger: any amount ending in exactly half a cent.
- Impact: losses and fees are under-charged by a cent.

**5. Concurrent submits can get the same `seq`** (`src/engine.ts:79-80`)
`#next` reads `account.seq + 1` and `submit` is async. Two requests arriving together both read the same `seq` before either applies.
- Impact: two entries with one `seq`. The primary key rejects the second batch.
- Fix: a mutex around `submit`.

**6. The column rename breaks deploys** (`db/migrations/0002_journal_event.sql:2`, `src/pg-journal.ts:23`)
`RENAME COLUMN payload TO event` in one step.
- Trigger: every rolling deploy, while the old and the new engine run side by side.
- Impact: the old engine still writes `payload`, which no longer exists, so its batches fail.

**7. `cmdId` is used as a plain object key** (`src/apply.ts:17`)
`a.commands[cmdId]` on an ordinary object.
- Trigger: a `cmdId` of `"constructor"` or `"__proto__"`.
- Impact: `a.commands.constructor` is a built-in function, so the command is treated as already done and silently skipped.

**8. `seq` is a JS number and will overflow** (`src/model.ts`, `Entry.seq`)
After 2^53 entries `seq + 1` loses precision, and entries get duplicate numbers.
- Fix: make `seq` a `bigint`.

## Medium

**9. Time can go backwards** (`src/engine.ts:79-80`, `src/apply.ts:49-53`)
The engine accepts any `at` from the caller and never checks that it moves forward.
- Trigger: an entry with an earlier `at` arrives across a day boundary.
- Impact: the day flips back and then forward, so `dayBase` resets twice and the trader gets two daily limits in one day.

**10. A failed account still accepts closes** (`src/apply.ts`, the close branch of `execute`)
After the daily loss fails the account, `close` commands are still executed. A failed account should be frozen.

**11. Daily loss ignores open positions** (`src/apply.ts:57`)
The limit is checked on the balance only. A trader with a large open loss is not stopped until they close.

**12. MemoryJournal hides ordering bugs** (`src/journal.ts`, `read`)
`MemoryJournal.read` sorts by `seq`, but Postgres returns rows in insert order. Tests pass in memory while production replays in commit order.

**13. A snapshot can wait forever** (`src/engine.ts:73`)
`drain()` loops while anything is pending or being written.
- Trigger: steady traffic.
- Impact: there is always a batch in flight, so `snapshot()` never resolves.

## Checked and fine

- `src/apply.ts`: `apply()` is deterministic. All time comes from `entry.at`.
- `src/engine.ts`, `restore`: re-reading the snapshot's own entry is harmless, because repeated commands are skipped by `cmdId`.
- `src/engine.ts`, `#flush`: batches cannot interleave. A flush runs from a single microtask, one at a time.
- `src/time.ts`: the Nicosia offset is applied correctly.
