import { Database } from "bun:sqlite";

let db: Database | null = null;

export function getDb(path = "data/hal9999.db"): Database {
  if (db) return db;

  // Ensure data directory exists for file-based DBs
  if (path !== ":memory:") {
    const dir = path.substring(0, path.lastIndexOf("/"));
    if (dir) {
      const fs = require("node:fs");
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  initSchema(db);
  migrate(db);
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

function migrate(db: Database): void {
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(vms)").all();
  if (cols.length > 0 && !cols.some((c) => c.name === "ssh_port")) {
    db.exec("ALTER TABLE vms ADD COLUMN ssh_port INTEGER");
  }
  if (cols.length > 0 && !cols.some((c) => c.name === "provider")) {
    db.exec("ALTER TABLE vms ADD COLUMN provider TEXT NOT NULL DEFAULT 'digitalocean'");
  }
  if (cols.length > 0 && !cols.some((c) => c.name === "idle_since")) {
    db.exec("ALTER TABLE vms ADD COLUMN idle_since TEXT");
  }

  // Task migrations
  const taskCols = db.query<{ name: string }, []>("PRAGMA table_info(tasks)").all();
  if (taskCols.length > 0 && !taskCols.some((c) => c.name === "branch")) {
    db.exec("ALTER TABLE tasks ADD COLUMN branch TEXT");
  }
  if (taskCols.length > 0 && !taskCols.some((c) => c.name === "pr_url")) {
    db.exec("ALTER TABLE tasks ADD COLUMN pr_url TEXT");
  }
  if (taskCols.length > 0 && !taskCols.some((c) => c.name === "slug")) {
    db.exec("ALTER TABLE tasks ADD COLUMN slug TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_slug ON tasks(slug)");
  }
}

function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vms (
      id          TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      provider    TEXT NOT NULL DEFAULT 'digitalocean',
      ip          TEXT,
      ssh_port    INTEGER,
      status      TEXT NOT NULL DEFAULT 'provisioning',
      task_id     TEXT,
      snapshot_id TEXT NOT NULL,
      region      TEXT NOT NULL,
      plan        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      error       TEXT,
      idle_since  TEXT
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT PRIMARY KEY,
      slug          TEXT UNIQUE,
      repo_url      TEXT NOT NULL,
      context       TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      vm_id         TEXT,
      result        TEXT,
      exit_code     INTEGER,
      branch        TEXT,
      pr_url        TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      started_at    TEXT,
      completed_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS images (
      id            TEXT PRIMARY KEY,
      provider      TEXT NOT NULL,
      instance_id   TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_vms_status ON vms(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_vms_task_id ON vms(task_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_vm_id ON tasks(vm_id);
    CREATE INDEX IF NOT EXISTS idx_images_instance_id ON images(instance_id);
  `);
}
