// ── Builtin collectors — dispatch spine ────────────────────────────────────────
// The agent is replacing command-string checks with builtin collectors that read
// the OS directly (no shell). This directory owns the builtin dispatch and the
// per-collector implementations; agent.ts keeps the command escape hatch and the
// config/report plumbing. Narrow-module discipline: everything here is about
// turning a validated BuiltinCheck into a CheckValue — nothing else.
//
// Layout (one-directional imports — index → fileread → shared → contract):
//   index.ts     — this file: the exhaustive dispatch + CheckValue builders
//   fileread.ts  — the 7 no-subprocess collectors (/proc, /sys, statfs)
//   shared.ts    — leaf helpers (Collector<T>, toFiniteNumber, meminfoField)
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
  collectInodes, collectUptime, collectTemperature,
} from "./fileread";

// Re-export the pure parse/compute functions so consumers (agent.ts and the
// verification harnesses) keep importing them from "./collectors" unchanged after
// the split into this directory.
export {
  parseLoadavg, parseMeminfoUsedPct, parseMeminfoSwapPct,
  parseUptimeSeconds, parseMilliCelsius, statfsUsedPct, statfsInodesPct,
} from "./fileread";

// ── Dispatch ───────────────────────────────────────────────────────────────────
// Exhaustive over the builtin union: every collector `type` is handled, and the
// `assertNever` default makes TS raise a COMPILE error if a new collector type is
// added to the union in contract.ts without a branch here — a new collector
// cannot silently no-op. The file-read tier is implemented; the remaining
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
      case "temperature":
        return numeric(check, collectTemperature(check));

      // Recognized collectors, not built yet — they follow one at a time. Fail
      // loud (never a stub number) until each is implemented.
      case "cpu":
      case "procs":
      case "service_active":
      case "file":
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
