#!/usr/bin/env bash
# Gather everything needed to rebuild Skylight and PiAware into ~/skylight/ops
# (secrets removed), keep .gitignore current, and scan for secrets before commit.
# Run on SKYLIGHT. Safe to re-run any time something changes.
#   ~/skylight/ops/collect.sh
set -euo pipefail
REPO="${REPO:-$HOME/skylight}"; OPS="$REPO/ops"; PIAWARE="${PIAWARE:-pi@10.0.5.20}"; SSH="${SSH:-ssh}"
cd "$REPO"
if [ "$(hostname)" != "skylight" ] && [ -z "${SKIP_HOST_CHECK:-}" ]; then echo "Run this on the Skylight Pi."; exit 1; fi
REDACT='s/^([[:space:]]*(export[[:space:]]+)?([A-Z0-9_]*_)?(LAT|LATITUDE|LON|LONGITUDE|ALT|ALTITUDE))=.*/\1="<REDACTED: see password manager>"/I'

echo "== Skylight files"
rm -rf "$OPS/skylight" "$OPS/piaware"
mkdir -p "$OPS/skylight/systemd" "$OPS/skylight/home" "$OPS/piaware"
cp /etc/systemd/system/skylight-server.service "$OPS/skylight/systemd/" && echo "  skylight-server.service"
for f in .local/bin/skylight-kiosk.sh .local/bin/skylight-display-schedule \
         .config/labwc/autostart .config/labwc/environment .config/labwc/rc.xml .config/labwc/rcgreeter.xml; do
  if [ -f "$HOME/$f" ]; then mkdir -p "$(dirname "$OPS/skylight/home/$f")"; sed -E "$REDACT" "$HOME/$f" > "$OPS/skylight/home/$f"
    [ -x "$HOME/$f" ] && chmod +x "$OPS/skylight/home/$f"; echo "  ~/$f"; fi
done
crontab -l > "$OPS/skylight/crontab.txt" 2>/dev/null && echo "  crontab" || true
{
  echo "Captured $(date -u '+%Y-%m-%d %H:%M UTC') on $(hostname)"
  grep PRETTY_NAME /etc/os-release || true
  echo "node $(node -v 2>/dev/null)  pnpm $(pnpm -v 2>/dev/null)"
  echo "display manager: $(readlink -f /etc/systemd/system/display-manager.service 2>/dev/null)"
  grep -hE '^[[:space:]]*autologin' /etc/lightdm/lightdm.conf 2>/dev/null | sed 's/^/lightdm: /' || true
  echo "upstream: $(git remote get-url upstream 2>/dev/null || git remote get-url origin)"
  echo "based on upstream commit: $(git merge-base HEAD "$(git rev-parse --verify -q upstream/main || git rev-parse --verify -q origin/main || echo HEAD)" | cut -c1-7)"
} > "$OPS/skylight/VERSIONS.txt"

echo "== PiAware files (one SSH login to $PIAWARE)"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if $SSH "$PIAWARE" 'bash -s' > "$tmp/p.tar" <<'REMOTE'
set -e
R='s/^([[:space:]]*(export[[:space:]]+)?([A-Z0-9_]*_)?(LAT|LATITUDE|LON|LONGITUDE|ALT|ALTITUDE))=.*/\1="<REDACTED: see password manager>"/I'
t=$(mktemp -d); mkdir -p "$t/systemd" "$t/etc"
for s in aerodatabox-feed aerodatabox-mlat; do [ -f /etc/systemd/system/$s.service ] && cp /etc/systemd/system/$s.service "$t/systemd/"; done
[ -r /etc/default/adsblol ] && sed -E "$R" /etc/default/adsblol > "$t/etc/default-adsblol"
[ -r /etc/default/dump1090-fa ] && sed -E "$R" /etc/default/dump1090-fa > "$t/etc/default-dump1090-fa"
{
  echo "Captured $(date -u '+%Y-%m-%d %H:%M UTC') on $(hostname)"
  grep PRETTY_NAME /etc/os-release
  echo "piaware $(piaware -v 2>/dev/null)"
  dpkg-query -W -f='${Package} ${Version}\n' dump1090-fa piaware 2>/dev/null || true
  echo "adsblol readsb commit $(cat /usr/local/share/adsblol/readsb_version 2>/dev/null)"
  echo "adsblol mlat-client commit $(cat /usr/local/share/adsblol/mlat_version 2>/dev/null)"
  for s in dump1090-fa piaware adsblol-feed adsblol-mlat tar1090 tar1090-adsblol aerodatabox-feed aerodatabox-mlat; do
    echo "service $s: $(systemctl is-enabled $s 2>/dev/null || echo missing) / $(systemctl is-active $s 2>/dev/null || true)"; done
  echo "aerodatabox uuid file present: $([ -s /etc/aerodatabox/uuid ] && echo yes || echo NO)"
  echo "adsblol uuid file present: $([ -s /usr/local/share/adsblol/adsblol-uuid ] && echo yes || echo NO)"
} > "$t/VERSIONS.txt"
tar -C "$t" -cf - .
rm -rf "$t"
REMOTE
then tar -C "$OPS/piaware" -xf "$tmp/p.tar"; ls -R "$OPS/piaware" | sed 's/^/  /'
else echo "  WARNING: could not reach PiAware; its files were not refreshed"; fi

echo "== .gitignore"
MARK="# --- local Skylight additions (ops/collect.sh) ---"
if ! grep -qF "$MARK" .gitignore 2>/dev/null; then
  cat >> .gitignore <<EOF

$MARK
# runtime state, logs, installer backups, keys
/data/
server/data/
/backups/
server/backups/
*.key
*.bak
*.bak-*
*.backup-*
*.before-*
*.tmp
EOF
  echo "  added local ignore rules"
else echo "  already present"; fi

echo "== Secret scan"
mapfile -t files < <(git ls-files -co --exclude-standard)
fail=0
for k in "$HOME"/.config/skylight/*.key; do
  [ -f "$k" ] || continue
  v=$(tr -d '\r\n' < "$k"); [ -n "$v" ] || continue
  hits=$(grep -lF -- "$v" "${files[@]}" 2>/dev/null || true)
  if [ -n "$hits" ]; then echo "  SECRET from $(basename "$k") found in:"; echo "$hits" | sed 's/^/    /'; fail=1; fi
done
uu=$(grep -lE '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' "${files[@]}" 2>/dev/null || true)
[ -n "$uu" ] && { echo "  Check these files contain no receiver UUIDs:"; echo "$uu" | sed 's/^/    /'; }
[ $fail = 0 ] && echo "  no API keys found in files to be committed" || { echo "  FIX BEFORE COMMITTING"; exit 2; }

echo "== Would be committed (new or changed)"
git status --short | sed 's/^/  /'
echo "== Ignored files outside node_modules/data/backups (check nothing important is here)"
git status --short --ignored | grep '^!!' | grep -vE 'node_modules|/data/|backups/|\.bak|\.backup-|\.before-|\.tmp$' | sed 's/^/  /' || true
