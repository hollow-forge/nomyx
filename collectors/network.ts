// ── Network collectors ──────────────────────────────────────────────────────────
// The first outbound collector: it doesn't read local state, it probes the network.
// ping shells out to the stock ping binary via execFile (fixed argv, no shell) —
// the probe confirmed ICMP works for the unprivileged agent account through
// net.ipv4.ping_group_range (no setuid, no cap_net_raw, no native dependency).
//
//   collectPing(check)              — platform seam; resolves the target, then pings
//   resolveTarget(target)           — literal, or the "gateway"/"dns" sentinels
//                                     resolved NATIVELY (no `ip route | awk` shell)
//   pingLinux(target)               — the execFile wrapper (thin; catches non-zero)
//   parseGatewayFromRoute(raw)      — pure: default gateway from /proc/net/route
//   parseFirstIpv4Nameserver(raw)   — pure: first IPv4 nameserver from resolv.conf
//   parsePingRtt(stdout, exitCode)  — pure: RTT ms, or the 9999 no-reply sentinel
//
// DOWN-vs-INVALID (network framing — the fault IS the signal):
//   • host replies      → emit RTT ms (thresholded "above": high latency → warn/crit)
//   • host doesn't reply → the UNREACHABLE fault we monitor for → emit 9999 ms so
//                          latency thresholds trip (migrates config.pihole.json's old
//                          `END{print 9999}`) — a DETERMINED answer, NOT invalid
//   • can't even attempt → sentinel unresolvable (no default route / no IPv4 resolver),
//                          ping binary missing, or ping couldn't run → INVALID
//   "The host is down" and "I couldn't run the check" are different alerts.
//
// SUBPROCESS SAFETY: execFile('ping', [..., target]) — target is one literal argv
// entry, never interpolated, so "1.1.1.1; echo INJECTED" becomes a bogus hostname
// ping fails to resolve, never a shell command. Same discipline as service_active.

import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { toFiniteNumber, type Collector } from "./shared";

const execFileP = promisify(execFile);

// The -W per-packet timeout doubles as the down-threshold: no reply within this many
// seconds counts as unreachable. The schema carries no timeout param yet, so this is
// the default (matches the old commands' `-W 2`).
const PING_TIMEOUT_SEC = 2;

// Emitted on no-reply so an "above" latency threshold trips — byte-for-byte the old
// config.pihole.json behavior (`END{if(!f) print 9999}`).
const NO_REPLY_MS = 9999;

export async function collectPing(check: Collector<"ping">): Promise<number> {
  if (process.platform === "win32") {
    throw new Error("collector ping: Windows backend not yet implemented");
  }
  const target = resolveTarget(check.params.target);
  return pingLinux(target);
}

// Sentinels resolve NATIVELY from /proc and /etc — no subprocess. A literal target
// is passed through untouched (ping does its own DNS for hostnames; it's a fixed arg).
// An unresolvable sentinel throws → "invalid" (config/environment error, not a
// down host).
function resolveTarget(target: string): string {
  if (target === "gateway") {
    return parseGatewayFromRoute(fs.readFileSync("/proc/net/route", "utf-8"));
  }
  if (target === "dns") {
    return parseFirstIpv4Nameserver(fs.readFileSync("/etc/resolv.conf", "utf-8"));
  }
  return target;
}

async function pingLinux(target: string): Promise<number> {
  let stdout: string;
  let exitCode: number;
  try {
    // -c 1 single echo; -W timeout. execFile timeout is a belt-and-suspenders kill in
    // case ping hangs (e.g. slow DNS) — a killed ping falls to the else → invalid.
    const r = await execFileP("ping", ["-c", "1", "-W", String(PING_TIMEOUT_SEC), target],
      { timeout: (PING_TIMEOUT_SEC + 3) * 1000 });
    stdout = r.stdout;
    exitCode = 0;
  } catch (err: any) {
    // ping exits non-zero when it gets no reply — that's the ANSWER (unreachable),
    // not a failure to run. Read stdout + exit code and let parsePingRtt interpret.
    if (typeof err?.code === "number") {
      stdout = typeof err.stdout === "string" ? err.stdout : "";
      exitCode = err.code;
    } else {
      // Spawn failed: ping missing (ENOENT), killed by the timeout/a signal — the
      // check could not run at all → cannot determine → invalid.
      const detail = err?.code ?? err?.signal ?? err?.message ?? "unknown";
      throw new Error(`collector ping: cannot run ping (${detail})`);
    }
  }
  return parsePingRtt(stdout, exitCode);
}

// ── Pure parsers ─────────────────────────────────────────────────────────────

// RTT from ping stdout, or the no-reply sentinel. Testable against captured output.
//   • "time=<X> ms" present → that's the RTT (a reply arrived), regardless of exit.
//   • no RTT + exit 1        → packets sent, none returned → unreachable → 9999.
//   • no RTT + any other exit → ping couldn't measure (resolution/arg error, exit 2;
//                               or unexpected) → throw → "invalid".
export function parsePingRtt(stdout: string, exitCode: number): number {
  const m = stdout.match(/time[=<]\s*([\d.]+)\s*ms/);
  if (m) {
    return toFiniteNumber(m[1], "ping rtt");
  }
  if (exitCode === 1) {
    return NO_REPLY_MS;   // unreachable fault — a determined answer, not invalid
  }
  throw new Error(`collector ping: could not measure RTT (exit ${exitCode})`);
}

// Default gateway IP from /proc/net/route. The default route is the row whose
// Destination is "00000000" (0.0.0.0) with the RTF_GATEWAY flag (0x2) set. The
// Gateway field is the address in little-endian hex — reverse the byte order to get
// the dotted quad. No default route → throw → "invalid" (can't resolve 'gateway').
export function parseGatewayFromRoute(raw: string): string {
  const lines = raw.trim().split("\n");
  for (const line of lines.slice(1)) {   // slice(1): skip the column header row
    const cols = line.split(/\s+/);
    if (cols.length < 4) continue;
    const [, destination, gateway, flagsHex] = cols;
    if (destination !== "00000000") continue;
    if (!(parseInt(flagsHex, 16) & 0x2)) continue;   // RTF_GATEWAY not set — skip
    return decodeHexIpLE(gateway);
  }
  throw new Error("collector ping: no default route in /proc/net/route (cannot resolve 'gateway')");
}

// "0102030A" → bytes [01,02,03,0A], little-endian → IP 10.3.2.1 (reversed).
function decodeHexIpLE(hex: string): string {
  if (!/^[0-9A-Fa-f]{8}$/.test(hex)) {
    throw new Error(`collector ping: malformed gateway hex ${JSON.stringify(hex)} in /proc/net/route`);
  }
  const b = [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `${b[3]}.${b[2]}.${b[1]}.${b[0]}`;
}

// First IPv4 nameserver from /etc/resolv.conf. IPv6 nameserver lines are skipped —
// an ICMP (IPv4) target needs a v4 address (netmon is Tailscale-managed with both a
// v4 and a v6 resolver). None found → throw → "invalid" (can't resolve 'dns').
const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export function parseFirstIpv4Nameserver(raw: string): string {
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith(";")) continue;   // comment
    const m = trimmed.match(/^nameserver\s+(\S+)/);
    if (m && IPV4_RE.test(m[1])) return m[1];
  }
  throw new Error("collector ping: no IPv4 nameserver in /etc/resolv.conf (cannot resolve 'dns')");
}
