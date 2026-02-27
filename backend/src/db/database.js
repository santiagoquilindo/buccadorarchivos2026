const Database = require("better-sqlite3");
const path = require("path");
const os = require("os");
const fs = require("fs");

// Carpeta de datos local por usuario (no se pierde al actualizar/desinstalar)
const dataDir = path.join(os.homedir(), "InventarioBuscadorData");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "app.db");
const db = new Database(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  email TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('ADMIN','USER')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url_drive TEXT NOT NULL,
  drive_folder_id TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS access_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  drive_url TEXT NOT NULL,
  cabinet TEXT,
  file_date TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
  drive_file_id TEXT,
  source TEXT NOT NULL DEFAULT 'MANUAL' CHECK(source IN ('MANUAL','ZIP','DRIVE')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER,
  description TEXT NOT NULL,
  keywords TEXT,
  location TEXT,
  ref_date TEXT,
  source TEXT NOT NULL DEFAULT 'MANUAL' CHECK(source IN ('MANUAL','ZIP','DRIVE')),
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (file_id) REFERENCES files(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS editor_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS drive_index (
  file_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  parents TEXT NOT NULL DEFAULT '[]',
  modified_time TEXT,
  size TEXT,
  md5_checksum TEXT,
  trashed INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS drive_sync_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Migration for existing databases created before users.email existed.
const userCols = db.prepare("PRAGMA table_info(users)").all();
if (!userCols.some((c) => c.name === "email")) {
  db.exec("ALTER TABLE users ADD COLUMN email TEXT");
}

const docCols = db.prepare("PRAGMA table_info(documents)").all();
if (!docCols.some((c) => c.name === "drive_folder_id")) {
  db.exec("ALTER TABLE documents ADD COLUMN drive_folder_id TEXT");
}

const fileCols = db.prepare("PRAGMA table_info(files)").all();
if (!fileCols.some((c) => c.name === "drive_file_id")) {
  db.exec("ALTER TABLE files ADD COLUMN drive_file_id TEXT");
}
if (!fileCols.some((c) => c.name === "source")) {
  db.exec("ALTER TABLE files ADD COLUMN source TEXT NOT NULL DEFAULT 'MANUAL'");
}

const entryCols = db.prepare("PRAGMA table_info(entries)").all();
if (!entryCols.some((c) => c.name === "source")) {
  db.exec("ALTER TABLE entries ADD COLUMN source TEXT NOT NULL DEFAULT 'MANUAL'");
}

db.exec(`
CREATE INDEX IF NOT EXISTS idx_entries_ref_date ON entries(ref_date);
CREATE INDEX IF NOT EXISTS idx_files_cabinet ON files(cabinet);
CREATE INDEX IF NOT EXISTS idx_entries_file_id ON entries(file_id);
CREATE INDEX IF NOT EXISTS idx_drive_index_name ON drive_index(name);
CREATE INDEX IF NOT EXISTS idx_drive_index_modified ON drive_index(modified_time);
CREATE INDEX IF NOT EXISTS idx_drive_index_trashed ON drive_index(trashed);
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_drive_file_id ON files(drive_file_id);
CREATE INDEX IF NOT EXISTS idx_files_source ON files(source);
CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);
`);

module.exports = db;
