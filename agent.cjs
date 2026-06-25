var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// agent.ts
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var import_http = __toESM(require("http"));
var import_https = __toESM(require("https"));
var import_child_process = require("child_process");
var import_os = __toESM(require("os"));
var DEFAULT_CHECKS = [
  { name: "load", command: "cut -d' ' -f1 /proc/loadavg", unit: "", warn: 8, crit: 16 },
  { name: "memory", command: `awk '/MemTotal/{t=$2}/MemAvailable/{a=$2}END{printf "%.1f",(t-a)/t*100}' /proc/meminfo`, unit: "%", warn: 80, crit: 95 },
  { name: "disk", command: "df --output=pcent /mnt/user 2>/dev/null | tail -1 | tr -dc 0-9", unit: "%", warn: 80, crit: 90 },
  { name: "containers", command: `curl -s --unix-socket /var/run/docker.sock http://localhost/containers/json | grep -o '"Id"' | wc -l`, unit: "" }
];
var isPackaged = !!process.pkg;
var TASK_NAME = "NomyxAgent";
function installService() {
  const exe = process.execPath;
  if (process.platform === "win32") {
    try {
      (0, import_child_process.execSync)(`schtasks /create /tn "${TASK_NAME}" /tr "\\"${exe}\\"" /sc onstart /ru SYSTEM /rl HIGHEST /f`, { stdio: "inherit" });
      (0, import_child_process.execSync)(`schtasks /run /tn "${TASK_NAME}"`, { stdio: "inherit" });
      console.log(`[nomyx-agent] installed as scheduled task "${TASK_NAME}" \u2014 runs on boot, started now.`);
    } catch {
      console.error("[nomyx-agent] install failed \u2014 run this from an elevated (Administrator) PowerShell.");
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
      `WorkingDirectory=${import_path.default.dirname(exe)}`,
      "Restart=always",
      "RestartSec=10",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      ""
    ].join("\n");
    try {
      import_fs.default.writeFileSync("/etc/systemd/system/nomyx-agent.service", unit);
      (0, import_child_process.execSync)("systemctl daemon-reload", { stdio: "inherit" });
      (0, import_child_process.execSync)("systemctl enable --now nomyx-agent", { stdio: "inherit" });
      console.log("[nomyx-agent] installed as systemd service 'nomyx-agent' \u2014 enabled and started.");
    } catch {
      console.error("[nomyx-agent] install failed \u2014 run with sudo / as root.");
      process.exit(1);
    }
  } else {
    console.error(`[nomyx-agent] --install is not supported on ${process.platform}.`);
    process.exit(1);
  }
}
function uninstallService() {
  if (process.platform === "win32") {
    try {
      (0, import_child_process.execSync)(`schtasks /delete /tn "${TASK_NAME}" /f`, { stdio: "inherit" });
      console.log("[nomyx-agent] scheduled task removed.");
    } catch {
      console.error("[nomyx-agent] uninstall failed \u2014 run elevated, or it wasn't installed.");
      process.exit(1);
    }
  } else if (process.platform === "linux") {
    try {
      (0, import_child_process.execSync)("systemctl disable --now nomyx-agent", { stdio: "inherit" });
      import_fs.default.rmSync("/etc/systemd/system/nomyx-agent.service", { force: true });
      (0, import_child_process.execSync)("systemctl daemon-reload", { stdio: "inherit" });
      console.log("[nomyx-agent] systemd service removed.");
    } catch {
      console.error("[nomyx-agent] uninstall failed \u2014 run with sudo, or it wasn't installed.");
      process.exit(1);
    }
  }
}
var cliArgs = process.argv.slice(1);
if (cliArgs.includes("--install")) {
  installService();
  process.exit(0);
}
if (cliArgs.includes("--uninstall")) {
  uninstallService();
  process.exit(0);
}
var baseDir = isPackaged ? import_path.default.dirname(process.execPath) : process.cwd();
var configPath = process.env.NOMYX_CONFIG ?? import_path.default.join(baseDir, "config.json");
var fileConfig = {};
if (import_fs.default.existsSync(configPath)) {
  try {
    fileConfig = JSON.parse(import_fs.default.readFileSync(configPath, "utf-8"));
  } catch (e) {
    console.error(`[nomyx-agent] failed to parse ${configPath}:`, e);
    process.exit(1);
  }
}
var env = process.env;
var config = {
  host: env.NOMYX_HOST ?? fileConfig.host ?? import_os.default.hostname(),
  group: env.NOMYX_GROUP ?? fileConfig.group ?? "default",
  division: env.NOMYX_DIVISION ?? fileConfig.division,
  department: env.NOMYX_DEPARTMENT ?? fileConfig.department,
  token: env.NOMYX_TOKEN ?? fileConfig.token,
  serverUrl: env.NOMYX_SERVER ?? fileConfig.serverUrl ?? "",
  intervalSeconds: env.NOMYX_INTERVAL ? parseInt(env.NOMYX_INTERVAL, 10) : fileConfig.intervalSeconds ?? 600,
  checks: fileConfig.checks && fileConfig.checks.length ? fileConfig.checks : DEFAULT_CHECKS,
  caCertPath: env.NOMYX_CA_CERT ?? fileConfig.caCertPath,
  insecureTLS: env.NOMYX_INSECURE_TLS != null ? env.NOMYX_INSECURE_TLS === "1" || env.NOMYX_INSECURE_TLS === "true" : fileConfig.insecureTLS
};
if (!config.serverUrl) {
  console.error("[nomyx-agent] no server URL \u2014 set NOMYX_SERVER (e.g. http://192.168.1.10:4433) or put serverUrl in config.json");
  process.exit(1);
}
function tlsOptions() {
  const opts = {};
  if (config.caCertPath) {
    const p = import_path.default.isAbsolute(config.caCertPath) ? config.caCertPath : import_path.default.join(baseDir, config.caCertPath);
    try {
      opts.ca = import_fs.default.readFileSync(p);
    } catch {
      console.warn(`[nomyx-agent] WARNING: could not read caCertPath ${p}`);
    }
  }
  if (config.insecureTLS) {
    opts.rejectUnauthorized = false;
    console.warn("[nomyx-agent] WARNING: insecureTLS is on \u2014 TLS certificate verification is disabled");
  }
  return opts;
}
function postJson(urlStr, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isTLS = url.protocol === "https:";
    const data = JSON.stringify(body);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data).toString()
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const options = {
      method: "POST",
      hostname: url.hostname,
      port: url.port || (isTLS ? 443 : 80),
      path: url.pathname + url.search,
      headers,
      ...isTLS ? tlsOptions() : {}
    };
    const lib = isTLS ? import_https.default : import_http.default;
    const req = lib.request(options, (res) => {
      let chunks = "";
      res.on("data", (c) => chunks += c);
      res.on("end", () => {
        try {
          resolve(JSON.parse(chunks || "{}"));
        } catch {
          resolve({ status: res.statusCode });
        }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}
function collect() {
  return config.checks.map((check) => {
    try {
      const out = (0, import_child_process.execSync)(check.command, { timeout: 1e4 }).toString().trim();
      const value = isNaN(parseFloat(out)) ? out : parseFloat(out);
      return {
        name: check.name,
        value,
        unit: check.unit,
        warn: check.warn,
        crit: check.crit,
        thresholdDir: check.thresholdDir ?? "above"
      };
    } catch {
      return { name: check.name, value: "error", unit: "string", status: "unknown" };
    }
  });
}
async function report() {
  const checks = collect();
  const payload = {
    host: config.host,
    group: config.group,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    intervalSeconds: config.intervalSeconds ?? 600,
    checks
  };
  const result = await postJson(config.serverUrl + "/api/status", payload, config.token);
  console.log(`[${(/* @__PURE__ */ new Date()).toISOString()}] ${config.host} \u2192 ${result.status ?? "?"} (${checks.length} checks)`);
}
async function main() {
  console.log(`[nomyx-agent] starting \u2014 ${config.host} \u2192 ${config.serverUrl} (config: ${configPath})`);
  if (!config.token) console.warn("[nomyx-agent] WARNING: no token configured \u2014 server may reject reports");
  await report();
  setInterval(async () => {
    try {
      await report();
    } catch (err) {
      console.error("[nomyx-agent] failed to report:", err);
    }
  }, (config.intervalSeconds ?? 600) * 1e3);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
