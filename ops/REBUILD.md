# Rebuilding Skylight and PiAware

How to rebuild either Pi from a blank SD card using this repository and your password manager. Exact versions last captured are in `ops/skylight/VERSIONS.txt` and `ops/piaware/VERSIONS.txt`. Day-to-day operation and troubleshooting: `ops/RUNBOOK.md`.

## Secrets — keep in your password manager

Never commit these. The repository contains placeholders where they're needed.

| Secret | Where it goes | How to read it from a working Pi |
|---|---|---|
| FlightAware AeroAPI key | Skylight `~/.config/skylight/aeroapi.key` | `cat` the file |
| AeroDataBox API key | Skylight `~/.config/skylight/aerodatabox.key` | `cat` the file |
| AeroDataBox receiver UUID | PiAware `/etc/aerodatabox/uuid` | `cat /etc/aerodatabox/uuid` |
| ADSB.lol receiver UUID | PiAware `/usr/local/share/adsblol/adsblol-uuid` | `cat` the file |
| PiAware feeder ID | PiAware (`piaware-config`) | `piaware-config -show feeder-id` |
| Receiver latitude, longitude, altitude | PiAware `/etc/default/adsblol` | `grep -E '^(LATITUDE\|LONGITUDE\|ALTITUDE)=' /etc/default/adsblol` |
| Repository deploy key (optional) | Skylight `~/.ssh/skylight_repo` | Or create a new one and add it to GitHub |

Reusing the same UUIDs and feeder ID keeps your FlightAware, ADSB.lol, and AeroDataBox stats and credits instead of registering a new station.

## Network

| Host | Address | Notes |
|---|---|---|
| PiAware | `10.0.5.20` | Skylight reads `http://10.0.5.20:8080/data/aircraft.json` |
| Skylight | `10.0.5.22` | Serves the display on port 3000 |

Both use the same static public IPv4 via the site's egress. Give each Pi a DHCP reservation (or static address) matching the table, or update `AIRCRAFT_JSON_URL` in `ops/skylight/systemd/skylight-server.service`.

---

## PiAware (`pi@10.0.5.20`)

Last captured: Raspbian 11 (bullseye), PiAware 11.1, `dump1090-fa`.

1. **Install PiAware.** Flash the FlightAware PiAware SD image (or Raspberry Pi OS Lite plus the FlightAware packages). Set hostname `piaware`, user `pi`, SSH enabled, address `10.0.5.20`.
2. **Restore the feeder ID** before the first connection registers a new one:
   ```bash
   sudo piaware-config feeder-id <FEEDER-ID>
   sudo systemctl restart piaware
   ```
   Confirm your location on your FlightAware "My ADS-B" stats page; `dump1090-fa` receives it from there.
3. **Check the receiver:** `http://10.0.5.20/skyaware/` shows aircraft and `http://10.0.5.20:8080/data/aircraft.json` returns JSON.
4. **ADSB.lol feeder (feed + MLAT).** Follow <https://www.adsb.lol/docs/get-started/bare-metal/>. Use feed name `scott4740-frankfort` and the coordinates from your password manager. Then restore the UUID and compare settings:
   ```bash
   echo '<ADSBLOL-UUID>' | sudo tee /usr/local/share/adsblol/adsblol-uuid
   diff <(grep -vE '^(LATITUDE|LONGITUDE|ALTITUDE)=' /etc/default/adsblol) \
        <(grep -vE '^(LATITUDE|LONGITUDE|ALTITUDE)=' ~/skylight-repo/ops/piaware/etc/default-adsblol)
   sudo systemctl restart adsblol-feed adsblol-mlat
   ```
   (Copy `ops/piaware/` to PiAware first, e.g. `scp -r` from Skylight or the Mac, to `~/skylight-repo/ops/piaware/`.)
5. **AeroDataBox feed + MLAT.** These reuse ADSB.lol's `readsb` and `mlat-client`, so step 4 must be done first.
   ```bash
   sudo mkdir -p /etc/aerodatabox
   echo '<AERODATABOX-UUID>' | sudo tee /etc/aerodatabox/uuid
   sudo cp ~/skylight-repo/ops/piaware/systemd/aerodatabox-*.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now aerodatabox-feed aerodatabox-mlat
   ```
   The MLAT service reads your coordinates from `/etc/default/adsblol`.
6. **Verify:**
   ```bash
   systemctl is-active dump1090-fa piaware adsblol-feed adsblol-mlat aerodatabox-feed aerodatabox-mlat
   sudo ss -tnp | grep feed-adsblol
   ```
   Within 15 minutes the receiver should show as feeding on AeroDataBox's **My Receivers** page (same UUID, so it stays claimed).

---

## Skylight (`pi@10.0.5.22`)

Last captured: see `ops/skylight/VERSIONS.txt` (Debian 12 Bookworm, labwc/Wayland, Node and pnpm versions).

1. **Install Raspberry Pi OS (Bookworm, with desktop).** Hostname `skylight`, user `pi`, SSH enabled, address `10.0.5.22`. In `sudo raspi-config` → System Options → Boot / Auto Login, choose **Desktop Autologin**.
2. **Install Node.js and pnpm** at the versions in `VERSIONS.txt` (or the versions the upstream README calls for).
3. **Clone this private repository** to `~/skylight`:
   ```bash
   # If using a deploy key: create ~/.ssh/skylight_repo (or restore it), add it to the repo's Deploy keys,
   # and add this to ~/.ssh/config:
   #   Host github-skylight
   #     HostName github.com
   #     User git
   #     IdentityFile ~/.ssh/skylight_repo
   git clone git@github-skylight:<YOUR-USER>/skylight-private.git ~/skylight
   cd ~/skylight && git remote add upstream https://github.com/cpaczek/skylight.git
   ```
4. **Install and build** following the upstream README's Raspberry Pi instructions (`install-on-pi.sh`), run from `~/skylight`.
5. **Service:**
   ```bash
   sudo cp ~/skylight/ops/skylight/systemd/skylight-server.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable skylight-server
   ```
6. **Kiosk, display schedule, labwc:**
   ```bash
   cp -a ~/skylight/ops/skylight/home/.local ~/skylight/ops/skylight/home/.config ~/
   chmod +x ~/.local/bin/skylight-kiosk.sh ~/.local/bin/skylight-display-schedule
   crontab ~/skylight/ops/skylight/crontab.txt
   ```
7. **API keys:**
   ```bash
   mkdir -p ~/.config/skylight
   nano ~/.config/skylight/aeroapi.key        # FlightAware key only
   nano ~/.config/skylight/aerodatabox.key    # AeroDataBox key only
   chmod 600 ~/.config/skylight/*.key
   ```
8. **Start and verify:**
   ```bash
   sudo systemctl start skylight-server
   cd ~/skylight/server
   pnpm exec tsx src/enrich/vrs-routes-cli.ts --selftest      # downloads CSV routes (~20 MB)
   pnpm exec tsx scripts/adb-wiring-selftest.ts               # mocked; no API calls
   python3 ~/skylight/adb-check.py --header X-Api-Key --raw SWA2820   # ~2 credits
   python3 ~/skylight/lookups.py status
   ```
   Reboot once to confirm the kiosk starts on its own and the display sleeps 10 p.m.–8 a.m.

### What is not restored, and why that's fine

`server/data/` (logs, ledgers, comparison results, CSV cache) isn't in the repository.

- CSV route tables download automatically on first start.
- FlightAware spending stays capped: before each paid lookup Skylight checks the account's reported usage, not only its local ledger.
- The AeroDataBox daily count restarts for that day only.
- `lookup-schedule.json` (pauses, away dates, daily cap) is recreated with defaults; re-enter any upcoming away dates with `lookups.py away`.

---

## Keeping this repository current

After any change on either Pi (new script, service edit, installer run), on **Skylight**:

```bash
~/skylight/ops/collect.sh          # refreshes ops/ from both Pis, scans for secrets
cd ~/skylight && git add -A && git commit -m "Describe the change" && git push
```

`collect.sh` stops with an error if an API key would be committed. Pulling the original author's updates:

```bash
cd ~/skylight && git fetch upstream && git merge upstream/main
```
