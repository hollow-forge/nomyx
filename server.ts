import { config } from "dotenv";
config();
import express            from "express";
import session            from "express-session";
// @ts-ignore
import bcrypt             from "bcrypt";
import Database           from "better-sqlite3";
// @ts-ignore
import BetterSqlite3Store from "better-sqlite3-session-store";
import { readFileSync, existsSync } from "fs";
import path  from "path";
import https from "https";
import { getAuthUrl, handleCallback } from "./entra";
import { ldapAuthenticate, ldapLookupUser } from './ldap';
import nodemailer from 'nodemailer';

// ── Constants ──────────────────────────────────────────────────────────────────

const app      = express();
const PORT     = 4433;
const SqlStore = BetterSqlite3Store(session) as any;

// HTTPS is enabled only when both a cert and key are provided and exist on disk.
// Otherwise the server runs plain HTTP — e.g. behind a TLS-terminating proxy.
const TLS_CERT  = process.env.TLS_CERT;
const TLS_KEY   = process.env.TLS_KEY;
const USE_HTTPS = !!(TLS_CERT && TLS_KEY && existsSync(TLS_CERT) && existsSync(TLS_KEY));
const TRUST_PROXY = process.env.TRUST_PROXY;

// ── Org config ─────────────────────────────────────────────────────────────────

let orgConfig: any = { name: "Nomyx", divisions: [] };
try {
  orgConfig = JSON.parse(readFileSync("./config_org.json", "utf-8")).org ?? orgConfig;
} catch {
  console.log("[nomyx] No config_org.json found — org structure will be empty");
}

// ── Database ───────────────────────────────────────────────────────────────────

const db = new Database(process.env.NOMYX_DB ?? "nomyx.db");
db.pragma("foreign_keys = ON");   // enforce ON DELETE CASCADE for host-owned tables

db.exec(`
  CREATE TABLE IF NOT EXISTS hosts (
    hostname        TEXT PRIMARY KEY,
    group_name      TEXT,
    ip              TEXT,
    division        TEXT,
    department      TEXT,
    status          TEXT,
    lastSeen        TEXT,
    checks          TEXT,
    intervalSeconds INTEGER DEFAULT 600
  );

  CREATE TABLE IF NOT EXISTS check_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    hostname   TEXT,
    checkName  TEXT,
    value      REAL,
    unit       TEXT,
    status     TEXT,
    recordedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS status_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    hostname   TEXT,
    checkName  TEXT,
    fromStatus TEXT,
    toStatus   TEXT,
    value      REAL,
    recordedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS notes (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    hostname  TEXT,
    checkName TEXT,
    note      TEXT,
    createdBy TEXT,
    createdAt TEXT
  );

  CREATE TABLE IF NOT EXISTS suppressions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    hostname     TEXT,
    checkName    TEXT,
    reason       TEXT,
    suppressedBy TEXT,
    createdAt    TEXT,
    startsAt     TEXT,
    expiresAt    TEXT,
    autoLiftOnOk INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    email        TEXT UNIQUE NOT NULL,
    displayName  TEXT NOT NULL,
    passwordHash TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'viewer',
    division     TEXT,
    department   TEXT,
    authSource   TEXT NOT NULL DEFAULT 'local',
    createdAt    TEXT NOT NULL,
    lastLogin    TEXT
  );

  CREATE TABLE IF NOT EXISTS user_scopes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    userId     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    division   TEXT NOT NULL,
    department TEXT
  );

  CREATE TABLE IF NOT EXISTS group_mappings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    groupName  TEXT UNIQUE NOT NULL,
    role       TEXT NOT NULL,
    division   TEXT,
    department TEXT,
    createdAt  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS group_mapping_scopes (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    mappingId INTEGER NOT NULL REFERENCES group_mappings(id) ON DELETE CASCADE,
    division  TEXT NOT NULL,
    department TEXT
  );

  CREATE TABLE IF NOT EXISTS config_templates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT,
    division    TEXT,
    department  TEXT,
    checks      TEXT NOT NULL DEFAULT '[]',
    createdBy   TEXT,
    createdAt   TEXT NOT NULL,
    updatedAt   TEXT
  );

  CREATE TABLE IF NOT EXISTS agent_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    label       TEXT NOT NULL,
    token       TEXT UNIQUE NOT NULL,
    createdBy   TEXT,
    createdAt   TEXT NOT NULL,
    lastUsedAt  TEXT
  );

  CREATE TABLE IF NOT EXISTS host_links (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    hostname  TEXT NOT NULL,
    label     TEXT NOT NULL,
    url       TEXT NOT NULL,
    createdBy TEXT,
    createdAt TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_host_links_hostname
    ON host_links (hostname);

  CREATE TABLE IF NOT EXISTS host_runbooks (
    hostname  TEXT PRIMARY KEY,
    content   TEXT NOT NULL DEFAULT '',
    updatedBy TEXT,
    updatedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  INSERT OR IGNORE INTO settings (key, value) VALUES
    ('raw_retention_days',     '7'),
    ('fivemin_retention_days', '90'),
    ('hourly_retention_days',  '730'),
    ('daily_retention_years',  '5'),
    ('event_log_retention_days', '365'),
    ('audit_log_retention_days', '365'),
    ('ldap_sync_interval_minutes', '15'),
    ('ldap_sync_enabled', '1'),
    ('alert_email_enabled',  '0'),
    ('alert_email_to',       ''),
    ('alert_email_from',     'nomyx@localhost'),
    ('alert_smtp_host',      ''),
    ('alert_smtp_port',      '25'),
    ('alert_teams_enabled',  '0'),
    ('alert_teams_webhook',  ''),
    ('alert_on_crit',        '1'),
    ('alert_on_unknown',     '1'),
    ('alert_on_recovery',    '1'),
    ('alert_on_warn',        '0');

  CREATE TABLE IF NOT EXISTS audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    actor     TEXT,
    action    TEXT,
    target    TEXT,
    details   TEXT,
    ip        TEXT,
    createdAt TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_audit_created
    ON audit_log (createdAt);

  CREATE INDEX IF NOT EXISTS idx_history_host_check
    ON check_history (hostname, checkName, recordedAt);

  CREATE INDEX IF NOT EXISTS idx_events_host_check
    ON status_events (hostname, checkName, recordedAt);

  CREATE INDEX IF NOT EXISTS idx_notes_host
    ON notes (hostname, createdAt);

  CREATE INDEX IF NOT EXISTS idx_suppressions_host
    ON suppressions (hostname, checkName, startsAt, expiresAt);

  CREATE INDEX IF NOT EXISTS idx_user_scopes_user
    ON user_scopes (userId);

  CREATE INDEX IF NOT EXISTS idx_group_mapping_scopes_mapping
    ON group_mapping_scopes (mappingId);
`);

// ── Migrations ─────────────────────────────────────────────────────────────────


const hostCols = (db.prepare("PRAGMA table_info(hosts)").all() as any[]).map(c => c.name);
if (!hostCols.includes("division"))   db.prepare("ALTER TABLE hosts ADD COLUMN division   TEXT").run();
if (!hostCols.includes("department")) db.prepare("ALTER TABLE hosts ADD COLUMN department TEXT").run();

// Add resolution column to check_history for rollup tracking
const historyCols = (db.prepare("PRAGMA table_info(check_history)").all() as any[]).map(c => c.name);
if (!historyCols.includes("resolution")) db.prepare("ALTER TABLE check_history ADD COLUMN resolution TEXT").run();

// Add lastError column to hosts for surfacing agent errors in the UI
const hostColNames = (db.prepare("PRAGMA table_info(hosts)").all() as any[]).map(c => c.name);
if (!hostColNames.includes("lastError"))        db.prepare("ALTER TABLE hosts ADD COLUMN lastError        TEXT").run();

// ── Seed a base host template (idempotent) ──────────────────────────────────────
const BASE_CHECKS = [
  { name: "cpu",      unit: "%",  warn: 75,  crit: 90,   command: "powershell -command \"Get-WmiObject Win32_Processor | Measure-Object -Property LoadPercentage -Average | Select-Object -ExpandProperty Average\"" },
  { name: "disk_c",   unit: "%",  warn: 80,  crit: 90,   command: "powershell -command \"$d = Get-PSDrive C; [math]::Round($d.Used / ($d.Used + $d.Free) * 100, 1)\"" },
  { name: "memory",   unit: "%",  warn: 80,  crit: 95,   command: "powershell -command \"$os = Get-WmiObject Win32_OperatingSystem; [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize * 100, 1)\"" },
  { name: "pagefile", unit: "%",  warn: 50,  crit: 80,   command: "powershell -command \"$p = Get-WmiObject Win32_PageFileUsage; $a = ($p | Measure-Object AllocatedBaseSize -Sum).Sum; if ($a) { [math]::Round((($p | Measure-Object CurrentUsage -Sum).Sum / $a) * 100, 1) } else { 0 }\"" },
  { name: "conn",     unit: "",   warn: 500, crit: 1000, command: "powershell -command \"(Get-NetTCPConnection -State Established).Count\"" },
];
if (!db.prepare("SELECT 1 FROM config_templates WHERE name = ? LIMIT 1").get("Base host")) {
  const seedNow = new Date().toISOString();
  db.prepare("INSERT INTO config_templates (name, description, division, department, checks, createdBy, createdAt, updatedAt) VALUES (?, ?, null, null, ?, 'system', ?, ?)")
    .run("Base host", "Default checks for every host - CPU, disk, memory, pagefile, connections.", JSON.stringify(BASE_CHECKS), seedNow, seedNow);
  console.log("[seed] Created 'Base host' config template");
}
if (!hostColNames.includes("alertingEnabled"))  db.prepare("ALTER TABLE hosts ADD COLUMN alertingEnabled  INTEGER DEFAULT 1").run();

// Migrate existing single-column scopes into scope tables
const migratedUsers = db.prepare("SELECT id, division, department FROM users WHERE division IS NOT NULL").all() as any[];
for (const u of migratedUsers) {
  const exists = db.prepare("SELECT 1 FROM user_scopes WHERE userId = ? AND division = ?").get(u.id, u.division);
  if (!exists) {
    db.prepare("INSERT INTO user_scopes (userId, division, department) VALUES (?, ?, ?)").run(u.id, u.division, u.department ?? null);
  }
}

const migratedMappings = db.prepare("SELECT id, division, department FROM group_mappings WHERE division IS NOT NULL").all() as any[];
for (const m of migratedMappings) {
  const exists = db.prepare("SELECT 1 FROM group_mapping_scopes WHERE mappingId = ? AND division = ?").get(m.id, m.division);
  if (!exists) {
    db.prepare("INSERT INTO group_mapping_scopes (mappingId, division, department) VALUES (?, ?, ?)").run(m.id, m.division, m.department ?? null);
  }
}

// ── Seed default admin if no users exist ───────────────────────────────────────

const userCount = (db.prepare("SELECT COUNT(*) as count FROM users").get() as any).count;
if (userCount === 0) {
  const hash = bcrypt.hashSync("admin", 10);
  db.prepare(`
    INSERT INTO users (email, displayName, passwordHash, role, authSource, createdAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("admin@nomyx.local", "Administrator", hash, "global_admin", "local", new Date().toISOString());
  console.log("[nomyx] Default admin created — email: admin@nomyx.local  password: admin");
  console.log("[nomyx] Change this password immediately after first login.");
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getUserScopes(userId: number) {
  return db.prepare("SELECT id, division, department FROM user_scopes WHERE userId = ?").all(userId) as any[];
}

function getMappingScopes(mappingId: number) {
  return db.prepare("SELECT id, division, department FROM group_mapping_scopes WHERE mappingId = ?").all(mappingId) as any[];
}

// ── Prepared statements ────────────────────────────────────────────────────────

const insertHost = db.prepare(`
  INSERT INTO hosts (hostname, group_name, ip, division, department, status, lastSeen, checks, intervalSeconds)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(hostname) DO UPDATE SET
    group_name      = excluded.group_name,
    ip              = excluded.ip,
    division        = excluded.division,
    department      = excluded.department,
    status          = excluded.status,
    lastSeen        = excluded.lastSeen,
    checks          = excluded.checks,
    intervalSeconds = excluded.intervalSeconds
`);

const insertHistory = db.prepare(`
  INSERT INTO check_history (hostname, checkName, value, unit, status, recordedAt)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const insertEvent = db.prepare(`
  INSERT INTO status_events (hostname, checkName, fromStatus, toStatus, value, recordedAt)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const getPreviousHost       = db.prepare(`SELECT checks FROM hosts WHERE hostname = ?`);

const getActiveSuppressions = db.prepare(`
  SELECT * FROM suppressions
  WHERE hostname = ?
  AND (checkName = ? OR checkName = 'all')
  AND startsAt <= ?
  AND (expiresAt IS NULL OR expiresAt > ?)
`);

const getHostSuppressions = db.prepare(`
  SELECT * FROM suppressions
  WHERE hostname = ?
  AND startsAt <= ?
  AND (expiresAt IS NULL OR expiresAt > ?)
`);

const insertSuppression = db.prepare(`
  INSERT INTO suppressions (hostname, checkName, reason, suppressedBy, createdAt, startsAt, expiresAt, autoLiftOnOk)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

// ── Interfaces ─────────────────────────────────────────────────────────────────

interface CheckValue {
  name:          string;
  value:         number | string;
  unit:          string;
  warn?:         number;
  crit?:         number;
  thresholdDir?: string;
  status?:       string;
}

interface HostRecord {
  hostname:    string;
  group:       string;
  ip?:         string;
  division?:   string;
  department?: string;
  status:      string;
  lastSeen:    string;
  checks:      CheckValue[];
}

interface Scope {
  division:    string;
  department?: string | null;
}

// ── Role helpers ───────────────────────────────────────────────────────────────

const ADMIN_ROLES    = ["global_admin", "admin"];
const OPERATOR_ROLES = ["global_admin", "admin", "noc", "operator"];

// ── Scope filtering ────────────────────────────────────────────────────────────

function hostMatchesScopes(host: any, scopes: Scope[]): boolean {
  if (scopes.length === 0) return true;              // no scopes = see everything
  if (!host.division)      return true;              // untagged host = visible to all
  return scopes.some(s => {
    if (s.division !== host.division) return false;
    if (s.department && s.department !== host.department) return false;
    return true;
  });
}

// ── Threshold evaluation ───────────────────────────────────────────────────────

function evaluateCheck(check: CheckValue, hostname: string): string {
  const now        = new Date().toISOString();
  const suppressed = getActiveSuppressions.get(hostname, check.name, now, now);
  if (suppressed) return "suppressed";

  if (typeof check.value !== "number") return "ok";
  if (check.warn === undefined || check.crit === undefined) return "ok";

  if (check.thresholdDir === "below") {
    if (check.value <= check.crit) return "crit";
    if (check.value <= check.warn) return "warn";
  } else {
    if (check.value >= check.crit) return "crit";
    if (check.value >= check.warn) return "warn";
  }

  return "ok";
}

// ── Middleware ─────────────────────────────────────────────────────────────────

app.use(express.json());

// Trust an upstream proxy's X-Forwarded-* headers (set TRUST_PROXY when behind a
// reverse proxy / load balancer) so client IPs and HTTPS detection are correct.
if (TRUST_PROXY) app.set("trust proxy", isNaN(Number(TRUST_PROXY)) ? TRUST_PROXY : Number(TRUST_PROXY));

app.use(session({
  store:             new SqlStore({ client: db, expired: { clear: true, intervalMs: 900000 } }),
  secret:            process.env.SESSION_SECRET ?? "nomyx-dev-secret-change-in-production",
  resave:            false,
  saveUninitialized: false,
  cookie: { secure: TRUST_PROXY ? "auto" : USE_HTTPS, httpOnly: true, maxAge: 8 * 60 * 60 * 1000 }
}));

// ── Static frontend (production) ────────────────────────────────────────────────
// When the Vite build output exists, this one process also serves the UI.
// In dev, Vite serves the frontend and proxies /api here, so this stays inert.
const distDir    = path.join(process.cwd(), "dist");
const hasBuiltUI = existsSync(path.join(distDir, "index.html"));
if (hasBuiltUI) {
  app.use(express.static(distDir));
  console.log(`[nomyx] Serving built UI from ${distDir}`);
}

// ── Audit log ──────────────────────────────────────────────────────────────────

function audit(actor: string | null | undefined, action: string, target?: string | null, details?: string | null, ip?: string | null): void {
  try {
    db.prepare("INSERT INTO audit_log (actor, action, target, details, ip, createdAt) VALUES (?, ?, ?, ?, ?, ?)")
      .run(actor ?? "system", action, target ?? null, details ?? null, ip ?? null, new Date().toISOString());
  } catch (e) {
    console.error("[AUDIT] failed to write entry", e);
  }
}

// ── Auth middleware ────────────────────────────────────────────────────────────

function requireAuth(req: any, res: any, next: any): void {
  if (req.session?.user) { next(); return; }
  res.status(401).json({ error: "Not authenticated" });
}

function requireAdmin(req: any, res: any, next: any): void {
  if (ADMIN_ROLES.includes(req.session?.user?.role)) { next(); return; }
  res.status(403).json({ error: "Forbidden" });
}

function requireOperator(req: any, res: any, next: any): void {
  if (OPERATOR_ROLES.includes(req.session?.user?.role)) { next(); return; }
  res.status(403).json({ error: "Forbidden" });
}

// ── Auth routes ────────────────────────────────────────────────────────────────

// ── Login rate limiting ──────────────────────────────────────────────────────────
// Per-IP throttle to blunt brute-force attempts. Counts only failures within a
// rolling window; after the limit the IP is blocked until the window passes.
// In-memory by design — login attempts don't need to survive a restart.

const LOGIN_WINDOW_MS    = 15 * 60 * 1000;  // 15 minutes
const LOGIN_MAX_FAILURES = 10;              // per IP per window
const loginFailures = new Map<string, { count: number; first: number }>();

function loginBlock(ip: string): number {
  const rec = loginFailures.get(ip);
  if (!rec) return 0;
  if (Date.now() - rec.first >= LOGIN_WINDOW_MS) { loginFailures.delete(ip); return 0; }
  if (rec.count >= LOGIN_MAX_FAILURES) return Math.ceil((LOGIN_WINDOW_MS - (Date.now() - rec.first)) / 1000);
  return 0;
}

function loginFailed(ip: string): void {
  const rec = loginFailures.get(ip);
  if (!rec || Date.now() - rec.first >= LOGIN_WINDOW_MS) loginFailures.set(ip, { count: 1, first: Date.now() });
  else rec.count++;
}

function loginOk(ip: string): void { loginFailures.delete(ip); }

// Prune stale entries hourly so the map can't grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of loginFailures) if (now - rec.first >= LOGIN_WINDOW_MS) loginFailures.delete(ip);
}, 60 * 60 * 1000);

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) { res.status(400).json({ error: "Email and password are required" }); return; }

  const ip = req.ip ?? "unknown";
  const blockedFor = loginBlock(ip);
  if (blockedFor > 0) { res.set("Retry-After", String(blockedFor)); res.status(429).json({ error: "Too many login attempts. Try again later." }); return; }

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as any;
  if (!user) { loginFailed(ip); res.status(401).json({ error: "Invalid email or password" }); return; }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) { loginFailed(ip); res.status(401).json({ error: "Invalid email or password" }); return; }

  loginOk(ip);
  db.prepare("UPDATE users SET lastLogin = ? WHERE id = ?").run(new Date().toISOString(), user.id);

  (req.session as any).user = {
    id:          user.id,
    email:       user.email,
    displayName: user.displayName,
    role:        user.role,
    scopes:      getUserScopes(user.id),
  };

  audit(user.displayName, "auth.login", user.email, "local", req.ip);
  res.json({ ok: true, user: (req.session as any).user });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/auth/me", (req, res) => {
  if ((req.session as any)?.user) {
    res.json({ user: (req.session as any).user });
  } else {
    res.status(401).json({ error: "Not authenticated" });
  }
});

app.post("/api/auth/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const userId = (req.session as any).user.id;
  const user   = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
  const valid  = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) { res.status(401).json({ error: "Current password is incorrect" }); return; }
  const hash = await bcrypt.hash(newPassword, 10);
  db.prepare("UPDATE users SET passwordHash = ? WHERE id = ?").run(hash, userId);
  res.json({ ok: true });
});

// ── LDAP auth ──────────────────────────────────────────────────────────────────

app.post("/api/auth/ldap", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) { res.status(400).json({ error: "Username and password are required" }); return; }

  const ip = req.ip ?? "unknown";
  const blockedFor = loginBlock(ip);
  if (blockedFor > 0) { res.set("Retry-After", String(blockedFor)); res.status(429).json({ error: "Too many login attempts. Try again later." }); return; }

  try {
    const ldapUser = await ldapAuthenticate(username, password);
    if (!ldapUser) { loginFailed(ip); res.status(401).json({ error: "Invalid credentials" }); return; }

    // Find matching group mapping
    const allMappings = db.prepare("SELECT * FROM group_mappings").all() as any[];
    let role = ldapUser.role;
    let matchedMappingId: number | null = null;

    for (const mapping of allMappings) {
      if (ldapUser.dn && ldapUser.dn.includes(mapping.groupName)) {
        role             = mapping.role;
        matchedMappingId = mapping.id;
        break;
      }
    }

    const now      = new Date().toISOString();
    const existing = db.prepare("SELECT * FROM users WHERE email = ?").get(ldapUser.email) as any;

    if (existing) {
      db.prepare("UPDATE users SET displayName = ?, role = ?, lastLogin = ? WHERE email = ?")
        .run(ldapUser.displayName, role, now, ldapUser.email);
      // Sync scopes from group mapping
      if (matchedMappingId !== null) {
        db.prepare("DELETE FROM user_scopes WHERE userId = ?").run(existing.id);
        const mappingScopes = getMappingScopes(matchedMappingId);
        for (const s of mappingScopes) {
          db.prepare("INSERT INTO user_scopes (userId, division, department) VALUES (?, ?, ?)").run(existing.id, s.division, s.department ?? null);
        }
      }
    } else {
      db.prepare(`
        INSERT INTO users (email, displayName, passwordHash, role, authSource, createdAt, lastLogin)
        VALUES (?, ?, '', ?, 'ldap', ?, ?)
      `).run(ldapUser.email, ldapUser.displayName, role, now, now);
      audit("system", "user.provision", ldapUser.email, "ldap", req.ip);
      const newUser = db.prepare("SELECT id FROM users WHERE email = ?").get(ldapUser.email) as any;
      if (matchedMappingId !== null) {
        const mappingScopes = getMappingScopes(matchedMappingId);
        for (const s of mappingScopes) {
          db.prepare("INSERT INTO user_scopes (userId, division, department) VALUES (?, ?, ?)").run(newUser.id, s.division, s.department ?? null);
        }
      }
    }

    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(ldapUser.email) as any;
    (req.session as any).user = {
      id:          user.id,
      email:       user.email,
      displayName: user.displayName,
      role:        user.role,
      scopes:      getUserScopes(user.id),
    };

    loginOk(ip);
    audit(user.displayName, "auth.login", user.email, "ldap", req.ip);
    res.json({ ok: true, user: (req.session as any).user });
  } catch (err) {
    console.error("LDAP auth error:", err);
    res.status(500).json({ error: "LDAP authentication failed" });
  }
});

// ── Entra SSO ──────────────────────────────────────────────────────────────────

app.get("/api/auth/entra", async (_req, res) => {
  const url = await getAuthUrl();
  res.json({ url });
});

app.post("/api/auth/entra/callback", async (req, res) => {
  const { code } = req.body;
  if (!code) { res.status(400).json({ error: "No code provided" }); return; }

  try {
    const result      = await handleCallback(code);
    const claims      = result.idTokenClaims as any;
    const email       = claims.email ?? claims.preferred_username;
    const displayName = claims.name ?? email;
    const oid         = claims.oid;

    let user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as any;
    if (!user) {
      db.prepare(`INSERT INTO users (email, displayName, passwordHash, role, authSource, createdAt) VALUES (?, ?, '', 'viewer', 'entra', ?)`)
        .run(email, displayName, new Date().toISOString());
      user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as any;
      console.log(`[entra] Auto-provisioned user: ${email}`);
      audit("system", "user.provision", email, "entra", req.ip);
    }

    db.prepare("UPDATE users SET lastLogin = ? WHERE id = ?").run(new Date().toISOString(), user.id);

    (req.session as any).user = {
      id:          user.id,
      email:       user.email,
      displayName: user.displayName,
      role:        user.role,
      scopes:      getUserScopes(user.id),
      entraOid:    oid,
    };

    audit(user.displayName, "auth.login", user.email, "entra", req.ip);
    res.json({ ok: true, user: (req.session as any).user });
  } catch (err) {
    console.error("[entra] callback error:", err);
    res.status(401).json({ error: "Entra authentication failed" });
  }
});

// ── Org config ─────────────────────────────────────────────────────────────────

app.get("/api/org", requireAuth, (_req, res) => {
  res.json(orgConfig);
});

// ── User management ────────────────────────────────────────────────────────────

app.get("/api/users", requireAuth, requireAdmin, (_req, res) => {
  const users = db.prepare(
    "SELECT id, email, displayName, role, authSource, createdAt, lastLogin FROM users"
  ).all() as any[];
  res.json(users.map(u => ({ ...u, scopes: getUserScopes(u.id) })));
});

app.post("/api/users", requireAuth, requireAdmin, async (req, res) => {
  const { email, displayName, password, role, scopes } = req.body;
  if (!email || !displayName || !password || !role) {
    res.status(400).json({ error: "email, displayName, password, and role are required" });
    return;
  }
  const hash = await bcrypt.hash(password, 10);
  try {
    db.prepare(`
      INSERT INTO users (email, displayName, passwordHash, role, authSource, createdAt)
      VALUES (?, ?, ?, ?, 'local', ?)
    `).run(email, displayName, hash, role, new Date().toISOString());
    const newUser = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as any;
    if (Array.isArray(scopes)) {
      for (const s of scopes) {
        if (s.division) {
          db.prepare("INSERT INTO user_scopes (userId, division, department) VALUES (?, ?, ?)").run(newUser.id, s.division, s.department ?? null);
        }
      }
    }
    audit((req.session as any).user?.displayName, "user.create", email, role, req.ip);
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: "Email already exists" });
  }
});

app.delete("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
  if (parseInt(req.params.id) === (req.session as any).user.id) {
    res.status(400).json({ error: "Cannot delete your own account" });
    return;
  }
  const deletedUser = db.prepare("SELECT email FROM users WHERE id = ?").get(req.params.id) as any;
  db.prepare("DELETE FROM user_scopes WHERE userId = ?").run(req.params.id);
  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  audit((req.session as any).user?.displayName, "user.delete", deletedUser?.email ?? `id:${req.params.id}`, null, req.ip);
  res.json({ ok: true });
});


app.patch("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
  const { displayName, email, role, scopes } = req.body;
  const id = parseInt(req.params.id);
  if (!displayName || !email || !role) {
    res.status(400).json({ error: "displayName, email, and role are required" });
    return;
  }
  try {
    db.prepare("UPDATE users SET displayName = ?, email = ?, role = ? WHERE id = ?")
      .run(displayName, email, role, id);
    if (Array.isArray(scopes)) {
      db.prepare("DELETE FROM user_scopes WHERE userId = ?").run(id);
      for (const s of scopes) {
        if (s.division) {
          db.prepare("INSERT INTO user_scopes (userId, division, department) VALUES (?, ?, ?)")
            .run(id, s.division, s.department ?? null);
        }
      }
    }
    audit((req.session as any).user?.displayName, "user.update", email, role, req.ip);
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: "Email already in use" });
  }
});

// ── User scopes ────────────────────────────────────────────────────────────────

app.get("/api/users/:id/scopes", requireAuth, requireAdmin, (req, res) => {
  res.json(getUserScopes(parseInt(req.params.id)));
});

app.post("/api/users/:id/scopes", requireAuth, requireAdmin, (req, res) => {
  const { division, department } = req.body;
  if (!division) { res.status(400).json({ error: "division is required" }); return; }
  db.prepare("INSERT INTO user_scopes (userId, division, department) VALUES (?, ?, ?)").run(parseInt(req.params.id), division, department ?? null);
  res.json({ ok: true });
});

app.delete("/api/users/:id/scopes/:scopeId", requireAuth, requireAdmin, (req, res) => {
  db.prepare("DELETE FROM user_scopes WHERE id = ? AND userId = ?").run(parseInt(req.params.scopeId), parseInt(req.params.id));
  res.json({ ok: true });
});

// ── Group mappings ─────────────────────────────────────────────────────────────

app.get("/api/group-mappings", requireAuth, requireAdmin, (_req, res) => {
  const mappings = db.prepare("SELECT * FROM group_mappings ORDER BY createdAt ASC").all() as any[];
  res.json(mappings.map(m => ({ ...m, scopes: getMappingScopes(m.id) })));
});

app.post("/api/group-mappings", requireAuth, requireAdmin, (req, res) => {
  const { groupName, role, scopes } = req.body;
  if (!groupName || !role) { res.status(400).json({ error: "groupName and role are required" }); return; }
  try {
    db.prepare(`INSERT INTO group_mappings (groupName, role, division, department, createdAt) VALUES (?, ?, null, null, ?)`)
      .run(groupName, role, new Date().toISOString());
    const mapping = db.prepare("SELECT id FROM group_mappings WHERE groupName = ?").get(groupName) as any;
    if (Array.isArray(scopes)) {
      for (const s of scopes) {
        if (s.division) {
          db.prepare("INSERT INTO group_mapping_scopes (mappingId, division, department) VALUES (?, ?, ?)").run(mapping.id, s.division, s.department ?? null);
        }
      }
    }
    audit((req.session as any).user?.displayName, "mapping.create", groupName, role, req.ip);
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: "Group mapping already exists" });
  }
});

app.delete("/api/group-mappings/:id", requireAuth, requireAdmin, (req, res) => {
  const m = db.prepare("SELECT groupName FROM group_mappings WHERE id = ?").get(req.params.id) as any;
  db.prepare("DELETE FROM group_mapping_scopes WHERE mappingId = ?").run(req.params.id);
  db.prepare("DELETE FROM group_mappings WHERE id = ?").run(req.params.id);
  audit((req.session as any).user?.displayName, "mapping.delete", m?.groupName ?? `id:${req.params.id}`, null, req.ip);
  res.json({ ok: true });
});

// ── Group mapping scopes ───────────────────────────────────────────────────────

app.post("/api/group-mappings/:id/scopes", requireAuth, requireAdmin, (req, res) => {
  const { division, department } = req.body;
  if (!division) { res.status(400).json({ error: "division is required" }); return; }
  db.prepare("INSERT INTO group_mapping_scopes (mappingId, division, department) VALUES (?, ?, ?)").run(parseInt(req.params.id), division, department ?? null);
  res.json({ ok: true });
});

app.delete("/api/group-mappings/:id/scopes/:scopeId", requireAuth, requireAdmin, (req, res) => {
  db.prepare("DELETE FROM group_mapping_scopes WHERE id = ? AND mappingId = ?").run(parseInt(req.params.scopeId), parseInt(req.params.id));
  res.json({ ok: true });
});


// ── Settings ───────────────────────────────────────────────────────────────────

app.get("/api/settings", requireAuth, requireAdmin, (_req, res) => {
  const rows = db.prepare("SELECT key, value FROM settings").all() as any[];
  const obj: Record<string, string> = {};
  for (const r of rows) obj[r.key] = r.value;
  res.json(obj);
});

app.post("/api/settings", requireAuth, requireAdmin, (req, res) => {
  const allowed = ["raw_retention_days", "fivemin_retention_days", "hourly_retention_days", "daily_retention_years", "event_log_retention_days", "ldap_sync_interval_minutes", "ldap_sync_enabled", "alert_email_enabled", "alert_email_to", "alert_email_from", "alert_smtp_host", "alert_smtp_port", "alert_teams_enabled", "alert_teams_webhook", "alert_on_crit", "alert_on_unknown", "alert_on_recovery", "alert_on_warn"];
  const changed: string[] = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, String(req.body[key]));
      changed.push(key);
    }
  }
  if (changed.length) audit((req.session as any).user?.displayName, "settings.update", null, changed.join(", "), req.ip);
  res.json({ ok: true });
});

app.get("/api/settings/stats", requireAuth, requireAdmin, (_req, res) => {
  const totalRows   = (db.prepare("SELECT COUNT(*) as c FROM check_history").get() as any).c;
  const hostCount   = (db.prepare("SELECT COUNT(*) as c FROM hosts").get() as any).c;
  const oldestEvent = (db.prepare("SELECT MIN(recordedAt) as t FROM status_events").get() as any).t;
  res.json({ totalRows, hostCount, oldestEvent });
});

app.post("/api/settings/rollup", requireAuth, requireAdmin, (_req, res) => {
  const deleted = runRollup();
  res.json({ ok: true, deleted });
});

app.post("/api/settings/ldap-sync", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const result = await runLdapSync();
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "LDAP sync failed" });
  }
});

// ── Agent tokens ──────────────────────────────────────────────────────────────────

app.get("/api/agent-tokens", requireAuth, requireAdmin, (_req, res) => {
  res.json(db.prepare("SELECT id, label, createdBy, createdAt, lastUsedAt FROM agent_tokens ORDER BY createdAt ASC").all());
});

app.post("/api/agent-tokens", requireAuth, requireAdmin, (req, res) => {
  const { label } = req.body;
  if (!label) { res.status(400).json({ error: "label is required" }); return; }
  const token = require("crypto").randomBytes(32).toString("hex");
  const user  = (req.session as any).user;
  db.prepare("INSERT INTO agent_tokens (label, token, createdBy, createdAt) VALUES (?, ?, ?, ?)")
    .run(label.trim(), token, user?.displayName ?? "admin", new Date().toISOString());
  audit(user?.displayName, "token.create", label.trim(), null, req.ip);
  res.json({ ok: true, token });
});

app.delete("/api/agent-tokens/:id", requireAuth, requireAdmin, (req, res) => {
  const tok = db.prepare("SELECT label FROM agent_tokens WHERE id = ?").get(req.params.id) as any;
  db.prepare("DELETE FROM agent_tokens WHERE id = ?").run(req.params.id);
  audit((req.session as any).user?.displayName, "token.revoke", tok?.label ?? `id:${req.params.id}`, null, req.ip);
  res.json({ ok: true });
});

// ── Config templates ──────────────────────────────────────────────────────────────

app.get("/api/templates", requireAuth, (_req, res) => {
  const rows = db.prepare("SELECT * FROM config_templates ORDER BY createdAt ASC").all() as any[];
  res.json(rows.map((r: any) => ({ ...r, checks: JSON.parse(r.checks) })));
});

app.post("/api/templates", requireAuth, requireAdmin, (req, res) => {
  const { name, description, division, department, checks } = req.body;
  if (!name) { res.status(400).json({ error: "name is required" }); return; }
  const user = (req.session as any).user;
  const now  = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO config_templates (name, description, division, department, checks, createdBy, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name.trim(), description ?? "", division ?? null, department ?? null,
         JSON.stringify(checks ?? []), user?.displayName ?? "admin", now, now);
  audit(user?.displayName, "template.create", name.trim(), null, req.ip);
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.patch("/api/templates/:id", requireAuth, requireAdmin, (req, res) => {
  const { name, description, division, department, checks } = req.body;
  if (!name) { res.status(400).json({ error: "name is required" }); return; }
  db.prepare(`
    UPDATE config_templates SET name = ?, description = ?, division = ?, department = ?, checks = ?, updatedAt = ? WHERE id = ?
  `).run(name.trim(), description ?? "", division ?? null, department ?? null,
         JSON.stringify(checks ?? []), new Date().toISOString(), req.params.id);
  audit((req.session as any).user?.displayName, "template.update", name.trim(), null, req.ip);
  res.json({ ok: true });
});

app.delete("/api/templates/:id", requireAuth, requireAdmin, (req, res) => {
  const tpl = db.prepare("SELECT name FROM config_templates WHERE id = ?").get(req.params.id) as any;
  db.prepare("DELETE FROM config_templates WHERE id = ?").run(req.params.id);
  audit((req.session as any).user?.displayName, "template.delete", tpl?.name ?? `id:${req.params.id}`, null, req.ip);
  res.json({ ok: true });
});

// ── Audit log endpoint ──────────────────────────────────────────────────────────

app.get("/api/audit", requireAuth, requireAdmin, (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit as string) || 250, 1000);
  const action = (req.query.action as string) || "";
  const search = (req.query.search as string) || "";
  const where: string[] = [];
  const params: any[] = [];
  if (action) { where.push("action = ?"); params.push(action); }
  if (search) {
    where.push("(actor LIKE ? OR target LIKE ? OR details LIKE ?)");
    const q = `%${search}%`; params.push(q, q, q);
  }
  let sql = "SELECT id, actor, action, target, details, ip, createdAt FROM audit_log";
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY createdAt DESC LIMIT ?";
  params.push(limit);
  res.json(db.prepare(sql).all(...params));
});

// ── Alert test endpoints ──────────────────────────────────────────────────────────

app.post("/api/settings/test-email", requireAuth, requireAdmin, async (_req, res) => {
  try {
    await sendAlert({ hostname: "test-host", checkName: "test", fromStatus: "ok", toStatus: "crit", value: 99 }, true);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed to send test email" });
  }
});

app.post("/api/settings/test-teams", requireAuth, requireAdmin, async (_req, res) => {
  try {
    await sendTeamsAlert({ hostname: "test-host", checkName: "test", fromStatus: "ok", toStatus: "crit", value: 99 }, true);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed to send test Teams message" });
  }
});

// ── Health ─────────────────────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ── Status endpoint (no auth — agents post here) ───────────────────────────────

app.post("/api/status", (req, res) => {
  // Token authentication — peek at hostname first so we can surface errors in the UI
  const authHeader = req.headers["authorization"] ?? "";
  const token      = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const hostname   = req.body?.host ?? null;

  if (!token) {
    if (hostname) db.prepare("UPDATE hosts SET lastError = ? WHERE hostname = ?").run("Missing agent token — add a token to config.json", hostname);
    console.warn(`[AUTH] Rejected status post from ${hostname ?? "unknown"} — no token`);
    res.status(401).json({ error: "Missing agent token" }); return;
  }

  const tokenRow = db.prepare("SELECT id FROM agent_tokens WHERE token = ?").get(token) as any;
  if (!tokenRow) {
    if (hostname) db.prepare("UPDATE hosts SET lastError = ? WHERE hostname = ?").run("Invalid agent token — check token in config.json", hostname);
    console.warn(`[AUTH] Rejected status post from ${hostname ?? "unknown"} — invalid token`);
    res.status(401).json({ error: "Invalid agent token" }); return;
  }

  // Valid token — clear any previous error and update last used
  if (hostname) db.prepare("UPDATE hosts SET lastError = NULL WHERE hostname = ?").run(hostname);
  db.prepare("UPDATE agent_tokens SET lastUsedAt = ? WHERE id = ?").run(new Date().toISOString(), tokenRow.id);

  const payload = req.body;
  if (!payload.host || !Array.isArray(payload.checks)) {
    res.status(400).json({ error: "host and checks are required" });
    return;
  }

  const evaluated = payload.checks.map((check: CheckValue) => ({
    ...check,
    status: evaluateCheck(check, payload.host)
  }));

  const worstStatus = evaluated.reduce((worst: string, check: CheckValue) => {
    if (check.status === "crit") return "crit";
    if (check.status === "warn"       && worst !== "crit") return "warn";
    if (check.status === "suppressed" && worst !== "crit" && worst !== "warn") return "suppressed";
    return worst;
  }, "ok");

  const record: HostRecord = {
    hostname:   payload.host,
    group:      payload.group      ?? "default",
    ip:         payload.ip,
    division:   payload.division   ?? null,
    department: payload.department ?? null,
    status:     worstStatus,
    lastSeen:   new Date().toISOString(),
    checks:     evaluated,
  };

  const previousRecord = getPreviousHost.get(record.hostname) as any;

  insertHost.run(
    record.hostname, record.group, record.ip ?? null,
    record.division ?? null, record.department ?? null,
    record.status, record.lastSeen,
    JSON.stringify(record.checks), payload.intervalSeconds ?? 600
  );

  for (const check of evaluated) {
    insertHistory.run(
      record.hostname, check.name,
      typeof check.value === "number" ? check.value : null,
      check.unit, check.status, record.lastSeen
    );

    if (previousRecord) {
      const prevChecks = JSON.parse(previousRecord.checks) as CheckValue[];
      const prevCheck  = prevChecks.find(c => c.name === check.name);
      if (prevCheck && prevCheck.status !== check.status) {
        insertEvent.run(
          record.hostname, check.name,
          prevCheck.status, check.status,
          typeof check.value === "number" ? check.value : null,
          record.lastSeen
        );
        // Fire alert if configured and host has alerting enabled
        const hostRow = db.prepare("SELECT alertingEnabled FROM hosts WHERE hostname = ?").get(record.hostname) as any;
        if (hostRow?.alertingEnabled !== 0 && shouldAlert(prevCheck.status ?? "unknown", check.status ?? "unknown")) {
          const alertEvt = {
            hostname:   record.hostname,
            checkName:  check.name,
            fromStatus: prevCheck.status ?? "unknown",
            toStatus:   check.status    ?? "unknown",
            value:      typeof check.value === "number" ? check.value : null,
          };
          void sendEmailAlert(alertEvt).catch(e => console.error("[alert] email failed:", e?.message));
          void sendTeamsAlert(alertEvt).catch(e => console.error("[alert] teams failed:", e?.message));
        }
      }
    }
  }

  console.log(`[${record.status.toUpperCase()}] ${record.hostname} — ${evaluated.length} checks`);
  res.json({ ok: true, status: worstStatus });
});

// ── Protected routes ───────────────────────────────────────────────────────────

app.get("/api/hosts", requireAuth, (req, res) => {
  const sessionUser = (req.session as any).user;
  const scopes      = (sessionUser.scopes ?? []) as Scope[];
  const rows        = db.prepare("SELECT * FROM hosts").all() as any[];
  const hosts       = rows
    .map(row => ({ ...row, group: row.group_name, checks: JSON.parse(row.checks) }))
    .filter(h => hostMatchesScopes(h, scopes));
  res.json(hosts.map(h => ({ ...h, lastError: h.lastError ?? null, alertingEnabled: h.alertingEnabled !== 0 })));
});

app.get("/api/hosts/:hostname", requireAuth, (req, res) => {
  const row = db.prepare("SELECT * FROM hosts WHERE hostname = ?").get(req.params.hostname) as any;
  if (!row) { res.status(404).json({ error: "Host not found" }); return; }
  const sessionUser = (req.session as any).user;
  const scopes      = (sessionUser.scopes ?? []) as Scope[];
  const host        = { ...row, group: row.group_name, checks: JSON.parse(row.checks) };
  if (!hostMatchesScopes(host, scopes)) { res.status(403).json({ error: "Forbidden" }); return; }
  res.json({ ...host, alertingEnabled: host.alertingEnabled !== 0 });
});

app.delete("/api/hosts/:hostname", requireAuth, requireAdmin, (req, res) => {
  const { hostname } = req.params;
  const removeHostCascade = db.transaction((h: string) => {
    db.prepare("DELETE FROM hosts         WHERE hostname = ?").run(h);
    db.prepare("DELETE FROM check_history WHERE hostname = ?").run(h);
    db.prepare("DELETE FROM status_events WHERE hostname = ?").run(h);
    db.prepare("DELETE FROM notes         WHERE hostname = ?").run(h);
    db.prepare("DELETE FROM suppressions  WHERE hostname = ?").run(h);
    db.prepare("DELETE FROM host_links    WHERE hostname = ?").run(h);
    db.prepare("DELETE FROM host_runbooks WHERE hostname = ?").run(h);
  });
  removeHostCascade(hostname);
  console.log(`[REMOVED] ${hostname} and all associated data`);
  audit((req.session as any).user?.displayName, "host.delete", hostname, null, req.ip);
  res.json({ ok: true });
});

// ── Host links ─────────────────────────────────────────────────────────────────

app.get("/api/hosts/:hostname/links", requireAuth, (req, res) => {
  const links = db.prepare("SELECT * FROM host_links WHERE hostname = ? ORDER BY createdAt ASC").all(req.params.hostname);
  res.json(links);
});

app.post("/api/hosts/:hostname/links", requireAuth, requireAdmin, (req, res) => {
  const { label, url } = req.body;
  if (!label || !url) { res.status(400).json({ error: "label and url are required" }); return; }
  const user = (req.session as any).user;
const normalizedUrl = url.trim().match(/^https?:\/\//) ? url.trim() : `https://${url.trim()}`;
  db.prepare("INSERT INTO host_links (hostname, label, url, createdBy, createdAt) VALUES (?, ?, ?, ?, ?)")
    .run(req.params.hostname, label.trim(), normalizedUrl, user?.displayName ?? "admin", new Date().toISOString());
  res.json({ ok: true });
});

app.delete("/api/hosts/:hostname/links/:id", requireAuth, requireAdmin, (req, res) => {
  db.prepare("DELETE FROM host_links WHERE id = ? AND hostname = ?").run(parseInt(req.params.id), req.params.hostname);
  res.json({ ok: true });
});

// ── Host runbook ───────────────────────────────────────────────────────────────

app.get("/api/hosts/:hostname/runbook", requireAuth, (req, res) => {
  const row = db.prepare("SELECT content, updatedBy, updatedAt FROM host_runbooks WHERE hostname = ?").get(req.params.hostname) as any;
  res.json(row ?? { content: "", updatedBy: null, updatedAt: null });
});

app.put("/api/hosts/:hostname/runbook", requireAuth, requireOperator, (req, res) => {
  const { content } = req.body;
  if (typeof content !== "string") { res.status(400).json({ error: "content is required" }); return; }
  const user = (req.session as any).user;
  const now  = new Date().toISOString();
  db.prepare(`
    INSERT INTO host_runbooks (hostname, content, updatedBy, updatedAt)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(hostname) DO UPDATE SET
      content   = excluded.content,
      updatedBy = excluded.updatedBy,
      updatedAt = excluded.updatedAt
  `).run(req.params.hostname, content, user?.displayName ?? "unknown", now);
  res.json({ ok: true, updatedBy: user?.displayName ?? "unknown", updatedAt: now });
});

app.patch("/api/hosts/:hostname/alerting", requireAuth, requireAdmin, (req, res) => {
  const { enabled } = req.body;
  if (enabled === undefined) { res.status(400).json({ error: "enabled is required" }); return; }
  db.prepare("UPDATE hosts SET alertingEnabled = ? WHERE hostname = ?").run(enabled ? 1 : 0, req.params.hostname);
  res.json({ ok: true });
});

app.get("/api/history/:hostname/:checkName/all", requireAuth, (req, res) => {
  const { hostname, checkName } = req.params;
  const ranges:  Record<string, number> = { "1h": 1, "24h": 24, "7d": 168, "30d": 720, "6mo": 4380, "1y": 8760 };
  const maxBars: Record<string, number> = { "1h": 12, "24h": 24, "7d": 28, "30d": 30, "6mo": 26, "1y": 24 };
  const result: Record<string, any>     = {};

  for (const [range, hoursBack] of Object.entries(ranges)) {
    const since         = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
    const bucketMinutes = Math.ceil((hoursBack * 60) / maxBars[range]);
    result[range] = db.prepare(`
      SELECT
        CASE MAX(CASE status WHEN 'crit' THEN 5 WHEN 'warn' THEN 4 WHEN 'unknown' THEN 3 WHEN 'suppressed' THEN 2 WHEN 'ok' THEN 1 ELSE 3 END) WHEN 5 THEN 'crit' WHEN 4 THEN 'warn' WHEN 3 THEN 'unknown' WHEN 2 THEN 'suppressed' ELSE 'ok' END as status,
        ROUND(AVG(value), 1) as value, unit, MIN(recordedAt) as recordedAt
      FROM check_history
      WHERE hostname = ? AND checkName = ? AND recordedAt >= ?
      GROUP BY (strftime('%s', recordedAt) / (? * 60))
      ORDER BY recordedAt ASC
    `).all(hostname, checkName, since, bucketMinutes);
  }

  const events = db.prepare(`
    SELECT fromStatus, toStatus, value, recordedAt FROM status_events
    WHERE hostname = ? AND checkName = ? ORDER BY recordedAt DESC LIMIT 50
  `).all(hostname, checkName);

  const notes = db.prepare(`
    SELECT note, createdBy, createdAt FROM notes
    WHERE hostname = ? AND (checkName = ? OR checkName IS NULL)
    ORDER BY createdAt DESC LIMIT 50
  `).all(hostname, checkName);

  const hostRow = db.prepare("SELECT checks FROM hosts WHERE hostname = ?").get(hostname) as any;
  let thresholds: { warn: number | null; crit: number | null; dir: string } | null = null;
  if (hostRow?.checks) {
    try {
      const chk = (JSON.parse(hostRow.checks) as any[]).find((c) => c.name === checkName);
      if (chk && (chk.warn !== undefined || chk.crit !== undefined)) {
        thresholds = { warn: chk.warn ?? null, crit: chk.crit ?? null, dir: chk.thresholdDir ?? "above" };
      }
    } catch { /* ignore malformed checks json */ }
  }
  res.json({ ranges: result, events, notes, thresholds });
});

app.get("/api/history/:hostname/:checkName", requireAuth, (req, res) => {
  const { hostname, checkName } = req.params;
  const range         = (req.query.range as string) ?? "24h";
  const hours:   Record<string, number> = { "1h": 1, "24h": 24, "7d": 168, "30d": 720, "6mo": 4380, "1y": 8760 };
  const maxBars: Record<string, number> = { "1h": 12, "24h": 24, "7d": 28, "30d": 30, "6mo": 26, "1y": 24 };
  const hoursBack     = hours[range] ?? 24;
  const since         = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
  const bucketMinutes = Math.ceil((hoursBack * 60) / (maxBars[range] ?? 24));

  const history = db.prepare(`
    SELECT
      CASE MAX(CASE status WHEN 'crit' THEN 5 WHEN 'warn' THEN 4 WHEN 'unknown' THEN 3 WHEN 'suppressed' THEN 2 WHEN 'ok' THEN 1 ELSE 3 END) WHEN 5 THEN 'crit' WHEN 4 THEN 'warn' WHEN 3 THEN 'unknown' WHEN 2 THEN 'suppressed' ELSE 'ok' END as status,
      ROUND(AVG(value), 1) as value, unit, MIN(recordedAt) as recordedAt
    FROM check_history
    WHERE hostname = ? AND checkName = ? AND recordedAt >= ?
    GROUP BY (strftime('%s', recordedAt) / (? * 60))
    ORDER BY recordedAt ASC
  `).all(hostname, checkName, since, bucketMinutes);

  const events = db.prepare(`
    SELECT fromStatus, toStatus, value, recordedAt FROM status_events
    WHERE hostname = ? AND checkName = ? AND recordedAt >= ?
    ORDER BY recordedAt DESC LIMIT 50
  `).all(hostname, checkName, since);

  const notes = db.prepare(`
    SELECT note, createdBy, createdAt FROM notes
    WHERE hostname = ? AND (checkName = ? OR checkName IS NULL) AND createdAt >= ?
    ORDER BY createdAt DESC LIMIT 50
  `).all(hostname, checkName, since);

  res.json({ history, events, notes });
});

app.post("/api/notes", requireAuth, requireOperator, (req, res) => {
  const { hostname, checkName, note, createdBy } = req.body;
  if (!hostname || !note) { res.status(400).json({ error: "hostname and note are required" }); return; }
  db.prepare(`INSERT INTO notes (hostname, checkName, note, createdBy, createdAt) VALUES (?, ?, ?, ?, ?)`)
    .run(hostname, checkName ?? null, note, createdBy ?? "anonymous", new Date().toISOString());
  res.json({ ok: true });
});

app.get("/api/suppressions/:hostname", requireAuth, (req, res) => {
  const now = new Date().toISOString();
  res.json(getHostSuppressions.all(req.params.hostname, now, now));
});

app.post("/api/suppressions", requireAuth, requireOperator, (req, res) => {
  const { hostname, checks, reason, suppressedBy, startsAt, expiresAt, autoLiftOnOk } = req.body;
  if (!hostname || !checks || !reason) { res.status(400).json({ error: "hostname, checks, and reason are required" }); return; }
  if (!reason.trim()) { res.status(400).json({ error: "reason cannot be empty" }); return; }

  const now   = new Date().toISOString();
  const start = startsAt ?? now;

  for (const checkName of checks) {
    insertSuppression.run(hostname, checkName, reason.trim(), suppressedBy ?? "anonymous", now, start, expiresAt ?? null, autoLiftOnOk ? 1 : 0);
  }

  db.prepare(`INSERT INTO notes (hostname, checkName, note, createdBy, createdAt) VALUES (?, ?, ?, ?, ?)`)
    .run(hostname, checks.join(", "), `[Suppressed] ${reason.trim()}`, suppressedBy ?? "anonymous", now);

  console.log(`[SUPPRESS] ${hostname} — ${checks.join(", ")} — ${reason}`);
  res.json({ ok: true });
});

app.delete("/api/suppressions/:id", requireAuth, requireOperator, (req, res) => {
  const sup = db.prepare("SELECT * FROM suppressions WHERE id = ?").get(req.params.id) as any;
  if (sup) {
    db.prepare(`INSERT INTO notes (hostname, checkName, note, createdBy, createdAt) VALUES (?, ?, ?, ?, ?)`)
      .run(sup.hostname, sup.checkName, `[Suppression lifted] ${sup.reason}`, (req.session as any).user?.displayName ?? "user", new Date().toISOString());
  }
  db.prepare("DELETE FROM suppressions WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ── Stale detection ────────────────────────────────────────────────────────────

setInterval(() => {
  const hosts = db.prepare("SELECT hostname, lastSeen, intervalSeconds FROM hosts").all() as any[];
  const now   = Date.now();
  for (const host of hosts) {
    const msSince = now - new Date(host.lastSeen).getTime();
    if (msSince > (host.intervalSeconds ?? 600) * 1000 * 1.5) {
      db.prepare(`UPDATE hosts SET status = 'unknown' WHERE hostname = ? AND status != 'unknown'`).run(host.hostname);
    }
  }
}, 60 * 1000);

// ── Suppression expiry ─────────────────────────────────────────────────────────

setInterval(() => {
  const now = new Date().toISOString();
  db.prepare(`DELETE FROM suppressions WHERE expiresAt IS NOT NULL AND expiresAt <= ?`).run(now);

  const active = db.prepare(`
    SELECT s.id, s.hostname, s.checkName FROM suppressions s
    WHERE s.autoLiftOnOk = 1 AND s.startsAt <= ? AND (s.expiresAt IS NULL OR s.expiresAt > ?)
  `).all(now, now) as any[];

  for (const sup of active) {
    const host = db.prepare("SELECT checks FROM hosts WHERE hostname = ?").get(sup.hostname) as any;
    if (!host) continue;
    const check = (JSON.parse(host.checks) as CheckValue[]).find(c => c.name === sup.checkName);
    if (check?.status === "ok") {
      db.prepare("DELETE FROM suppressions WHERE id = ?").run(sup.id);
      console.log(`[LIFTED] ${sup.hostname} ${sup.checkName} returned to OK`);
    }
  }
}, 60 * 1000);


// ── Data rollup ────────────────────────────────────────────────────────────────

function getSetting(key: string, fallback: number): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as any;
  return row ? parseInt(row.value) || fallback : fallback;
}

function runRollup(): number {
  let deleted = 0;
  const now = Date.now();

  const rawDays    = getSetting("raw_retention_days",     7);
  const fiveMinDays = getSetting("fivemin_retention_days", 90);
  const hourlyDays  = getSetting("hourly_retention_days",  730);
  const dailyYears  = getSetting("daily_retention_years",  5);
  const eventLogDays = getSetting("event_log_retention_days", 365);
  const auditDays    = getSetting("audit_log_retention_days", 365);

  const rawCutoff      = new Date(now - rawDays     * 86400000).toISOString();
  const fiveMinCutoff  = new Date(now - fiveMinDays * 86400000).toISOString();
  const hourlyCutoff   = new Date(now - hourlyDays  * 86400000).toISOString();
  const dailyCutoff    = new Date(now - dailyYears  * 365 * 86400000).toISOString();
  const eventLogCutoff = new Date(now - eventLogDays * 86400000).toISOString();
  const auditCutoff    = new Date(now - auditDays * 86400000).toISOString();

  // ── Step 1: Roll raw → 5-min buckets (rows older than rawCutoff, newer than fiveMinCutoff) ──
  const rawToRoll = db.prepare(`
    SELECT hostname, checkName, unit,
      strftime('%s', recordedAt) / 300 AS bucket,
      CASE MAX(CASE status WHEN 'crit' THEN 5 WHEN 'warn' THEN 4 WHEN 'unknown' THEN 3 WHEN 'suppressed' THEN 2 WHEN 'ok' THEN 1 ELSE 3 END) WHEN 5 THEN 'crit' WHEN 4 THEN 'warn' WHEN 3 THEN 'unknown' WHEN 2 THEN 'suppressed' ELSE 'ok' END AS status,
      ROUND(AVG(value), 2) AS value,
      MIN(recordedAt) AS recordedAt
    FROM check_history
    WHERE recordedAt < ? AND recordedAt >= ? AND resolution IS NULL
    GROUP BY hostname, checkName, bucket
  `).all(rawCutoff, fiveMinCutoff) as any[];

  const insert5min = db.prepare(`
    INSERT OR IGNORE INTO check_history (hostname, checkName, value, unit, status, recordedAt, resolution)
    VALUES (?, ?, ?, ?, ?, ?, '5min')
  `);

  const rollTx = db.transaction(() => {
    for (const r of rawToRoll) {
      insert5min.run(r.hostname, r.checkName, r.value, r.unit, r.status, r.recordedAt);
    }
    const res = db.prepare(`
      DELETE FROM check_history WHERE recordedAt < ? AND resolution IS NULL
    `).run(rawCutoff);
    deleted += res.changes;
  });
  rollTx();

  // ── Step 2: Roll 5-min → hourly (rows older than fiveMinCutoff, newer than hourlyCutoff) ──
  const fiveToRoll = db.prepare(`
    SELECT hostname, checkName, unit,
      strftime('%s', recordedAt) / 3600 AS bucket,
      CASE MAX(CASE status WHEN 'crit' THEN 5 WHEN 'warn' THEN 4 WHEN 'unknown' THEN 3 WHEN 'suppressed' THEN 2 WHEN 'ok' THEN 1 ELSE 3 END) WHEN 5 THEN 'crit' WHEN 4 THEN 'warn' WHEN 3 THEN 'unknown' WHEN 2 THEN 'suppressed' ELSE 'ok' END AS status,
      ROUND(AVG(value), 2) AS value,
      MIN(recordedAt) AS recordedAt
    FROM check_history
    WHERE recordedAt < ? AND recordedAt >= ? AND resolution = '5min'
    GROUP BY hostname, checkName, bucket
  `).all(fiveMinCutoff, hourlyCutoff) as any[];

  const insertHourly = db.prepare(`
    INSERT OR IGNORE INTO check_history (hostname, checkName, value, unit, status, recordedAt, resolution)
    VALUES (?, ?, ?, ?, ?, ?, 'hourly')
  `);

  const rollHourlyTx = db.transaction(() => {
    for (const r of fiveToRoll) {
      insertHourly.run(r.hostname, r.checkName, r.value, r.unit, r.status, r.recordedAt);
    }
    const res = db.prepare(`
      DELETE FROM check_history WHERE recordedAt < ? AND resolution = '5min'
    `).run(fiveMinCutoff);
    deleted += res.changes;
  });
  rollHourlyTx();

  // ── Step 3: Roll hourly → daily (rows older than hourlyCutoff, newer than dailyCutoff) ──
  const hourlyToRoll = db.prepare(`
    SELECT hostname, checkName, unit,
      strftime('%s', recordedAt) / 86400 AS bucket,
      CASE MAX(CASE status WHEN 'crit' THEN 5 WHEN 'warn' THEN 4 WHEN 'unknown' THEN 3 WHEN 'suppressed' THEN 2 WHEN 'ok' THEN 1 ELSE 3 END) WHEN 5 THEN 'crit' WHEN 4 THEN 'warn' WHEN 3 THEN 'unknown' WHEN 2 THEN 'suppressed' ELSE 'ok' END AS status,
      ROUND(AVG(value), 2) AS value,
      MIN(recordedAt) AS recordedAt
    FROM check_history
    WHERE recordedAt < ? AND recordedAt >= ? AND resolution = 'hourly'
    GROUP BY hostname, checkName, bucket
  `).all(hourlyCutoff, dailyCutoff) as any[];

  const insertDaily = db.prepare(`
    INSERT OR IGNORE INTO check_history (hostname, checkName, value, unit, status, recordedAt, resolution)
    VALUES (?, ?, ?, ?, ?, ?, 'daily')
  `);

  const rollDailyTx = db.transaction(() => {
    for (const r of hourlyToRoll) {
      insertDaily.run(r.hostname, r.checkName, r.value, r.unit, r.status, r.recordedAt);
    }
    const res = db.prepare(`
      DELETE FROM check_history WHERE recordedAt < ? AND resolution = 'hourly'
    `).run(hourlyCutoff);
    deleted += res.changes;
  });
  rollDailyTx();

  // ── Step 4: Purge daily rows older than dailyCutoff ──
  const purgeDailyRes = db.prepare(`
    DELETE FROM check_history WHERE recordedAt < ? AND resolution = 'daily'
  `).run(dailyCutoff);
  deleted += purgeDailyRes.changes;

  // ── Step 5: Purge status_events older than the event-log retention window ──
  const purgeEventsRes = db.prepare(`
    DELETE FROM status_events WHERE recordedAt < ?
  `).run(eventLogCutoff);
  const eventsPurged = purgeEventsRes.changes;

  // ── Step 6: Purge audit_log entries older than the audit retention window ──
  const purgeAuditRes = db.prepare(`
    DELETE FROM audit_log WHERE createdAt < ?
  `).run(auditCutoff);
  const auditPurged = purgeAuditRes.changes;

  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_rollup_run', ?)").run(new Date().toISOString());
  console.log(`[ROLLUP] Complete — ${deleted} rows compacted, ${eventsPurged} events, ${auditPurged} audit entries purged`);
  return deleted;
}

// ── Alerting ──────────────────────────────────────────────────────────────────────

interface AlertEvent {
  hostname:   string;
  checkName:  string;
  fromStatus: string;
  toStatus:   string;
  value:      number | null;
}

function getStr(key: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as any;
  return row?.value ?? "";
}

async function sendEmailAlert(evt: AlertEvent, isTest = false): Promise<void> {
  const host    = getStr("alert_smtp_host");
  const port    = parseInt(getStr("alert_smtp_port")) || 25;
  const from    = getStr("alert_email_from") || "nomyx@localhost";
  const to      = getStr("alert_email_to");
  if (!host || !to) throw new Error("SMTP host and recipient email are required");

  const transporter = nodemailer.createTransport({ host, port, secure: false });

  const subject = isTest
    ? "[Nomyx] Test alert"
    : `[Nomyx] ${evt.hostname} — ${evt.checkName} is ${evt.toStatus.toUpperCase()}`;

  const text = isTest
    ? "This is a test alert from Nomyx. Email alerting is configured correctly."
    : `Host: ${evt.hostname}\nCheck: ${evt.checkName}\nStatus change: ${evt.fromStatus} → ${evt.toStatus}${evt.value !== null ? `\nValue: ${evt.value}` : ""}\nTime: ${new Date().toLocaleString()}`;

  await transporter.sendMail({ from, to, subject, text });
  console.log(`[alert] Email sent to ${to} — ${subject}`);
}

async function sendTeamsAlert(evt: AlertEvent, isTest = false): Promise<void> {
  const webhook = getStr("alert_teams_webhook");
  if (!webhook) throw new Error("Teams webhook URL is required");

  const statusColor: Record<string, string> = {
    crit:       "FF4444",
    warn:       "F59E0B",
    ok:         "4ADE80",
    unknown:    "A855F7",
    suppressed: "60A5FA",
  };

  const color = statusColor[evt.toStatus] ?? "888888";
  const title = isTest ? "Nomyx Test Alert" : `${evt.hostname} — ${evt.checkName} is ${evt.toStatus.toUpperCase()}`;
  const text  = isTest
    ? "This is a test alert from Nomyx. Teams alerting is configured correctly."
    : `**Status change:** ${evt.fromStatus} → ${evt.toStatus}${evt.value !== null ? `  \n**Value:** ${evt.value}` : ""}  \n**Time:** ${new Date().toLocaleString()}`;

  const body = {
    "@type":      "MessageCard",
    "@context":   "http://schema.org/extensions",
    themeColor:   color,
    summary:      title,
    sections: [{ activityTitle: title, activityText: text }],
  };

  const res = await fetch(webhook, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Teams webhook returned ${res.status}`);
  console.log(`[alert] Teams message sent — ${title}`);
}

async function sendAlert(evt: AlertEvent, isTest = false): Promise<void> {
  const emailEnabled = getStr("alert_email_enabled") === "1";
  if (emailEnabled) await sendEmailAlert(evt, isTest);
}

function shouldAlert(fromStatus: string, toStatus: string): boolean {
  if (toStatus === "crit"    && getStr("alert_on_crit")     === "1") return true;
  if (toStatus === "unknown" && getStr("alert_on_unknown")  === "1") return true;
  if (toStatus === "warn"    && getStr("alert_on_warn")     === "1") return true;
  if (toStatus === "ok" && fromStatus !== "ok" && getStr("alert_on_recovery") === "1") return true;
  return false;
}

// Schedule rollup nightly at 2am
function scheduleNightlyRollup() {
  const now    = new Date();
  const next2am = new Date(now);
  next2am.setHours(2, 0, 0, 0);
  if (next2am <= now) next2am.setDate(next2am.getDate() + 1);
  const msUntil = next2am.getTime() - now.getTime();
  setTimeout(() => {
    runRollup();
    setInterval(runRollup, 24 * 60 * 60 * 1000);
  }, msUntil);
  console.log(`[ROLLUP] Scheduled for ${next2am.toLocaleTimeString()}`);
}

scheduleNightlyRollup();


// ── LDAP background sync ───────────────────────────────────────────────────────

let ldapSyncTimer: ReturnType<typeof setInterval> | null = null;

async function runLdapSync(): Promise<{ synced: number; errors: number; skipped: number }> {
  const enabledRow = db.prepare("SELECT value FROM settings WHERE key = ?").get("ldap_sync_enabled") as any;
  if (enabledRow && enabledRow.value === "0") {
    console.log("[ldap-sync] Disabled, skipping");
    return { synced: 0, errors: 0, skipped: 0 };
  }

  const ldapUsers = db.prepare("SELECT id, email, displayName, role FROM users WHERE authSource = 'ldap'").all() as any[];
  if (ldapUsers.length === 0) {
    console.log("[ldap-sync] No LDAP users to sync");
    return { synced: 0, errors: 0, skipped: 0 };
  }

  const allMappings = db.prepare("SELECT * FROM group_mappings").all() as any[];
  let synced = 0, errors = 0, skipped = 0;

  for (const localUser of ldapUsers) {
    try {
      const ldapUser = await ldapLookupUser(localUser.email);

      if (!ldapUser) {
        skipped++;
        continue;
      }

      // Match against group mappings (same logic as login)
      let role = ldapUser.role;
      let matchedMappingId: number | null = null;

      for (const mapping of allMappings) {
        if (ldapUser.dn && ldapUser.dn.includes(mapping.groupName)) {
          role             = mapping.role;
          matchedMappingId = mapping.id;
          break;
        }
      }

      // Also check group names directly against mapping groupNames
      if (matchedMappingId === null) {
        for (const mapping of allMappings) {
          if (ldapUser.groups.includes(mapping.groupName)) {
            role             = mapping.role;
            matchedMappingId = mapping.id;
            break;
          }
        }
      }

      // Update role and display name
      const changed = localUser.role !== role || localUser.displayName !== ldapUser.displayName;
      if (changed) {
        db.prepare("UPDATE users SET displayName = ?, role = ? WHERE id = ?")
          .run(ldapUser.displayName, role, localUser.id);
      }

      // Sync scopes from group mapping
      if (matchedMappingId !== null) {
        db.prepare("DELETE FROM user_scopes WHERE userId = ?").run(localUser.id);
        const mappingScopes = getMappingScopes(matchedMappingId);
        for (const s of mappingScopes) {
          db.prepare("INSERT INTO user_scopes (userId, division, department) VALUES (?, ?, ?)")
            .run(localUser.id, s.division, s.department ?? null);
        }
      }

      synced++;
    } catch {
      errors++;
    }
  }

  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_ldap_sync', ?)").run(new Date().toISOString());
  console.log(`[ldap-sync] Complete — synced: ${synced}, skipped: ${skipped}, errors: ${errors}`);
  return { synced, errors, skipped };
}

function scheduleLdapSync() {
  if (ldapSyncTimer) clearInterval(ldapSyncTimer);
  const minutes = getSetting("ldap_sync_interval_minutes", 15);
  const ms = minutes * 60 * 1000;
  ldapSyncTimer = setInterval(() => { void runLdapSync(); }, ms);
  console.log(`[ldap-sync] Scheduled every ${minutes} minutes`);
}

// Start LDAP sync on boot (first run after 30 seconds, then on interval)
setTimeout(() => {
  void runLdapSync();
  scheduleLdapSync();
}, 30000);

// ── Agent downloads ─────────────────────────────────────────────────────────────
// Admin-only. Serves the bundled agent binaries and generates a ready-to-run
// config.json (this server's URL + a freshly minted token) so a host just drops the
// two files in a folder and runs — no editing. Registered before the SPA fallback so
// /agent/* isn't swallowed by the catch-all.
const agentDir = path.join(process.cwd(), "agent");
app.use("/agent", requireAuth, requireAdmin, express.static(agentDir));

const AGENT_WIN_CHECKS = [
  { name: "cpu",    command: "powershell -command \"Get-WmiObject Win32_Processor | Measure-Object -Property LoadPercentage -Average | Select-Object -ExpandProperty Average\"", unit: "%", warn: 75, crit: 90 },
  { name: "disk_c", command: "powershell -command \"$d = Get-PSDrive C; [math]::Round($d.Used / ($d.Used + $d.Free) * 100, 1)\"", unit: "%", warn: 80, crit: 90 },
  { name: "memory", command: "powershell -command \"$os = Get-WmiObject Win32_OperatingSystem; [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize * 100, 1)\"", unit: "%", warn: 80, crit: 95 },
];
const AGENT_LINUX_CHECKS = [
  { name: "load",   command: "cut -d' ' -f1 /proc/loadavg", unit: "", warn: 8, crit: 16 },
  { name: "memory", command: "awk '/MemTotal/{t=$2}/MemAvailable/{a=$2}END{printf \"%.1f\",(t-a)/t*100}' /proc/meminfo", unit: "%", warn: 80, crit: 95 },
  { name: "disk",   command: "df --output=pcent / | tail -1 | tr -dc 0-9", unit: "%", warn: 80, crit: 90 },
];

app.get("/api/agent/config", requireAuth, requireAdmin, (req, res) => {
  const isWin = (req.query.os as string) === "windows";
  const proto = (req.headers["x-forwarded-proto"] as string) || (req.secure ? "https" : "http");
  const host  = req.headers.host ?? `localhost:${PORT}`;
  const serverUrl = `${proto}://${host}`;

  const token = require("crypto").randomBytes(32).toString("hex");
  const user  = (req.session as any).user;
  const now   = new Date().toISOString();
  db.prepare("INSERT INTO agent_tokens (label, token, createdBy, createdAt) VALUES (?, ?, ?, ?)")
    .run(`agent download (${isWin ? "windows" : "linux"} ${now.slice(0, 10)})`, token, user?.displayName ?? "admin", now);
  audit(user?.displayName, "agent.config_download", isWin ? "windows" : "linux", null, req.ip);

  const config = {
    host:            isWin ? "windows-host" : "linux-host",
    group:           "default",
    token,
    serverUrl,
    intervalSeconds: 300,
    checks:          isWin ? AGENT_WIN_CHECKS : AGENT_LINUX_CHECKS,
  };
  res.setHeader("Content-Disposition", 'attachment; filename="config.json"');
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(config, null, 2));
});

// ── SPA fallback (production) ────────────────────────────────────────────────────
// Any non-/api GET returns the React app so client-side routes survive a refresh.
if (hasBuiltUI) {
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

// ── Start ──────────────────────────────────────────────────────────────────────

if (USE_HTTPS) {
  https.createServer({ cert: readFileSync(TLS_CERT!), key: readFileSync(TLS_KEY!) }, app)
    .listen(PORT, () => console.log(`Nomyx running on https://localhost:${PORT}`));
} else {
  app.listen(PORT, () => console.log(`Nomyx running on http://localhost:${PORT}`));
}