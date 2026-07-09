// ── Builtin collectors ────────────────────────────────────────────────────────
// The agent is replacing command-string checks with builtin collectors that read
// the OS directly (no shell). This module owns the builtin dispatch and the
// per-collector implementations; agent.ts keeps the command escape hatch and the
// config/report plumbing. Narrow-module discipline: everything here is about
// turning a validated BuiltinCheck into a CheckValue — nothing else.
//
// Two invariants hold across every collector:
//   1. OS-BACKEND SEAM — each collector selects its platform backend internally.
//      Linux is implemented; the Windows branch throws a clear "not yet
//      implemented" error rather than emitting a stub number, so a Windows host
//      never reports a plausible-wrong value.
//   2. FAIL-LOUD — a collector that cannot produce a real finite number throws;
//      runBuiltin catches and returns a status:"invalid" CheckValue. A non-value
//      is never silently coerced to "ok" or to a fabricated reading.

import fs from "fs";
import type { BuiltinCheck, CheckValue } from "./contract";

// Narrow a BuiltinCheck to a single collector variant by its `type` discriminant,
// so a per-collector function receives exactly its own params shape.
type Collector<T extends BuiltinCheck["type"]> = Extract<BuiltinCheck, { type: T }>;

// ── Dispatch ───────────────────────────────────────────────────────────────────
// Exhaustive over the builtin union: every collector `type` is handled, and the
// `assertNever` default makes TS raise a COMPILE error if a new collector type is
// added to the union in contract.ts without a branch here — a new collector
// cannot silently no-op. `load` is implemented this step; the remaining
// recognized types are wired to a fail-loud "not yet implemented" placeholder
// (surfaces as status "invalid"), distinct from the unreachable schema-drift
// default. runBuiltin catches any throw and converts it to an "invalid"
// CheckValue so one broken collector can't take down the whole report.

export function runBuiltin(check: BuiltinCheck): CheckValue {
  try {
    switch (check.type) {
      case "load":
        return numeric(check, collectLoad(check));
      case "memory":
        return numeric(check, collectMemory(check));
      case "swap":
        return numeric(check, collectSwap(check));
      case "disk":
        return numeric(check, collectDisk(check));
      case "inodes":
        return numeric(check, collectInodes(check));
      case "uptime":
        return numeric(check, collectUptime(check));

      // Recognized collectors, not built yet — they follow one at a time. Fail
      // loud (never a stub number) until each is implemented.
      case "cpu":
      case "procs":
      case "service_active":
      case "file":
      case "temperature":
      case "ping":
      case "http":
      case "port":
        throw new Error(`collector ${check.type}: not yet implemented`);

      default:
        // Unreachable for the known union. If contract.ts grows a new collector
        // type, `check` is no longer `never` here and this line fails to compile.
        return assertNever(check);
    }
  } catch (err) {
    return invalid(check, err instanceof Error ? err.message : String(err));
  }
}

// ── CheckValue builders ──────────────────────────────────────────────────────

// A real numeric reading. Mirrors the command path exactly so the server's
// evaluateCheck thresholds it identically: same unit, warn, crit, and the
// thresholdDir default of "above".
function numeric(check: BuiltinCheck, value: number): CheckValue {
  return {
    name:         check.name,
    value,
    unit:         check.unit,
    warn:         check.warn,
    crit:         check.crit,
    thresholdDir: check.thresholdDir ?? "above",
  };
}

// A fail-loud non-value: never a number, never "ok". Carries the reason as the
// value so it is visible in the UI/history. Mirrors the command path's error
// shape (text value, unit "string") but with the Phase-0 "invalid" status.
function invalid(check: BuiltinCheck, reason: string): CheckValue {
  return { name: check.name, value: `error: ${reason}`, unit: "string", status: "invalid" };
}

function assertNever(x: never): never {
  throw new Error(`unhandled collector type: ${JSON.stringify(x)}`);
}

// ── load ─────────────────────────────────────────────────────────────────────
// 1-minute load average — the primary cpu-pressure signal in the Xymon model.
// Pure file read of /proc/loadavg: no sleep, no subprocess. Reported AS-IS, NOT
// normalized per-core, to match the command it replaces:
//     cut -d' ' -f1 /proc/loadavg
// so a 4-core Pi sitting at load 2.0 still reports 2.0, exactly as before.

function collectLoad(_check: Collector<"load">): number {
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
  const value = Number(first);
  if (!Number.isFinite(value)) {
    throw new Error(`collector load: unparseable /proc/loadavg (${JSON.stringify(raw)})`);
  }
  return value;
}

// ── memory ───────────────────────────────────────────────────────────────────
// Physical RAM used %, computed from /proc/meminfo as:
//     (MemTotal - MemAvailable) / MemTotal * 100
// MemAvailable (not MemFree/Buffers/Cached) is used deliberately so the value
// matches the awk formula in config.pihole.json / config.agent.json exactly —
// migrated hosts see no dashboard shift. The raw float is returned; rounding
// (config.agent.json's printf "%.1f") is a display concern, not source-of-truth.
// params.kind is "physical" only per schema.

function collectMemory(_check: Collector<"memory">): number {
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
  const field = (key: string): number | undefined => {
    const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m"));
    return m ? Number(m[1]) : undefined;
  };
  const total     = field("MemTotal");
  const available = field("MemAvailable");
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

function collectSwap(_check: Collector<"swap">): number {
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
  const field = (key: string): number | undefined => {
    const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m"));
    return m ? Number(m[1]) : undefined;
  };
  const total = field("SwapTotal");
  const free  = field("SwapFree");
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

function collectDisk(check: Collector<"disk">): number {
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

function collectInodes(check: Collector<"inodes">): number {
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

function collectUptime(_check: Collector<"uptime">): number {
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
  const value = Number(first);
  // Guard the empty field explicitly: Number("") is 0 (finite), so an empty or
  // whitespace-only /proc/uptime would otherwise be read as "0 seconds" rather
  // than the parse failure it is.
  if (first === "" || !Number.isFinite(value)) {
    throw new Error(`collector uptime: unparseable /proc/uptime (${JSON.stringify(raw)})`);
  }
  return value;
}
