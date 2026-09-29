import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type Aircraft } from "@shared/index.js";
import { nearbyAircraft, NearestSelector } from "../src/display/nearest.js";
const cfg = { ...DEFAULT_CONFIG, centerLat: 41.51384, centerLon: -87.82465, radiusMiles: 20, staleSec: 20 };
const plane = (hex: string, d: number, extra: Partial<Aircraft> = {}): Aircraft => ({ hex, lat: cfg.centerLat + d, lon: cfg.centerLon, altBaro: 8000, seen: 0, ...extra });
describe("nearest aircraft", () => {
  it("orders ground distances and excludes ground, stale, invalid, distant, and altitude-filtered targets", () => {
    const aircraft = [plane("far", .1), plane("near", .01), plane("ground", 0, { onGround: true }), plane("stale", 0, { seen: 20 }), plane("invalid", 0, { lat: NaN }), plane("missing", 0, { lon: undefined }), plane("range", 1), plane("low", 0, { altBaro: 0 }), plane("high", 0, { altBaro: 100000 })];
    expect(nearbyAircraft(aircraft, cfg).map(x => x.ac.hex)).toEqual(["near", "far"]);
  });
  it("expires snapshots even when the connection stays open without fresh messages", () => {
    expect(nearbyAircraft([plane("old", 0, { seen: 12 })], cfg, 8)).toEqual([]);
  });
  it("requires a continuous five-second challenger and resets after a brief crossover", () => {
    const s = new NearestSelector();
    const a = { ac: plane("a", .01), miles: 1 };
    const b = { ac: plane("b", .02), miles: 2 };
    expect(s.choose([a,b], 0)?.ac.hex).toBe("a");
    expect(s.choose([b,a], 1000)?.ac.hex).toBe("a");
    expect(s.choose([a,b], 5000)?.ac.hex).toBe("a");
    expect(s.choose([b,a], 6000)?.ac.hex).toBe("a");
    expect(s.choose([b,a], 10999)?.ac.hex).toBe("a");
    expect(s.choose([b,a], 11000)?.ac.hex).toBe("b");
  });
  it("replaces a lost target immediately and clears on empty feed", () => {
    const s = new NearestSelector();
    const a = { ac: plane("a", .01), miles: 1 };
    const b = { ac: plane("b", .02), miles: 2 };
    s.choose([a,b], 0);
    expect(s.choose([b], 10)?.ac.hex).toBe("b");
    expect(s.choose([], 20)).toBeNull();
    expect(s.choose([a], 30)?.ac.hex).toBe("a");
  });
});
