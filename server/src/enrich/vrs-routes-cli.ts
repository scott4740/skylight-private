// Usage (from ~/skylight/server):
//   pnpm exec tsx src/enrich/vrs-routes-cli.ts --selftest
//   pnpm exec tsx src/enrich/vrs-routes-cli.ts --callsign SWA2820 [--lat 40.1 --lon -86.2 --track 150]
//   pnpm exec tsx src/enrich/vrs-routes-cli.ts --live [--url http://10.0.5.20/skyaware/data/aircraft.json] [--all]
// Makes no FlightAware requests.

import { decideRoute, ensureVrsLoaded, lookupInTables, lookupVrsRoute, parseCsv, vrsStats, type RouteResult } from "./vrs-routes.js";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const num = (v?: string) => (v === undefined ? undefined : Number(v));

function fmt(r: RouteResult): string {
  const leg = r.origin && r.destination
    ? `${r.origin.iata || r.origin.code}→${r.destination.iata || r.destination.code}`
    : "-";
  const legInfo = r.legIndex !== undefined ? ` leg ${r.legIndex + 1}/${r.legCount}` : r.legCount ? ` ${r.legCount} legs` : "";
  const xt = r.crossTrackNm !== undefined ? ` xt=${r.crossTrackNm}nm` : "";
  const d = decideRoute(r);
  const tag = d.paidLookup ? "FA " : d.display ? "csv" : " - ";
  return `${tag} ${r.callsign.padEnd(8)} ${r.status.padEnd(11)} ${leg.padEnd(9)} ${r.route ?? ""}${legInfo}${xt} (${r.reason})`;
}

async function selftest(): Promise<number> {
  let failures = 0;
  const check = (label: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
    if (!ok) failures++;
  };

  // CSV parser: quoted comma and BOM
  const rows = parseCsv('\ufeffA,B\n1,"x, y"\r\n2,"say ""hi"""\n');
  check("csv quoted fields", rows.length === 3 && rows[1][1] === "x, y" && rows[2][1] === 'say "hi"');

  // Synthetic geometry, independent of downloaded data
  const ap = (code: string, lat: number, lon: number) => ({ code, icao: code, iata: code.slice(1), name: code, location: "", lat, lon });
  const airports = new Map(
    [
      ap("KMDW", 41.786, -87.752), ap("KATL", 33.6367, -84.4281), ap("KDEN", 39.8617, -104.673),
      ap("KOAK", 37.7213, -122.221), ap("KDAL", 32.847, -96.852), ap("KHOU", 29.645, -95.279),
      ap("KCRP", 27.770, -97.501),
    ].map((a) => [a.code, a]),
  );
  const routes = new Map([
    ["TST1", ["KMDW", "KATL"]],
    ["TST2", ["KDEN", "KOAK"]],
    ["TST3", ["KDAL", "KHOU", "KCRP"]],
  ]);
  const t = { routes, airports };
  const L = (callsign: string, lat?: number, lon?: number, track?: number) => lookupInTables(t, { callsign, lat, lon, track });

  let r = L("TST1", 37.7, -86.1, 160);
  check("mid-leg, heading to destination -> plausible", r.status === "plausible" && r.destination?.code === "KATL", fmt(r));
  r = L("TST1", 37.7, -86.1, 340);
  check("mid-leg, heading away -> implausible", r.status === "implausible", fmt(r));
  r = L("TST2", 41.49, -87.85, 180);
  check("DEN-OAK route seen over Chicago area -> implausible", r.status === "implausible", fmt(r));
  r = L("TST3", 29.75, -95.45, 225);
  check("multi-leg at HOU heading SW -> HOU-CRP", r.status === "plausible" && r.legIndex === 1, fmt(r));
  r = L("TST3", 30.0, -95.5, 150);
  check("multi-leg arriving HOU from north -> DAL-HOU", r.status === "plausible" && r.legIndex === 0, fmt(r));
  r = L("TST3");
  check("no position -> unverified", r.status === "unverified", fmt(r));
  r = L("NOPE1");
  check("unknown callsign -> not_found", r.status === "not_found", fmt(r));

  // Policy
  const swa = (callsign: string, lat?: number, lon?: number, track?: number) =>
    decideRoute(lookupInTables({ routes: new Map([...routes, ["SWA1", ["KMDW", "KATL"]], ["SWA2", ["KDEN", "KOAK"]], ["SWA3", ["KDAL", "KHOU", "KCRP"]]]), airports }, { callsign, lat, lon, track }));
  let d = swa("SWA1", 37.7, -86.1, 160);
  check("policy: SWA plausible -> csv, no FA", !!d.display && !d.paidLookup, d.reason);
  d = swa("SWA2", 41.49, -87.85, 180);
  check("policy: SWA implausible -> FA", !d.display && d.paidLookup, d.reason);
  d = swa("SWA9");
  check("policy: SWA not found -> FA", !d.display && d.paidLookup, d.reason);
  d = swa("SWA1");
  check("policy: SWA single-leg, no position -> csv, no FA", !!d.display && !d.paidLookup, d.reason);
  d = swa("SWA3");
  check("policy: SWA multi-leg, no position -> FA", !d.display && d.paidLookup, d.reason);
  d = decideRoute(L("TST2", 41.49, -87.85, 180));
  check("policy: other airline implausible -> nothing, no FA", !d.display && !d.paidLookup, d.reason);

  // Real data
  try {
    await ensureVrsLoaded();
    const s = vrsStats()!;
    check("VRS data loaded", s.routes > 100_000 && s.airports > 10_000, `routes=${s.routes} airports=${s.airports}`);
    r = await lookupVrsRoute({ callsign: "SWA2820" });
    check("SWA2820 present in real data", r.status !== "not_found", fmt(r));
  } catch (e) {
    check("VRS data loaded", false, String(e));
  }

  console.log(failures ? `\n${failures} failure(s)` : "\nAll checks passed");
  return failures ? 1 : 0;
}

async function live(): Promise<number> {
  const url = opt("url") ?? "http://10.0.5.20/skyaware/data/aircraft.json";
  const all = args.includes("--all");
  await ensureVrsLoaded();
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`aircraft.json HTTP ${res.status}`);
  const data = (await res.json()) as { aircraft: Array<Record<string, unknown>> };
  const counts: Record<string, number> = {};
  const decisions = { csv: 0, flightaware: 0, none: 0 };
  const lines: string[] = [];
  for (const a of data.aircraft) {
    const cs = String(a.flight ?? "").trim().toUpperCase();
    if (!/^[A-Z]{3}\d/.test(cs)) continue; // airline-style callsigns only
    if (!all && !cs.startsWith("SWA")) continue;
    const r = await lookupVrsRoute({ callsign: cs, lat: a.lat as number, lon: a.lon as number, track: a.track as number });
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    const d = decideRoute(r);
    decisions[d.display ? "csv" : d.paidLookup ? "flightaware" : "none"]++;
    lines.push(fmt(r));
  }
  console.log(lines.sort().join("\n") || "(no matching aircraft right now)");
  console.log("\nstatus:  " + JSON.stringify(counts));
  console.log("display: " + JSON.stringify(decisions) + "   (FA = would request FlightAware, subject to budget/hours)");
  return 0;
}

async function main(): Promise<number> {
  if (args.includes("--selftest")) return selftest();
  if (args.includes("--live")) return live();
  const cs = opt("callsign");
  if (cs) {
    const r = await lookupVrsRoute({ callsign: cs, lat: num(opt("lat")), lon: num(opt("lon")), track: num(opt("track")) });
    console.log(fmt(r));
    return 0;
  }
  console.log("Use --selftest, --live [--all], or --callsign CS [--lat --lon --track]");
  return 2;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
