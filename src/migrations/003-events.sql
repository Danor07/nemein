CREATE TABLE IF NOT EXISTS event_identity (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), source TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS budget_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE, envelope TEXT NOT NULL CHECK(json_valid(envelope)));
