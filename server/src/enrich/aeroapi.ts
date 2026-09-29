import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { RouteTrial, type Sample, type LolResult } from "./route-trial.js";
import { decideRoute, lookupVrsNow, trackFrom, vrsStats, ROUTE_POLICY, type RouteDecision, type VrsAirport } from "./vrs-routes.js";
import { chicagoWindow } from "../nearest-demand.js";
import { AdbRoutes } from "./adb-routes.js";
import { LookupSchedule } from "./lookup-schedule.js";
import type { Aircraft } from "@shared/index.js";

const MINUTE = 60_000;
// Integer thousandths of a dollar avoid rounding errors at the final lookup.
const BILLING_DAY = 20; // Confirmed account allowance reset date: 2026-09-20.
const QUERY_MILLS = 5;
const BUDGET_MILLS = 10_000;
const QUERY_LIMIT = BUDGET_MILLS / QUERY_MILLS;
const USAGE_LAG_MS = 20 * MINUTE;
const BASE = "https://aeroapi.flightaware.com/aeroapi";
const clean = (s: unknown) => typeof s === "string" ? s.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
const identity = (a: Aircraft) => [a.hex, clean(a.flight), clean(a.registration)].join(":");
interface Airport { code_iata?: string; code_icao?: string; code_lid?: string; city?: string; name?: string }
export interface Flight {
  ident?: string; ident_icao?: string; atc_ident?: string; registration?: string;
  fa_flight_id?: string; actual_off?: string | null; actual_on?: string | null; actual_in?: string | null;
  cancelled?: boolean; origin?: Airport | null; destination?: Airport | null;
}
export interface Route { originCodes?: string[]; destinationCodes?: string[]; origin: string; destination: string; originName?: string; destName?: string; routeSource: "flightaware"; routeFlightId: string }
/** Never choose a previous or future leg just because it shares a flight number. */
export function matchFlight(flights: Flight[], ac: Aircraft, now: number): Route | null {
  const callsign = clean(ac.flight);
  const reg = clean(ac.registration);
  const matches = flights.filter(f => {
    const off = Date.parse(f.actual_off ?? "");
    const identMatches = callsign ? [f.ident, f.ident_icao, f.atc_ident, f.registration].some(v => clean(v) === callsign)
      : !!reg && clean(f.registration) === reg;
    return identMatches && !(reg && f.registration && reg !== clean(f.registration)) &&
      !f.cancelled && !f.actual_on && !f.actual_in && Number.isFinite(off) && off <= now && now - off < 24 * 60 * MINUTE;
  });
  // Even two records with the same fa_flight_id can represent diversion legs.
  if (matches.length !== 1) return null;
  const f = matches[0];
  const code = (p: Airport | null | undefined) => p?.code_iata || p?.code_icao || p?.code_lid;
  const origin = code(f.origin), destination = code(f.destination);
  if (!origin || !destination || !f.fa_flight_id) return null;
  return { origin, destination, originCodes: [f.origin?.code_iata, f.origin?.code_icao, f.origin?.code_lid].filter((s): s is string => !!s), destinationCodes: [f.destination?.code_iata, f.destination?.code_icao, f.destination?.code_lid].filter((s): s is string => !!s), originName: f.origin?.city || f.origin?.name,
    destName: f.destination?.city || f.destination?.name, routeSource: "flightaware", routeFlightId: f.fa_flight_id };
}
interface Ledger { version: 1; reservations: number[] }
export const DEFAULT_AIRLINE_PREFIXES = ["SWA"];
export const hasAirports = (ac: Aircraft): boolean => !!ac.origin?.trim() && !!ac.destination?.trim();
const ROUTE_KEYS = ["origin", "destination", "originName", "destName", "originLat", "originLon", "destLat", "destLon", "routeSource", "routeFlightId"] as const;
/** Free route decision from the local VRS table for any flight; null until the table has loaded. */
export function freeRoute(ac: Aircraft, prefixes: readonly string[] = DEFAULT_AIRLINE_PREFIXES): RouteDecision | null {
  const callsign = clean(ac.flight);
  if (!callsign) return { display: null, paidLookup: false, reason: "no callsign" };
  const r = lookupVrsNow({ callsign, lat: ac.lat ?? undefined, lon: ac.lon ?? undefined, track: trackFrom(ac) });
  return r && decideRoute(r, { ...ROUTE_POLICY, paidAirlinePrefixes: [...prefixes] });
}
const airportCode = (a: VrsAirport) => a.iata || a.icao || a.code;
function vrsFields(d: NonNullable<RouteDecision["display"]>) {
  const o = d.origin, t = d.destination;
  return { origin: airportCode(o), destination: airportCode(t), originName: o.location || o.name, destName: t.location || t.name,
    originLat: o.lat, originLon: o.lon, destLat: t.lat, destLon: t.lon, routeSource: "vrs" };
}
/** Any airline-style callsign: three letters then a digit (SWA123, AAL1, UAL2331). */
export const airlineCallsign = (ac: Aircraft): boolean => /^[A-Z]{3}[0-9][A-Z0-9]*$/.test((ac.flight ?? "").trim().toUpperCase());
export function airlineEligible(ac: Aircraft, prefixes: readonly string[] = DEFAULT_AIRLINE_PREFIXES): boolean {
  const callsign = (ac.flight ?? "").trim().toUpperCase();
  return /^[A-Z]{3}[0-9][A-Z0-9]*$/.test(callsign) && prefixes.includes(callsign.slice(0, 3));
}
interface Options { onDecision?: (ac: Aircraft, outcome: string) => void; keyPath: string; ledgerPath: string; fetcher?: typeof fetch; now?: () => number }

/** One process owns the ledger. Reservations are persisted BEFORE network calls, including failures. */
export class AeroRoutes {
  private key = "";
  private trial: RouteTrial;
  private adb: AdbRoutes;
  private schedule: LookupSchedule;
  private airlinePrefixes: string[] = [...DEFAULT_AIRLINE_PREFIXES];
  private ledger: Ledger = { version: 1, reservations: [] };
  private blocked = false;
  private busy = false;
  private retryAfter = 0;
  private accountCost: number | null = null;
  private accountCycle: number | null = null;
  private cache = new Map<string, { until: number; route: Route | null }>();
  private message = "Ready";
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  constructor(private options: Options) {
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetcher ?? fetch;
    this.trial = new RouteTrial(resolve(dirname(options.ledgerPath), "route-comparison.json"), this.fetcher, this.now);
    const dataDir = dirname(options.ledgerPath);
    this.schedule = new LookupSchedule(resolve(dataDir, "lookup-schedule.json"));
    this.adb = new AdbRoutes({ keyPath: resolve(dirname(options.keyPath), "aerodatabox.key"), dataDir, fetcher: this.fetcher,
      now: this.now, dailyCap: () => this.schedule.get().adbDailyCredits });
    try { this.key = readFileSync(options.keyPath, "utf8").trim(); } catch { /* safe status below */ }
    if (!this.key) this.message = "API key file unavailable";
    try {
      const policy = JSON.parse(readFileSync(resolve(dirname(options.ledgerPath), "aeroapi-policy.json"), "utf8"));
      if (!Array.isArray(policy.airlinePrefixes) || policy.airlinePrefixes.some((p: unknown) => typeof p !== "string" || !/^[A-Z]{3}$/.test(p))) throw new Error();
      this.airlinePrefixes = [...new Set<string>(policy.airlinePrefixes)].filter(p => p === "SWA");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") { this.blocked = true; this.message = "Airline policy invalid; paid lookups stopped"; }
    }
    try {
      const data = JSON.parse(readFileSync(options.ledgerPath, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.reservations) || data.reservations.some((n: unknown) => typeof n !== "number" || !Number.isFinite(n) || n < 0)) throw new Error();
      this.ledger = data;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") { this.blocked = true; this.message = "Budget ledger unreadable; lookups stopped"; }
    }
  }
  private counts() {
    const now = new Date(this.now());
    // Date-only billing anchor is interpreted at 00:00 UTC on the 20th.
    const cycleMonth = now.getUTCMonth() - (now.getUTCDate() < BILLING_DAY ? 1 : 0);
    const monthStart = Date.UTC(now.getUTCFullYear(), cycleMonth, BILLING_DAY);
    const localDay = chicagoWindow(this.now()).day;
    return { monthStart, cycleEnd: Date.UTC(now.getUTCFullYear(), cycleMonth + 1, BILLING_DAY), month: this.ledger.reservations.filter(t => t >= monthStart).length,
      day: this.ledger.reservations.filter(t => { const local = chicagoWindow(t); return local.active && local.day === localDay; }).length };
  }
  private budgetMills() {
    const c = this.counts();
    const recent = this.ledger.reservations.filter(t => t >= c.monthStart && t >= this.now() - USAGE_LAG_MS).length;
    const account = this.accountCycle === c.monthStart ? this.accountCost : null;
    // Count all local attempts, or the account total plus unreported recent
    // attempts, whichever is larger. Do not double-count the entire month.
    return Math.max(c.month * QUERY_MILLS, account === null ? 0 : Math.ceil(account * 1000 - 1e-7) + recent * QUERY_MILLS);
  }
  private logPath(cycleStart = this.counts().monthStart) {
    return resolve(dirname(this.options.ledgerPath), "aeroapi-queries", new Date(cycleStart).toISOString().slice(0, 10) + ".jsonl");
  }
  private log(event: Record<string, unknown>, cycleStart: number) {
    let fd: number | undefined;
    try {
      const path = this.logPath(cycleStart);
      mkdirSync(dirname(path), { recursive: true });
      fd = openSync(path, "a", 0o600);
      writeSync(fd, JSON.stringify({ timestamp: new Date(this.now()).toISOString(), ...event }) + "\n");
      fsyncSync(fd);
    } catch {
      this.blocked = true;
      throw new Error("Cannot save query log; lookups stopped");
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  status() {
    const c = this.counts();
    const effective = this.budgetMills();
    return { enabled: !!this.key && !this.blocked, message: this.message, busy: this.busy,
      requestsToday: c.day, dailyLimit: null, requestsThisMonth: c.month, monthlyLimit: QUERY_LIMIT,
      reservedDollars: c.month * QUERY_MILLS / 1000, localBudgetDollars: BUDGET_MILLS / 1000,
      costPerLookupDollars: QUERY_MILLS / 1000,
      accountReportedDollars: this.accountCycle === c.monthStart ? this.accountCost : null,
      budgetUsedDollars: effective / 1000, remainingBudgetDollars: Math.max(0, BUDGET_MILLS - effective) / 1000,
      cycleStart: new Date(c.monthStart).toISOString(), cycleEnd: new Date(c.cycleEnd).toISOString(),
      queryLog: this.logPath(), minimumLookupIntervalSeconds: 90,
      comparison: this.trial.status(),
      airlinePrefixes: this.airlinePrefixes, airlineOnly: true, missingAirportsOnly: true, reuseUnverifiedAirports: true,
      freeRouteSource: "vrs-standing-data", freeRoutes: vrsStats(), paidOnFreeStatuses: ROUTE_POLICY.paidOnStatuses,
      lookupOrder: "AeroDataBox (all airline flights) -> CSV if it passes the position check -> FlightAware backup",
      lookupMode: this.schedule.status(this.now()), aerodatabox: this.adb.status(),
      quietHours: "22:00–08:00 America/Chicago" };
  }
  decorate(aircraft: Aircraft[]): Aircraft[] {
    return aircraft.map(ac => {
      // Keep free-source airports as requested. A current verified cache entry
      // replaces the entire route to avoid mixing endpoints from two sources.
      const copy = { ...ac };
      // Free airports come from the VRS table for every flight. A route that
      // fails the position check is removed rather than shown. Until the table
      // loads, incoming airports are left unchanged.
      const free = freeRoute(ac, this.airlinePrefixes);
      if (free) {
        for (const k of ROUTE_KEYS) delete copy[k];
        if (free.display) Object.assign(copy, vrsFields(free.display));
      }
      // AeroDataBox route first, then a FlightAware route, else the CSV route above.
      const adbHit = this.adb.cached(ac);
      const hit = this.cache.get(identity(ac));
      if (adbHit) {
        for (const k of ROUTE_KEYS) delete copy[k];
        Object.assign(copy, adbHit);
      } else if (hit?.route && hit.until > this.now() && !ac.onGround) {
        for (const k of ROUTE_KEYS) delete copy[k];
        Object.assign(copy, hit.route);
      }
      return copy;
    });
  }
  private async get(path: string): Promise<unknown> {
    const paid = path.startsWith("/flights/");
    const stage = paid ? "flight lookup" : "usage check";
    const requestId = randomUUID();
    const started = this.now();
    const cycleStart = this.counts().monthStart;
    const metadata = { requestId, endpoint: paid ? "/flights/{ident}" : "/account/usage",
      ident: paid ? decodeURIComponent(path.split("?")[0].split("/").at(-1)!) : null,
      reservedDollars: paid ? QUERY_MILLS / 1000 : 0 };
    // A durable query record must be written before any request is sent.
    this.log({ ...metadata, event: "query", requestsThisCycle: this.counts().month,
      localReservedDollars: this.counts().month * QUERY_MILLS / 1000 }, cycleStart);
    let httpStatus: number | null = null;
    try {
      const res = await this.fetcher(BASE + path, { headers: { "x-apikey": this.key, Accept: "application/json" },
        redirect: "error", signal: AbortSignal.timeout(12_000) });
      httpStatus = res.status;
      if (!res.ok) {
        let detail = "";
        try {
          const body = await res.json() as { detail?: unknown; reason?: unknown };
          const value = typeof body.detail === "string" ? body.detail : body.reason;
          if (typeof value === "string") detail = value.split(this.key).join("[REDACTED]").replace(/[\r\n\t]/g, " ").slice(0, 300);
        } catch { /* Non-JSON error: report only the status. */ }
        throw new Error(`AeroAPI HTTP ${res.status} (${stage})${detail ? ": " + detail : ""}`);
      }
      const body: unknown = await res.json();
      this.log({ ...metadata, event: "result", httpStatus, outcome: "response_received", durationMs: this.now() - started }, cycleStart);
      return body;
    } catch (e) {
      // Do not persist external error bodies or fetch internals. Safe response
      // detail remains available in the status endpoint for troubleshooting.
      this.log({ ...metadata, event: "result", httpStatus, outcome: "error", durationMs: this.now() - started }, cycleStart);
      throw e;
    }
  }
  async lookup(ac: Aircraft): Promise<void> {
    const now = this.now();
    if (!chicagoWindow(now).active) { this.message = "Night schedule: lookups paused"; return; }
    const decision = (outcome: string) => this.options.onDecision?.(ac, outcome);
    // Pause / away schedule: CSV routes only, no paid calls.
    const mode = this.schedule.mode(now);
    if (mode.mode !== "normal") { decision(`lookups_${mode.mode}`); this.message = `CSV routes only: ${mode.reason}`; return; }
    if (!airlineCallsign(ac)) { decision("excluded_operator"); this.message = "Paid routes limited to airline callsigns"; return; }
    if (ac.onGround) { decision("on_ground"); return; }
    // 1) AeroDataBox for every airline flight (daily credit cap applies).
    const adb = await this.adb.lookup(ac);
    if (adb === "adb_route" || adb === "adb_cache") { decision(adb); this.message = this.adb.message; return; }
    if (adb === "adb_busy" || adb === "adb_interval") { decision(adb); return; }
    // 2) No AeroDataBox route: a CSV route that passes the position check is shown for free.
    const trialEligible = this.trial.eligible(ac);
    const free = freeRoute(ac, this.airlinePrefixes);
    if (!free) { decision("free_routes_loading"); this.message = "Route table loading — no paid lookup"; return; }
    if (free.display && !trialEligible) {
      decision(`${adb}_csv`);
      this.message = `${this.adb.message}; showing CSV route`;
      return;
    }
    // 3) FlightAware backup (existing $10 cycle budget and 90-second spacing).
    if (!this.key) { decision("missing_key"); return; }
    if (this.blocked) { decision("blocked"); return; }
    if (this.busy) { decision("busy"); return; }
    const id = identity(ac), hit = this.cache.get(id);
    if (hit && hit.until > now) { decision(hit.route ? "route_cache" : "no_match_cache"); this.message = hit.route ? "Current flight matched — FlightAware (cached)" : "No unambiguous airborne flight match (cached)"; return; }
    if (now < this.retryAfter) { decision("backoff"); return; }
    const ident = clean(ac.flight) || clean(ac.registration);
    if (!ident || ac.onGround) { decision("missing_identifier"); this.message = "No usable flight identifier"; return; }
    const count = this.counts();
    if (count.month >= QUERY_LIMIT) { decision("budget_limit"); this.message = "Lookup allowance reached; live positions continue"; return; }
    const last = this.ledger.reservations.at(-1) ?? 0;
    if (now - last < 90_000) { decision("minimum_interval"); this.message = "Waiting between lookups"; return; }
    decision("checking_usage");
    this.busy = true;
    let sample: Sample | undefined;
    let lol: Promise<LolResult> | undefined;
    let sampleDone = false;
    try {
      // Gate comparison spending on a usable free response first.
      if (trialEligible) {
        const checked = await this.trial.fetch(ac);
        if (!this.trial.check(ac, checked)) {
          this.message = "Comparison paused: route table unavailable; no comparison charge";
          decision("comparison_free_check_failed");
          return;
        }
        lol = Promise.resolve(checked);
      }
      // Usage is free but delayed. Recent reservations bridge that reporting lag.
      const start = new Date(count.monthStart).toISOString().replace(/\.\d{3}Z$/, "Z");
      const usage = await this.get(`/account/usage?start=${encodeURIComponent(start)}&all_keys=true`) as { total_cost?: unknown };
      if (typeof usage?.total_cost !== "number" || !Number.isFinite(usage.total_cost) || usage.total_cost < 0) {
        throw new Error("Usage response not recognized; paid lookups stopped");
      }
      if (this.counts().monthStart !== count.monthStart) {
        this.message = "Billing cycle changed; rechecking usage on the next attempt";
        return;
      }
      this.accountCost = usage.total_cost;
      this.accountCycle = count.monthStart;
      if (this.budgetMills() + QUERY_MILLS > BUDGET_MILLS) { this.message = "Account budget safeguard reached"; this.retryAfter = now + 10 * MINUTE; return; }
      if (!chicagoWindow(this.now()).active) { this.message = "Night schedule: lookups paused"; return; }
      this.ledger.reservations.push(now);
      try {
        mkdirSync(dirname(this.options.ledgerPath), { recursive: true });
        const tmp = this.options.ledgerPath + ".tmp";
        writeFileSync(tmp, JSON.stringify(this.ledger), { mode: 0o600 });
        const fd = openSync(tmp, "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(tmp, this.options.ledgerPath);
        const dirFd = openSync(dirname(this.options.ledgerPath), "r");
        try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      } catch { this.blocked = true; throw new Error("Cannot save budget ledger; paid lookups stopped"); }
      if (trialEligible) { sample = this.trial.begin(ac); }
      const query = new URLSearchParams({ ident_type: clean(ac.flight) && clean(ac.flight) !== clean(ac.registration) ? "designator" : "registration", max_pages: "1",
        start: new Date(now - 24 * 60 * MINUTE).toISOString().replace(/\.\d{3}Z$/, "Z"), end: new Date(now + MINUTE).toISOString().replace(/\.\d{3}Z$/, "Z") });
      const body = await this.get(`/flights/${encodeURIComponent(ident)}?${query}`) as { flights?: Flight[]; links?: { next?: string | null } };
      // Do not follow pagination; a truncated set cannot establish a unique match.
      const route = Array.isArray(body?.flights) && !body.links?.next ? matchFlight(body.flights, ac, now) : null;
      this.log({ event: "match", ident, aircraft: ac.hex, attemptTimestamp: new Date(now).toISOString(),
        outcome: route ? "matched" : "no_match", requestsThisCycle: this.counts().month,
        localReservedDollars: this.counts().month * QUERY_MILLS / 1000 }, count.monthStart);
      if (sample && lol) { this.trial.finish(sample, route, await lol); sampleDone = true; }
      if (!sample || !free.display) this.cache.set(id, { until: now + (route ? 10 : 30) * MINUTE, route });
      for (const [key, entry] of this.cache) if (entry.until <= now) this.cache.delete(key);
      this.message = route ? "Current flight matched — FlightAware" : "No unambiguous airborne flight match";
    } catch (e) {
      this.message = e instanceof Error && /^(AeroAPI HTTP|Usage response|Cannot save)/.test(e.message) ? e.message : "AeroAPI unavailable; lookups paused";
      this.retryAfter = now + 10 * MINUTE;
    } finally {
      if (sample && lol && !sampleDone) {
        try { this.trial.finish(sample, null, await lol, true); } catch { /* Status exposes the persistent-state error. */ }
      }
      this.busy = false;
    }
  }
}
