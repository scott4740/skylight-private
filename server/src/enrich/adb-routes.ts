// AeroDataBox route lookups (primary paid source). Credits come from ADS-B
// feeding. Each flight-status call is a TIER 2 request = 2 credits.
// Flight plans are never requested (they double the charge).

import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Aircraft } from "@shared/index.js";
import { chicagoDay } from "./lookup-schedule.js";

const MINUTE = 60_000;
const BASE = "https://api.aerodatabox.com";
export const ADB_CREDITS_PER_CALL = 2;
const AIRBORNE = new Set(["enroute", "departed", "approaching"]);
const clean = (s: unknown) => typeof s === "string" ? s.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
const up = (s: unknown) => typeof s === "string" ? s.trim().toUpperCase() : "";
export const identity = (a: Aircraft) => [a.hex, clean(a.flight), clean(a.registration)].join(":");

interface AdbAirport { icao?: string; iata?: string; localCode?: string; name?: string; shortName?: string; municipalityName?: string; location?: { lat?: number; lon?: number } }
interface AdbTime { utc?: string }
interface AdbEnd { airport?: AdbAirport; scheduledTime?: AdbTime; revisedTime?: AdbTime; predictedTime?: AdbTime; runwayTime?: AdbTime }
export interface AdbFlight { number?: string; callSign?: string; status?: string; departure?: AdbEnd; arrival?: AdbEnd; aircraft?: { modeS?: string; reg?: string } }

export interface AdbRoute {
  origin: string; destination: string; originCodes: string[]; destinationCodes: string[];
  originName?: string; destName?: string; originLat?: number; originLon?: number; destLat?: number; destLon?: number;
  routeSource: "aerodatabox"; routeFlightId: string;
}

const parseT = (s?: string) => {
  if (!s) return null;
  const t = Date.parse(s.replace(" ", "T"));
  return Number.isFinite(t) ? t : null;
};
const endTime = (e?: AdbEnd) => parseT(e?.runwayTime?.utc) ?? parseT(e?.revisedTime?.utc) ?? parseT(e?.predictedTime?.utc) ?? parseT(e?.scheduledTime?.utc);

function toRoute(f: AdbFlight): AdbRoute | null {
  const o = f.departure?.airport, d = f.arrival?.airport;
  const code = (a?: AdbAirport) => up(a?.iata) || up(a?.icao) || up(a?.localCode);
  const origin = code(o), destination = code(d);
  if (!origin || !destination) return null;
  const codes = (a?: AdbAirport) => [up(a?.iata), up(a?.icao), up(a?.localCode)].filter(Boolean);
  const num = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? n : undefined;
  return { origin, destination, originCodes: codes(o), destinationCodes: codes(d),
    originName: o?.municipalityName || o?.shortName || o?.name, destName: d?.municipalityName || d?.shortName || d?.name,
    originLat: num(o?.location?.lat), originLon: num(o?.location?.lon), destLat: num(d?.location?.lat), destLon: num(d?.location?.lon),
    routeSource: "aerodatabox", routeFlightId: `${clean(f.number) || clean(f.callSign)}@${f.departure?.scheduledTime?.utc ?? "?"}` };
}

/**
 * Choose the leg this aircraft is flying now. Prefer legs flown by this
 * transponder, then airborne status, then the departure..arrival window
 * (±45 min). Ambiguity returns null rather than guessing.
 */
export function pickLeg(flights: AdbFlight[], ac: Aircraft, now: number): { leg: AdbFlight | null; why: string } {
  let pool = flights.filter(f => toRoute(f));
  if (!pool.length) return { leg: null, why: "no_airports" };
  const hex = clean(ac.hex);
  const byHex = pool.filter(f => clean(f.aircraft?.modeS) === hex);
  if (hex && byHex.length) pool = byHex;
  const airborne = pool.filter(f => AIRBORNE.has((f.status ?? "").toLowerCase()));
  if (airborne.length === 1) return { leg: airborne[0], why: byHex.length ? "airborne_hex" : "airborne" };
  const candidates = airborne.length > 1 ? airborne : pool;
  const inWindow = candidates.filter(f => {
    const dep = endTime(f.departure), arr = endTime(f.arrival);
    if (dep === null && arr === null) return false;
    return (dep ?? arr!) - 45 * MINUTE <= now && now <= (arr ?? dep!) + 45 * MINUTE;
  });
  if (inWindow.length === 1) return { leg: inWindow[0], why: "time_window" };
  if (inWindow.length > 1) return { leg: null, why: "ambiguous" };
  return { leg: null, why: "no_leg_now" };
}

export type AdbOutcome = "adb_route" | "adb_cache" | "adb_miss" | "adb_miss_cache" | "adb_cap" | "adb_backoff" | "adb_busy"
  | "adb_no_key" | "adb_blocked" | "adb_interval" | "adb_error" | "adb_no_credits";

interface Ledger { version: 1; calls: number[] } // epoch ms of each call (2 credits each)
interface Options { keyPath: string; dataDir: string; fetcher?: typeof fetch; now?: () => number; dailyCap: () => number; header?: string }

export class AdbRoutes {
  private key = "";
  private ledger: Ledger = { version: 1, calls: [] };
  private cache = new Map<string, { until: number; route: AdbRoute | null }>();
  private blocked = false;
  private busy = false;
  private retryAfter = 0;
  private lastCall = 0;
  private creditsEmptySince: number | null = null;
  message = "Ready";
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  private readonly ledgerPath: string;

  constructor(private options: Options) {
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetcher ?? fetch;
    this.ledgerPath = resolve(options.dataDir, "aerodatabox-ledger.json");
    try { this.key = readFileSync(options.keyPath, "utf8").trim(); } catch { /* reported in status */ }
    if (!this.key) this.message = "AeroDataBox key file unavailable";
    try {
      const d = JSON.parse(readFileSync(this.ledgerPath, "utf8"));
      if (d.version !== 1 || !Array.isArray(d.calls) || d.calls.some((n: unknown) => typeof n !== "number" || !Number.isFinite(n))) throw new Error();
      this.ledger = d;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") { this.blocked = true; this.message = "AeroDataBox ledger unreadable; lookups stopped"; }
    }
  }

  creditsToday(t = this.now()): number {
    const day = chicagoDay(t);
    return this.ledger.calls.filter(c => chicagoDay(c) === day).length * ADB_CREDITS_PER_CALL;
  }

  /** Cached route for display, if still current. */
  cached(ac: Aircraft): AdbRoute | null {
    const hit = this.cache.get(identity(ac));
    return hit?.route && hit.until > this.now() && !ac.onGround ? hit.route : null;
  }

  private saveLedger() {
    // Keep ~45 days; older entries are not needed for daily caps or reports.
    const cutoff = this.now() - 45 * 24 * 60 * MINUTE;
    this.ledger.calls = this.ledger.calls.filter(c => c >= cutoff);
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    const tmp = this.ledgerPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.ledger), { mode: 0o600 });
    const fd = openSync(tmp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.ledgerPath);
  }

  /** Remove a call from the ledger when AeroDataBox did not bill it (errors, 402, timeouts). */
  private refund(at: number) {
    const i = this.ledger.calls.lastIndexOf(at);
    if (i < 0) return;
    this.ledger.calls.splice(i, 1);
    try { this.saveLedger(); } catch { /* the next save retries */ }
  }

  private log(event: Record<string, unknown>) {
    let fd: number | undefined;
    try {
      const path = resolve(this.options.dataDir, "aerodatabox-queries", chicagoDay(this.now()).slice(0, 7) + ".jsonl");
      mkdirSync(dirname(path), { recursive: true });
      fd = openSync(path, "a", 0o600);
      writeSync(fd, JSON.stringify({ timestamp: new Date(this.now()).toISOString(), ...event }) + "\n");
    } catch { /* logging must not break lookups */ } finally { if (fd !== undefined) closeSync(fd); }
  }

  async lookup(ac: Aircraft): Promise<AdbOutcome> {
    const now = this.now();
    const id = identity(ac), hit = this.cache.get(id);
    if (hit && hit.until > now) return hit.route ? "adb_cache" : "adb_miss_cache";
    if (!this.key) return "adb_no_key";
    if (this.blocked) return "adb_blocked";
    if (this.busy) return "adb_busy";
    if (now < this.retryAfter) return "adb_backoff";
    if (now - this.lastCall < 5_000) return "adb_interval";
    if (this.creditsToday(now) + ADB_CREDITS_PER_CALL > this.options.dailyCap()) {
      this.message = `Daily AeroDataBox cap reached (${this.options.dailyCap()} credits)`;
      return "adb_cap";
    }
    const callsign = clean(ac.flight);
    this.busy = true;
    try {
      // Record the spend before sending, like the FlightAware ledger.
      this.ledger.calls.push(now);
      try { this.saveLedger(); } catch { this.blocked = true; this.message = "Cannot save AeroDataBox ledger; lookups stopped"; return "adb_blocked"; }
      this.lastCall = now;
      const q = "withAircraftImage=false&withLocation=false&withFlightPlan=false&dateLocalRole=Both";
      const url = `${BASE}/flights/callsign/${encodeURIComponent(callsign)}/${chicagoDay(now)}?${q}`;
      const started = this.now();
      let status = 0;
      let body: unknown = null;
      try {
        const res = await this.fetcher(url, { headers: { [this.options.header ?? "X-Api-Key"]: this.key, Accept: "application/json" },
          redirect: "error", signal: AbortSignal.timeout(12_000) });
        status = res.status;
        if (status === 200) body = await res.json();
      } catch {
        this.refund(now);
        this.log({ event: "query", callsign, aircraft: ac.hex, httpStatus: status || null, outcome: "network_error", durationMs: this.now() - started });
        this.retryAfter = now + 5 * MINUTE; this.message = "AeroDataBox unreachable; retrying in 5 minutes";
        return "adb_error";
      }
      // Only 200 and 204 are counted as billed; everything else is refunded.
      if (status !== 200 && status !== 204) this.refund(now);
      if (status === 401) {
        this.blocked = true; this.message = "AeroDataBox rejected the key (HTTP 401); lookups stopped until restart";
        this.log({ event: "query", callsign, aircraft: ac.hex, httpStatus: status, outcome: "auth_error" });
        return "adb_blocked";
      }
      if (status === 402 || status === 403) {
        // 402 = credit balance empty. 403 is treated the same way rather than
        // stopping for good: check again every 15 minutes, so converting
        // credits restores lookups without a restart.
        this.creditsEmptySince ??= now;
        this.retryAfter = now + 15 * MINUTE;
        this.message = status === 402
          ? "AeroDataBox credit balance is empty: convert credits on My Receivers (rechecking every 15 min)"
          : "AeroDataBox refused the request (HTTP 403); rechecking every 15 min";
        this.log({ event: "query", callsign, aircraft: ac.hex, httpStatus: status, outcome: status === 402 ? "no_credits" : "forbidden" });
        return "adb_no_credits";
      }
      if (status === 429 || status >= 500) {
        this.retryAfter = now + (status === 429 ? 2 : 5) * MINUTE;
        this.message = `AeroDataBox HTTP ${status}; backing off`;
        this.log({ event: "query", callsign, aircraft: ac.hex, httpStatus: status, outcome: "retry_later" });
        return "adb_error";
      }
      if (status === 200 || status === 204) this.creditsEmptySince = null;
      const flights = status === 200 && Array.isArray(body) ? body as AdbFlight[] : [];
      const { leg, why } = pickLeg(flights, ac, now);
      const route = leg ? toRoute(leg) : null;
      // Keep a route until shortly after its arrival (max 4 h); misses for 30 min.
      const arr = leg ? endTime(leg.arrival) : null;
      const until = route ? Math.min(now + 240 * MINUTE, Math.max(now + 30 * MINUTE, (arr ?? now) + 20 * MINUTE)) : now + 30 * MINUTE;
      this.cache.set(id, { until, route });
      for (const [k, v] of this.cache) if (v.until <= now) this.cache.delete(k);
      this.log({ event: "query", callsign, aircraft: ac.hex, httpStatus: status, legs: flights.length, choice: why,
        outcome: route ? "matched" : "no_match", route: route ? `${route.origin}-${route.destination}` : null,
        creditsToday: this.creditsToday(now), durationMs: this.now() - started });
      this.message = route ? `Matched ${callsign} ${route.origin}→${route.destination} — AeroDataBox` : `No current leg for ${callsign} (${why})`;
      return route ? "adb_route" : "adb_miss";
    } finally { this.busy = false; }
  }

  status() {
    const t = this.now();
    return { enabled: !!this.key && !this.blocked, message: this.message, creditsToday: this.creditsToday(t),
      dailyCap: this.options.dailyCap(), callsToday: this.creditsToday(t) / ADB_CREDITS_PER_CALL,
      creditsEmptySince: this.creditsEmptySince ? new Date(this.creditsEmptySince).toISOString() : null,
      creditsPerCall: ADB_CREDITS_PER_CALL, backoffUntil: t < this.retryAfter ? new Date(this.retryAfter).toISOString() : null,
      ledger: this.ledgerPath };
  }
}
