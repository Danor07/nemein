-- Additional tables from tag v0.2.0, events.js and access.js. Apply after v0.1.0.sql.
CREATE TABLE IF NOT EXISTS event_identity (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), source TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS budget_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE, envelope TEXT NOT NULL CHECK(json_valid(envelope)));
CREATE TABLE IF NOT EXISTS agent_connections(
    id TEXT PRIMARY KEY,label TEXT NOT NULL,version TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_rules(
    connection_id TEXT NOT NULL REFERENCES agent_connections(id),connection_version TEXT NOT NULL,action TEXT NOT NULL,action_version INTEGER NOT NULL,
    decision TEXT NOT NULL,conditions TEXT NOT NULL,PRIMARY KEY(connection_id,connection_version,action));
    CREATE TABLE IF NOT EXISTS agent_audit(
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,args TEXT NOT NULL,decision TEXT NOT NULL,reason TEXT NOT NULL,reviewer TEXT);
    CREATE TABLE IF NOT EXISTS agent_requests(
    actor TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(actor,request_id));
    CREATE TABLE IF NOT EXISTS agent_proposals(
    id TEXT PRIMARY KEY,actor TEXT NOT NULL REFERENCES agent_connections(id),connection_version TEXT NOT NULL,request_id TEXT NOT NULL,
    action TEXT NOT NULL,action_version INTEGER NOT NULL,args TEXT NOT NULL,base TEXT NOT NULL,purpose TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,final_args TEXT,result TEXT,reason TEXT,resolved_at TEXT,UNIQUE(actor,request_id));
ALTER TABLE agent_audit ADD COLUMN policy TEXT;
