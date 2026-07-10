// ── Builtin collectors — dispatch spine ────────────────────────────────────────
// The agent is replacing command-string checks with builtin collectors that read
// the OS directly (no shell). This directory owns the builtin dispatch and the
// per-collector implementations; agent.ts keeps the command escape hatch and the
// config/report plumbing. Narrow-module discipline: everything here is about
// turning a validated BuiltinCheck into a CheckValue — nothing else.
//
// Layout (one-directional imports — index → {fileread,cpu,subprocess,network} → shared → contract):
//   index.ts       — this file: the exhaustive dispatch + CheckValue builders
//   fileread.ts    — the no-subprocess collectors (/proc, /sys, statfs) incl. procs
//   cpu.ts         — the windowed /proc/stat-delta collector (genuinely async)
//   subprocess.ts  — collectors that spawn a fixed-argv tool (execFile, never a shell)
//   network.ts     — outbound probes: ping (execFile ping) + native sentinel resolution
//   shared.ts      — leaf helpers (Collector<T>, toFiniteNumber, meminfoField)
//
// Two invariants hold across every collector:
//   1. OS-BACKEND SEAM — each collector selects its platform backend internally
//      (Linux implemented; Windows throws "not yet implemented", never a stub
//      number). Applied per collector in fileread.ts.
//   2. FAIL-LOUD — a collector that cannot produce a real finite number throws;
//      runBuiltin (below) catches and returns a status:"invalid" CheckValue. A
//      non-value is never silently coerced to "ok" or to a fabricated reading.

import type { BuiltinCheck, CheckValue } from "../contract";
import {
  collectLoad, collectMemory, collectSwap, collectDisk,
  collectInodes, collectUptime, collectTemperature, collectProcs,
} from "./fileread";
import { collectCpu } from "./cpu";
import { collectServiceActive } from "./subprocess";
import { collectPing, collectPort } from "./network";

// Re-export the pure parse/compute functions so consumers (agent.ts and the
// verification harnesses) keep importing them from "./collectors" unchanged after
// the split into this directory.
export {
  parseLoadavg, parseMeminfoUsedPct, parseMeminfoSwapPct,
  parseUptimeSeconds, parseMilliCelsius, statfsUsedPct, statfsInodesPct,
  countMatches,
} from "./fileread";
export { parseStatCpu, cpuPctFromDeltas } from "./cpu";
export { interpretIsActive } from "./subprocess";
export { parseGatewayFromRoute, parseFirstIpv4Nameserver, parsePingRtt, classifyConnectError } from "./network";

// ── Dispatch ───────────────────────────────────────────────────────────────────
// Exhaustive over the builtin union: every collector `type` is handled, and the
// `assertNever` default makes TS raise a COMPILE error if a new collector type is
// added to the union in contract.ts without a branch here — a new collector
// cannot silently no-op. The file-read tier is implemented; the remaining
// recognized types are wired to a fail-loud "not yet implemented" placeholder
// (surfaces as status "invalid"), distinct from the unreachable schema-drift
// default. runBuiltin catches any throw and converts it to an "invalid"
// CheckValue so one broken collector can't take down the whole report.

// Async so genuinely-async collectors (cpu windowing, network I/O — later tiers)
// fit the same dispatch. The 7 file-read collectors stay synchronous internally
// (plain fs.readFileSync); awaiting a sync call is harmless, so no gratuitous async
// is pushed down into them. The try/catch wraps the awaited call so a throw from a
// sync OR async collector alike becomes a status:"invalid" CheckValue.
export async function runBuiltin(check: BuiltinCheck): Promise<CheckValue> {
  try {
    switch (check.type) {
      case "load":
        return numeric(check, await collectLoad(check));
      case "memory":
        return numeric(check, await collectMemory(check));
      case "swap":
        return numeric(check, await collectSwap(check));
      case "disk":
        return numeric(check, await collectDisk(check));
      case "inodes":
        return numeric(check, await collectInodes(check));
      case "uptime":
        return numeric(check, await collectUptime(check));
      case "temperature":
        return numeric(check, await collectTemperature(check));
      case "cpu":
        // Windowed: awaits params.window_seconds between two /proc/stat reads, so
        // this branch takes ~window_seconds to resolve (by design).
        return numeric(check, await collectCpu(check));
      case "service_active":
        // execFile('systemctl', ['is-active', unit]) — 1 active / 0 down; a check
        // that cannot be determined throws → "invalid" (see subprocess.ts).
        return numeric(check, await collectServiceActive(check));
      case "procs":
        // Native /proc scan → count of matching processes; count 0 is a real answer
        // (process absent), only an unreadable /proc throws → "invalid".
        return numeric(check, await collectProcs(check));

      case "ping":
        // execFile('ping', ['-c','1','-W',…, target]) — RTT ms; no-reply → 9999 (fault
        // via threshold), unresolvable sentinel / can't-run → "invalid" (see network.ts).
        return numeric(check, await collectPing(check));
      case "port":
        // Pure Node net.createConnection — 1 open / 0 closed-or-timeout (fault);
        // unresolvable host / bad config → "invalid" (see network.ts). No subprocess.
        return numeric(check, await collectPort(check));

      // Recognized collectors, not built yet — they follow one at a time. Fail
      // loud (never a stub number) until each is implemented.
      case "file":
      case "http":
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
