// ── Shared collector helpers ───────────────────────────────────────────────────
// Leaf module: pure type + parse helpers with no dependency on any collector. The
// dependency flow is one-directional — index → fileread → shared → contract — so
// nothing here imports a collector or the dispatch.

import type { BuiltinCheck } from "../contract";

// Narrow a BuiltinCheck to a single collector variant by its `type` discriminant,
// so a per-collector function receives exactly its own params shape.
export type Collector<T extends BuiltinCheck["type"]> = Extract<BuiltinCheck, { type: T }>;

// Finite-number guard shared by the single-value parsers (load, uptime,
// temperature). Callers do their own tokenizing and hand in the already-extracted
// token plus a ctx for the error message. The empty-string check is load-bearing:
// Number("") === 0 is finite, so without it an empty/whitespace-only file would
// parse as 0 rather than fail loud.
export function toFiniteNumber(token: string, ctx: string): number {
  const value = Number(token);
  if (token === "" || !Number.isFinite(value)) {
    throw new Error(`collector ${ctx}: unparseable (${JSON.stringify(token)})`);
  }
  return value;
}

// Extract a numeric "<Key>:  <value> kB" field from /proc/meminfo. Shared by the
// memory and swap parsers, which keep their own distinct total/zero handling — only
// the field extractor is shared. `key` is always a hardcoded literal (MemTotal /
// SwapTotal / …), so the interpolated regex is injection-safe; do NOT make key
// caller/config-supplied.
export function meminfoField(raw: string, key: string): number | undefined {
  const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m"));
  return m ? Number(m[1]) : undefined;
}
