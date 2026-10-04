// Free route lookup from ADSB.lol's VRS standing-data mirror, replacing the
// broken POST /api/0/routeset. Data: https://vrs-standing-data.adsb.lol/
// (routes.csv + airports.csv, CC0, updated hourly upstream).
//
// Files are cached under server/data/vrs and refreshed at most every
// REFRESH_HOURS with conditional requests. Lookups are local and free.
// A failed refresh keeps the previous files.

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

const BASE_URL = process.env.VRS_BASE_URL ?? "https://vrs-standing-data.adsb.lol";
// skylight-server runs from ~/skylight; the CLI runs from ~/skylight/server.
// Both should use ~/skylight/server/data/vrs alongside the other state files.
const DATA_DIR =
  process.env.VRS_DATA_DIR ??
  (existsSync(path.resolve(process.cwd(), "server", "data"))
    ? path.resolve(process.cwd(), "server", "data", "vrs")
    : path.resolve(process.cwd(), "data", "vrs"));
const REFRESH_HOURS = Number(process.env.VRS_REFRESH_HOURS ?? 6);
const USER_AGENT = "SkylightRouteLookup/1.0 (contact: scott4740@gmail.com)";
const FILES = ["routes.csv", "airports.csv"] as const;

export interface VrsAirport {
  code: string;
  icao: string;
  iata: string;
  name: string;
  location: string;
  lat: number;
  lon: number;
}

export type RouteStatus =
  | "plausible" // aircraft position fits a leg of the published route
  | "implausible" // route exists but the aircraft is not on any leg of it
  | "unverified" // route exists but position/airports were missing
  | "not_found"; // callsign not in the database

export interface RouteResult {
  source: "vrs-standing-data";
  callsign: string;
  status: RouteStatus;
  route?: string; // full ICAO chain, e.g. "KDAL-KHOU-KCRP"
  origin?: VrsAirport; // chosen leg (or first/last airport if unverified)
  destination?: VrsAirport;
  legIndex?: number;
  legCount?: number;
  crossTrackNm?: number;
  reason: string;
}

interface Tables {
  routes: Map<string, string[]>;
  airports: Map<string, VrsAirport>;
  loadedAt: number;
}

let tables: Tables | null = null;
let loading: Promise<Tables> | null = null;
let nextAttemptAt = 0; // backoff after a failed initial load

// ---------- CSV ----------

/** Parse one CSV line. Fast path for lines without quotes (almost all of them). */
function parseLine(line: string): string[] {
  if (line.indexOf('"') < 0) return line.split(",");
  const out: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let j = i + 1, val = "";
      for (;;) {
        const q = line.indexOf('"', j);
        if (q < 0) { val += line.slice(j); j = line.length; break; }
        val += line.slice(j, q);
        if (line[q + 1] === '"') { val += '"'; j = q + 2; continue; }
        j = q + 1; break;
      }
      out.push(val);
      const comma = line.indexOf(",", j);
      i = comma < 0 ? line.length + 1 : comma + 1;
    } else {
      const comma = line.indexOf(",", i);
      out.push(comma < 0 ? line.slice(i) : line.slice(i, comma));
      i = comma < 0 ? line.length + 1 : comma + 1;
    }
  }
  return out;
}

/** Iterate CSV rows without building the whole table as arrays (keeps memory flat). */
function* csvRows(text: string): Generator<string[]> {
  let start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    let line = text.slice(start, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    start = end + 1;
    if (line) yield parseLine(line);
  }
}

/** Kept for tests and callers that want a full table. */
export function parseCsv(text: string): string[][] {
  return [...csvRows(text)];
}

function indexer(header: string[]) {
  const idx = new Map(header.map((h, i) => [h.trim().toLowerCase(), i]));
  return (row: string[], name: string) => {
    const i = idx.get(name);
    return i === undefined ? "" : (row[i] ?? "").trim();
  };
}

/** Copy a string so it doesn't keep a slice of the big source text alive. */
const own = (s: string) => (" " + s).slice(1);

function buildTables(routesCsv: string, airportsCsv: string): Tables {
  const routes = new Map<string, string[]>();
  const codePool = new Map<string, string>(); // one shared string per airport code
  const intern = (c: string) => { let v = codePool.get(c); if (v === undefined) { v = own(c); codePool.set(c, v); } return v; };
  const rows = csvRows(routesCsv);
  const first = rows.next();
  if (!first.done) {
    const rget = indexer(first.value);
    for (const r of rows) {
      const cs = rget(r, "callsign").toUpperCase();
      const codes = rget(r, "airportcodes");
      if (cs && codes) routes.set(own(cs), Object.freeze(codes.toUpperCase().split("-").filter(Boolean).map(intern)) as string[]);
    }
  }

  const airports = new Map<string, VrsAirport>();
  const arows = csvRows(airportsCsv);
  const afirst = arows.next();
  if (!afirst.done) {
    const aget = indexer(afirst.value);
    for (const r of arows) {
      const lat = Number(aget(r, "latitude"));
      const lon = Number(aget(r, "longitude"));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const a: VrsAirport = {
        code: intern(aget(r, "code").toUpperCase()),
        icao: intern(aget(r, "icao").toUpperCase()),
        iata: intern(aget(r, "iata").toUpperCase()),
        name: own(aget(r, "name")),
        location: own(aget(r, "location")),
        lat,
        lon,
      };
      if (a.code) airports.set(a.code, a);
      if (a.icao && !airports.has(a.icao)) airports.set(a.icao, a);
    }
  }
  if (routes.size === 0 || airports.size === 0) {
    throw new Error(`VRS tables empty (routes=${routes.size}, airports=${airports.size})`);
  }
  return { routes, airports, loadedAt: Date.now() };
}

// ---------- download / cache ----------

async function fileAgeHours(p: string): Promise<number> {
  try {
    const st = await fs.stat(p);
    return (Date.now() - st.mtimeMs) / 3_600_000;
  } catch {
    return Infinity;
  }
}

async function refreshFile(name: string): Promise<void> {
  const dest = path.join(DATA_DIR, name);
  const metaPath = dest + ".meta.json";
  let meta: { etag?: string; lastModified?: string } = {};
  try { meta = JSON.parse(await fs.readFile(metaPath, "utf8")); } catch {}
  const haveFile = Number.isFinite(await fileAgeHours(dest));

  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (haveFile && meta.etag) headers["If-None-Match"] = meta.etag;
  if (haveFile && meta.lastModified) headers["If-Modified-Since"] = meta.lastModified;

  const res = await fetch(`${BASE_URL}/${name}`, { headers, signal: AbortSignal.timeout(120_000) });
  if (res.status === 304) {
    const now = new Date();
    await fs.utimes(dest, now, now);
    return;
  }
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const body = await res.text();
  if (body.length < 1000) throw new Error(`${name}: suspiciously small (${body.length} bytes)`);
  const tmp = dest + ".tmp";
  await fs.writeFile(tmp, body);
  await fs.rename(tmp, dest);
  await fs.writeFile(
    metaPath,
    JSON.stringify({
      etag: res.headers.get("etag") ?? undefined,
      lastModified: res.headers.get("last-modified") ?? undefined,
      fetchedAt: new Date().toISOString(),
    }),
  );
}

async function load(force = false): Promise<Tables> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  let refreshError: unknown = null;
  for (const f of FILES) {
    const age = await fileAgeHours(path.join(DATA_DIR, f));
    if (force || age > REFRESH_HOURS) {
      try { await refreshFile(f); } catch (e) { refreshError = e; }
    }
  }
  try {
    const [r, a] = await Promise.all(FILES.map((f) => fs.readFile(path.join(DATA_DIR, f), "utf8")));
    return buildTables(r, a);
  } catch (e) {
    throw refreshError ?? e;
  }
}

/** Load tables if missing or stale. Safe to call often; concurrent calls share one load. */
export async function ensureVrsLoaded(force = false): Promise<Tables> {
  const stale = !tables || (Date.now() - tables.loadedAt) / 3_600_000 > REFRESH_HOURS;
  if (!force && !stale) return tables!;
  if (!loading) {
    loading = load(force)
      .then((t) => (tables = t))
      .catch((e) => {
        if (tables) {
          console.warn("[vrs-routes] refresh failed, keeping previous tables:", e);
          tables.loadedAt = Date.now(); // back off until next interval
          return tables;
        }
        nextAttemptAt = Date.now() + 10 * 60_000;
        throw e;
      })
      .finally(() => (loading = null));
  }
  return loading;
}

/**
 * Synchronous lookup for per-tick server code. Returns null (and starts a
 * background load) until the tables are available; stale tables are used
 * while a refresh runs in the background.
 */
export function lookupVrsNow(input: LookupInput): RouteResult | null {
  const stale = !tables || (Date.now() - tables.loadedAt) / 3_600_000 > REFRESH_HOURS;
  if (stale && !loading && Date.now() >= nextAttemptAt) {
    ensureVrsLoaded().catch((e) => console.warn("[vrs-routes] load failed; retrying in 10 minutes:", e));
  }
  return tables ? lookupInTables(tables, input) : null;
}

export function vrsStats() {
  return tables
    ? { routes: tables.routes.size, airports: tables.airports.size, loadedAt: new Date(tables.loadedAt).toISOString() }
    : null;
}

// ---------- geometry ----------

const R_NM = 3440.065;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function distNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

// Tunables for the per-leg check.
export const FIT = {
  nearAirportNm: 30, // within this of either end: position fits regardless of heading
  minToleranceNm: 25,
  maxToleranceNm: 100,
  toleranceFraction: 0.12, // of leg length
  maxHeadingOffDeg: 90, // track vs bearing to destination
};

interface LegFit {
  index: number;
  fits: boolean;
  xtd: number;
  headingOk: boolean; // true when no track given
  why: string;
}

function checkLeg(a: VrsAirport, b: VrsAirport, lat: number, lon: number, track: number | undefined, index: number): LegFit {
  const dAB = distNm(a.lat, a.lon, b.lat, b.lon);
  const dAP = distNm(a.lat, a.lon, lat, lon);
  const dPB = distNm(lat, lon, b.lat, b.lon);
  const xtd = Math.abs(
    Math.asin(Math.sin(dAP / R_NM) * Math.sin(rad(bearingDeg(a.lat, a.lon, lat, lon) - bearingDeg(a.lat, a.lon, b.lat, b.lon)))) * R_NM,
  );
  const atd = Math.acos(Math.max(-1, Math.min(1, Math.cos(dAP / R_NM) / Math.cos(xtd / R_NM)))) * R_NM;
  const nearEnd = dAP <= FIT.nearAirportNm || dPB <= FIT.nearAirportNm;
  const tol = Math.min(FIT.maxToleranceNm, Math.max(FIT.minToleranceNm, FIT.toleranceFraction * dAB));
  const between = atd <= dAB + FIT.nearAirportNm && dPB <= dAB + FIT.nearAirportNm;
  const off = track !== undefined && Number.isFinite(track) ? angleDiff(track, bearingDeg(lat, lon, b.lat, b.lon)) : 0;
  const headingOk = off <= FIT.maxHeadingOffDeg;

  // Near an endpoint the position fits regardless of heading (departure turns,
  // approach patterns); heading is still used to choose between legs.
  if (nearEnd) return { index, fits: true, xtd, headingOk, why: "near leg endpoint" };
  if (xtd > tol) return { index, fits: false, xtd, headingOk, why: `off track ${xtd.toFixed(0)}nm > ${tol.toFixed(0)}nm` };
  if (!between) return { index, fits: false, xtd, headingOk, why: "beyond leg ends" };
  if (!headingOk) return { index, fits: false, xtd, headingOk, why: `heading away from ${b.code} (${off.toFixed(0)}°)` };
  return { index, fits: true, xtd, headingOk, why: "on leg" };
}

// ---------- lookup ----------

/** Aircraft track in degrees true from an aircraft record, if present. */
export function trackFrom(ac: unknown): number | undefined {
  const o = ac as Record<string, unknown> | null;
  for (const k of ["track", "true_heading", "heading", "mag_heading"]) {
    const v = o?.[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

export interface LookupInput {
  callsign: string;
  lat?: number;
  lon?: number;
  track?: number; // degrees true, from aircraft.json "track"
}

export async function lookupVrsRoute(input: LookupInput): Promise<RouteResult> {
  const t = await ensureVrsLoaded();
  return lookupInTables(t, input);
}

export function lookupInTables(t: Pick<Tables, "routes" | "airports">, input: LookupInput): RouteResult {
  const callsign = input.callsign.trim().toUpperCase();
  const base = { source: "vrs-standing-data" as const, callsign };
  const codes = t.routes.get(callsign);
  if (!codes || codes.length < 2) return { ...base, status: "not_found", reason: "callsign not in VRS routes" };

  const route = codes.join("-");
  const aps = codes.map((c) => t.airports.get(c));
  const legCount = codes.length - 1;
  const first = aps[0], last = aps[aps.length - 1];

  if (aps.some((a) => !a) || input.lat === undefined || input.lon === undefined) {
    return {
      ...base, status: "unverified", route, legCount,
      origin: legCount === 1 ? first : undefined,
      destination: legCount === 1 ? last : undefined,
      reason: aps.some((a) => !a) ? "airport coordinates missing" : "no aircraft position",
    };
  }

  const fits: LegFit[] = [];
  for (let i = 0; i < legCount; i++) fits.push(checkLeg(aps[i]!, aps[i + 1]!, input.lat, input.lon, input.track, i));
  const good = fits
    .filter((f) => f.fits)
    .sort((x, y) => Number(y.headingOk) - Number(x.headingOk) || x.xtd - y.xtd);

  if (good.length === 0) {
    const best = [...fits].sort((x, y) => x.xtd - y.xtd)[0];
    return { ...base, status: "implausible", route, legCount, crossTrackNm: round(best.xtd), reason: best.why };
  }
  const g = good[0];
  return {
    ...base, status: "plausible", route, legCount, legIndex: g.index,
    origin: aps[g.index]!, destination: aps[g.index + 1]!,
    crossTrackNm: round(g.xtd),
    reason: good.length > 1 ? `${g.why}; ${good.length} legs fit, chose closest` : g.why,
  };
}

const round = (n: number) => Math.round(n * 10) / 10;

// ---------- display / paid-lookup policy ----------

export interface RoutePolicy {
  /** Callsign prefixes eligible for a paid FlightAware lookup. */
  paidAirlinePrefixes: string[];
  /** Free-lookup outcomes that count as "no usable route" for eligible airlines. */
  paidOnStatuses: RouteStatus[];
}

export const ROUTE_POLICY: RoutePolicy = {
  paidAirlinePrefixes: ["SWA"],
  paidOnStatuses: ["not_found", "implausible", "unverified"],
};

export interface RouteDecision {
  /** Airports to show from the free lookup, or null to show none. */
  display: { origin: VrsAirport; destination: VrsAirport } | null;
  /** True when this flight should get a (budget-limited) FlightAware lookup. */
  paidLookup: boolean;
  reason: string;
}

/**
 * CSV route for every flight; FlightAware only for eligible airlines when the
 * CSV gives nothing usable. A single-leg route with no position to check is
 * shown as-is (same as the earlier reuseUnverifiedAirports choice) and does
 * not trigger a paid lookup.
 */
export function decideRoute(r: RouteResult, policy: RoutePolicy = ROUTE_POLICY): RouteDecision {
  const eligible = policy.paidAirlinePrefixes.some((p) => r.callsign.startsWith(p));
  const usable =
    (r.status === "plausible" || (r.status === "unverified" && r.legCount === 1)) && r.origin && r.destination;
  if (usable) return { display: { origin: r.origin!, destination: r.destination! }, paidLookup: false, reason: `csv ${r.status}` };
  const paid = eligible && policy.paidOnStatuses.includes(r.status);
  return {
    display: null,
    paidLookup: paid,
    reason: paid ? `csv ${r.status}; eligible for paid lookup` : `csv ${r.status}; no paid lookup for this airline`,
  };
}
