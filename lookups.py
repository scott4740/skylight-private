#!/usr/bin/env python3
"""Pause, resume, or schedule Skylight's paid route lookups (AeroDataBox and
FlightAware). While paused or away, the display uses CSV routes only.
Changes take effect within seconds; no restart needed.

  python3 ~/skylight/lookups.py status
  python3 ~/skylight/lookups.py pause                     # until 'resume'
  python3 ~/skylight/lookups.py pause --hours 6
  python3 ~/skylight/lookups.py pause --until "2026-10-05 08:00"   # Chicago time
  python3 ~/skylight/lookups.py resume
  python3 ~/skylight/lookups.py away 2026-10-12 2026-10-21 --note "trip"
  python3 ~/skylight/lookups.py list
  python3 ~/skylight/lookups.py cancel a1
  python3 ~/skylight/lookups.py cap 900                   # AeroDataBox credits per day
"""
import argparse, json, os, sys, urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

DATA = Path.home() / "skylight" / "server" / "data"
PATH = DATA / "lookup-schedule.json"
CHI = ZoneInfo("America/Chicago")
DEFAULT = {"version": 1, "paused": False, "pausedUntil": None, "away": [], "adbDailyCredits": 900}


def load():
    try:
        s = json.loads(PATH.read_text())
    except FileNotFoundError:
        return dict(DEFAULT, away=[])
    except json.JSONDecodeError as e:
        sys.exit(f"{PATH} is not valid JSON ({e}). Fix or delete it; paid lookups are stopped until then.")
    s.setdefault("adbDailyCredits", 900)
    return s


def save(s):
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(s, indent=2) + "\n")
    os.replace(tmp, PATH)


def day(s):
    try:
        return datetime.strptime(s, "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError:
        sys.exit(f"Dates must be YYYY-MM-DD (got {s!r})")


def today():
    return datetime.now(CHI).strftime("%Y-%m-%d")


def mode(s):
    now_ms = datetime.now(timezone.utc).timestamp() * 1000
    if s.get("paused") and (s.get("pausedUntil") is None or now_ms < s["pausedUntil"]):
        if s.get("pausedUntil"):
            return "paused", "until " + datetime.fromtimestamp(s["pausedUntil"] / 1000, CHI).strftime("%Y-%m-%d %H:%M %Z")
        return "paused", "until you run 'resume'"
    for a in s.get("away", []):
        if a["start"] <= today() <= a["end"]:
            return "away", f"{a['start']} to {a['end']}" + (f" ({a['note']})" if a.get("note") else "")
    return "normal", "AeroDataBox first, CSV if it passes the position check, FlightAware backup"


def credits_today():
    try:
        calls = json.loads((DATA / "aerodatabox-ledger.json").read_text())["calls"]
    except (FileNotFoundError, KeyError, json.JSONDecodeError):
        return 0
    t = today()
    return 2 * sum(1 for c in calls if datetime.fromtimestamp(c / 1000, CHI).strftime("%Y-%m-%d") == t)


def server_status():
    try:
        with urllib.request.urlopen("http://localhost:3000/api/aeroapi/status", timeout=3) as r:
            return json.load(r)
    except Exception:
        return None


def cmd_status(s, _):
    m, why = mode(s)
    print(f"Mode: {m.upper()} — {why}")
    print(f"AeroDataBox credits used today: {credits_today()} of {s['adbDailyCredits']} (daily cap)")
    live = server_status()
    if live:
        adb = live.get("aerodatabox") or {}
        print(f"AeroDataBox: {adb.get('message', '—')}")
        print(f"FlightAware backup: ${live.get('budgetUsedDollars', 0):.3f} of ${live.get('localBudgetDollars', 10):.2f} this cycle — {live.get('message', '')}")
        srv_mode = (live.get("lookupMode") or {}).get("mode")
        if srv_mode and srv_mode != m:
            print(f"Note: server reports mode {srv_mode!r}; it re-reads the file within seconds.")
    else:
        print("Server status unavailable (is skylight-server running?)")
    cmd_list(s, None, header=True)


def cmd_list(s, _, header=False):
    upcoming = sorted([a for a in s.get("away", []) if a["end"] >= today()], key=lambda a: a["start"])
    if header and not upcoming:
        return
    print("Away periods (CSV only, Chicago dates, inclusive):" if upcoming else "No away periods scheduled.")
    for a in upcoming:
        print(f"  {a['id']}: {a['start']} to {a['end']}" + (f"  {a['note']}" if a.get("note") else ""))


def cmd_pause(s, a):
    until = None
    if a.hours:
        until = datetime.now(timezone.utc) + timedelta(hours=a.hours)
    elif a.until:
        try:
            until = datetime.strptime(a.until, "%Y-%m-%d %H:%M").replace(tzinfo=CHI)
        except ValueError:
            sys.exit('Use --until "YYYY-MM-DD HH:MM" (Chicago time)')
    s["paused"], s["pausedUntil"] = True, (int(until.timestamp() * 1000) if until else None)
    save(s)
    print("Paused" + (f" until {until.astimezone(CHI):%Y-%m-%d %H:%M %Z}" if until else " until 'resume'") + ". CSV routes only.")


def cmd_resume(s, _):
    s["paused"], s["pausedUntil"] = False, None
    save(s)
    m, why = mode(s)
    print("Resumed." if m == "normal" else f"Pause cleared, but an away period is active: {why}")


def cmd_away(s, a):
    start, end = day(a.start), day(a.end)
    if end < start:
        sys.exit("End date is before start date")
    used = {x["id"] for x in s["away"]}
    n = 1
    while f"a{n}" in used:
        n += 1
    s["away"].append({"id": f"a{n}", "start": start, "end": end, "note": a.note or ""})
    s["away"] = [x for x in s["away"] if x["end"] >= today()]  # drop finished periods
    save(s)
    print(f"Added a{n}: CSV routes only from {start} through {end} (Chicago dates).")


def cmd_cancel(s, a):
    before = len(s["away"])
    s["away"] = [x for x in s["away"] if x["id"] != a.id]
    if len(s["away"]) == before:
        sys.exit(f"No away period with id {a.id!r}; see 'list'")
    save(s)
    print(f"Cancelled {a.id}.")


def cmd_cap(s, a):
    if not 0 <= a.credits <= 100_000:
        sys.exit("Cap must be between 0 and 100000")
    s["adbDailyCredits"] = a.credits
    save(s)
    print(f"AeroDataBox daily cap set to {a.credits} credits (~{a.credits // 2} lookups/day).")


p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
sub = p.add_subparsers(dest="cmd", required=True)
sub.add_parser("status").set_defaults(f=cmd_status)
sub.add_parser("list").set_defaults(f=cmd_list)
x = sub.add_parser("pause"); g = x.add_mutually_exclusive_group()
g.add_argument("--hours", type=float); g.add_argument("--until"); x.set_defaults(f=cmd_pause)
sub.add_parser("resume").set_defaults(f=cmd_resume)
x = sub.add_parser("away"); x.add_argument("start"); x.add_argument("end"); x.add_argument("--note"); x.set_defaults(f=cmd_away)
x = sub.add_parser("cancel"); x.add_argument("id"); x.set_defaults(f=cmd_cancel)
x = sub.add_parser("cap"); x.add_argument("credits", type=int); x.set_defaults(f=cmd_cap)
args = p.parse_args()
args.f(load(), args)
