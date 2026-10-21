# prop-engine

The core of a trading engine, in miniature: one account, one writer.
Traders send commands (open and close positions); the platform sends system events (balance adjustments).
The engine applies every event in order, writes it to a journal, and can be rebuilt from a snapshot plus the journal.

No trading background needed: a position is "bought `qty` units at a price"; closing it at another price makes or loses `(close − open) × qty`.

## Run

Everything runs in a Docker container, so nothing gets installed on your machine:

```bash
docker compose run --rm dev                      # install (first run only) and run the tests
docker compose run --rm dev npm run typecheck    # any other command
```

Remove everything afterwards, then delete this folder:

```bash
docker compose down -v --rmi all
```

Without Docker: `npm ci --ignore-scripts && npm test`.

## Rules

These are the invariants. Code that breaks one of them is a bug.

**Money**
- Amounts, prices and quantities are `bigint` micros (1e-6). Never a JS `number`.
- An amount is rounded to whole cents only when posted to the balance, half away from zero.

**Determinism**
- `apply(account, entry)` is deterministic: the same journal always produces the same account, on any machine, at any time.
- Time comes only from the entry (`entry.at`, stamped by the sequencer). Never from the system clock.

**Journal**
- Every event gets the next `seq` (1, 2, 3… no gaps) and is written to the journal before it counts.
- Entries are written in batches. A batch commits in one transaction, and batches commit in `seq` order.
- A command is answered only after its batch has committed. If a commit fails, the engine stops: unanswered commands fail, and nothing is retried blindly.

**Snapshots**
- A snapshot is the account after entry `seq`. Restart = snapshot + every journal entry after it.
- The restored account must equal the account before the restart, field for field.

**Commands**
- Every command carries a `cmdId`. The same `cmdId` with the same content returns the first result. The same `cmdId` with different content is rejected.
- System events carry no `cmdId`.

**Daily loss**
- A trading day starts at 00:00 in Nicosia (Asia/Nicosia, UTC+2 in winter, UTC+3 in summer).
- The balance at the start of the day is the day base. When the balance falls to `base × (1 − dailyLossPct%)` or lower, the account fails.
- A failed account accepts only closes.

**Deploys**
- Deploys are rolling: for a few seconds the old and the new engine version run against the same database.
  Every migration must work with both versions (expand → migrate → contract).
