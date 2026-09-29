#!/usr/bin/env python3
"""Southwest route comparison report: free CSV routes (VRS standing data)
versus FlightAware. Read-only; makes no network requests.

Usage: python3 ~/skylight/comparison-report.py [path/to/route-comparison.json]
"""
import json, sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

STATE = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "skylight" / "server" / "data" / "route-comparison.json"
LIMIT, MAX_COST, PER_LOOKUP = 50, 0.25, 0.005
VRS = "vrs-standing-data"
SHOWN_RESULTS = ["exact_match", "partial_match", "reversed", "disagreement", "no_unique_flightaware_match", "flightaware_error"]

try:
    state = json.loads(STATE.read_text())
except FileNotFoundError:
    sys.exit(f"No comparison state at {STATE}")
rows = state.get("rows", [])

def up(s): return s.strip().upper() if isinstance(s, str) else ""
def fa_pair(r):
    ref = r.get("reference") or {}
    return f"{ref['origin']}-{ref['destination']}" if ref.get("origin") and ref.get("destination") else "—"
def fa_codes(r, side):
    ref = r.get("reference") or {}
    return {up(c) for c in (ref.get(f"{side}Codes") or [ref.get(side)]) if c}
def csv_legs(r):
    codes = [up(c) for c in ((r.get("lol") or {}).get("route") or "").split("-") if c]
    return list(zip(codes, codes[1:]))
def leg_matches_fa(r):
    """True if any leg of the CSV route equals FlightAware's pair (ICAO or IATA).
    VRS routes use ICAO codes; FA reference codes include ICAO."""
    o, d = fa_codes(r, "origin"), fa_codes(r, "destination")
    return any(a in o and b in d for a, b in csv_legs(r))

def is_legacy(r):
    lol = r.get("lol")
    return (lol is not None and lol.get("source") != VRS) or str(r.get("result", "")).startswith("adsblol_")
legacy = [r for r in rows if is_legacy(r)]
pending = [r for r in rows if not is_legacy(r) and not r.get("result")]
csv_rows = [r for r in rows if not is_legacy(r) and r.get("result")]
done = [r for r in csv_rows if r.get("result")]
shown = [r for r in done if (r.get("lol") or {}).get("status") == "pair"]
rejected = [r for r in done if (r.get("lol") or {}).get("status") != "pair"]

print("SOUTHWEST ROUTE COMPARISON — FlightAware reference")
print(f"Samples reserved: {len(rows)}/{LIMIT}; maximum trial reservation: ${MAX_COST:.2f}")
print(f"Estimated reservations for these samples: ${len(rows) * PER_LOOKUP:.3f} (not an invoice)")
status = "enabled" if state.get("enabled") and len(rows) < LIMIT else ("complete" if len(rows) >= LIMIT else "paused")
print(f"Status: {status}{' — ' + state['pauseReason'] if state.get('pauseReason') else ''}. Collecting during 8am–10pm Chicago time.")
if state.get("cooldownUntil"):
    until = datetime.fromtimestamp(state["cooldownUntil"] / 1000, timezone.utc)
    if until > datetime.now(timezone.utc):
        print(f"Cooling down until {until:%Y-%m-%d %H:%M} UTC")

print(f"\nFREE SOURCE: CSV routes (VRS standing data) — {len(done)} completed sample(s)"
      + (f", {len(pending)} in progress" if pending else ""))

print(f"\n  Routes shown on the display (passed position check): {len(shown)}")
c = Counter(r["result"] for r in shown)
for k in SHOWN_RESULTS + sorted(set(c) - set(SHOWN_RESULTS)):
    if c[k]: print(f"    {k}: {c[k]}")
comparable = [r for r in shown if r["result"] in ("exact_match", "partial_match", "reversed", "disagreement")]
if comparable:
    ex = sum(r["result"] == "exact_match" for r in comparable)
    print(f"    Shown routes that match FlightAware exactly: {ex}/{len(comparable)} ({100 * ex / len(comparable):.1f}%)")

print(f"\n  Routes rejected (not shown; FlightAware used instead): {len(rejected)}")
c = Counter(r["result"] for r in rejected)
for k in sorted(c): print(f"    {k}: {c[k]}")
judged = [r for r in rejected if r.get("reference") and csv_legs(r)]
if judged:
    wrong = [r for r in judged if leg_matches_fa(r)]
    print(f"    Rejection correct (CSV route differs from FlightAware): {len(judged) - len(wrong)}/{len(judged)}")
    print(f"    Rejection wrong (CSV route was right; check too strict): {len(wrong)}/{len(judged)}")
    for r in wrong:
        lol = r["lol"]
        print(f"      {r['callsign']}: {lol.get('route')} vs FA {fa_pair(r)} — {lol.get('reason', '')}")

if shown or judged:
    total = len(comparable) + len(judged)
    good = sum(r["result"] == "exact_match" for r in comparable) + sum(not leg_matches_fa(r) for r in judged)
    print(f"\n  Overall: free-route decision agreed with FlightAware in {good}/{total} sample(s)")
    print("  (a shown route matching exactly, or a rejected route that really was wrong)")

last = state.get("lastCheck")
if last:
    res = last.get("result") or {}
    print(f"\nLast free check: {last.get('callsign')} {res.get('status')} {res.get('route') or ''}"
          + (f" xt={res['crossTrackNm']}nm" if res.get("crossTrackNm") is not None else ""))

if legacy:
    print(f"\nEARLIER ADSB.lol SAMPLES (before the switch; excluded from the figures above): {len(legacy)}")
    for k, n in sorted(Counter(r.get("result") or "incomplete" for r in legacy).items()):
        print(f"  {k}: {n}")

print(f"\n{'FLIGHT':<12} {'FLIGHTAWARE':<15} {'FREE ROUTE':<24} {'CHECK':<22} RESULT")
for r in rows:
    lol = r.get("lol") or {}
    if not r.get("result") and not is_legacy(r):
        free, check = "—", "—"
    elif lol.get("source") == VRS:
        free = lol.get("route") or "—"
        check = lol.get("status", "")
        if check == "pair": check = "shown"
        if lol.get("crossTrackNm") is not None: check += f" {lol['crossTrackNm']:g}nm"
    else:
        free = "-".join(lol.get("codes") or []) or "—"
        check = f"ADSB.lol {lol.get('httpStatus') or ''}".strip()
    print(f"{r.get('callsign', ''):<12} {fa_pair(r):<15} {free:<24} {check:<22} {r.get('result') or 'in progress'}")

print("\nDistinct aircraft address + callsign samples, not independently verified flight legs.")
print("Every sampled Southwest flight gets a FlightAware lookup: shown routes to check accuracy,")
print("rejected routes because the paid policy looks those up anyway.")
print("FlightAware is the reference, not independent ground truth. Multi-leg CSV routes count as")
print("a correct rejection only if no leg matches FlightAware's pair.")
print("Trial reservations are part of the existing cycle budget; normal lookups also consume that budget.")
