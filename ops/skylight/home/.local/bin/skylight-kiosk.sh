#!/usr/bin/env bash
# Kiosk launcher. NOTE: Chromium's native-Wayland GPU path crashes on the Pi 5
# (V3D MakeCurrent failures), so we run it through Xwayland (--ozone-platform=x11).
export DISPLAY=:0
export XDG_RUNTIME_DIR=/run/user/$(id -u)
# Wait for the tracker server to be up.
until curl -fsS http://localhost:3000/api/health >/dev/null 2>&1; do sleep 1; done
command -v unclutter >/dev/null && unclutter -idle 0.1 &
exec /usr/bin/chromium-browser \
  --force-device-scale-factor=1.5 --kiosk --ozone-platform=x11 --app=http://localhost:3000/nearest.html \
  --user-data-dir=$HOME/.kiosk-profile --no-first-run --password-store=basic \
  --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
  --check-for-update-interval=31536000 --start-fullscreen
