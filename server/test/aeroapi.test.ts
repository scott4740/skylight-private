import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AeroRoutes, matchFlight, type Flight } from "../src/enrich/aeroapi.js";
import type { Aircraft } from "@shared/index.js";
const NOW = Date.parse("2026-09-20T17:00:00Z");
const ac: Aircraft = { hex: "abc123", flight: "SWA1398", registration: "N123UA" };
const flight: Flight = { ident_icao: "SWA1398", registration: "N123UA", fa_flight_id: "SWA1398-current", actual_off: "2026-09-20T16:00:00Z", actual_on: null, actual_in: null, origin: { code_iata: "ORD", city: "Chicago" }, destination: { code_iata: "ATL", city: "Atlanta" } };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup(opts: { usage?: unknown; body?: unknown; ledger?: unknown; failUsage?: boolean; now?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "skylight-aero-test-")); dirs.push(dir);
  const keyPath = join(dir, "key"), ledgerPath = join(dir, "ledger");
  writeFileSync(keyPath, "fake-test-key");
  if (opts.ledger !== undefined) writeFileSync(ledgerPath, typeof opts.ledger === "string" ? opts.ledger : JSON.stringify(opts.ledger));
  let now = opts.now ?? NOW;
  const calls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    const u = String(url); calls.push(u);
    if (u.includes("/account/usage") && opts.failUsage) return new Response("no", { status: 401 });
    // The reservation must exist on disk before ANY paid request.
    if (u.includes("/flights/")) expect(JSON.parse(readFileSync(ledgerPath, "utf8")).reservations.length).toBeGreaterThan(0);
    return new Response(JSON.stringify(u.includes("/account/usage") ? opts.usage ?? { total_cost: 0 } : opts.body ?? { flights: [flight] }), { status: 200 });
  }) as typeof fetch;
  const options = { keyPath, ledgerPath, fetcher, now: () => now };
  return { provider: new AeroRoutes(options), options, calls, advance: (ms: number) => { now += ms; } };
}
describe("flight matching", () => {
  it("selects the airborne ATL leg instead of a completed DEN leg or future flight", () => {
    expect(matchFlight([{ ...flight, destination: { code_iata: "DEN" }, actual_on: "2026-09-20T15:00:00Z" }, flight, { ...flight, actual_off: null }], ac, NOW)?.destination).toBe("ATL");
  });
  it("rejects ambiguous, diverted duplicate, wrong registration, cancelled, old, future and missing-flight-id records", () => {
    expect(matchFlight([flight, flight], ac, NOW)).toBeNull();
    for (const changes of [{ registration: "N999UA" }, { cancelled: true }, { actual_off: "2026-09-18T16:00:00Z" }, { actual_off: "2026-09-21T16:00:00Z" }, { fa_flight_id: undefined }, { ident_icao: "SWA1399" }, { destination: null }]) expect(matchFlight([{ ...flight, ...changes }], ac, NOW)).toBeNull();
  });
  it("supports registration lookup when callsign is missing", () => {
    expect(matchFlight([flight], { ...ac, flight: undefined }, NOW)?.destination).toBe("ATL");
  });
});
describe("lookup and spending safeguards", () => {
  it("reserves before a single-page call and caches the matching aircraft identity", async () => {
    const { provider: p, calls } = setup();
    await p.lookup(ac); await p.lookup(ac);
    expect(calls).toHaveLength(2); expect(calls[1]).toContain("max_pages=1");
    const query = new URL(calls[1]).searchParams;
    expect(query.get("start")).toBe("2026-09-19T17:00:00Z");
    expect(query.get("end")).toBe("2026-09-20T17:01:00Z");
    expect(p.decorate([ac])[0].destination).toBe("ATL");
    expect(p.decorate([{ ...ac, hex: "different" }])[0].destination).toBeUndefined();
    expect(p.decorate([{ ...ac, flight: "SWA10" }])[0].destination).toBeUndefined();
    expect(p.status().reservedDollars).toBe(.005);
    expect(JSON.stringify(p.status())).not.toContain("fake-test-key");
  });
  it("preserves free airports and prefers an unexpired verified cache", async () => {
    const { provider: p, advance } = setup();
    const wrong = { ...ac, origin: "ORD", destination: "DEN", destLat: 40, destLon: -105 };
    expect(p.decorate([wrong])[0].destination).toBe("DEN");
    await p.lookup(ac); expect(p.decorate([wrong])[0].destination).toBe("ATL");
    expect(p.decorate([{ ...wrong, onGround: true }])[0].destination).toBe("DEN");
    advance(600_001); expect(p.decorate([wrong])[0].destination).toBe("DEN");
  });
  it("fails closed on unavailable or unexpected account usage", async () => {
    for (const opts of [{ failUsage: true }, { usage: {} }, { usage: { total_cost: "0" } }]) {
      const { provider: p, calls } = setup(opts); await p.lookup(ac); await p.lookup(ac);
      expect(calls).toHaveLength(1); expect(p.status().requestsThisMonth).toBe(0);
    }
  });
  it("stops at account limit", async () => {
    const { provider: p, calls } = setup({ usage: { total_cost: 10 } });
    await p.lookup(ac); expect(calls).toHaveLength(1); expect(p.status().requestsThisMonth).toBe(0);
  });
  it("stops at 2,000 attempts and allows more than the old daily cap", async () => {
    const capped = setup({ ledger: { version: 1, reservations: Array(2000).fill(NOW - 100_000) } });
    await capped.provider.lookup(ac); expect(capped.calls).toHaveLength(0);
    const available = setup({ ledger: { version: 1, reservations: Array(50).fill(NOW - 100_000) } });
    await available.provider.lookup(ac); expect(available.calls).toHaveLength(2);
  });
  it("uses the final half-cent without double-counting the whole month", async () => {
    const { provider: p, calls } = setup({ usage: { total_cost: 9.995 }, ledger: { version: 1, reservations: Array(1999).fill(NOW - 3600_000) } });
    await p.lookup(ac);
    expect(calls).toHaveLength(2); expect(p.status().requestsThisMonth).toBe(2000);
    expect(p.status().reservedDollars).toBe(10); expect(p.status().remainingBudgetDollars).toBe(0);
  });
  it("accounts for recent unreported requests and releases the lag buffer later", async () => {
    const s = setup({ usage: { total_cost: 9.99 }, ledger: { version: 1, reservations: [NOW - 120_000, NOW - 120_000] } });
    await s.provider.lookup(ac); expect(s.calls).toHaveLength(1);
    s.advance(21 * 60_000); await s.provider.lookup(ac); expect(s.calls).toHaveLength(3);
  });
  it("records free checks, paid queries and errors without the key, and appends after restart", async () => {
    const s = setup(); await s.provider.lookup(ac);
    const path = join(s.options.ledgerPath, "..", "aeroapi-queries", "2026-09-20.jsonl");
    const events = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(events.filter(e => e.event === "query")).toHaveLength(2);
    expect(events.filter(e => e.event === "result")).toHaveLength(2);
    expect(events.find(e => e.event === "match").outcome).toBe("matched");
    expect(events.filter(e => e.event === "query").map(e => e.reservedDollars)).toEqual([0, .005]);
    expect(readFileSync(path, "utf8")).not.toContain("fake-test-key");
    s.advance(120_000); await new AeroRoutes(s.options).lookup(ac);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(10);
  });
  it("starts a new cycle's log and counter without deleting the prior ledger", async () => {
    const s = setup(); await s.provider.lookup(ac);
    s.advance(Date.parse("2026-10-20T17:00:00Z") - NOW);
    expect(s.provider.status().cycleStart).toBe("2026-10-20T00:00:00.000Z");
    expect(s.provider.status().requestsThisMonth).toBe(0);
    expect(s.provider.status().accountReportedDollars).toBeNull();
    await s.provider.lookup(ac);
    expect(s.provider.status().requestsThisMonth).toBe(1);
    expect(readdirSync(join(s.options.ledgerPath, "..", "aeroapi-queries"))).toEqual(["2026-09-20.jsonl", "2026-10-20.jsonl"]);
    expect(JSON.parse(readFileSync(s.options.ledgerPath, "utf8")).reservations).toHaveLength(2);
  });
  it("keeps September usage through October 19 and rolls across December correctly", () => {
    const s = setup({ now: Date.parse("2026-10-19T17:00:00Z"), ledger: { version: 1, reservations: [NOW] } });
    expect(s.provider.status().cycleStart).toBe("2026-09-20T00:00:00.000Z");
    expect(s.provider.status().requestsThisMonth).toBe(1);
    const january = setup({ now: Date.parse("2027-01-01T17:00:00Z") });
    expect(january.provider.status().cycleStart).toBe("2026-12-20T00:00:00.000Z");
    expect(january.provider.status().cycleEnd).toBe("2027-01-20T00:00:00.000Z");
  });
  it("does not send a request when its log cannot be saved", async () => {
    const s = setup(); writeFileSync(join(s.options.ledgerPath, "..", "aeroapi-queries"), "not a directory");
    await s.provider.lookup(ac); expect(s.calls).toHaveLength(0);
    expect(s.provider.status().enabled).toBe(false);
    expect(s.provider.status().message).toContain("Cannot save query log");
  });
  it("keeps reservations over restarts and avoids overlapping lookups", async () => {
    const { provider: p, calls, options } = setup();
    await Promise.all([p.lookup(ac), p.lookup(ac)]); expect(calls).toHaveLength(2);
    const restarted = new AeroRoutes(options); await restarted.lookup({ ...ac, flight: "UAL1" });
    expect(calls).toHaveLength(2); expect(restarted.status().requestsThisMonth).toBe(1);
  });
  it("blocks a corrupt ledger and skips night hours", async () => {
    for (const opts of [{ ledger: "bad json" }, { now: Date.parse("2026-09-21T04:00:00Z") }, { now: Date.parse("2026-09-21T12:59:59Z") }]) {
      const { provider: p, calls } = setup(opts); await p.lookup(ac); expect(calls).toHaveLength(0);
    }
  });
  it("does not follow pagination or display an ambiguous truncated match", async () => {
    const { provider: p, calls } = setup({ body: { flights: [flight], links: { next: "another-page" } } });
    await p.lookup(ac); expect(calls).toHaveLength(2); expect(p.decorate([ac])[0].destination).toBeUndefined();
  });
  it("retains failed paid requests in the ledger", async () => {
    const s = setup();
    const fetcher = (async (url: string | URL | Request) => String(url).includes("/flights/") ? new Response(JSON.stringify({ detail: "Invalid start date fake-test-key" }), { status: 400 }) : new Response('{"total_cost":0}')) as typeof fetch;
    const p = new AeroRoutes({ ...s.options, fetcher }); await p.lookup(ac);
    expect(p.status().requestsThisMonth).toBe(1); expect(p.status().message).toContain("400 (flight lookup): Invalid start date [REDACTED]");
    expect(p.status().message).not.toContain("fake-test-key");
    expect(new AeroRoutes(s.options).status().requestsThisMonth).toBe(1);
  });
});

it("records cached and rate-limited decisions without extra API requests", async () => {
  const s = setup(); const decisions: string[] = [];
  const p = new AeroRoutes({ ...s.options, onDecision: (_ac, outcome) => decisions.push(outcome) });
  await p.lookup(ac); await p.lookup(ac); await p.lookup({ ...ac, flight: "SWA1" });
  expect(decisions).toEqual(["checking_usage", "route_cache", "minimum_interval"]);
  expect(s.calls).toHaveLength(2);
});
it("skips private, charter, cargo and unknown operators without an API request", async () => {
  const s = setup(); const decisions: string[] = [];
  const p = new AeroRoutes({ ...s.options, onDecision: (_ac, outcome) => decisions.push(outcome) });
  for (const flight of ["N878XL", "EJA123", "FDX123", "UPS123", "XYZ123", "UAL", "UAL-123", ""]) await p.lookup({ ...ac, flight });
  expect(s.calls).toHaveLength(0);
  expect(p.status().requestsThisMonth).toBe(0);
  expect(decisions).toEqual(Array(8).fill("excluded_operator"));
});
it("only allows Southwest even when a policy lists other airlines", async () => {
  const s=setup();
  writeFileSync(join(s.options.ledgerPath,"..","aeroapi-policy.json"), JSON.stringify({airlinePrefixes:["SWA","UAL","DAL"]}));
  const p=new AeroRoutes(s.options);
  for (const flight of ["UAL1398","DAL123","SKW1234","VOI1893"]) await p.lookup({...ac,flight});
  expect(s.calls).toHaveLength(0);
  await p.lookup({...ac,flight:"SWA3615"});expect(s.calls).toHaveLength(2);
});
it("skips Southwest when both airports exist, even if incorrect", async () => {
  const s=setup(); const decisions:string[]=[];
  const p=new AeroRoutes({...s.options,onDecision:(_ac,result)=>decisions.push(result)});
  await p.lookup({...ac,origin:"ORD",destination:"DEN"});
  expect(s.calls).toHaveLength(0);expect(p.status().requestsThisMonth).toBe(0);
  expect(decisions).toEqual(["airports_present"]);
  expect(p.decorate([{...ac,origin:"ORD",destination:"DEN"}])[0].destination).toBe("DEN");
});
it("queries Southwest with either airport missing or blank", async () => {
  for (const route of [{origin:"ORD"},{destination:"ATL"},{origin:"ORD",destination:"  "}]) {
    const s=setup();await s.provider.lookup({...ac,...route});expect(s.calls).toHaveLength(2);
  }
});
it("fails closed on an invalid airline policy", async () => {
  const s=setup();writeFileSync(join(s.options.ledgerPath,"..","aeroapi-policy.json"),"bad json");
  const p=new AeroRoutes(s.options);await p.lookup(ac);
  expect(s.calls).toHaveLength(0);expect(p.status().enabled).toBe(false);
});
