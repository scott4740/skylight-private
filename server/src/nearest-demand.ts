import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Aircraft, Config } from "@shared/index.js";
import { nearbyAircraft } from "@shared/nearest.js";

const calendar = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
export function chicagoWindow(now: number) {
  const parts = Object.fromEntries(calendar.formatToParts(now).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, active: Number(parts.hour) >= 8 && Number(parts.hour) < 22 };
}
const flightKey = (a: Aircraft) => `${a.hex.toLowerCase()}:${(a.flight ?? "").trim().toUpperCase()}`;

/** Passive local-feed observations. This class never makes network requests. */
export class NearestDemand {
  private candidate = "";
  private since = 0;
  private featured = "";
  private lastAt = 0;
  private lastDay = "";
  private lastMinute = -1;
  private error: string | null = null;
  constructor(private directory: string, private now: () => number = Date.now) {}
  status() { return { window: "08:00–22:00 America/Chicago", error: this.error, logDirectory: this.directory }; }
  private write(event: Record<string, unknown>, at: number) {
    const local = chicagoWindow(at);
    if (!local.active) return;
    try {
      mkdirSync(this.directory, { recursive: true });
      appendFileSync(resolve(this.directory, `${local.day}.jsonl`), JSON.stringify({ timestamp: new Date(at).toISOString(), localDate: local.day, ...event }) + "\n", { mode: 0o600 });
      this.error = null;
    } catch { this.error = "Daytime demand log unavailable; observations may be missing"; }
  }
  observe(aircraft: Aircraft[], cfg: Config, live = true) {
    const now = this.now(), local = chicagoWindow(now);
    if (!live || !local.active) { this.candidate = this.featured = ""; this.lastAt = 0; return; }
    if (local.day !== this.lastDay || now - this.lastAt > 5000 || now < this.lastAt) {
      this.candidate = this.featured = "";
      this.lastMinute = -1;
    }
    this.lastDay = local.day;
    this.lastAt = now;
    const minute = Math.floor(now / 60_000);
    if (minute !== this.lastMinute) {
      this.write({ event: "coverage", minute }, now);
      this.lastMinute = minute;
    }
    const target = nearbyAircraft(aircraft, cfg)[0];
    if (!target) { this.candidate = this.featured = ""; return; }
    const key = flightKey(target.ac);
    if (key !== this.candidate) { this.candidate = key; this.since = now; }
    if (now - this.since >= 5000 && this.featured !== key) {
      this.write({ event: "closest", flightKey: key, hex: target.ac.hex, callsign: target.ac.flight?.trim() || null, groundMiles: Number(target.miles.toFixed(3)) }, now);
      this.featured = key;
    }
  }
  decision(ac: Aircraft, outcome: string) {
    this.write({ event: "lookup_check", flightKey: flightKey(ac), hex: ac.hex, callsign: ac.flight?.trim() || null, outcome }, this.now());
  }
}
