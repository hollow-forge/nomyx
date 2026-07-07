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
// Discriminated on `type`. Existing configs predate the discriminant and are all
// command checks, so a check with no `type` is normalized to "command" before
// validation — every current config.json stays valid. "builtin" is forward-
// looking (a named internal collector) and not yet implemented by the agent.

const CommandCheckSchema = z.object({
  type:         z.literal("command"),
  name:         z.string().min(1),
  command:      z.string().min(1),
  unit:         z.string().default(""),
  warn:         Threshold.optional(),
  crit:         Threshold.optional(),
  thresholdDir: ThresholdDir.optional(),
});

const BuiltinCheckSchema = z.object({
  type:         z.literal("builtin"),
  name:         z.string().min(1),
  builtin:      z.string().min(1),   // identifier of a built-in collector (future)
  unit:         z.string().default(""),
  warn:         Threshold.optional(),
  crit:         Threshold.optional(),
  thresholdDir: ThresholdDir.optional(),
});

export const CheckConfigSchema = z.preprocess(
  (val) =>
    val && typeof val === "object" && !("type" in (val as Record<string, unknown>))
      ? { ...(val as Record<string, unknown>), type: "command" }
      : val,
  z.discriminatedUnion("type", [CommandCheckSchema, BuiltinCheckSchema]),
);
export type CheckConfig = z.infer<typeof CheckConfigSchema>;

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
