-- The production journal and snapshots in Postgres. Tests use MemoryJournal (src/journal.ts).

CREATE TABLE journal (
  seq     bigint PRIMARY KEY,
  at      timestamptz NOT NULL,
  payload jsonb NOT NULL
);

CREATE TABLE snapshots (
  seq     bigint PRIMARY KEY,
  account jsonb NOT NULL
);
