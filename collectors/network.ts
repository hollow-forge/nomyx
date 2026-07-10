// ── Network collectors ──────────────────────────────────────────────────────────
// Outbound collectors: they don't read local state, they probe the network.
//   ping — shells out to the stock ping binary via execFile (fixed argv, no shell);
//          the probe confirmed ICMP works for the unprivileged agent account through
//          net.ipv4.ping_group_range (no setuid, no cap_net_raw, no native dep).
//   port — pure Node net.createConnection TCP-connect check; spawns NOTHING (see below).
//   http — pure Node http/https GET; status-match check, strict TLS; spawns NOTHING.
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
import net from "net";
import http from "http";
import https from "https";
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

// ── port ─────────────────────────────────────────────────────────────────────
// TCP-connect presence check — 1 if something is listening on host:port, 0 if not.
// Pure Node net.createConnection: NO subprocess, NO shell, and — unlike ping — this
// spawns NOTHING. host/port are socket connection OPTIONS, not a command line, so
// there is no injection surface at all (safer than ping's execFile). It's a single
// connect with no data sent, then the socket is destroyed.
//
// Cross-platform: net.createConnection is identical on Linux and Windows, so there
// is NO OS-backend seam and NO win32 throw here (contrast the /proc collectors,
// whose reads are Linux-specific).
//
// DOWN-vs-INVALID (same framing as ping — the fault IS the signal):
//   • 'connect' fires        → 1 (port open; presence threshold: thresholdDir "below",
//                              warn/crit ~0.5, so 0 trips the port-closed fault)
//   • refused / timeout /    → 0 — the port-closed / unreachable FAULT we monitor
//     host-unreachable          for; a DETERMINED "not open", NOT invalid
//   • host unresolvable /    → INVALID — couldn't even attempt (config/DNS error),
//     bad config                distinct from a closed port
// The error-code → outcome split lives in classifyConnectError (pure). A refused
// connection MUST read 0/fault; a DNS failure MUST read invalid — they are not lumped.

const PORT_TIMEOUT_MS = 3000;   // the connect timeout doubles as the down-threshold

export async function collectPort(check: Collector<"port">): Promise<number> {
  return tcpConnect(check.params.host, check.params.port);
}

// Thin async wrapper over the event-based socket API. The socket is destroyed on
// EVERY path (connect, timeout, error) via done(), so no fd leaks and no lingering
// connections. `settled` guards against a second event after we've resolved.
function tcpConnect(host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port, timeout: PORT_TIMEOUT_MS });
    let settled = false;
    const done = (act: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      act();
    };
    socket.once("connect", () => done(() => resolve(1)));   // listening — no data sent, close immediately
    socket.once("timeout", () => done(() => resolve(0)));   // filtered / host down → closed fault
    socket.once("error", (err: NodeJS.ErrnoException) =>
      done(() => classifyConnectError(err.code) === "invalid"
        ? reject(new Error(`collector port: cannot attempt ${host}:${port} (${err.code ?? err.message})`))
        : resolve(0)),
    );
  });
}

// Pure: a connect error code → 0 (port-closed / unreachable FAULT — a determined
// answer) or "invalid" (couldn't even attempt). Testable without opening a socket.
//   ECONNREFUSED  nothing listening              → 0 (the classic closed-port signal)
//   ETIMEDOUT     OS-level connect timeout       → 0
//   EHOSTUNREACH/ENETUNREACH/EHOSTDOWN  no route → 0 (unreachable is a fault, not can't-tell)
//   ECONNRESET    listener reset the handshake   → 0
//   ENOTFOUND/EAI_AGAIN  DNS can't resolve host  → invalid (couldn't attempt)
//   anything else (e.g. ERR_SOCKET_BAD_PORT)     → invalid (bad config)
export function classifyConnectError(code: string | undefined): 0 | "invalid" {
  switch (code) {
    case "ECONNREFUSED":
    case "ETIMEDOUT":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "EHOSTDOWN":
    case "ECONNRESET":
      return 0;
    default:
      return "invalid";
  }
}

// ── http ─────────────────────────────────────────────────────────────────────
// HTTP(S) status-match check — 1 if the response status equals params.expect_status
// (default 200), else 0. Pure Node http/https GET: NO subprocess, spawns nothing; the
// URL is a request option, not a command line — no injection surface. Cross-platform,
// so no OS seam / no win32 throw (like port).
//
// LOCKED DECISIONS:
//   • Status-MATCH, not 2xx-ish: status === expect_status → 1, anything else → 0. A
//     301/302 when expecting 200 is a real, surfaced event → 0.
//   • DON'T FOLLOW REDIRECTS: we check the ACTUAL response status. Node's http.get does
//     not auto-follow, and we add no redirect logic — a 301 stays 301 → 0.
//   • STRICT TLS: rejectUnauthorized is left at its secure default. An expired /
//     self-signed / wrong-host cert makes the request error → 0 (fault). We NEVER set
//     rejectUnauthorized:false. (Cert-expiry-DAYS warning is separate deferred work.)
//
// DOWN-vs-INVALID (same framing as ping/port):
//   • status == expect_status                         → 1 (OK)
//   • status != expect_status (incl. unfollowed 3xx)  → 0 (answered-but-unhealthy fault)
//   • refused / timeout / TLS cert rejected / unreachable → 0 (endpoint down or TLS
//                                                     broken — the FAULT we monitor)
//   • malformed URL / non-http(s) scheme / DNS-unresolvable → INVALID (couldn't attempt)
// The status-match is trivially pure; the error → 0|invalid split is classifyHttpError.

const HTTP_TIMEOUT_MS = 5000;   // request timeout — part of the down signal

export async function collectHttp(check: Collector<"http">): Promise<number> {
  return httpProbe(check.params.url, check.params.expect_status);
}

function httpProbe(rawUrl: string, expectStatus: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      reject(new Error(`collector http: malformed URL ${JSON.stringify(rawUrl)}`));
      return;
    }
    // Scheme allowlist — only http/https reach the network. file:/ftp:/… → invalid
    // (a determined config error, never attempted).
    const mod = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
    if (!mod) {
      reject(new Error(`collector http: unsupported URL scheme ${JSON.stringify(url.protocol)} (only http/https)`));
      return;
    }

    let settled = false;
    // agent:false → a one-off socket that closes after the response (no pooled
    // keep-alive handle lingering to hold the event loop open). Strict TLS: no
    // rejectUnauthorized override, so a bad cert errors out below.
    const req = mod.get(url, { timeout: HTTP_TIMEOUT_MS, agent: false }, (res) => {
      const status = res.statusCode ?? 0;
      res.resume();   // drain & discard the body — we only need the status; frees the socket
      if (settled) return;
      settled = true;
      resolve(status === expectStatus ? 1 : 0);   // match → 1, mismatch → 0 (fault)
    });
    req.once("timeout", () => {
      if (settled) return;
      settled = true;
      req.destroy();   // slow/hung endpoint → fault; destroy so no fd lingers
      resolve(0);
    });
    req.once("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      classifyHttpError(err.code) === "invalid"
        ? reject(new Error(`collector http: cannot attempt ${rawUrl} (${err.code ?? err.message})`))
        : resolve(0);
    });
  });
}

// Pure: an http request error code → 0 (fault) or "invalid" (couldn't attempt). This
// INVERTS classifyConnectError's default: for HTTP, a TLS/cert error (CERT_HAS_EXPIRED,
// DEPTH_ZERO_SELF_SIGNED_CERT, ERR_TLS_CERT_ALTNAME_INVALID, …) is a REAL endpoint
// fault → 0, as is refused/timeout/unreachable. ONLY a DNS-resolution failure means we
// never reached anything → invalid. (Malformed URL / bad scheme are rejected before the
// request is made, so they don't pass through here.)
export function classifyHttpError(code: string | undefined): 0 | "invalid" {
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "invalid";
    default:
      return 0;   // connection refused / timeout / TLS cert rejected / unreachable → fault
  }
}
