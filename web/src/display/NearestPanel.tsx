import { useEffect, useRef, useState } from "react";
import { bearing, convertDistance, formatAltitude, formatSpeed, type Config } from "@shared/index.js";
import type { StreamState } from "../lib/connection.js";
import { nearbyAircraft, NearestSelector, type NearbyAircraft } from "./nearest.js";
import "../styles/nearest.css";

export function useNearest(state: StreamState, enabled: boolean) {
  const latest = useRef(state);
  const arrived = useRef(performance.now());
  const selector = useRef(new NearestSelector());
  const [result, setResult] = useState<{ target: NearbyAircraft | null; count: number; live: boolean }>({ target: null, count: 0, live: false });
  useEffect(() => {
    if (latest.current.aircraft !== state.aircraft || latest.current.now !== state.now) arrived.current = performance.now();
    latest.current = state;
  }, [state]);
  useEffect(() => {
    if (!enabled) return;
    const update = () => {
      const s = latest.current;
      const age = (performance.now() - arrived.current) / 1000;
      const live = !!s.config && s.connected && s.status?.ok !== false && s.now > 0 && age < s.config.staleSec;
      const candidates = live ? nearbyAircraft(s.aircraft, s.config!, age) : [];
      setResult({ target: selector.current.choose(candidates, performance.now()), count: candidates.length, live });
    };
    update();
    const interval = setInterval(update, 500);
    return () => clearInterval(interval);
  }, [enabled]);
  return result;
}

const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const direction = (degrees: number) => directions[Math.round(degrees / 45) % 8];

export function NearestPanel({ target, cfg, live, count }: { target: NearbyAircraft | null; cfg: Config; live: boolean; count: number }) {
  const ac = target?.ac;
  const [routeStatus, setRouteStatus] = useState("Waiting for FlightAware lookup.");
  useEffect(() => {
    let cancelled = false;
    const update = async () => {
      try {
        const res = await fetch("/api/aeroapi/status");
        if (!res.ok) return;
        const status = await res.json();
        if (!cancelled && typeof status.message === "string") setRouteStatus(status.message);
      } catch { /* Live receiver data remains available during route outages. */ }
    };
    void update();
    const timer = setInterval(() => { void update(); }, 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!live || !ac) return;
    const hex = ac.hex;
    const lookup = () => { void fetch("/api/aeroapi/nearest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hex }) }).catch(() => {}); };
    const delay = setTimeout(lookup, 5000);
    const timer = setInterval(lookup, 60_000);
    return () => { clearTimeout(delay); clearInterval(timer); };
  }, [live, ac?.hex, ac?.flight, ac?.registration]);
  const route = ac && ac.origin && ac.destination;
  const alt = ac?.altBaro ?? ac?.altGeom;
  const range = target ? `${convertDistance(target.miles, cfg.distanceUnit).toFixed(1)} ${cfg.distanceUnit}` : "—";
  const rate = ac?.baroRate;
  const trend = rate == null ? "Vertical rate unavailable" : rate > 150 ? "Climbing" : rate < -150 ? "Descending" : "Level";
  const compass = ac ? direction(bearing(cfg.centerLat, cfg.centerLon, ac.lat!, ac.lon!)) : "";
  return <aside className="nearest-panel" aria-label="Nearest aircraft information" onClick={(e) => e.stopPropagation()} style={{ opacity: Math.max(0, Math.min(1, cfg.brightness)) }}>
    <header className="nearest-header"><span className={`nearest-status ${live ? "live" : ""}`} />{live ? "LIVE AIRSPACE" : "FEED UNAVAILABLE"}<span>SKYLIGHT</span></header>
    <div className="nearest-content">
      <div className="nearest-kicker">NEAREST AIRCRAFT <span>◎</span></div>
      {ac ? <>
        <h1>{ac.airline || "Aircraft nearby"}</h1>
        <div className="nearest-flight">{ac.flight?.trim() || ac.registration || ac.hex.toUpperCase()}</div>
        <div className="nearest-type">{ac.typeName || ac.typeCode || "Aircraft type unavailable"}</div>
        <div className="nearest-route">
          {route ? <><div><small>FROM</small><strong>{ac.origin}</strong><span>{ac.originName || "Departure"}</span></div><b aria-hidden="true">→</b><div><small>TO</small><strong>{ac.destination}</strong><span>{ac.destName || "Arrival"}</span></div></> : <p>Route unavailable<small>{routeStatus}</small></p>}
        </div>
        {route && <div className="nearest-route-note">{ac.routeSource === "flightaware" ? "FlightAware · current flight match" : "Reported route · unverified"}</div>}
        <div className="nearest-distance"><strong>{range}</strong><span>{compass} of home · ground distance</span></div>
        <dl className="nearest-metrics">
          <div><dt>ALTITUDE</dt><dd>{alt != null ? formatAltitude(alt, cfg.altitudeUnit) : "—"}</dd></div>
          <div><dt>GROUND SPEED</dt><dd>{ac.gs != null ? formatSpeed(ac.gs, cfg.speedUnit) : "—"}</dd></div>
          <div><dt>FLIGHT TREND</dt><dd>{trend}</dd></div>
          <div><dt>REGISTRATION</dt><dd>{ac.registration || "—"}</dd></div>
        </dl>
      </> : <div className="nearest-empty"><h1>{live ? "Watching the sky" : "Waiting for live data"}</h1><p>{live ? "No fresh airborne aircraft match your range and altitude filters." : "Flight details will return when fresh receiver data arrives."}</p></div>}
    </div>
    <footer><span className="nearest-ring-key">◯ Highlighted on the map</span><span>{count} airborne within {convertDistance(cfg.radiusMiles, cfg.distanceUnit).toFixed(0)} {cfg.distanceUnit}</span><small>Nearest by ground distance · 5-second switching delay</small></footer>
  </aside>;
}
