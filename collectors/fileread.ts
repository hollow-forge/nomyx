// ── File-read collectors ───────────────────────────────────────────────────────
// The 7 collectors that read the OS directly with no subprocess — /proc, /sys, and
// the statfs syscall: load, memory, swap, disk, inodes, uptime, temperature. Each
// follows the same shape:
//   collectX(check)  — selects the platform backend (Linux impl / Windows throws)
//   xLinux()         — does the Linux read
//   parseX(raw)      — the pure parse/compute, split out so it can be exercised
//                      against captured input by the verification harnesses.
//
// The OS-BACKEND SEAM (Linux impl / Windows throws) is applied per collector below;
// the FAIL-LOUD invariant (throw → "invalid", never a fabricated number) is enforced
// by the dispatch in ./index catching whatever these throw.

import fs from "fs";
import { toFiniteNumber, meminfoField, type Collector } from "./shared";

// ── load ─────────────────────────────────────────────────────────────────────
// 1-minute load average — the primary cpu-pressure signal in the Xymon model.
// Pure file read of /proc/loadavg: no sleep, no subprocess. Reported AS-IS, NOT
// normalized per-core, to match the command it replaces:
//     cut -d' ' -f1 /proc/loadavg
// so a 4-core Pi sitting at load 2.0 still reports 2.0, exactly as before.

export function collectLoad(_check: Collector<"load">): number {
  if (process.platform === "win32") {
    throw new Error("collector load: Windows backend not yet implemented");
  }
  return loadLinux();
}

function loadLinux(): number {
  return parseLoadavg(fs.readFileSync("/proc/loadavg", "utf-8"));
}

// Split out from the file read so the exact parse can be exercised against a
// captured /proc/loadavg line (see the live-verification harness). The 1-minute
// average is the first whitespace-delimited field.
export function parseLoadavg(raw: string): number {
  const first = raw.trim().split(/\s+/)[0];
  return toFiniteNumber(first, "load /proc/loadavg");
}

// ── memory ───────────────────────────────────────────────────────────────────
// Physical RAM used %, computed from /proc/meminfo as:
//     (MemTotal - MemAvailable) / MemTotal * 100
// MemAvailable (not MemFree/Buffers/Cached) is used deliberately so the value
// matches the awk formula in config.pihole.json / config.agent.json exactly —
// migrated hosts see no dashboard shift. The raw float is returned; rounding
// (config.agent.json's printf "%.1f") is a display concern, not source-of-truth.
// params.kind is "physical" only per schema.

export function collectMemory(_check: Collector<"memory">): number {
  if (process.platform === "win32") {
    throw new Error("collector memory: Windows backend not yet implemented");
  }
  return memoryLinux();
}

function memoryLinux(): number {
  return parseMeminfoUsedPct(fs.readFileSync("/proc/meminfo", "utf-8"));
}

// Split out from the file read so the exact parse+compute can be exercised
// against a captured /proc/meminfo (see the live-verification harness). Each line
// is "Key:   <value> kB"; both fields are in kB, so the unit cancels in the ratio.
// Missing MemTotal/MemAvailable, or MemTotal <= 0, throws (fail-loud → "invalid")
// rather than emitting NaN or a fabricated number.
export function parseMeminfoUsedPct(raw: string): number {
  const total     = meminfoField(raw, "MemTotal");
  const available = meminfoField(raw, "MemAvailable");
  if (total === undefined || available === undefined) {
    throw new Error(`collector memory: /proc/meminfo missing MemTotal/MemAvailable`);
  }
  if (!(total > 0)) {
    throw new Error(`collector memory: /proc/meminfo MemTotal is ${total}`);
  }
  return (total - available) / total * 100;
}

// ── swap ─────────────────────────────────────────────────────────────────────
// Swap used %, computed from /proc/meminfo as:
//     (SwapTotal - SwapFree) / SwapTotal * 100
// A NEW capability (Xymon MEMSWAP parity) — no legacy config has a swap check, so
// this is not a migration. Distinct from `memory` (physical RAM); swap pressure is
// its own signal.

export function collectSwap(_check: Collector<"swap">): number {
  if (process.platform === "win32") {
    throw new Error("collector swap: Windows backend not yet implemented");
  }
  return swapLinux();
}

function swapLinux(): number {
  return parseMeminfoSwapPct(fs.readFileSync("/proc/meminfo", "utf-8"));
}

// Split out from the file read so the compute can be exercised against a captured
// /proc/meminfo. Zero-handling DELIBERATELY DIFFERS from parseMeminfoUsedPct:
//
//   SwapTotal == 0 is a LEGITIMATE state — the host simply has no swap configured
//   (common on Pis/containers) — NOT a parse error. No swap means no swap pressure
//   to alert on, so we emit 0% used (which is OK and never trips an "above"
//   threshold). We must NOT throw or return "invalid" here, or every swapless host
//   would false-alarm. (memory's MemTotal==0 throws because a machine with zero
//   physical RAM is impossible → genuinely malformed meminfo.) Do not "fix" this
//   into a throw.
//
// A genuinely malformed meminfo — SwapTotal/SwapFree fields ABSENT entirely — is a
// real parse failure and still throws (→ "invalid"), distinct from SwapTotal==0.
export function parseMeminfoSwapPct(raw: string): number {
  const total = meminfoField(raw, "SwapTotal");
  const free  = meminfoField(raw, "SwapFree");
  if (total === undefined || free === undefined) {
    throw new Error(`collector swap: /proc/meminfo missing SwapTotal/SwapFree`);
  }
  if (total === 0) return 0;                 // no swap configured — legitimate, 0% used
  return (total - free) / total * 100;
}

// ── disk ─────────────────────────────────────────────────────────────────────
// Filesystem used %, from the statfs syscall via fs.statfsSync — NO subprocess.
// First parameterized collector (params.path) and first migration collector
// (config.pi.json / config.pihole.json / config.agent.json have real df checks).
//
// BACKEND: native fs.statfsSync (Node 22, and the agent ships a bundled Node 22
// runtime so it is present on the Pi even though the Pi has no system node). This
// is structurally identical to the /proc collectors — a syscall, no shell, so
// params.path is passed as pure DATA to statfs and never touches a command line.
//
// FORMULA matches `df -P` exactly (its "used% of space available to unprivileged
// users" convention), so migrated hosts report the same number:
//     used  = blocks - bfree      (total minus all free, i.e. reserved counts as used)
//     avail = bavail              (free blocks available to unprivileged users)
//     pct   = used / (used + avail) * 100
// df then rounds this UP to an integer; we emit the raw float (rounding is a
// display concern). Reserved blocks (bfree - bavail) are EXCLUDED from the
// denominator — that is the reserved-block handling df uses; the naive
// (blocks - bavail) / blocks overstates usage and must not be used.
//
// A path that does not exist / is not a mount makes statfsSync throw (ENOENT),
// which surfaces as status "invalid" — a typo'd path fails loud, never silently
// reports 0 or another filesystem's numbers.

export function collectDisk(check: Collector<"disk">): number {
  if (process.platform === "win32") {
    throw new Error("collector disk: Windows backend not yet implemented");
  }
  return diskLinux(check.params.path);
}

function diskLinux(path: string): number {
  const s = fs.statfsSync(path);             // throws ENOENT on a nonexistent path
  return statfsUsedPct(s.blocks, s.bfree, s.bavail);
}

// Split out so the df-matching arithmetic can be exercised against captured statfs
// numbers (e.g. `stat -f` on the Pi, which exposes the same syscall's fields).
// A filesystem with no usable capacity (used + avail == 0, e.g. a pseudo-fs)
// would divide by zero; guard it as fail-loud rather than emitting NaN.
export function statfsUsedPct(blocks: number, bfree: number, bavail: number): number {
  const used  = blocks - bfree;
  const avail = bavail;
  const denom = used + avail;
  if (!(denom > 0)) {
    throw new Error(`collector disk: filesystem has no usable capacity (blocks=${blocks}, bfree=${bfree}, bavail=${bavail})`);
  }
  return used / denom * 100;
}

// ── inodes ───────────────────────────────────────────────────────────────────
// Filesystem inode-table used %, from the SAME statfs syscall as disk (native
// fs.statfsSync, no subprocess) but different fields: `files` (total inodes) and
// `ffree` (free inodes). NEW capability (Xymon INODE parity) — no legacy config
// has an inode check, so not a migration. No reserved-block subtlety here; that's
// a space-only df convention, inodes don't have it:
//     used% = (files - ffree) / files * 100

export function collectInodes(check: Collector<"inodes">): number {
  if (process.platform === "win32") {
    throw new Error("collector inodes: Windows backend not yet implemented");
  }
  return inodesLinux(check.params.path);
}

function inodesLinux(path: string): number {
  const s = fs.statfsSync(path);             // throws ENOENT on a nonexistent path
  return statfsInodesPct(s.files, s.ffree);
}

// Split out so the compute can be exercised against captured statfs numbers
// (`stat -f` on the Pi exposes the same syscall's fields).
//
// ZERO-INODE handling DELIBERATELY MIRRORS swap, NOT disk: files == 0 means the
// filesystem has NO fixed inode table (btrfs allocates inodes dynamically; many
// overlay/network/pseudo-filesystems report 0). Such a filesystem CANNOT run out
// of inodes, so there is no inode pressure to alert on — emit 0% used (OK, never
// trips an "above" threshold). We must NOT throw or return "invalid", or every
// btrfs/overlay host would false-alarm. (Contrast disk: a bad path is a genuine
// error and throws.) Do not "fix" this into a throw.
export function statfsInodesPct(files: number, ffree: number): number {
  if (files === 0) return 0;                 // no fixed inode table — legitimate, 0% used
  return (files - ffree) / files * 100;
}

// ── uptime ───────────────────────────────────────────────────────────────────
// Seconds since boot — the primary reboot-recency signal (Xymon UP). Pure file
// read of /proc/uptime, no subprocess. Emitted RAW in SECONDS: display renders it
// human-friendly (days/hours) and config thresholds are set in seconds to match
// the emitted unit — no hidden conversion at the source.
//
// The common alert is recent-reboot detection via thresholdDir:"below" (fire when
// uptime < N seconds), which the existing single-direction threshold model handles
// as-is. Xymon's full UP also alerts up-too-long (a second, upper bound), but that
// needs a two-sided threshold model the schema doesn't have — a DEFERRED
// threshold-model enhancement, not an uptime-collector concern; not handled here.

export function collectUptime(_check: Collector<"uptime">): number {
  if (process.platform === "win32") {
    throw new Error("collector uptime: Windows backend not yet implemented");
  }
  return uptimeLinux();
}

function uptimeLinux(): number {
  return parseUptimeSeconds(fs.readFileSync("/proc/uptime", "utf-8"));
}

// Split out from the file read so the parse can be exercised against a captured
// /proc/uptime line. The first whitespace-delimited field is seconds-since-boot
// (float); an empty/unparseable field throws (→ "invalid") rather than NaN.
export function parseUptimeSeconds(raw: string): number {
  const first = raw.trim().split(/\s+/)[0];
  return toFiniteNumber(first, "uptime /proc/uptime");
}

// ── temperature ──────────────────────────────────────────────────────────────
// Thermal-zone temperature in °C (Xymon-style). Pure file read of
// /sys/class/thermal/thermal_<zone>/temp, no subprocess. params.zone (default
// "zone0" per schema) selects the zone; on this Pi zone0 is type "cpu-thermal".
//
// params.zone is DATA used to build a /sys path, so it is constrained to an
// allowlist — letters/digits/underscore/hyphen only (^[A-Za-z0-9_-]+$). This
// blocks path traversal by construction: "/" and "." are rejected, so neither
// "../../etc/hostname" nor "zone0/../.." can escape the thermal dir. A malformed
// zone fails loud (→ "invalid") rather than reading an attacker-chosen file.
//
// /sys/.../temp reports MILLIDEGREES C; divide by 1000 → °C. This /1000 is an
// AT-SOURCE conversion on purpose: millidegrees is a kernel encoding quirk, not a
// unit anyone thresholds in (configs use warn:70 meaning 70°C), and it matches the
// old awk '{print $1/1000}' in config.pihole.json so migrated thresholds are
// unchanged. (Contrast uptime, which stays raw because seconds IS the threshold
// unit — here millidegrees is not.)
//
// A nonexistent zone, or /sys/class/thermal absent entirely (some VMs have no
// thermal hardware), makes the read throw → clean "invalid", never a crash.

const ZONE_RE = /^[A-Za-z0-9_-]+$/;

export function collectTemperature(check: Collector<"temperature">): number {
  if (process.platform === "win32") {
    throw new Error("collector temperature: Windows backend not yet implemented");
  }
  return temperatureLinux(check.params.zone);
}

function temperatureLinux(zone: string): number {
  if (!ZONE_RE.test(zone)) {
    throw new Error(`collector temperature: invalid zone ${JSON.stringify(zone)} (expected e.g. "zone0")`);
  }
  const raw = fs.readFileSync(`/sys/class/thermal/thermal_${zone}/temp`, "utf-8");
  return parseMilliCelsius(raw);
}

// Split out so the millidegrees→°C conversion can be exercised against a captured
// /sys temp value. Empty/unparseable content throws (→ "invalid") rather than
// emitting 0°C (Number("") is 0, a plausible-wrong reading).
export function parseMilliCelsius(raw: string): number {
  return toFiniteNumber(raw.trim(), "temperature temp") / 1000;
}
