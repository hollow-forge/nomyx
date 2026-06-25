import Database from "better-sqlite3";

const db = new Database("nomyx.db");

const groups = ["webservers", "databases", "dns", "monitoring", "storage", "network"];

const checkTemplates = [
  { name: "cpu",    unit: "%",    warn: 75, crit: 90, thresholdDir: "above" },
  { name: "memory", unit: "%",    warn: 80, crit: 95, thresholdDir: "above" },
  { name: "disk",   unit: "%",    warn: 80, crit: 90, thresholdDir: "above" },
  { name: "ping",   unit: "ms",   warn: 100, crit: 500, thresholdDir: "above" },
];

const insertHost = db.prepare(`
  INSERT OR REPLACE INTO hosts (hostname, group_name, ip, status, lastSeen, checks)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const insertHistory = db.prepare(`
  INSERT INTO check_history (hostname, checkName, value, unit, status, recordedAt)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const insertEvent = db.prepare(`
  INSERT INTO status_events (hostname, checkName, fromStatus, toStatus, value, recordedAt)
  VALUES (?, ?, ?, ?, ?, ?)
`);

function randomValue(min: number, max: number): number {
  return Math.round((Math.random() * (max - min) + min) * 10) / 10;
}

function evaluateStatus(value: number, warn: number, crit: number, dir: string): string {
  if (dir === "above") {
    if (value >= crit) return "crit";
    if (value >= warn) return "warn";
    return "ok";
  } else {
    if (value <= crit) return "crit";
    if (value <= warn) return "warn";
    return "ok";
  }
}

console.log("Generating 50 fake hosts with 90 days of history...");

const insertMany = db.transaction(() => {
  for (let h = 1; h <= 50; h++) {
    const hostname = `server${String(h).padStart(2, "0")}.local`;
    const group    = groups[h % groups.length];
    const ip       = `10.0.${Math.floor(h / 254)}.${h % 254}`;

    // Generate 90 days of history at 10 minute intervals
    // 90 days * 24 hours * 6 readings/hour = 12960 readings per check
    const now       = Date.now();
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    const intervalMs   = 10 * 60 * 1000;
    const readings     = Math.floor(ninetyDaysMs / intervalMs);

    const latestChecks: any[] = [];
    let prevStatuses: Record<string, string> = {};

    for (let r = 0; r < readings; r++) {
      const recordedAt = new Date(now - ninetyDaysMs + r * intervalMs).toISOString();

      for (const tmpl of checkTemplates) {
        const value  = randomValue(20, 98);
        const status = evaluateStatus(value, tmpl.warn, tmpl.crit, tmpl.thresholdDir);

        insertHistory.run(hostname, tmpl.name, value, tmpl.unit, status, recordedAt);

        if (prevStatuses[tmpl.name] && prevStatuses[tmpl.name] !== status) {
          insertEvent.run(hostname, tmpl.name, prevStatuses[tmpl.name], status, value, recordedAt);
        }

        prevStatuses[tmpl.name] = status;

        if (r === readings - 1) {
          latestChecks.push({ name: tmpl.name, value, unit: tmpl.unit, status, warn: tmpl.warn, crit: tmpl.crit, thresholdDir: tmpl.thresholdDir });
        }
      }
    }

    const worstStatus = latestChecks.reduce((worst, c) => {
      if (c.status === "crit") return "crit";
      if (c.status === "warn" && worst !== "crit") return "warn";
      return worst;
    }, "ok");

    insertHost.run(hostname, group, ip, worstStatus, new Date().toISOString(), JSON.stringify(latestChecks));

    if (h % 10 === 0) console.log(`  ${h}/50 hosts done...`);
  }
});

insertMany();
console.log("Done. Restart the server and check the dashboard.");
db.close();