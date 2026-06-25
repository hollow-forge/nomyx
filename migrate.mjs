import Database from 'better-sqlite3';
const db = new Database('nomyx.db');
db.prepare("ALTER TABLE users ADD COLUMN authSource TEXT NOT NULL DEFAULT 'local'").run();
console.log('done');