#!/usr/bin/env python3
"""Read local records only. Never contacts FlightAware or reads the API key."""
from pathlib import Path
from datetime import datetime, timezone
import json, sys, re
now = datetime.now(timezone.utc)
month = now.month - (1 if now.day < 20 else 0)
year = now.year
if month == 0: year, month = year-1, 12
cycle = sys.argv[1] if len(sys.argv) > 1 else f"{year:04d}-{month:02d}-20"
if re.fullmatch(r'\d{4}-(0[1-9]|1[0-2])', cycle): cycle += "-20"
if not re.fullmatch(r'\d{4}-(0[1-9]|1[0-2])-20', cycle):
    raise SystemExit('Use the cycle start date, for example: python3 query-report.py 2026-09-20')
base = Path.home()/'skylight/server/data'
start = datetime.strptime(cycle, '%Y-%m-%d').replace(tzinfo=timezone.utc)
end = start.replace(year=start.year+(start.month==12), month=start.month%12+1).timestamp()
try:
    ledger = json.loads((base/'aeroapi-budget.json').read_text())
    count = sum(start.timestamp()*1000 <= t < end*1000 for t in ledger['reservations'])
except (OSError, ValueError, KeyError, TypeError):
    raise SystemExit('Budget ledger unavailable; no totals reported.')
path = base/'aeroapi-queries'/f'{cycle}.jsonl'
events=[]
if path.exists():
    for n, line in enumerate(path.read_text().splitlines(), 1):
        try: events.append(json.loads(line))
        except ValueError: print(f'Warning: incomplete log line {n}', file=sys.stderr)
queries=[e for e in events if e.get('event')=='query']
results={e['requestId']:e for e in events if e.get('event')=='result'}
paid=[e for e in queries if e.get('endpoint')=='/flights/{ident}']
print(f'Cycle: {cycle} (starts on the 20th, 00:00 UTC)')
print(f'Paid attempts reserved: {count}/2000; estimated reservation: ${count*.005:.3f}/$10.00')
print(f'Logged paid attempts: {len(paid)}; free usage checks: {len(queries)-len(paid)}')
print('Reservations include errors; these are not confirmed FlightAware charges.')
if count>len(paid): print(f'{count-len(paid)} earlier/local reservations have no query detail in this log.')
print('\nRecent queries (UTC):')
print('TIME                  TYPE    FLIGHT        HTTP   RESULT')
for q in queries[-30:]:
    r=results.get(q['requestId'],{})
    print(f"{q['timestamp'][:19]:21} {'flight' if q.get('ident') else 'usage':7} {q.get('ident') or '—':13} {str(r.get('httpStatus') or '—'):6} {r.get('outcome','unknown/interrupted')}")
print(f'\nFull log: {path}')
