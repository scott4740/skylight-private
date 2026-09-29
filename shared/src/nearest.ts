import { llToMeters, metersToMiles, rangeMeters, type Aircraft, type Config } from "./index.js";

export interface NearbyAircraft { ac: Aircraft; miles: number }

/** Ground distance, matching the map's range. Never promote stale or ground targets. */
export function nearbyAircraft(aircraft: Aircraft[], cfg: Config, snapshotAgeSec = 0): NearbyAircraft[] {
  return aircraft.flatMap((ac) => {
    if (ac.onGround || !Number.isFinite(ac.lat) || !Number.isFinite(ac.lon) ||
        Math.abs(ac.lat!) > 90 || Math.abs(ac.lon!) > 180) return [];
    const age = (ac.seen ?? 0) + snapshotAgeSec;
    if (!Number.isFinite(age) || age >= cfg.staleSec) return [];
    const alt = ac.altBaro ?? ac.altGeom;
    if (alt != null && (!Number.isFinite(alt) || alt < cfg.minAltitudeFt || alt > cfg.maxAltitudeFt)) return [];
    const miles = metersToMiles(rangeMeters(llToMeters(ac.lat!, ac.lon!, cfg.centerLat, cfg.centerLon)));
    return miles <= cfg.radiusMiles ? [{ ac, miles }] : [];
  }).sort((a, b) => a.miles - b.miles || a.ac.hex.localeCompare(b.ac.hex));
}

/** A challenger must remain closest for five seconds; lost targets are replaced immediately. */
export class NearestSelector {
  private current: string | null = null;
  private challenger: string | null = null;
  private since = 0;
  reset(): void { this.current = this.challenger = null; }
  choose(candidates: NearbyAircraft[], now: number, delayMs = 5000): NearbyAircraft | null {
    const closest = candidates[0];
    if (!closest) { this.reset(); return null; }
    const current = candidates.find(({ ac }) => ac.hex === this.current);
    if (!current || current.ac.hex === closest.ac.hex) {
      this.current = closest.ac.hex;
      this.challenger = null;
      return closest;
    }
    if (this.challenger !== closest.ac.hex) {
      this.challenger = closest.ac.hex;
      this.since = now;
    }
    if (now - this.since >= delayMs) {
      this.current = closest.ac.hex;
      this.challenger = null;
      return closest;
    }
    return current;
  }
}
