// ── Subprocess collectors ───────────────────────────────────────────────────────
// The first collector to shell out since disk went native — but NOT via a shell.
// The whole tier's safety rule ("parameterize, don't interpolate") gets its real
// test here: we run systemctl through execFile with a fixed argv, so a config-
// supplied unit name is passed as a single literal argument and never touches a
// command line.
//
//   collectServiceActive(check) — selects the platform backend (Linux / Windows throws)
//   serviceActiveLinux(unit)    — validates the unit, runs `systemctl is-active <unit>`
//                                 via execFile, hands the (stdout, exitCode) to the
//                                 pure interpreter
//   interpretIsActive(...)      — pure: the up / down / invalid mapping, testable
//                                 against captured systemctl outputs without spawning
//
// SUBPROCESS SAFETY — execFile, never exec:
//   execFile('systemctl', ['is-active', unit]) spawns systemctl directly with no
//   shell, so `unit` is one argv entry. A hostile unit like "nginx; rm -rf /" or
//   "x; echo INJECTED" becomes a literal (nonexistent) service NAME — systemctl
//   reports it unknown; the shell metacharacters are never interpreted. exec(
//   'systemctl is-active ' + unit) would be a shell-injection hole and is FORBIDDEN.
//   execFile-not-exec is the PRIMARY guarantee; the UNIT_RE charset check below is
//   defense-in-depth that rejects wild input before we even spawn.
//
// The FAIL-LOUD invariant holds as elsewhere: a check that cannot be determined
// throws → the dispatch in ./index returns status:"invalid". The care specific to
// this collector is the down-vs-invalid distinction — see interpretIsActive.

import { execFile } from "child_process";
import { promisify } from "util";
import type { Collector } from "./shared";

const execFileP = promisify(execFile);

// Defense-in-depth: a systemd unit name is letters/digits and .:_@- (the "." also
// admits the ".service" suffix). Anything outside this — spaces, ';', '|', '/', '$',
// backticks — is not a real unit and is rejected up front, so wild/hostile input
// never reaches the spawn. (execFile already neutralizes it; this fails it louder,
// sooner, and more legibly.)
const UNIT_RE = /^[A-Za-z0-9._@-]+$/;

// Pure interpreter result: the service is UP, genuinely DOWN, or the check could
// not be determined (INVALID). Exported alongside interpretIsActive so both are
// testable.
export type IsActiveResult =
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "invalid"; reason: string };

export async function collectServiceActive(check: Collector<"service_active">): Promise<number> {
  if (process.platform === "win32") {
    throw new Error("collector service_active: Windows backend not yet implemented");
  }
  return serviceActiveLinux(check.params.unit);
}

async function serviceActiveLinux(unit: string): Promise<number> {
  if (!UNIT_RE.test(unit)) {
    throw new Error(`collector service_active: invalid unit name ${JSON.stringify(unit)}`);
  }

  let stdout: string;
  let exitCode: number;
  try {
    // Resolves ⇒ systemctl exited 0 ⇒ the unit is active.
    const r = await execFileP("systemctl", ["is-active", unit]);
    stdout = r.stdout;
    exitCode = 0;
  } catch (err: any) {
    // execFile THROWS on any non-zero exit — but `systemctl is-active` exits
    // non-zero DELIBERATELY for a service that is simply not active. That non-zero
    // exit is the ANSWER, not a failure to run, so we do NOT treat the throw as
    // "invalid" outright: we read stdout + the numeric exit code off the error and
    // let interpretIsActive decide down-vs-invalid.
    if (typeof err?.code === "number") {
      stdout = typeof err.stdout === "string" ? err.stdout : "";
      exitCode = err.code;
    } else {
      // The spawn itself failed — systemctl missing (ENOENT), not permitted
      // (EACCES), or killed by a signal. The check genuinely could not run, so it
      // is unknowable → invalid (never read as a service being "down").
      const detail = err?.code ?? err?.signal ?? err?.message ?? "unknown";
      throw new Error(`collector service_active: cannot run systemctl (${detail})`);
    }
  }

  const res = interpretIsActive(stdout, exitCode);
  if (res.kind === "up")   return 1;   // active  → 1 (OK)
  if (res.kind === "down") return 0;   // not active → 0 (trips a "below" threshold → crit)
  throw new Error(`collector service_active: ${res.reason}`);   // → status "invalid"
}

// Pure status mapping — split out so it can be exercised against captured
// (stdout, exitCode) pairs from real systemctl runs, no spawning.
//
// DOWN-vs-INVALID is the whole point of this function, and the two signals must be
// read TOGETHER — stdout alone is not enough. On systemd, `is-active`:
//   • exit 0            → the unit is active            → UP (stdout is "active")
//   • exit 3            → the unit exists but is NOT active (inactive / failed /
//                          deactivating / activating)  → genuinely DOWN
//   • exit 4            → NO SUCH UNIT                  → cannot determine → INVALID
//   • anything else / spawn failure                    → INVALID
// The exit-4 carve-out is essential and verified on the Pi: a nonexistent unit
// prints "inactive" on stdout (identical to a real dead service) yet exits 4 — so
// keying "down" off the stdout word ALONE would misreport a typo'd unit as a
// down/crit service. We must gate on the exit code.
export function interpretIsActive(stdout: string, exitCode: number): IsActiveResult {
  const status = stdout.trim().split(/\s+/)[0] ?? "";

  if (exitCode === 0) {
    // The only definitive "active". If exit is 0 but the word isn't "active",
    // something is off (version quirk / unexpected output) — don't fabricate UP.
    return status === "active"
      ? { kind: "up" }
      : { kind: "invalid", reason: `systemctl is-active exited 0 with unexpected status ${JSON.stringify(status)}` };
  }

  // No-such-unit exits 4 even though older/newer systemd may still print
  // "inactive"/"unknown" — this is "couldn't check", NOT "service is down".
  if (exitCode === 4) {
    return { kind: "invalid", reason: `unit not found (systemctl is-active exit 4, status ${JSON.stringify(status)})` };
  }

  // Non-zero, not-found ruled out: a recognized systemd non-active state word means
  // the unit really exists and is not active → a genuine, alertable DOWN.
  const DOWN = new Set(["inactive", "failed", "deactivating", "activating", "reloading"]);
  if (DOWN.has(status)) {
    return { kind: "down" };
  }

  // Non-zero exit with an unrecognized status word (e.g. "unknown", empty) — we
  // cannot honestly call it up or down.
  return { kind: "invalid", reason: `unrecognized systemctl is-active result (status ${JSON.stringify(status)}, exit ${exitCode})` };
}
