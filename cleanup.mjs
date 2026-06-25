// cleanup.mjs
/*
import Database from 'better-sqlite3';
const db = new Database('nomyx.db');
const r  = db.prepare("DELETE FROM hosts WHERE hostname LIKE 'server%'").run();
console.log('Deleted:', r.changes, 'rows');
*/
// cleanup.mjs
import Database from 'better-sqlite3';
const db = new Database('nomyx.db');
const h  = db.prepare("DELETE FROM hosts        WHERE hostname LIKE 'server%'").run();
const c  = db.prepare("DELETE FROM check_history WHERE hostname LIKE 'server%'").run();
const e  = db.prepare("DELETE FROM status_events WHERE hostname LIKE 'server%'").run();
console.log(`Deleted ${h.changes} hosts, ${c.changes} history rows, ${e.changes} events`);