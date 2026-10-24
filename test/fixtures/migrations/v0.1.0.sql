-- Frozen from tag v0.1.0, core.js and planning.js; not derived from new migrations.
CREATE TABLE accounts(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,type TEXT NOT NULL CHECK(type IN ('corriente','credito','efectivo')));
 CREATE TABLE groups_(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE);
 CREATE TABLE categories(id INTEGER PRIMARY KEY,group_id INTEGER NOT NULL REFERENCES groups_(id),name TEXT NOT NULL,UNIQUE(group_id,name));
 CREATE TABLE allocations(month TEXT NOT NULL,category_id INTEGER NOT NULL REFERENCES categories(id),amount INTEGER NOT NULL,PRIMARY KEY(month,category_id));
 CREATE TABLE transactions(id INTEGER PRIMARY KEY,account_id INTEGER NOT NULL REFERENCES accounts(id),date TEXT NOT NULL,payee TEXT NOT NULL,amount INTEGER NOT NULL,category_id INTEGER REFERENCES categories(id),kind TEXT NOT NULL DEFAULT 'normal',cleared INTEGER NOT NULL DEFAULT 0,reconciled INTEGER NOT NULL DEFAULT 0,import_key TEXT UNIQUE,transfer_key TEXT);
 CREATE INDEX tx_date ON transactions(date); CREATE INDEX tx_account ON transactions(account_id);
 CREATE TABLE memory(payee TEXT PRIMARY KEY,category_id INTEGER NOT NULL REFERENCES categories(id));
 CREATE TABLE mappings(account_id INTEGER PRIMARY KEY REFERENCES accounts(id),config TEXT NOT NULL);
 CREATE TABLE reconciliations(id INTEGER PRIMARY KEY,account_id INTEGER NOT NULL REFERENCES accounts(id),date TEXT NOT NULL,balance INTEGER NOT NULL);
 INSERT INTO groups_(name) VALUES ('Esenciales'),('Estilo de vida'),('Ahorro');
 INSERT INTO categories(group_id,name) VALUES (1,'Alimentación'),(1,'Vivienda'),(1,'Servicios'),(1,'Transporte'),(2,'Salidas'),(2,'Suscripciones'),(3,'Fondo de emergencia');
 PRAGMA user_version=1;
CREATE TABLE IF NOT EXISTS goals(category_id INTEGER PRIMARY KEY REFERENCES categories(id),amount INTEGER NOT NULL CHECK(amount>0),due_date TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS recurring(id INTEGER PRIMARY KEY,account_id INTEGER NOT NULL REFERENCES accounts(id),category_id INTEGER REFERENCES categories(id),payee TEXT NOT NULL,amount INTEGER NOT NULL,next_date TEXT NOT NULL,frequency TEXT NOT NULL,anchor_day INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS recurring_occurrences(recurring_id INTEGER NOT NULL REFERENCES recurring(id),due_date TEXT NOT NULL,transaction_id INTEGER,PRIMARY KEY(recurring_id,due_date));
