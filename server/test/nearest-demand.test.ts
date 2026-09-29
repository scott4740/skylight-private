import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Aircraft } from "@shared/index.js";
import { chicagoWindow, NearestDemand } from "../src/nearest-demand.js";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
const cfg = { ...DEFAULT_CONFIG, centerLat: 41.51, centerLon: -87.82, radiusMiles: 20 };
const a: Aircraft = { hex: "abc", flight: "UAL123", lat: 41.52, lon: -87.82, altBaro: 12000, seen: 0 };
function setup(iso = "2026-09-21T00:00:00Z") {
  const dir = mkdtempSync(join(tmpdir(), "nearest-demand-")); dirs.push(dir);
  let now = Date.parse(iso);
  return { tracker: new NearestDemand(dir, () => now), dir, advance: (ms: number) => now += ms,
    records: () => readdirSync(dir).flatMap(p => readFileSync(join(dir,p), "utf8").trim().split("\n").map(s => JSON.parse(s))) };
}
it("uses Chicago date, daytime boundaries and daylight saving time", () => {
  expect(chicagoWindow(Date.parse("2026-09-21T00:00:00Z"))).toEqual({ day: "2026-09-20", active: true });
  for (const [date, active] of [["2026-09-21T12:59:59Z",false],["2026-09-21T13:00:00Z",true],["2026-09-22T02:59:59Z",true],["2026-09-22T03:00:00Z",false],["2026-12-01T13:59:59Z",false],["2026-12-01T14:00:00Z",true],["2026-12-02T04:00:00Z",false]] as const) expect(chicagoWindow(Date.parse(date)).active).toBe(active);
});
it("requires five continuous seconds, avoids repeat snapshots and counts returns", () => {
  const s = setup(); s.tracker.observe([a],cfg); s.advance(4000); s.tracker.observe([a],cfg);
  expect(s.records().filter(e => e.event === "closest")).toHaveLength(0);
  s.advance(1000); s.tracker.observe([a],cfg); s.advance(1000); s.tracker.observe([a],cfg);
  expect(s.records().filter(e => e.event === "closest")).toHaveLength(1);
  const b = {...a,hex:"def",flight:"SWA1"};
  s.tracker.observe([b],cfg); s.advance(5000); s.tracker.observe([b],cfg);
  s.tracker.observe([a],cfg); s.advance(5000); s.tracker.observe([a],cfg);
  const records=s.records().filter(e => e.event === "closest");
  expect(records).toHaveLength(3); expect(new Set(records.map(e => e.flightKey)).size).toBe(2);
});
it("rejects ground and stale targets and resets across feed gaps", () => {
  const s=setup(); s.tracker.observe([a],cfg); s.advance(6000); s.tracker.observe([a],cfg);
  expect(s.records().filter(e => e.event === "closest")).toHaveLength(0);
  s.advance(5000); s.tracker.observe([{...a,onGround:true}],cfg);
  s.tracker.observe([{...a,seen:999}],cfg);
  expect(s.records().filter(e => e.event === "closest")).toHaveLength(0);
  s.tracker.observe([a],cfg); s.tracker.observe([],cfg,false); s.advance(5000); s.tracker.observe([a],cfg);
  expect(s.records().filter(e => e.event === "closest")).toHaveLength(0);
});
it("does not log overnight observations or lookup checks", () => {
  const s=setup("2026-09-21T03:00:00Z"); s.tracker.observe([a],cfg); s.advance(5000); s.tracker.observe([a],cfg); s.tracker.decision(a,"route_cache");
  expect(s.records()).toEqual([]);
});
it("appends to the same local day after restart and reports logging failures", () => {
  const s=setup();s.tracker.observe([a],cfg);s.advance(5000);s.tracker.observe([a],cfg);
  new NearestDemand(s.dir,()=>Date.parse("2026-09-21T00:01:00Z")).decision(a,"route_cache");
  expect(readdirSync(s.dir)).toEqual(["2026-09-20.jsonl"]);
  expect(s.records().filter(e=>e.event==="lookup_check")).toHaveLength(1);
  const file=join(s.dir,"file");writeFileSync(file,"bad");const broken=new NearestDemand(file,()=>Date.parse("2026-09-21T00:00:00Z"));
  expect(()=>broken.observe([a],cfg)).not.toThrow();expect(broken.status().error).toContain("unavailable");
});
