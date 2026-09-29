import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AeroRoutes } from "../src/enrich/aeroapi.js";
import { pickLeg } from "../src/enrich/adb-routes.js";
import { ensureVrsLoaded } from "../src/enrich/vrs-routes.js";
import type { Aircraft } from "@shared/index.js";

let now = Date.parse("2026-09-29T19:00:00Z"); // 2 p.m. Chicago
const dir = mkdtempSync(join(tmpdir(), "w2-"));
writeFileSync(join(dir, "aeroapi.key"), "FAKEY");
writeFileSync(join(dir, "aerodatabox.key"), "ADBKEY\n");
const sched = join(dir, "lookup-schedule.json");
const calls: string[] = [];
let adbStatus = 200;
const leg = (cs: string, o: string, d: string, dep: string, arr: string, status = "EnRoute", modeS?: string) => ({
  number: "XX " + cs.slice(3), callSign: cs, status, aircraft: modeS ? { modeS } : undefined,
  departure: { airport: { icao: "K" + o, iata: o, municipalityName: o + " city", location: { lat: 41, lon: -87 } }, scheduledTime: { utc: dep } },
  arrival: { airport: { icao: "K" + d, iata: d, municipalityName: d + " city", location: { lat: 32, lon: -81 } }, scheduledTime: { utc: arr } } });
const ADB: Record<string, unknown[]> = {
  SWA2820: [leg("SWA2820", "MDW", "SAV", "2026-09-29 18:45Z", "2026-09-29 20:22Z")],
  UAL1732: [leg("UAL1732", "ORD", "CVG", "2026-09-29 18:40Z", "2026-09-29 19:50Z")],
  SWA3151: [], // no data -> CSV (plausible) should be used, no FlightAware
};
const fetcher = (async (url: string, init?: RequestInit) => {
  const u = url.replace(/\?.*/, "");
  calls.push(u.replace(/^https:\/\/[^/]+/, ""));
  if (url.startsWith("https://api.aerodatabox.com")) {
    if ((init?.headers as Record<string, string>)["X-Api-Key"] !== "ADBKEY") return new Response("", { status: 401 });
    if (adbStatus !== 200) return new Response("", { status: adbStatus });
    const cs = u.split("/")[5];
    const d = ADB[cs];
    return d && d.length ? new Response(JSON.stringify(d), { status: 200 }) : new Response(null, { status: 204 });
  }
  const body = url.includes("/account/usage") ? { total_cost: 1.0 } : { flights: [{ ident: "AAL9999", ident_icao: "AAL9999", fa_flight_id: "AAL9999-1",
    actual_off: new Date(now - 3600e3).toISOString(), origin: { code_iata: "DFW" }, destination: { code_iata: "BOS" } }], links: { next: null } };
  return new Response(JSON.stringify(body), { status: 200 });
}) as unknown as typeof fetch;

const decisions: string[] = [];
const mk = () => new AeroRoutes({ keyPath: join(dir, "aeroapi.key"), ledgerPath: join(dir, "aeroapi-budget.json"), fetcher, now: () => now,
  onDecision: (ac, o) => decisions.push(`${ac.flight}:${o}`) });
let fails = 0;
const check = (label: string, ok: boolean, detail: unknown = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`, ok ? "" : JSON.stringify(detail)); if (!ok) fails++; };
const ac = (flight: string, lat: number, lon: number, track: number, hex = flight.toLowerCase().slice(0, 6)): Aircraft => ({ hex, flight, lat, lon, track });
const step = () => { now += 6_000; };
const last = () => decisions.at(-1);
await ensureVrsLoaded();

// --- leg selection unit checks
const L2 = [leg("SWA1", "TPA", "MDW", "2026-09-29 14:00Z", "2026-09-29 16:30Z", "Arrived"), leg("SWA1", "MDW", "LAS", "2026-09-29 18:30Z", "2026-09-29 22:00Z", "EnRoute")];
check("pickLeg: airborne leg chosen over earlier arrived leg", pickLeg(L2 as never, ac("SWA1", 41, -88, 250), now).leg?.arrival?.airport?.iata === "LAS");
const L3 = [leg("SWA1", "TPA", "MDW", "2026-09-29 18:00Z", "2026-09-29 19:30Z", "Expected"), leg("SWA1", "MDW", "LAS", "2026-09-29 18:30Z", "2026-09-29 22:00Z", "Expected")];
check("pickLeg: two legs in window, none airborne -> ambiguous (no guess)", pickLeg(L3 as never, ac("SWA1", 41, -88, 250), now).why === "ambiguous");
const L4 = [leg("SWA1", "TPA", "MDW", "2026-09-29 18:00Z", "2026-09-29 19:30Z", "EnRoute", "AAAAAA"), leg("SWA1", "MDW", "LAS", "2026-09-29 18:30Z", "2026-09-29 22:00Z", "EnRoute", "BBBBBB")];
check("pickLeg: transponder code picks the right plane", pickLeg(L4 as never, ac("SWA1", 41, -88, 250, "bbbbbb"), now).leg?.arrival?.airport?.iata === "LAS");

// --- normal operation
let aero = mk();
const swa = ac("SWA2820", 38.5, -84.9, 140);           // CSV says IND-MCO (plausible here); ADB says MDW-SAV
await aero.lookup(swa);
let [d] = aero.decorate([swa]);
check("AeroDataBox route overrides CSV for every airline flight", d.origin === "MDW" && d.destination === "SAV" && (d.routeSource as string) === "aerodatabox", d);
check("no FlightAware call when AeroDataBox answers", !calls.some(c => c.startsWith("/aeroapi")) && last() === "SWA2820:adb_route", { calls, d: last() });
step(); await aero.lookup(swa);
check("second lookup served from cache (no new call)", last() === "SWA2820:adb_cache" && calls.length === 1, calls);
step(); const ual = ac("UAL1732", 41.9, -87.9, 150); await aero.lookup(ual);
check("non-Southwest airline also uses AeroDataBox", aero.decorate([ual])[0].destination === "CVG");
step(); const csvOk = ac("SWA3151", 41.786, -87.752, 200); await aero.lookup(csvOk);
check("AeroDataBox no data + CSV passes check -> CSV, no FlightAware", last() === "SWA3151:adb_miss_csv" && !calls.some(c => c.startsWith("/aeroapi")), { d: last(), calls });
step(); const aal = ac("AAL9999", 41.5, -87.8, 60); await aero.lookup(aal);
check("AeroDataBox no data + no CSV -> FlightAware backup (any airline)", calls.some(c => c.endsWith("/flights/AAL9999")) && aero.decorate([aal])[0].destination === "BOS", calls);
const st = aero.status() as Record<string, any>;
check("status shows credits used today (4 calls = 8 credits)", st.aerodatabox.creditsToday === 8 && st.lookupMode.mode === "normal", st.aerodatabox);
check("ledger and query log written", existsSync(join(dir, "aerodatabox-ledger.json")) && readdirSync(join(dir, "aerodatabox-queries")).length === 1);

// --- daily cap
writeFileSync(sched, JSON.stringify({ version: 1, paused: false, pausedUntil: null, away: [], adbDailyCredits: 8 }));
step(); calls.length = 0; await aero.lookup(ac("UAL9", 41.5, -87.8, 60));
check("daily cap reached -> no AeroDataBox call", !calls.some(c => c.startsWith("/flights/callsign")) && aero.status().aerodatabox.message.includes("cap"), calls);

// --- pause / away / invalid
writeFileSync(sched, JSON.stringify({ version: 1, paused: true, pausedUntil: null, away: [], adbDailyCredits: 900 }));
step(); calls.length = 0; await aero.lookup(ac("DAL5", 41.5, -87.8, 60));
check("paused -> no calls, CSV only", calls.length === 0 && last() === "DAL5:lookups_paused", { calls, d: last() });
writeFileSync(sched, JSON.stringify({ version: 1, paused: true, pausedUntil: now - 1000, away: [], adbDailyCredits: 900 }));
step(); await aero.lookup(ac("DAL6", 41.5, -87.8, 60));
check("pause with an expired end time -> normal again", last() !== "DAL6:lookups_paused", last());
writeFileSync(sched, JSON.stringify({ version: 1, paused: false, pausedUntil: null, away: [{ id: "a1", start: "2026-09-28", end: "2026-10-01", note: "trip" }], adbDailyCredits: 900 }));
step(); calls.length = 0; await aero.lookup(ac("DAL7", 41.5, -87.8, 60));
check("away period covering today -> no calls", calls.length === 0 && last() === "DAL7:lookups_away", { calls, d: last() });
check("status shows away mode", (aero.status() as any).lookupMode.mode === "away");
writeFileSync(sched, "{not json");
step(); calls.length = 0; await aero.lookup(ac("DAL8", 41.5, -87.8, 60));
check("invalid schedule file stops paid calls", calls.length === 0 && last() === "DAL8:lookups_schedule_invalid", last());
writeFileSync(sched, JSON.stringify({ version: 1, paused: false, pausedUntil: null, away: [], adbDailyCredits: 900 }));

// --- key rejected
adbStatus = 401; step(); calls.length = 0; await aero.lookup(ac("SWA2820", 38.5, -84.9, 140, "ffff01"));
check("rejected key blocks AeroDataBox (falls back to CSV/FlightAware)", (aero.status() as any).aerodatabox.enabled === false, aero.status().aerodatabox);

// --- night window still respected
now = Date.parse("2026-09-30T05:00:00Z"); calls.length = 0; adbStatus = 200;
const aero2 = mk(); await aero2.lookup(ac("UAL1732", 41.9, -87.9, 150, "eeee01"));
check("night hours -> no calls", calls.length === 0);
check("ledger survives restart (credits counted by Chicago day)", (aero2.status() as any).aerodatabox.creditsToday === 0);
console.log(fails ? `${fails} failure(s)` : "All checks passed");
process.exit(fails ? 1 : 0);
