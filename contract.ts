// ── Shared wire contract ─────────────────────────────────────────────────────
// Single source of truth for the agent <-> server wire format. Both the agent
// build (bundled into agent.cjs via esbuild) and the server import from here so
// the config shape and the metric payload cannot drift apart.
//
// Zod schemas are the source of truth; the TS types are DERIVED from them via
// z.infer — never hand-written alongside. Add a field to a schema and the type
// follows automatically. zod is pure JS (no native module) and inlines cleanly
// into agent.cjs.

import { z } from "zod";

// ── Status ───────────────────────────────────────────────────────────────────
// The set of per-check / per-host statuses the server may assign. "invalid" is
// NEW in this phase — it is added to the union so downstream code can refer to
// it, but nothing PRODUCES it yet. Wiring the ingest boundary to emit "invalid"
// for malformed/non-metric values is a separate, later phase.

export const STATUSES = ["ok", "warn", "crit", "suppressed", "unknown", "invalid"] as const;
export const StatusSchema = z.enum(STATUSES);
export type Status = z.infer<typeof StatusSchema>;

// ── Threshold helper ─────────────────────────────────────────────────────────
// Hand-edited config.json thresholds frequently arrive as strings ("75"), so we
// coerce. But a coerced garbage value becomes NaN — reject it explicitly so a
// typo'd threshold fails loud instead of silently disabling a comparison.
const Threshold = z.coerce
  .number()
  .refine((n) => Number.isFinite(n), { message: "must be a finite number" });

const ThresholdDir = z.enum(["above", "below"]);

// ── CheckConfig ──────────────────────────────────────────────────────────────
// A check is either a "command" check (an arbitrary shell command — the escape
// hatch) or a builtin collector the agent binary implements. Both live in ONE
// single-level union discriminated by `type`: the value is "command" or a
// collector name ("load", "disk", "ping", …) — there is no separate `builtin`
// field. Existing configs predate the discriminant and are all command checks, so
// a check with no `type` is normalized to "command" — every current config.json
// stays valid and command checks are untouched.
//
// IMPORTANT: builtin params are DATA handed to a collector the binary implements.
// No param field is EVER interpolated into a shell command — that is the whole
// point of replacing command-checks with builtins.

// ── Command check (escape hatch) — shape unchanged ───────────────────────────
const CommandCheckSchema = z.object({
  type:         z.literal("command"),
  name:         z.string().min(1),
  command:      z.string().min(1),
  unit:         z.string().default(""),
  warn:         Threshold.optional(),
  crit:         Threshold.optional(),
  thresholdDir: ThresholdDir.optional(),
});
export type CommandCheck = z.infer<typeof CommandCheckSchema>;

// ── Builtin collectors ───────────────────────────────────────────────────────
// The variants below plus CommandCheckSchema form one single-level
// z.discriminatedUnion("type", …), so Zod emits precise field-path errors
// natively (e.g. `checks.0.params.path: Required`) instead of a generic fallback.
//
// Collector DATA params live under a nested `params` object so a param can safely
// reuse a generic word: procs' `params.name` (process name) and service_active's
// `params.unit` (systemd unit) would otherwise collide with the check's top-level
// `name` / `unit`. A `params` whose fields are all-optional defaults to {}; a
// `params` with required fields must be supplied (omitting it => "params:
// Required", a present-but-incomplete params => the exact missing inner field).
// Numeric params are coerced (configs are hand-edited). Mirrors Xymon's default
// client + server monitor set. NOTE: no param field is EVER interpolated into a
// shell command — collectors are implemented in the binary.

// Fields shared by every builtin variant (identity + thresholds; the discriminant
// `type` literal is set per-variant).
const checkBaseFields = {
  name:         z.string().min(1),
  unit:         z.string().default(""),
  warn:         Threshold.optional(),
  crit:         Threshold.optional(),
  thresholdDir: ThresholdDir.optional(),
};

// Client-side — local reads.
const LoadCheckSchema = z.object({          // 1-min loadavg (/proc/loadavg). Primary cpu-pressure signal.
  type: z.literal("load"), ...checkBaseFields,
});
const CpuCheckSchema = z.object({           // windowed /proc/stat delta
  type: z.literal("cpu"), ...checkBaseFields,
  params: z.object({
    window_seconds: z.coerce.number().positive().default(1),
  }).default({}),
});
const MemoryCheckSchema = z.object({        // physical RAM used %
  type: z.literal("memory"), ...checkBaseFields,
  params: z.object({
    kind: z.enum(["physical"]).default("physical"),
  }).default({}),
});
const SwapCheckSchema = z.object({          // swap used % (distinct from memory; Xymon MEMSWAP)
  type: z.literal("swap"), ...checkBaseFields,
});
const DiskCheckSchema = z.object({          // mount/drive used %
  type: z.literal("disk"), ...checkBaseFields,
  params: z.object({ path: z.string().min(1) }),
});
const InodesCheckSchema = z.object({        // filesystem inode usage %
  type: z.literal("inodes"), ...checkBaseFields,
  params: z.object({ path: z.string().min(1) }),
});
const ProcsCheckSchema = z.object({         // process presence/count (Xymon PROC)
  type: z.literal("procs"), ...checkBaseFields,
  params: z.object({
    name: z.string().min(1),                          // process name/pattern to match
    min:  z.coerce.number().int().default(1),         // count below this => breach
    max:  z.coerce.number().int().default(-1),        // -1 = unlimited
  }),
});
const ServiceActiveCheckSchema = z.object({ // systemd unit active => 1/0
  type: z.literal("service_active"), ...checkBaseFields,
  params: z.object({ unit: z.string().min(1) }),   // down => crit; not-found/errored => "invalid"
});
const FileCheckSchema = z.object({          // general file check; "expiry" => cert days-remaining
  type: z.literal("file"), ...checkBaseFields,
  params: z.object({
    path: z.string().min(1),
    mode: z.enum(["expiry", "size", "age", "mtime", "exists"]),
  }),
});
const TemperatureCheckSchema = z.object({   // thermal zone °C
  type: z.literal("temperature"), ...checkBaseFields,
  params: z.object({ zone: z.string().default("zone0") }).default({}),
});
const UptimeCheckSchema = z.object({        // uptime; reboot-recent / up-too-long (Xymon UP)
  type: z.literal("uptime"), ...checkBaseFields,
});

// Server/network-side — outbound.
const PingCheckSchema = z.object({          // ICMP RTT ms
  type: z.literal("ping"), ...checkBaseFields,
  params: z.object({
    target: z.string().min(1),                        // literal IP/host, or "gateway"/"dns" sentinel (resolved in code)
  }),
});
const HttpCheckSchema = z.object({          // HTTP status / latency
  type: z.literal("http"), ...checkBaseFields,
  params: z.object({
    url:           z.string().url(),
    expect_status: z.coerce.number().int().default(200),
  }),
});
const PortCheckSchema = z.object({          // TCP connect check
  type: z.literal("port"), ...checkBaseFields,
  params: z.object({
    host: z.string().min(1),
    port: z.coerce.number().int().min(1).max(65535),
  }),
});

// Existing configs predate the discriminant and are all command checks, so a
// check with no `type` is normalized to "command" — every current config.json
// stays valid and command checks are byte-for-byte untouched. Builtin checks name
// their collector explicitly (type: "disk", type: "ping", …).
export const CheckConfigSchema = z.preprocess(
  (val) =>
    val && typeof val === "object" && !("type" in (val as Record<string, unknown>))
      ? { ...(val as Record<string, unknown>), type: "command" }
      : val,
  z.discriminatedUnion("type", [
    CommandCheckSchema,
    LoadCheckSchema, CpuCheckSchema, MemoryCheckSchema, SwapCheckSchema,
    DiskCheckSchema, InodesCheckSchema, ProcsCheckSchema, ServiceActiveCheckSchema,
    FileCheckSchema, TemperatureCheckSchema, UptimeCheckSchema,
    PingCheckSchema, HttpCheckSchema, PortCheckSchema,
  ]),
);
export type CheckConfig = z.infer<typeof CheckConfigSchema>;

// All non-command variants — the collector checks — derived from the union.
export type BuiltinCheck = Exclude<CheckConfig, CommandCheck>;

// ── AgentConfig ──────────────────────────────────────────────────────────────
// The effective config the agent runs on (file + environment + defaults merged).
// serverUrl is validated only for presence here; the agent still constructs a
// URL() from it, which remains the real parse gate.

export const AgentConfigSchema = z.object({
  host:            z.string().min(1),
  group:           z.string().min(1),
  division:        z.string().optional(),
  department:      z.string().optional(),
  token:           z.string().optional(),
  serverUrl:       z.string().min(1),
  intervalSeconds: z.coerce.number().positive(),
  checks:          z.array(CheckConfigSchema).min(1),
  caCertPath:      z.string().optional(),
  insecureTLS:     z.boolean().optional(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// ── Metric payload (agent -> POST /api/status) ───────────────────────────────
// The inbound wire format the server ingests. A check value is number OR string
// (the agent reports the raw string when a command's output isn't numeric, or
// the literal "error" when a command fails), which is exactly the ambiguity the
// later ingest-validation phase will tighten. warn/crit are already numbers on
// the wire (they were coerced at config load), so no coercion here.

export const CheckValueSchema = z.object({
  name:         z.string(),
  value:        z.union([z.number(), z.string()]),
  unit:         z.string(),
  warn:         z.number().optional(),
  crit:         z.number().optional(),
  thresholdDir: z.string().optional(),
  status:       StatusSchema.optional(),
});
export type CheckValue = z.infer<typeof CheckValueSchema>;

export const MetricPayloadSchema = z.object({
  host:            z.string().min(1),
  group:           z.string().optional(),
  division:        z.string().nullish(),
  department:      z.string().nullish(),
  ip:              z.string().nullish(),
  timestamp:       z.string().optional(),
  intervalSeconds: z.number().optional(),
  checks:          z.array(CheckValueSchema),
});
export type MetricPayload = z.infer<typeof MetricPayloadSchema>;

// ── Runtime validators ───────────────────────────────────────────────────────
// safeParse-based, usable by BOTH agent and server. On failure they return
// structured, fail-loud messages keyed by field path (e.g. "checks.0.command:
// Required") rather than throwing.

export interface ValidationSuccess<T> { success: true;  data: T; }
export interface ValidationFailure    { success: false; errors: string[]; }
export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

function formatIssues(err: z.ZodError): string[] {
  return err.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

export function validateAgentConfig(raw: unknown): ValidationResult<AgentConfig> {
  const result = AgentConfigSchema.safeParse(raw);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, errors: formatIssues(result.error) };
}

export function validateMetricPayload(raw: unknown): ValidationResult<MetricPayload> {
  const result = MetricPayloadSchema.safeParse(raw);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, errors: formatIssues(result.error) };
}
