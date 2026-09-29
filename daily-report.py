#!/usr/bin/env python3
"""Local-only daily demand report. No credentials or network access."""
from pathlib import Path
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
from collections import Counter
import json, argparse
TZ=ZoneInfo('America/Chicago')
parser=argparse.ArgumentParser()
parser.add_argument('--date', help='Chicago date YYYY-MM-DD; default last seven days')
args=parser.parse_args()
today=datetime.now(TZ).date()
if args.date:
    dates=[datetime.strptime(args.date,'%Y-%m-%d').date()]
else:
    dates=[today-timedelta(days=n) for n in range(6,-1,-1)]
base=Path.home()/'skylight/server/data'
def readlines(path):
    if not path.exists(): return []
    rows=[]
    for line in path.read_text().splitlines():
        try: rows.append(json.loads(line))
        except ValueError: print(f'Warning: incomplete record in {path.name}')
    return rows
queries=[];results={}
for path in sorted((base/'aeroapi-queries').glob('*.jsonl')):
    for row in readlines(path):
        if row.get('event')=='query':queries.append(row)
        elif row.get('event')=='result':results[row['requestId']]=row
try: reservations=json.loads((base/'aeroapi-budget.json').read_text())['reservations']
except (OSError,ValueError,KeyError): raise SystemExit('Budget ledger unavailable; no cost totals reported.')
def local_time(value):
    return datetime.fromtimestamp(value/1000,timezone.utc).astimezone(TZ) if isinstance(value,(int,float)) else datetime.fromisoformat(value.replace('Z','+00:00')).astimezone(TZ)
def in_day(value,day):
    t=local_time(value)
    return t.date()==day and 8<=t.hour<22
print('DAYTIME DEMAND — 8am–10pm America/Chicago')
print('DATE        UNIQUE  VISITS  CACHE  QUERIES  ERRORS  RESERVED$  FEED MIN')
for day in dates:
    observations=readlines(base/'nearest-demand'/f'{day}.jsonl')
    sightings=[e for e in observations if e.get('event')=='closest']
    unique=len({e['flightKey'] for e in sightings})
    cache=sum(e.get('event')=='lookup_check' and e.get('outcome')=='route_cache' for e in observations)
    minutes=len({e['minute'] for e in observations if e.get('event')=='coverage'})
    paid=[q for q in queries if q.get('endpoint')=='/flights/{ident}' and in_day(q['timestamp'],day)]
    errors=sum(results.get(q['requestId'],{}).get('outcome')=='error' for q in paid)
    reserved=sum(in_day(t,day) for t in reservations)
    u=str(unique) if observations else '—'
    visits=str(len(sightings)) if observations else '—'
    print(f'{day}  {u:>6}  {visits:>6}  {cache:>5}  {len(paid):>7}  {errors:>6}  {reserved*.005:>9.3f}  {minutes:>8}')
    if observations:
        checks=Counter(e.get('outcome') for e in observations if e.get('event')=='lookup_check')
        delayed={k:v for k,v in checks.items() if k not in ('route_cache','checking_usage')}
        if delayed: print('  Skipped/deferred checks: '+', '.join(f'{k}={v}' for k,v in sorted(delayed.items())))
    if reserved>len(paid): print(f'  {reserved-len(paid)} reserved attempts have no query detail (earlier logging or interrupted attempts).')
    unknown=sum(q['requestId'] not in results for q in paid)
    if unknown: print(f'  {unknown} query outcomes unknown/interrupted.')
print('\nUNIQUE: distinct aircraft address + callsign; not independently verified flight legs.')
print('VISITS: closest for at least five seconds; returns after a gap can count again.')
print('CACHE: browser checks served by a cached route; repeated checks can count again.')
print('QUERIES: logged flight HTTP attempts; ERRORS: HTTP/network/parse failures.')
print('RESERVED$: all local daytime attempts × $0.005, including errors; not an invoice.')
print('FEED MIN: distinct minutes with a fresh-feed sample, out of 840 possible.')
print('A dash means no tracking data. Today and days with gaps are partial observations.')
