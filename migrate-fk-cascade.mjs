// migrate-fk-cascade.mjs
//
// One-time migration: add ON DELETE CASCADE foreign keys from every host-owned
// table to hosts(hostname), so deleting a host automatically removes its
// history, events, notes, suppressions, links, and runbook — and so any table
// added later inherits the same guarantee instead of needing a manual DELETE.
//
// ── READ BEFORE RUNNING ─────────────────────────────────────────────────────
//   1. Deploy the updated server.ts FIRST. It changes the host upsert from
//      `INSERT OR REPLACE` to `ON CONFLICT DO UPDATE`. With cascade enabled,
//      an INSERT OR REPLACE on hosts deletes the old row first, which would
//      cascade-wipe that host's history on every agent check-in. This script
//      cannot inspect the running server, so that ordering is on you.
//   2. STOP the server before running this — the database must not be in use.
//   3. This script copies the database to a timestamped .bak file before
//      touching anything. If foreign_key_check finds a problem, it aborts and
//      your backup is untouched.
//   4. It is idempotent: any table that already has the cascade FK is skipped,
//      so re-running is harmless.
//
//   Usage:   node migrate-fk-cascade.mjs
//   (set NOMYX_DB if your database isn't ./nomyx.db)

import Database from "better-sqlite3";
import fs from "fs";

const DB_PATH = process.env.NOMYX_DB ?? "nomyx.db";
const CHILD_TABLES = [
  "check_history",
  "status_events",
  "notes",
  "suppressions",
  "host_links",
  "host_runbooks",
];

if (!fs.existsSync(DB_PATH)) {
  console.error(`Database not found at "${DB_PATH}". Set NOMYX_DB or run from the data directory.`);
  process.exit(1);
}

// 1) Back up the database file before any change.
const stamp  = new Date().toISOString().replace(/[:.]/g, "-");
const backup = `${DB_PATH}.bak-${stamp}`;
fs.copyFileSync(DB_PATH, backup);
console.log(`Backed up "${DB_PATH}" -> "${backup}"`);

const db = new Database(DB_PATH);

const hasHostFk = (table) =>
  db.pragma(`foreign_key_list(${table})`).some((fk) => fk.table === "hosts");

function migrateTable(table) {
  if (hasHostFk(table)) {
    console.log(`  ${table}: already has the hosts foreign key — skipping`);
    return;
  }

  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table);
  if (!row) {
    console.log(`  ${table}: table not found — skipping`);
    return;
  }

  const cols = db.pragma(`table_info(${table})`).map((c) => c.name);
  if (!cols.includes("hostname")) {
    console.log(`  ${table}: no hostname column — skipping`);
    return;
  }

  // Rebuild the original CREATE statement under a temp name, with the FK added.
  // Reading the live DDL (rather than hardcoding it) means any column added by
  // a future migration is carried across automatically.
  let createSql = row.sql
    .replace(
      new RegExp(`CREATE TABLE\\s+(IF NOT EXISTS\\s+)?["'\`]?${table}["'\`]?`, "i"),
      `CREATE TABLE ${table}__new`
    )
    .replace(
      /\)\s*$/,
      ",\n  FOREIGN KEY (hostname) REFERENCES hosts(hostname) ON DELETE CASCADE\n)"
    );

  // Index DDL has to be recreated after the swap (it's dropped with the table).
  const indexes = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL")
    .all(table)
    .map((r) => r.sql);

  const colList = cols.join(", ");
  const before  = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;

  db.exec(createSql);
  // Copy only rows whose host still exists — this drops any pre-existing orphans.
  db.exec(
    `INSERT INTO ${table}__new (${colList}) SELECT ${colList} FROM ${table} ` +
    `WHERE hostname IN (SELECT hostname FROM hosts)`
  );
  const after = db.prepare(`SELECT COUNT(*) AS c FROM ${table}__new`).get().c;

  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${table}__new RENAME TO ${table}`);
  for (const idx of indexes) db.exec(idx);

  const dropped = before - after;
  console.log(
    `  ${table}: migrated — ${after} rows kept` +
    (dropped ? `, ${dropped} orphan row(s) dropped` : "")
  );
}

console.log("Adding ON DELETE CASCADE foreign keys to host-owned tables...");

// PRAGMA foreign_keys is a no-op inside a transaction, so set it OFF out here,
// then let better-sqlite3's transaction() wrap the table rebuilds in BEGIN/COMMIT.
db.pragma("foreign_keys = OFF");
db.transaction(() => {
  for (const t of CHILD_TABLES) migrateTable(t);
})();

// Verify integrity before declaring success.
const violations = db.pragma("foreign_key_check");
if (violations.length) {
  console.error("\nforeign_key_check reported violations:", violations);
  console.error(`Aborting. Your original data is intact in the backup: ${backup}`);
  process.exit(2);
}

db.pragma("foreign_keys = ON");
db.close();
console.log("\nDone. Cascade foreign keys are in place and verified.");
console.log("Start the server normally — deleting a host now removes its child rows automatically.");
