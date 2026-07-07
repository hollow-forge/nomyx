import fs   from "fs";
import path from "path";
import http  from "http";
import https from "https";
import { execSync } from "child_process";
import os   from "os";
import { validateAgentConfig, type AgentConfig, type CheckConfig, type CheckValue, type MetricPayload } from "./contract";

// ── Interfaces ─────────────────────────────────────────────────────────────────
// CheckConfig / AgentConfig (and the CheckValue / MetricPayload wire shapes) now
// live in the shared contract (contract.ts), imported above, so the agent and
// server cannot drift apart.

// ── Config ─────────────────────────────────────────────────────────────────────
// When running as a packaged binary (pkg), look for config.json next to the
// executable; in dev (tsx/node) use the current directory. NOMYX_CONFIG overrides.

// Default checks for a containerized Linux host (Unraid / Docker). Used when no
// config.json supplies its own, so the agent can run with zero config files —
// driven entirely by environment variables.
const DEFAULT_CHECKS: CheckConfig[] = [
  { type: "command", name: "load",       command: "cut -d' ' -f1 /proc/loadavg", unit: "", warn: 8, crit: 16 },
  { type: "command", name: "memory",     command: "awk '/MemTotal/{t=$2}/MemAvailable/{a=$2}END{printf \"%.1f\",(t-a)/t*100}' /proc/meminfo", unit: "%", warn: 80, crit: 95 },
  { type: "command", name: "disk",       command: "df --output=pcent /mnt/user 2>/dev/null | tail -1 | tr -dc 0-9", unit: "%", warn: 80, crit: 90 },
  { type: "command", name: "containers", command: "curl -s --unix-socket /var/run/docker.sock http://localhost/containers/json | grep -o '\"Id\"' | wc -l", unit: "" },
];

const isPackaged = !!(process as any).pkg;

// ── Service install / uninstall ──────────────────────────────────────────────
// `nomyx-agent --install` registers the agent to run in the background on boot —
// a hidden Scheduled Task on Windows (as SYSTEM), a systemd service on Linux —
// and `--uninstall` removes it. Both need admin/root; config.json must sit next
// to the binary. Handled before any config loading so it works without a config.
const TASK_NAME = "NomyxAgent";

function installService(): void {
  const exe = process.execPath;
  if (process.platform === "win32") {
    try {
      execSync(`schtasks /create /tn "${TASK_NAME}" /tr "\\"${exe}\\"" /sc onstart /ru SYSTEM /rl HIGHEST /f`, { stdio: "inherit" });
      execSync(`schtasks /run /tn "${TASK_NAME}"`, { stdio: "inherit" });
      console.log(`[nomyx-agent] installed as scheduled task "${TASK_NAME}" — runs on boot, started now.`);
    } catch {
      console.error("[nomyx-agent] install failed — run this from an elevated (Administrator) PowerShell.");
      process.exit(1);
    }
  } else if (process.platform === "linux") {
    const unit = [
      "[Unit]",
      "Description=Nomyx monitoring agent",
      "After=network-online.target",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${exe}`,
      `WorkingDirectory=${path.dirname(exe)}`,
      "Restart=always",
      "RestartSec=10",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "",
    ].join("\n");
    try {
      fs.writeFileSync("/etc/systemd/system/nomyx-agent.service", unit);
      execSync("systemctl daemon-reload", { stdio: "inherit" });
      execSync("systemctl enable --now nomyx-agent", { stdio: "inherit" });
      console.log("[nomyx-agent] installed as systemd service 'nomyx-agent' — enabled and started.");
    } catch {
      console.error("[nomyx-agent] install failed — run with sudo / as root.");
      process.exit(1);
    }
  } else {
    console.error(`[nomyx-agent] --install is not supported on ${process.platform}.`);
    process.exit(1);
  }
}

function uninstallService(): void {
  if (process.platform === "win32") {
    try {
      execSync(`schtasks /delete /tn "${TASK_NAME}" /f`, { stdio: "inherit" });
      console.log("[nomyx-agent] scheduled task removed.");
    } catch {
      console.error("[nomyx-agent] uninstall failed — run elevated, or it wasn't installed.");
      process.exit(1);
    }
  } else if (process.platform === "linux") {
    try {
      execSync("systemctl disable --now nomyx-agent", { stdio: "inherit" });
      fs.rmSync("/etc/systemd/system/nomyx-agent.service", { force: true });
      execSync("systemctl daemon-reload", { stdio: "inherit" });
      console.log("[nomyx-agent] systemd service removed.");
    } catch {
      console.error("[nomyx-agent] uninstall failed — run with sudo, or it wasn't installed.");
      process.exit(1);
    }
  }
}

const cliArgs = process.argv.slice(1);
if (cliArgs.includes("--install"))   { installService();   process.exit(0); }
if (cliArgs.includes("--uninstall")) { uninstallService(); process.exit(0); }

// Optional config.json — next to the binary (pkg) or in the cwd (tsx/node);
// NOMYX_CONFIG overrides the path. The file is no longer required: any field can
// come from an environment variable instead, which is how the container is meant
// to run (fill a couple of fields in the UI, mount nothing).
const baseDir    = isPackaged ? path.dirname(process.execPath) : process.cwd();
const configPath = process.env.NOMYX_CONFIG ?? path.join(baseDir, "config.json");

let fileConfig: Partial<AgentConfig> = {};
if (fs.existsSync(configPath)) {
  try {
    fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Partial<AgentConfig>;
  } catch (e) {
    console.error(`[nomyx-agent] failed to parse ${configPath}:`, e);
    process.exit(1);
  }
}

// Environment variables take precedence over the file, so a deployment can set
// just NOMYX_SERVER and NOMYX_TOKEN and rely on the baked-in default checks.
const env = process.env;
const config: AgentConfig = {
  host:            env.NOMYX_HOST       ?? fileConfig.host       ?? os.hostname(),
  group:           env.NOMYX_GROUP      ?? fileConfig.group      ?? "default",
  division:        env.NOMYX_DIVISION   ?? fileConfig.division,
  department:      env.NOMYX_DEPARTMENT ?? fileConfig.department,
  token:           env.NOMYX_TOKEN      ?? fileConfig.token,
  serverUrl:       env.NOMYX_SERVER     ?? fileConfig.serverUrl  ?? "",
  intervalSeconds: env.NOMYX_INTERVAL ? parseInt(env.NOMYX_INTERVAL, 10) : (fileConfig.intervalSeconds ?? 600),
  checks:          (fileConfig.checks && fileConfig.checks.length) ? fileConfig.checks : DEFAULT_CHECKS,
  caCertPath:      env.NOMYX_CA_CERT    ?? fileConfig.caCertPath,
  insecureTLS:     env.NOMYX_INSECURE_TLS != null ? (env.NOMYX_INSECURE_TLS === "1" || env.NOMYX_INSECURE_TLS === "true") : fileConfig.insecureTLS,
};

if (!config.serverUrl) {
  console.error("[nomyx-agent] no server URL — set NOMYX_SERVER (e.g. http://192.168.1.10:4433) or put serverUrl in config.json");
  process.exit(1);
}

// ── Validate the effective config ────────────────────────────────────────────
// Fail loud on a malformed config.json (missing command, non-numeric threshold,
// empty checks, …) instead of starting up and silently misreporting. This only
// REPORTS errors and exits — it does not mutate `config`, so valid configs are
// entirely unaffected.
const validation = validateAgentConfig(config);
if (!validation.success) {
  console.error(`[nomyx-agent] invalid configuration (from ${configPath} + environment):`);
  for (const err of validation.errors) console.error(`  - ${err}`);
  process.exit(1);
}

// ── TLS options ──────────────────────────────────────────────────────────────────

function tlsOptions(): https.RequestOptions {
  const opts: https.RequestOptions = {};
  if (config.caCertPath) {
    const p = path.isAbsolute(config.caCertPath) ? config.caCertPath : path.join(baseDir, config.caCertPath);
    try { opts.ca = fs.readFileSync(p); }
    catch { console.warn(`[nomyx-agent] WARNING: could not read caCertPath ${p}`); }
  }
  if (config.insecureTLS) {
    opts.rejectUnauthorized = false;
    console.warn("[nomyx-agent] WARNING: insecureTLS is on — TLS certificate verification is disabled");
  }
  return opts;
}

// ── POST helper (http/https, no external deps so it packages cleanly) ────────────

function postJson(urlStr: string, body: object, token?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const url   = new URL(urlStr);
    const isTLS = url.protocol === "https:";
    const data  = JSON.stringify(body);

    const headers: Record<string, string> = {
      "Content-Type":   "application/json",
      "Content-Length": Buffer.byteLength(data).toString(),
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const options: https.RequestOptions = {
      method:   "POST",
      hostname: url.hostname,
      port:     url.port || (isTLS ? 443 : 80),
      path:     url.pathname + url.search,
      headers,
      ...(isTLS ? tlsOptions() : {}),
    };

    const lib = isTLS ? https : http;
    const req = lib.request(options, res => {
      let chunks = "";
      res.on("data", c => (chunks += c));
      res.on("end", () => {
        try { resolve(JSON.parse(chunks || "{}")); }
        catch { resolve({ status: res.statusCode }); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ── Collect ─────────────────────────────────────────────────────────────────────

function collect(): CheckValue[] {
  return config.checks.map((check): CheckValue => {
    // Phase 0 runs command checks only. Every existing config carries `command`
    // (they predate the `type` discriminant), so guard on its presence to keep
    // them running exactly as before. Builtin-collector dispatch is a separate,
    // later track — a builtin check (none exist yet) reports as unknown here.
    if (!("command" in check)) {
      return { name: check.name, value: "error", unit: "string", status: "unknown" };
    }
    try {
      const out   = execSync(check.command, { timeout: 10000 }).toString().trim();
      const value = isNaN(parseFloat(out)) ? out : parseFloat(out);
      return {
        name:         check.name,
        value,
        unit:         check.unit,
        warn:         check.warn,
        crit:         check.crit,
        thresholdDir: check.thresholdDir ?? "above",
      };
    } catch {
      return { name: check.name, value: "error", unit: "string", status: "unknown" };
    }
  });
}

// ── Report ──────────────────────────────────────────────────────────────────────

async function report(): Promise<void> {
  const checks  = collect();
  const payload: MetricPayload = {
    host:            config.host,
    group:           config.group,
    timestamp:       new Date().toISOString(),
    intervalSeconds: config.intervalSeconds ?? 600,
    checks,
  };
  const result = await postJson(config.serverUrl + "/api/status", payload, config.token);
  console.log(`[${new Date().toISOString()}] ${config.host} → ${result.status ?? "?"} (${checks.length} checks)`);
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[nomyx-agent] starting — ${config.host} → ${config.serverUrl} (config: ${configPath})`);
  if (!config.token) console.warn("[nomyx-agent] WARNING: no token configured — server may reject reports");

  await report();

  setInterval(async () => {
    try { await report(); }
    catch (err) { console.error("[nomyx-agent] failed to report:", err); }
  }, (config.intervalSeconds ?? 600) * 1000);
}

main().catch(err => { console.error(err); process.exit(1); });
