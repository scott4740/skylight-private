import { readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import type { Aircraft } from "@shared/index.js";
import type { Route } from "./aeroapi.js";
import { decideRoute, lookupVrsNow, trackFrom, type RouteResult, type VrsAirport } from "./vrs-routes.js";
export type LolResult = { status: string; codes?: string[]; aliases?: string[][]; plausible?: boolean; httpStatus?: number; at: number; source?: string; route?: string; crossTrackNm?: number; reason?: string };
export interface Sample { key: string; callsign: string; hex: string; at: number; completedAt?: number; result?: string; reference?: Route | null; lol?: LolResult; }
interface State { version: 1; enabled: boolean; rows: Sample[]; cooldownUntil?: number; pauseReason?: string; lastCheck?: { callsign: string; result: LolResult } }
const code = (s: unknown) => typeof s === "string" ? s.trim().toUpperCase() : "";
export function parseLol(body: unknown, callsign: string, at: number): LolResult {
  if (!Array.isArray(body)) return { status: "invalid_response", at };
  const matches = body.filter(r => r && code(r.callsign) === code(callsign));
  if (matches.length !== 1) return { status: "missing_or_ambiguous", at };
  const row = matches[0];
  const raw = code(row.airport_codes);
  if (!raw || raw === "UNKNOWN") return { status: "missing", at };
  const codes = raw.split("-").map(code);
  if (codes.some(c => !/^[A-Z0-9]{3,4}$/.test(c))) return { status: "invalid_response", at };
  if (codes.length !== 2) return { status: "multiple_legs", codes, at };
  const airports: { icao?: string; iata?: string }[] = Array.isArray(row._airports) ? row._airports : [];
  const aliases = codes.map(c => {
    const ap = airports.find(a => a && code(a.icao) === c);
    return [...new Set([c, code(ap?.iata)].filter(Boolean))];
  });
  return { status: "pair", codes, aliases, plausible: typeof row.plausible === "boolean" ? row.plausible : undefined, at };
}
/** Free-route result from the local VRS table, in the comparison's result shape. */
export function vrsToLol(r: RouteResult | null, at: number): LolResult {
  const source = "vrs-standing-data";
  if (!r) return { status: "unavailable", at, source, reason: "route table not loaded" };
  const base = { at, source, route: r.route, crossTrackNm: r.crossTrackNm, reason: r.reason };
  const d = decideRoute(r);
  if (!d.display) return { ...base, status: r.status };
  const o = d.display.origin, t = d.display.destination;
  const aliases = (a: VrsAirport) => [...new Set([a.icao, a.iata, a.code].map(code).filter(Boolean))];
  return { ...base, status: "pair", codes: [code(o.icao || o.code), code(t.icao || t.code)], aliases: [aliases(o), aliases(t)], plausible: r.status === "plausible" };
}
export function classify(reference: Route | null, lol: LolResult, failed = false): string {
  if (failed) return "flightaware_error";
  if (!reference) return "no_unique_flightaware_match";
  if (lol.status !== "pair" || !lol.aliases) return lol.source === "vrs-standing-data" ? `vrs_${lol.status}` : `adsblol_${lol.status}`;
  const from = reference.originCodes ?? [reference.origin];
  const to = reference.destinationCodes ?? [reference.destination];
  const equal = (a: string[], b: string[]) => a.some(c => b.map(code).includes(code(c)));
  const a = equal(from, lol.aliases[0]), b = equal(to, lol.aliases[1]);
  if (a && b) return "exact_match";
  if (equal(from,lol.aliases[1]) && equal(to,lol.aliases[0])) return "reversed";
  return a || b ? "partial_match" : "disagreement";
}
export class RouteTrial {
  private state: State = { version: 1, enabled: false, rows: [] };
  private error: string | null = null;
  // The fetcher is no longer used (routes are local); kept so callers are unchanged.
  constructor(private path: string, _fetcher: typeof fetch, private now: () => number) {
    try {
      const s = JSON.parse(readFileSync(path,"utf8"));
      if (s.version !== 1 || typeof s.enabled !== "boolean" || !Array.isArray(s.rows) || s.rows.length > 50 || s.rows.some((r: Sample) => !r || typeof r.key !== "string" || !Number.isFinite(r.at))) throw new Error();
      if (new Set(s.rows.map((r: Sample) => r.key)).size !== s.rows.length || (s.cooldownUntil !== undefined && !Number.isFinite(s.cooldownUntil))) throw new Error();
      this.state = s;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.error = "Comparison state unreadable; comparison disabled"; }
  }
  private key(ac: Aircraft) { return `${ac.hex.toLowerCase()}:${code(ac.flight)}`; }
  eligible(ac: Aircraft) {
    return !this.error && this.state.enabled && this.state.rows.length < 50 && this.now() >= (this.state.cooldownUntil ?? 0) &&
      /^SWA[0-9][A-Z0-9]*$/.test(code(ac.flight)) && !ac.onGround && Number.isFinite(ac.lat) && Number.isFinite(ac.lon) && Math.abs(ac.lat!) <= 90 && Math.abs(ac.lon!) <= 180 &&
      !this.state.rows.some(r => r.key === this.key(ac));
  }
  private save() {
    try {
      const tmp=this.path+".tmp";
      writeFileSync(tmp,JSON.stringify(this.state,null,2),{mode:0o600});
      const fd=openSync(tmp,"r");try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp,this.path);
      const dir=openSync(dirname(this.path),"r");try { fsyncSync(dir); } finally { closeSync(dir); }
    } catch { this.error="Cannot save comparison state; comparison disabled"; throw new Error("Cannot save comparison state"); }
  }
  begin(ac: Aircraft): Sample {
    if (!this.eligible(ac)) throw new Error("Comparison slot unavailable");
    const row: Sample={key:this.key(ac),callsign:code(ac.flight),hex:ac.hex,at:this.now()};
    this.state.rows.push(row);this.save();return row;
  }
  async fetch(ac: Aircraft): Promise<LolResult> {
    // Free route from the local VRS standing-data table; ADSB.lol routeset
    // returns empty HTTP 201 responses. Only the AIRCRAFT's position is used.
    return vrsToLol(lookupVrsNow({ callsign: code(ac.flight), lat: ac.lat ?? undefined, lon: ac.lon ?? undefined, track: trackFrom(ac) }), this.now());
  }
  check(ac: Aircraft, result: LolResult): boolean {
    this.state.lastCheck = { callsign: code(ac.flight), result };
    // The local table always answers once loaded. Implausible / not-found
    // answers are still compared: those are the flights the paid policy
    // sends to FlightAware anyway. Only an unloaded table pauses the trial.
    if (result.status === "unavailable") {
      this.state.enabled = false;
      this.state.pauseReason = "Route table unavailable; no FlightAware request made for this check";
    }
    this.save();
    return result.status !== "unavailable";
  }
  finish(row: Sample, reference: Route | null, lol: LolResult, failed=false) {
    Object.assign(row,{reference,lol,result:classify(reference,lol,failed),completedAt:this.now()});
    if (lol.status==="rate_limited") this.state.cooldownUntil=this.now()+30*60_000;
    this.save();
  }
  status() { return { enabled:this.state.enabled&&!this.error&&this.state.rows.length<50, limit:50, sampled:this.state.rows.length, completed:this.state.rows.filter(r=>r.result).length, maxFlightAwareCostDollars:.25, error:this.error, pauseReason:this.state.pauseReason ?? null, lastCheck:this.state.lastCheck ?? null, stateFile:this.path }; }
}
