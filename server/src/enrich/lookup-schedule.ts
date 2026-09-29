// Pause / away schedule for paid route lookups. Edited by ~/skylight/lookups.py;
// re-read automatically when the file changes (no restart needed).
//
// data/lookup-schedule.json:
//   { "version": 1, "paused": false, "pausedUntil": null,
//     "away": [{ "id": "a1", "start": "2026-10-12", "end": "2026-10-21", "note": "" }],
//     "adbDailyCredits": 900 }
// Dates are America/Chicago calendar days, inclusive. While paused or away the
// display uses CSV routes only and makes no AeroDataBox or FlightAware calls.

import { readFileSync, statSync } from "node:fs";

export type LookupMode = "normal" | "paused" | "away" | "schedule_invalid";

export interface AwayPeriod { id: string; start: string; end: string; note?: string }
export interface ScheduleFile {
  version: 1;
  paused: boolean;
  pausedUntil: number | null; // epoch ms; null = until resumed
  away: AwayPeriod[];
  adbDailyCredits: number;
}

export const DEFAULT_SCHEDULE: ScheduleFile = { version: 1, paused: false, pausedUntil: null, away: [], adbDailyCredits: 900 };
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function chicagoDay(t: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
}

export function validate(s: unknown): ScheduleFile {
  const o = s as Partial<ScheduleFile>;
  if (!o || o.version !== 1 || typeof o.paused !== "boolean") throw new Error("bad header");
  if (o.pausedUntil !== null && o.pausedUntil !== undefined && !Number.isFinite(o.pausedUntil)) throw new Error("bad pausedUntil");
  if (!Array.isArray(o.away) || o.away.some(a => !a || typeof a.id !== "string" || !DAY.test(a.start) || !DAY.test(a.end) || a.end < a.start)) throw new Error("bad away");
  const cap = o.adbDailyCredits ?? DEFAULT_SCHEDULE.adbDailyCredits;
  if (!Number.isInteger(cap) || cap < 0 || cap > 100_000) throw new Error("bad adbDailyCredits");
  return { version: 1, paused: o.paused, pausedUntil: o.pausedUntil ?? null, away: o.away, adbDailyCredits: cap };
}

export class LookupSchedule {
  private cached: ScheduleFile = DEFAULT_SCHEDULE;
  private mtime = -1;
  private error: string | null = null;
  constructor(private path: string) {}

  private refresh() {
    let m: number;
    try { m = statSync(this.path).mtimeMs; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") { this.cached = DEFAULT_SCHEDULE; this.error = null; this.mtime = -1; return; }
      this.error = "schedule file unreadable"; return;
    }
    if (m === this.mtime) return;
    try { this.cached = validate(JSON.parse(readFileSync(this.path, "utf8"))); this.error = null; }
    catch (e) { this.error = `schedule file invalid (${(e as Error).message})`; }
    this.mtime = m;
  }

  get(): ScheduleFile { this.refresh(); return this.cached; }

  /** Mode at time t. An invalid file stops paid lookups rather than guessing. */
  mode(t: number): { mode: LookupMode; reason: string; period?: AwayPeriod } {
    this.refresh();
    if (this.error) return { mode: "schedule_invalid", reason: this.error };
    const s = this.cached;
    if (s.paused && (s.pausedUntil === null || t < s.pausedUntil)) {
      return { mode: "paused", reason: s.pausedUntil ? `paused until ${new Date(s.pausedUntil).toISOString()}` : "paused until resumed" };
    }
    const day = chicagoDay(t);
    const period = s.away.find(a => a.start <= day && day <= a.end);
    if (period) return { mode: "away", reason: `away ${period.start} to ${period.end}${period.note ? ` (${period.note})` : ""}`, period };
    return { mode: "normal", reason: "lookups active" };
  }

  status(t: number) {
    const s = this.get(), m = this.mode(t), today = chicagoDay(t);
    return { mode: m.mode, reason: m.reason, adbDailyCredits: s.adbDailyCredits,
      upcomingAway: s.away.filter(a => a.end >= today).sort((a, b) => a.start.localeCompare(b.start)), file: this.path };
  }
}
