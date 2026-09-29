#!/usr/bin/env python3
"""AeroDataBox check for Skylight: verify the key, show a raw response, and
compare AeroDataBox routes against the FlightAware references in the route
comparison trial. Makes NO FlightAware requests.

  python3 adb-check.py --header x-api-key --raw SWA2820      # 1 lookup (~2 credits)
  python3 adb-check.py --header x-api-key                    # accuracy test (~2 credits per sample)
  python3 adb-check.py --header x-api-key --limit 10         # smaller test

Key file: ~/.config/skylight/aerodatabox.key (never printed).
Results:  ~/skylight/server/data/adb-check.json
"""
import argparse, json, os, sys, time, urllib.error, urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = os.environ.get("ADB_BASE", "https://api.aerodatabox.com")
KEY_PATH = Path.home() / ".config" / "skylight" / "aerodatabox.key"
STATE = Path.home() / "skylight" / "server" / "data" / "route-comparison.json"
OUT = Path.home() / "skylight" / "server" / "data" / "adb-check.json"
CHI = ZoneInfo("America/Chicago")
QUERY = "withAircraftImage=false&withLocation=false&withFlightPlan=false&dateLocalRole=Both"
CREDITS_PER_CALL = 2


class AuthError(Exception): pass


def up(s): return s.strip().upper() if isinstance(s, str) else ""


def call(path, header, key):
    req = urllib.request.Request(f"{BASE}{path}?{QUERY}", headers={
        header: key, "Accept": "application/json",
        "User-Agent": "SkylightAdbCheck/1.0 (contact: scott4740@gmail.com)"})
    for attempt in (1, 2):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                body = r.read()
                return r.status, (json.loads(body) if body else [])
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise AuthError(f"HTTP {e.code}: key or header name rejected ({e.read()[:200]!r})")
            if e.code == 429 and attempt == 1:
                time.sleep(20); continue
            return e.code, None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            return 0, str(e)


def parse_t(s):
    """AeroDataBox times look like '2026-09-28 14:05Z'."""
    if not isinstance(s, str) or not s: return None
    try: return datetime.fromisoformat(s.replace(" ", "T").replace("Z", "+00:00"))
    except ValueError: return None


def best_time(end):
    end = end or {}
    for k in ("runwayTime", "revisedTime", "predictedTime", "scheduledTime"):
        t = parse_t((end.get(k) or {}).get("utc"))
        if t: return t
    return None


def codes(end):
    ap = (end or {}).get("airport") or {}
    return {c for c in (up(ap.get("icao")), up(ap.get("iata")), up(ap.get("localCode"))) if c}


def label(end):
    ap = (end or {}).get("airport") or {}
    return up(ap.get("iata")) or up(ap.get("icao")) or "?"


def pick_leg(flights, at):
    """Leg whose departure..arrival window (±45 min) contains the sighting time;
    otherwise the leg with the nearest window."""
    scored = []
    for f in flights:
        dep, arr = best_time(f.get("departure")), best_time(f.get("arrival"))
        if not dep and not arr: continue
        lo = (dep or arr) - timedelta(minutes=45); hi = (arr or dep) + timedelta(minutes=45)
        gap = 0 if lo <= at <= hi else min(abs((at - lo).total_seconds()), abs((at - hi).total_seconds()))
        scored.append((gap, f))
    if not scored: return None, "no_times"
    scored.sort(key=lambda x: x[0])
    inside = [f for g, f in scored if g == 0]
    if len(inside) > 1: return inside[0], "ambiguous"
    return scored[0][1], ("in_window" if scored[0][0] == 0 else f"nearest_{int(scored[0][0] // 60)}min")


def compare(ref, leg):
    fo = {up(c) for c in (ref.get("originCodes") or [ref.get("origin")]) if c}
    fd = {up(c) for c in (ref.get("destinationCodes") or [ref.get("destination")]) if c}
    ao, ad = codes(leg.get("departure")), codes(leg.get("arrival"))
    if fo & ao and fd & ad: return "exact_match"
    if fo & ad and fd & ao: return "reversed"
    if fo & ao or fd & ad: return "partial_match"
    return "disagreement"


def trim(f):
    return {k: f.get(k) for k in ("number", "callSign", "status", "codeshareStatus", "lastUpdatedUtc")} | {
        "departure": {"airport": label(f.get("departure")), "time_utc": str(best_time(f.get("departure"))),
                      "quality": (f.get("departure") or {}).get("quality")},
        "arrival": {"airport": label(f.get("arrival")), "time_utc": str(best_time(f.get("arrival"))),
                    "quality": (f.get("arrival") or {}).get("quality")}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--header", required=True, help="API key header name from your AeroDataBox dashboard")
    ap.add_argument("--raw", metavar="CALLSIGN", help="look up one callsign now and print the response")
    ap.add_argument("--full", action="store_true", help="with --raw, print the complete response")
    ap.add_argument("--limit", type=int, default=50)
    ap.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    a = ap.parse_args()
    try:
        key = KEY_PATH.read_text().strip()
    except FileNotFoundError:
        sys.exit(f"No key at {KEY_PATH}")
    if not key: sys.exit(f"{KEY_PATH} is empty")

    if a.raw:
        try: status, body = call(f"/flights/callsign/{up(a.raw)}", a.header, key)
        except AuthError as e: sys.exit(str(e))
        print(f"HTTP {status}  (~{CREDITS_PER_CALL} credits)")
        if isinstance(body, list):
            print(json.dumps(body if a.full else [trim(f) for f in body], indent=2, default=str))
        else:
            print(body)
        return

    rows = [r for r in json.loads(STATE.read_text()).get("rows", []) if r.get("reference") and r.get("at")]
    rows = rows[: a.limit]
    print(f"{len(rows)} samples with a FlightAware reference; about {len(rows) * CREDITS_PER_CALL} credits.")
    if not a.yes and input("Proceed? [y/N] ").strip().lower() != "y":
        return
    results = []
    for i, r in enumerate(rows, 1):
        at = datetime.fromtimestamp(r["at"] / 1000, timezone.utc)
        day = at.astimezone(CHI).strftime("%Y-%m-%d")
        try: status, body = call(f"/flights/callsign/{up(r['callsign'])}/{day}", a.header, key)
        except AuthError as e: sys.exit(f"Stopped after {i - 1} lookups. {e}")
        ref = r["reference"]; fa = f"{ref.get('origin')}-{ref.get('destination')}"
        if status == 204 or body == []:
            res, adb, how = "no_data", "—", ""
        elif not isinstance(body, list):
            res, adb, how = f"error_{status}", "—", ""
        else:
            leg, how = pick_leg(body, at)
            if not leg: res, adb = "no_times", "—"
            else: res, adb = compare(ref, leg), f"{label(leg.get('departure'))}-{label(leg.get('arrival'))}"
        results.append({"callsign": r["callsign"], "date": day, "flightaware": fa, "aerodatabox": adb,
                        "result": res, "leg_choice": how, "legs_returned": len(body) if isinstance(body, list) else 0,
                        "csv": (r.get("lol") or {}).get("route"), "csv_status": (r.get("lol") or {}).get("status")})
        print(f"{i:>3} {r['callsign']:<9} FA {fa:<9} ADB {adb:<9} {res:<14} {how}")
        time.sleep(1.2)

    OUT.write_text(json.dumps(results, indent=2))
    n = len(results)
    from collections import Counter
    c = Counter(x["result"] for x in results)
    print("\nRESULTS")
    for k, v in c.most_common(): print(f"  {k}: {v}")
    answered = [x for x in results if x["result"] in ("exact_match", "partial_match", "reversed", "disagreement")]
    if answered:
        ex = c["exact_match"]
        print(f"\nAeroDataBox matched FlightAware exactly: {ex}/{len(answered)} answered ({100 * ex / len(answered):.1f}%)")
        print(f"Coverage (returned a usable leg): {len(answered)}/{n}")
        bad = [x for x in results if x["csv_status"] not in (None, "pair") and x["result"] == "exact_match"]
        print(f"Flights the CSV got wrong that AeroDataBox got right: {len(bad)}")
    amb = sum(1 for x in results if x["leg_choice"] == "ambiguous")
    if amb: print(f"Samples where several legs fit the sighting time: {amb}")
    print(f"\nSaved to {OUT}. About {n * CREDITS_PER_CALL} credits used.")


if __name__ == "__main__":
    main()
