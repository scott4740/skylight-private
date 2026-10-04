import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RouteTrial, parseLol, classify } from '../src/enrich/route-trial.js';
import { AeroRoutes, type Route } from '../src/enrich/aeroapi.js';
const dirs:string[]=[];
afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
const now=Date.parse('2026-09-23T18:00:00Z');
const ac={hex:'abc123',flight:'SWA1775',lat:42,lon:-88,origin:'DEN',destination:'MDW'};
const ref={origin:'DEN',destination:'MDW',originCodes:['DEN','KDEN'],destinationCodes:['MDW','KMDW'],routeSource:'flightaware',routeFlightId:'test'} as Route;
const body=[{callsign:'SWA1775',airport_codes:'KDEN-KMDW',_airports:[{icao:'KDEN',iata:'DEN'},{icao:'KMDW',iata:'MDW'}]}];
function setup(){const d=mkdtempSync(join(tmpdir(),'trial-'));dirs.push(d);const p=join(d,'route-comparison.json');writeFileSync(p,JSON.stringify({version:1,enabled:true,rows:[]}));return {d,p};}
it('normalizes aliases and separates reversals, missing and multileg routes',()=>{
 expect(classify(ref,parseLol(body,ac.flight,now))).toBe('exact_match');
 expect(classify(ref,parseLol([{...body[0],airport_codes:'KMDW-KDEN'}],ac.flight,now))).toBe('reversed');
 expect(classify(ref,parseLol([{...body[0],airport_codes:'KDEN-KMDW-KATL'}],ac.flight,now))).toBe('adsblol_multiple_legs');
 expect(classify(null,parseLol(body,ac.flight,now))).toBe('no_unique_flightaware_match');
 expect(classify(ref,parseLol([],ac.flight,now))).toBe('adsblol_missing_or_ambiguous');
});
it('persists the 50 attempt cap and rejects repeats after restart',()=>{
 const {p}=setup();let t=new RouteTrial(p,fetch,()=>now);
 for(let i=0;i<50;i++){const a={...ac,flight:`SWA${i}`};expect(t.eligible(a)).toBe(true);t.begin(a);t=new RouteTrial(p,fetch,()=>now);expect(t.eligible(a)).toBe(false);}
 expect(t.status().sampled).toBe(50);expect(t.eligible({...ac,flight:'SWA999'})).toBe(false);
});
it('pairs fresh requests, does not expose the key to ADSB.lol, and preserves the displayed free route',async()=>{
 const {d,p}=setup();writeFileSync(join(d,'key'),'secret-test');const calls:string[]=[];
 const f=(async(url:any,options:any)=>{const u=String(url);calls.push(u);
 if(u.includes('adsb.lol')){expect(options.headers['User-Agent']).toBe('SkylightRouteComparison/1.1 (contact: scott4740@gmail.com)');expect(JSON.stringify(options)).not.toContain('secret-test');expect(JSON.parse(options.body).planes[0]).toEqual({callsign:ac.flight,lat:42,lng:-88});return new Response(JSON.stringify(body));}
 return new Response(JSON.stringify(u.includes('/account/usage')?{total_cost:0}:{flights:[{ident_icao:ac.flight,fa_flight_id:'test',actual_off:'2026-09-23T17:00:00Z',origin:{code_iata:'DEN',code_icao:'KDEN'},destination:{code_iata:'MDW',code_icao:'KMDW'}}]}));}) as typeof fetch;
 const provider=new AeroRoutes({keyPath:join(d,'key'),ledgerPath:join(d,'ledger'),fetcher:f,now:()=>now});
 await provider.lookup({...ac,destination:'ATL'});await provider.lookup(ac);
 expect(calls).toHaveLength(3);expect(JSON.parse(readFileSync(p,'utf8')).rows[0].result).toBe('exact_match');
 expect(provider.decorate([{...ac,destination:'ATL'}])[0].destination).toBe('ATL');
});
it('does not run at night or for non-Southwest flights',async()=>{
 const {d}=setup();writeFileSync(join(d,'key'),'test');let calls=0;const f=(async()=>{calls++;throw Error();}) as typeof fetch;
 const p=new AeroRoutes({keyPath:join(d,'key'),ledgerPath:join(d,'ledger'),fetcher:f,now:()=>Date.parse('2026-09-23T04:00:00Z')});await p.lookup(ac);expect(calls).toBe(0);
 const t=new RouteTrial(join(d,'route-comparison.json'),f,()=>now);expect(t.eligible({...ac,flight:'UAL123'})).toBe(false);
});
it('pauses on rate limits and fails closed on corrupt state',()=>{
 const {p}=setup();let t=new RouteTrial(p,fetch,()=>now);t.finish(t.begin(ac),ref,{status:'rate_limited',at:now});
 t=new RouteTrial(p,fetch,()=>now);expect(t.eligible({...ac,flight:'SWA999'})).toBe(false);
 writeFileSync(p,'broken');t=new RouteTrial(p,fetch,()=>now);expect(t.status().error).toBeTruthy();expect(t.eligible(ac)).toBe(false);
});
it('makes no FlightAware requests on a 403 and persists the pause after restart',async()=>{
 const {d,p}=setup();writeFileSync(join(d,'key'),'test');const calls:string[]=[];
 const f=(async(url:any)=>{calls.push(String(url));return new Response('Forbidden',{status:403});}) as typeof fetch;
 const options={keyPath:join(d,'key'),ledgerPath:join(d,'ledger'),fetcher:f,now:()=>now};
 const provider=new AeroRoutes(options);await provider.lookup(ac);
 expect(calls).toEqual(['https://api.adsb.lol/api/0/routeset']);
 expect(provider.status().requestsThisMonth).toBe(0);
 const state=JSON.parse(readFileSync(p,'utf8'));expect(state.enabled).toBe(false);expect(state.rows).toHaveLength(0);expect(state.lastCheck.result.httpStatus).toBe(403);
 await new AeroRoutes(options).lookup({...ac,flight:'SWA999'});expect(calls).toHaveLength(1);
});
it('does not spend on missing or ambiguous free airport pairs',async()=>{
 for(const body of [[],[{callsign:ac.flight,airport_codes:'unknown'}],[{callsign:ac.flight,airport_codes:'KDEN-KMDW-KATL'}]]){
 const {d}=setup();writeFileSync(join(d,'key'),'test');let calls=0;
 const f=(async()=>{calls++;return new Response(JSON.stringify(body));}) as typeof fetch;
 const p=new AeroRoutes({keyPath:join(d,'key'),ledgerPath:join(d,'ledger'),fetcher:f,now:()=>now});await p.lookup(ac);expect(calls).toBe(1);expect(p.status().requestsThisMonth).toBe(0);
 }
});
