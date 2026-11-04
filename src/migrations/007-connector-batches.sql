CREATE TABLE connector_batches (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  component_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  config TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  batch TEXT,
  batch_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  confirmed_at TEXT,
  result TEXT
);
CREATE INDEX connector_batches_actor ON connector_batches(actor, confirmed_at, expires_at);
