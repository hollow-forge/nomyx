// ── cpu (windowed) collector ────────────────────────────────────────────────────
// The first BEHAVIOR-DECISION collector: unlike the file-read tier (a single
// instantaneous read), CPU utilization is a RATE and only exists over an interval.
// So this collector is genuinely async — it reads /proc/stat, actually awaits a
// timer for params.window_seconds, reads again, and computes the busy fraction from
// the DELTA between the two cumulative-counter snapshots. This is the accurate
// method (what top/mpstat do), NOT an instantaneous approximation.
//
// WHY WINDOWED, NOT top -bn1: the file-read collectors migrated snapshot commands
// where the number's exact value carried over. cpu is different — the OLD command
// (config.pihole.json) was ALREADY a windowed /proc/stat delta (read, sleep 1,
// read), so this is not a snapshot→snapshot migration. We verify the windowed math
// against a windowed reference (mpstat / the pihole delta command), NOT against
// top -bn1 (an instantaneous quantity — a different measurement entirely).
//
// Shape mirrors the file-read collectors:
//   collectCpu(check)          — selects the platform backend (Linux impl / Windows throws)
//   cpuLinux(windowSeconds)    — the two timed reads + the await
//   parseStatCpu(raw)          — pure: /proc/stat text → the aggregate cpu fields
//   cpuPctFromDeltas(f1, f2)   — pure: the delta arithmetic, testable against a
//                                captured /proc/stat PAIR (see verification harness)
//
// The OS-BACKEND SEAM and FAIL-LOUD invariants hold exactly as elsewhere: Windows
// throws (never a stub number), and any degenerate/unparseable input throws → the
// dispatch in ./index turns it into a status:"invalid" CheckValue, never a garbage
// or negative percent.

import fs from "fs";
import { toFiniteNumber, type Collector } from "./shared";

export async function collectCpu(check: Collector<"cpu">): Promise<number> {
  if (process.platform === "win32") {
    throw new Error("collector cpu: Windows backend not yet implemented");
  }
  return cpuLinux(check.params.window_seconds);
}

// The two timed reads. GENUINELY ASYNC: we await a real timer for the window so the
// event loop is free during the wait (runBuiltin awaits us). Both reads parse the
// AGGREGATE `cpu ` line (all cores averaged) — see parseStatCpu — matching the
// multi-core Pi; the delta arithmetic lives entirely in cpuPctFromDeltas so it can
// be exercised against a captured pair without waiting a real second.
async function cpuLinux(windowSeconds: number): Promise<number> {
  const read1 = parseStatCpu(fs.readFileSync("/proc/stat", "utf-8"));
  await sleep(windowSeconds * 1000);
  const read2 = parseStatCpu(fs.readFileSync("/proc/stat", "utf-8"));
  return cpuPctFromDeltas(read1, read2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pure parse: /proc/stat text → the AGGREGATE cpu counter fields (numbers, in the
// kernel's order: user nice system idle iowait irq softirq steal [guest guest_nice]).
//
// AGGREGATE LINE ONLY: we match the line starting with "cpu " (trailing space
// load-bearing) — the all-core total the kernel prints first — NOT the per-core
// "cpu0"/"cpu1"/… lines. `startsWith("cpu ")` excludes "cpu0" because that has no
// space after "cpu". A /proc/stat with no such line (impossible on Linux, but
// guarded) throws → "invalid", never a fabricated reading.
export function parseStatCpu(raw: string): number[] {
  const line = raw.split("\n").find((l) => l.startsWith("cpu "));
  if (line === undefined) {
    throw new Error(`collector cpu: /proc/stat has no aggregate 'cpu ' line`);
  }
  // Drop the "cpu" label; parse the rest fail-loud (an unparseable token throws
  // rather than becoming NaN and poisoning the delta).
  const tokens = line.trim().split(/\s+/).slice(1);
  const fields = tokens.map((t, i) => toFiniteNumber(t, `cpu /proc/stat field ${i}`));
  // Need at least through iowait (index 4) for the busy/idle split below.
  if (fields.length < 5) {
    throw new Error(`collector cpu: /proc/stat 'cpu ' line has too few fields (${fields.length})`);
  }
  return fields;
}

// Pure delta arithmetic — split out so it can be exercised against a captured
// /proc/stat PAIR (~1s apart), no real timer needed. Takes the two field arrays
// from parseStatCpu (read1 earlier, read2 later) and returns the raw busy % over
// the window.
//
// CONVENTION — iowait counted as IDLE (a deliberate choice):
//     busy  = total - idle - iowait
//     total = sum of all fields
//     cpu%  = (busyDelta / totalDelta) * 100
// Counting iowait toward idle (rather than busy) is the top/mpstat convention —
// least surprise, and it matches the reference tools we verify against. iowait is
// time the CPU was idle waiting on I/O; treating it as busy would inflate the
// number versus what an operator sees in top. (The old pihole command counted
// iowait as busy; on a near-idle Pi iowait ≈ 0 so the two agree to the ballpark —
// the small residual is exactly this convention difference, expected, not a bug.)
//
// Raw float % is returned — rounding is display's concern (mirrors the other
// collectors).
//
// FAIL-LOUD: totalDelta <= 0 means the counters didn't advance (non-monotonic or a
// degenerate/zero-length window). /proc/stat counters are monotonic so this
// shouldn't happen, but we guard it explicitly and throw → "invalid" rather than
// dividing by zero/negative and emitting a garbage or negative percent.
export function cpuPctFromDeltas(read1Fields: number[], read2Fields: number[]): number {
  const a = cpuTotals(read1Fields);
  const b = cpuTotals(read2Fields);
  const totalDelta = b.total - a.total;
  const busyDelta  = b.busy - a.busy;
  if (!(totalDelta > 0)) {
    throw new Error(`collector cpu: non-monotonic/degenerate /proc/stat delta (totalDelta=${totalDelta})`);
  }
  return (busyDelta / totalDelta) * 100;
}

// Collapse one field snapshot into (total, busy) using the iowait-as-idle
// convention documented above. Length is guarded by parseStatCpu, but re-checked
// here so cpuPctFromDeltas is self-protecting when fed a hand-built pair.
function cpuTotals(fields: number[]): { total: number; busy: number } {
  if (fields.length < 5) {
    throw new Error(`collector cpu: too few /proc/stat fields (${fields.length}) to split busy/idle`);
  }
  const total  = fields.reduce((sum, f) => sum + f, 0);
  const idle   = fields[3];
  const iowait = fields[4];
  const busy   = total - idle - iowait;   // iowait toward idle — top/mpstat convention
  return { total, busy };
}
