CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  package_json TEXT NOT NULL,
  report TEXT NOT NULL,
  generated_by TEXT NOT NULL,
  generator TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);
