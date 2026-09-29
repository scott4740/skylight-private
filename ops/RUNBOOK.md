# Skylight Route Lookups — Operations & Troubleshooting

Updated: September 29, 2026

## How it works

For each **nearest airline flight** between **8 a.m. and 10 p.m. America/Chicago**, Skylight decides which departure and destination airports to show, in this order:

| Step | Source | Cost | When it's used |
|---|---|---|---|
| 1 | Pause / away schedule | — | If paused or away: CSV routes only, no paid calls |
| 2 | **AeroDataBox** | 2 credits per lookup | Every airline callsign, up to the daily cap |
| 3 | **CSV** (VRS standing data) | Free | AeroDataBox had no route, and the CSV route passes the position check |
| 4 | **FlightAware AeroAPI** | ~$0.005 per lookup | Backup when neither of the above has a route |
| 5 | Nothing | — | Airports are left blank rather than guessed |

Routes are cached per aircraft. AeroDataBox routes are kept until about 20 minutes after landing (maximum 4 hours), so a plane that stays nearest isn't looked up twice. Private and general-aviation flights (no airline callsign) are never looked up; they show CSV data only, if any.

**Accuracy (September 2026 checks against FlightAware):** AeroDataBox 50/50 exact; CSV routes that passed the position check 17/19; the position check correctly rejected 29/29 wrong CSV routes.

### Hosts

| Host | Address | Role |
|---|---|---|
| Skylight | `pi@10.0.5.22` | Display, route lookups, all commands in this guide unless noted |
| PiAware | `pi@10.0.5.20` | Receiver; feeds FlightAware, ADSB.lol, and AeroDataBox |
| Mac | — | Downloads and `scp` to the Pis |

> Most "file not found" problems come from running a command on the wrong host. Check the prompt: `pi@skylight`, `pi@piaware`, or your Mac.

### Budgets and limits

| Item | Value |
|---|---|
| AeroDataBox cost | 2 credits per callsign lookup (flight plans never requested) |
| AeroDataBox daily cap | 900 credits (~450 lookups) by default; change with `lookups.py cap` |
| AeroDataBox credits earned | ~1,080 per day from feeding (first 24-hour measurement) |
| FlightAware budget | $10 per cycle; cycle starts on the 20th at 00:00 UTC |
| FlightAware spacing | At least 90 seconds between lookups |
| Lookup hours | 8:00 a.m. – 10:00 p.m. America/Chicago |

---

## Daily check

On **Skylight**:

```bash
python3 ~/skylight/lookups.py status
```

This shows the current mode, AeroDataBox credits used today against the cap, the last AeroDataBox message, and FlightAware spend for the cycle.

More detail when needed:

```bash
python3 ~/skylight/daily-report.py        # demand and lookup decisions per day
python3 ~/skylight/query-report.py        # FlightAware budget and recent FlightAware calls
tail -n 20 ~/skylight/server/data/aerodatabox-queries/$(date +%Y-%m).jsonl   # recent AeroDataBox calls
curl -s http://localhost:3000/api/aeroapi/status | python3 -m json.tool      # full server status
```

In the AeroDataBox log, `"outcome":"matched"` means a route was found; `"choice"` shows how the leg was picked (`airborne_hex`, `airborne`, or `time_window`). `no_match` with `ambiguous` means several legs fit and none was guessed.

### Weekly: convert AeroDataBox credits

Conversion is manual. Once a week:

1. Sign in at aerodatabox.com → **My Receivers**.
2. Click **Convert to API credits** and convert the full amount (minimum 500).

Converted credits never expire. Leftover positions stay on the receiver for next time. Converting regularly locks in the current rate, which AeroDataBox says may change.

---

## Pausing and scheduling lookups

All commands run on **Skylight**. Changes take effect within seconds; no restart is needed.

While paused or away, the display keeps running and shows **CSV routes only** (routes that pass the position check). No AeroDataBox credits or FlightAware money are spent. Your receiver keeps earning AeroDataBox credits.

### Commands

| Task | Command |
|---|---|
| Show mode, credits, budgets, upcoming trips | `python3 ~/skylight/lookups.py status` |
| Pause until you resume | `python3 ~/skylight/lookups.py pause` |
| Pause for a number of hours | `python3 ~/skylight/lookups.py pause --hours 6` |
| Pause until a set time (Chicago) | `python3 ~/skylight/lookups.py pause --until "2026-10-05 08:00"` |
| Resume | `python3 ~/skylight/lookups.py resume` |
| Schedule an away period | `python3 ~/skylight/lookups.py away 2026-10-12 2026-10-21 --note "trip"` |
| List away periods | `python3 ~/skylight/lookups.py list` |
| Cancel an away period | `python3 ~/skylight/lookups.py cancel a1` |
| Change the AeroDataBox daily cap | `python3 ~/skylight/lookups.py cap 1000` |

### Notes

- **Away dates** are America/Chicago calendar days and **inclusive**: `away 2026-10-12 2026-10-21` covers 12:00 a.m. on the 12th through 11:59 p.m. on the 21st. Lookups resume automatically afterward.
- `resume` clears a pause only. If an away period is active, it stays in effect; use `cancel` to end it early.
- Finished away periods are cleaned up automatically the next time you add one.
- Routes already cached before a pause keep showing until they expire.
- Setting `cap 0` stops AeroDataBox only; FlightAware backup and CSV routes continue.
- Choosing a cap: stay below what you earn per day (~1,080) so the balance grows. `cap 1000` uses nearly all of it.

### Schedule file

`~/skylight/server/data/lookup-schedule.json` — edited by `lookups.py`. Example:

```json
{
  "version": 1,
  "paused": false,
  "pausedUntil": null,
  "away": [{ "id": "a1", "start": "2026-10-12", "end": "2026-10-21", "note": "trip" }],
  "adbDailyCredits": 900
}
```

If this file is ever invalid (for example, a manual edit with a typo), **all paid lookups stop** and the mode shows `schedule_invalid`. Fix the file, or delete it to return to defaults (no pauses, cap 900).

---

## Troubleshooting

### `lookups.py status` says "Server status unavailable"

The server isn't answering on port 3000. Right after a restart this is normal for a few seconds.

```bash
systemctl status skylight-server --no-pager
journalctl -u skylight-server --since "15 min ago" --no-pager | tail -40
sudo systemctl restart skylight-server
```

### AeroDataBox credits used stay at 0

1. Confirm the mode is `NORMAL` and it's between 8 a.m. and 10 p.m. Chicago.
2. Confirm an **airline** flight has been nearest. Private jets and general aviation are skipped (`Paid routes limited to airline callsigns`).
3. Check the key file exists and isn't empty:
   ```bash
   ls -l ~/.config/skylight/aerodatabox.key
   ```
4. Look at the server log for errors (see above).

### "AeroDataBox rejected the key (HTTP 401/403); lookups stopped"

Skylight stops using AeroDataBox until the next restart and falls back to CSV and FlightAware.

- **Key problem:** check `~/.config/skylight/aerodatabox.key` holds only the key (no quotes or spaces). Test it directly (uses ~2 credits):
  ```bash
  python3 ~/skylight/adb-check.py --header X-Api-Key --raw SWA2820
  ```
- **Empty credit balance:** the error AeroDataBox returns when credits run out hasn't been observed yet; it may look like this. Check your balance on the AeroDataBox **Subscription & Billing** page and convert credits.

After fixing either, restart: `sudo systemctl restart skylight-server`.

### "Daily AeroDataBox cap reached"

Expected on busy days. Remaining flights that day use CSV routes or FlightAware. The count resets at midnight Chicago time. To raise the cap: `python3 ~/skylight/lookups.py cap 1000`.

### "AeroDataBox HTTP 429" or "HTTP 5xx; backing off" / "unreachable"

Temporary. Skylight waits 2 minutes (429) or 5 minutes (errors) and tries again. If it persists, check <https://status.aerodatabox.com> and Skylight's internet access.

### The display shows no airports for an airliner

Possible, and intentional, when:

- AeroDataBox found no current leg, or several legs fit (`ambiguous`), **and**
- the CSV route failed the position check, **and**
- FlightAware had no unique match, is spacing lookups (90 seconds), or its budget is reached.

Check the AeroDataBox log line for that callsign, and `python3 ~/skylight/query-report.py` for FlightAware.

### A route on the display looks wrong

1. Look up the flight now (~2 credits):
   ```bash
   python3 ~/skylight/adb-check.py --header X-Api-Key --raw SWA1234 --full
   ```
2. Compare with the AeroDataBox log line for that callsign — the `choice` field shows how the leg was picked.
3. Note the callsign, time, and what was shown, and collect the log line for review.

### Schedule mode shows `schedule_invalid`

See [Schedule file](#schedule-file). Delete or fix `~/skylight/server/data/lookup-schedule.json`.

### FlightAware budget reached ("Lookup allowance reached" / "Account budget safeguard reached")

FlightAware backup stops until the cycle resets on the 20th. AeroDataBox and CSV routes continue normally.

### CSV routes missing ("Route table loading — no paid lookup")

The CSV route table loads at startup and refreshes every 6 hours.

```bash
cat ~/skylight/server/data/vrs/routes.csv.meta.json; echo
journalctl -u skylight-server --since "1 hour ago" --no-pager | grep -i vrs-routes
cd ~/skylight/server && pnpm exec tsx src/enrich/vrs-routes-cli.ts --selftest
```

### AeroDataBox credits stopped growing (feed problem)

On **PiAware**:

```bash
systemctl is-active dump1090-fa piaware adsblol-feed adsblol-mlat aerodatabox-feed aerodatabox-mlat
journalctl -u aerodatabox-feed -n 30 --no-pager
sudo ss -tnp | grep feed-adsblol
```

`aerodatabox-feed` should be active with connections to `127.0.0.1:30005` and to AeroDataBox on port 30004. `aerodatabox-mlat` only appears if MLAT for AeroDataBox was set up. The feed uses ADSB.lol's copy of `readsb`; uninstalling the ADSB.lol feeder would break it.

Receiver UUID for AeroDataBox (needed to claim the receiver again): stored in `/etc/aerodatabox/uuid` on PiAware. Keep a copy off the Pi.

### Undo the AeroDataBox wiring

Each installer writes a rollback script. On **Skylight**:

```bash
ls ~/skylight/server/backups/
~/skylight/server/backups/adb-wiring-<timestamp>/rollback.sh
sudo systemctl restart skylight-server
```

This returns to the previous setup (CSV first, FlightAware for Southwest). Budget ledgers, logs, and comparison data are not touched.

---

## File locations (Skylight)

| Path | Contents |
|---|---|
| `~/skylight/lookups.py` | Pause / away / cap tool |
| `~/skylight/adb-check.py` | AeroDataBox key test and accuracy check |
| `~/skylight/server/data/lookup-schedule.json` | Pause / away schedule and daily cap |
| `~/skylight/server/data/aerodatabox-ledger.json` | AeroDataBox calls (for the daily cap) |
| `~/skylight/server/data/aerodatabox-queries/` | AeroDataBox call log, one file per month |
| `~/skylight/server/data/aeroapi-budget.json` | FlightAware budget ledger |
| `~/skylight/server/data/aeroapi-queries/` | FlightAware call log, one file per cycle |
| `~/skylight/server/data/vrs/` | CSV route and airport tables |
| `~/skylight/server/backups/` | Installer backups and rollback scripts |
| `~/.config/skylight/aerodatabox.key` | AeroDataBox API key (never share) |
| `~/.config/skylight/aeroapi.key` | FlightAware API key (never share) |

Header name for the AeroDataBox key: `X-Api-Key`.
