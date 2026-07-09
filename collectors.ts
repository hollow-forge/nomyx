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

      // Recognized collectors, not built yet — they follow one at a time. Fail
      // loud (never a stub number) until each is implemented.
      case "cpu":
      case "memory":
      case "swap":
      case "disk":
      case "inodes":
      case "procs":
      case "service_active":
      case "file":
      case "temperature":
      case "uptime":
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
